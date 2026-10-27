-- Documents sensibles — lot 0 (plan : PLAN-DOCUMENTS-SENSIBLES.md, repris
-- d'Alanya Work).
--
-- Un document sensible s'ouvre seulement dans la visionneuse protégée
-- d'Alanya ; il ne se transfère ni ne se partage, et la seule copie qui sort
-- (« Enregistrer ») est signée au nom de qui l'a fait sortir, avec une
-- EMPREINTE NUMÉRIQUE de 128 bits que le serveur note ici.
--
-- 1. `message.isSensitive` : 1 = document sensible. Le serveur s'en sert pour
--    refuser un transfert et écarter le message des galeries.
--
-- 2. `message.mediaProtection` : JSON OPAQUE, écrit par l'expéditeur, relayé
--    tel quel, jamais lu par le serveur (`{sensible, protection?}`, mêmes clés
--    que le descripteur chiffré d'Alanya Work). Le jour où les médias seront
--    chiffrés de bout en bout, il passera dans l'enveloppe et la colonne
--    restera NULL pour les messages chiffrés.
--
-- 3. `document_consultation` : chaque consultation, et chaque copie sortie
--    avec son empreinte. SANS clé étrangère, volontairement : la trace doit
--    survivre à la purge du message et à la suppression des comptes — c'est
--    précisément quand le document a fui qu'on la cherche. Expéditeur et
--    conversation y sont donc recopiés.
--
-- Réexécutable : colonnes testées dans information_schema, CREATE TABLE IF
-- NOT EXISTS. Ajouts seulement : l'ancien code n'est pas gêné. Le nouveau ne
-- nomme les deux colonnes à l'INSERT que pour un message sensible
-- (utils/messageInsert), mais la galerie des médias (`m.isSensitive = 0`) et
-- les routes /api/documents-sensibles en ont besoin : l'appliquer AVANT de
-- déployer ce lot.

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
    AND COLUMN_NAME = 'isSensitive');
SET @sql := IF(@has = 0, 'ALTER TABLE message
    ADD COLUMN isSensitive TINYINT NOT NULL DEFAULT 0
      COMMENT ''1 = document sensible (visionneuse protegee, copie signee)'',
    ALGORITHM=INSTANT', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
    AND COLUMN_NAME = 'mediaProtection');
SET @sql := IF(@has = 0, 'ALTER TABLE message
    ADD COLUMN mediaProtection JSON NULL
      COMMENT ''Descripteur sensible opaque, ecrit par l expediteur, jamais lu'',
    ALGORITHM=INSTANT', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS document_consultation (
  id             BIGINT       NOT NULL AUTO_INCREMENT,
  msgID          BIGINT       NOT NULL,
  conversationID BIGINT       NOT NULL,
  alanyaID       INT          NOT NULL COMMENT 'Qui a consulté ou fait sortir la copie',
  expediteurID   INT          NOT NULL COMMENT 'Qui avait envoyé le document',
  geste          ENUM('CONSULTATION','TELECHARGEMENT','PARTAGE','TRANSFERT') NOT NULL,
  empreinte      CHAR(32)     NULL COMMENT 'Code de trace écrit dans la copie (hex minuscule) ; NULL pour une consultation',
  appareil       VARCHAR(120) NULL COMMENT 'Marque et modèle, déclarés par l''appareil',
  appareilId     VARCHAR(64)  NULL COMMENT 'Appareil de la session (jeton)',
  createdAt      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_document_consultation_empreinte (empreinte),
  KEY idx_document_consultation_msg (msgID, createdAt),
  KEY idx_document_consultation_user (alanyaID, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
