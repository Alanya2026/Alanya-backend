-- Coffre-fort — lot 3 : envoyer un fichier du coffre à un autre inscrit.
-- Conception : docs/conception/coffre-fort.html, section 07.
--
-- Un partage relie un fichier du coffre de l'expéditeur à une discussion. Le
-- message (type 11) ne porte que l'identifiant du partage ; le serveur remet
-- les adresses de lecture et la clé aux membres ACTUELS de la discussion,
-- tant que l'expéditeur garde le fichier dans son coffre (hors corbeille).
-- « Enregistrer dans mon coffre » ne copie rien chez MEGA : le fichier du
-- destinataire désigne les mêmes blocs (safebox_blob).
--
-- Réexécutable : CREATE TABLE IF NOT EXISTS, colonnes testées dans
-- information_schema. Appliquer AVANT de déployer le code.

CREATE TABLE IF NOT EXISTS safebox_share (
  id              BIGINT       NOT NULL AUTO_INCREMENT,
  file_id         BIGINT       NULL COMMENT 'NULL une fois le fichier supprimé : le partage est retiré',
  conversation_id BIGINT       NOT NULL,
  sender_id       INT          NOT NULL,
  name            VARCHAR(180) NOT NULL COMMENT 'Copié à la création : la carte reste lisible après retrait',
  mime            VARCHAR(127) NULL,
  family          ENUM('albums','videos','audios','documents') NOT NULL,
  plain_bytes     BIGINT       NOT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at      DATETIME     NULL,
  PRIMARY KEY (id),
  KEY idx_safebox_share_conv (conversation_id),
  KEY idx_safebox_share_file (file_id),
  CONSTRAINT fk_safebox_share_file FOREIGN KEY (file_id)
    REFERENCES safebox_file(id) ON DELETE SET NULL,
  CONSTRAINT fk_safebox_share_conv FOREIGN KEY (conversation_id)
    REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_safebox_share_sender FOREIGN KEY (sender_id)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Un téléchargement par destinataire et par fenêtre de deux heures : renouveler
-- les adresses d'un gros fichier (elles valent 15 minutes) ne compte pas comme
-- un nouveau téléchargement. Purgé au-delà de 31 jours (purge `safebox`) :
-- l'admin compte les téléchargements des 30 derniers jours.
CREATE TABLE IF NOT EXISTS safebox_share_download (
  id         BIGINT   NOT NULL AUTO_INCREMENT,
  share_id   BIGINT   NOT NULL,
  alanyaID   INT      NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_safebox_dl_share (share_id, alanyaID, created_at),
  KEY idx_safebox_dl_date (created_at),
  CONSTRAINT fk_safebox_dl_share FOREIGN KEY (share_id)
    REFERENCES safebox_share(id) ON DELETE CASCADE,
  CONSTRAINT fk_safebox_dl_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Réglages : limite de téléchargements, et date du dernier rapprochement entre
-- MEGA et la base (objets restés chez MEGA sans ligne, une fois par semaine).
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_settings' AND COLUMN_NAME = 'share_downloads_per_day');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_settings
     ADD COLUMN share_downloads_per_day SMALLINT NOT NULL DEFAULT 3
       COMMENT ''Téléchargements d''''un fichier partagé, par destinataire et par 24 h'' AFTER max_folders',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_settings' AND COLUMN_NAME = 'last_reconcile_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_settings ADD COLUMN last_reconcile_at DATETIME NULL
     COMMENT ''Dernier rapprochement MEGA / base'' AFTER extensions',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
