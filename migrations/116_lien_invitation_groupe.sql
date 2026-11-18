-- Migration 116 : lien et QR code d'invitation de groupe.
-- Plan : docs-groupes/PLAN-LIEN-QR-GROUPE.md (hors dépôt).
--
-- Appliquer après 115. Application MANUELLE, réexécutable sans erreur :
-- CREATE TABLE IF NOT EXISTS, colonnes testées dans information_schema.
-- Appliquer AVANT de déployer le code.
--
-- Le jeton vit dans sa PROPRE table et non dans `conversation` : la fiche de
-- groupe (`SELECT c.*`) est diffusée à TOUS les membres, et un jeton posé là
-- aurait fuité vers les membres simples même quand seuls les admins ont le
-- droit de partager le lien.

-- 1. Réglages du groupe (diffusés aux membres avec la fiche).
SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation' AND COLUMN_NAME = 'onlyAdminsCanShareLink');
SET @sql := IF(@col = 0,
  'ALTER TABLE conversation ADD COLUMN onlyAdminsCanShareLink TINYINT NOT NULL DEFAULT 1
     COMMENT ''1 = seuls les admins voient et partagent le lien d''''invitation''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation' AND COLUMN_NAME = 'approveNewMembers');
SET @sql := IF(@col = 0,
  'ALTER TABLE conversation ADD COLUMN approveNewMembers TINYINT NOT NULL DEFAULT 0
     COMMENT ''1 = une arrivée par lien devient une demande à approuver''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 2. Le lien : un seul par groupe, créé à la première demande, remplacé à la
--    réinitialisation (l'ancien cesse aussitôt de résoudre).
CREATE TABLE IF NOT EXISTS conv_invite_link (
  conversID  BIGINT      NOT NULL,
  token      VARCHAR(32) NOT NULL COMMENT '16 caractères base64url (96 bits)',
  createdBy  INT         NULL,
  createdAt  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversID),
  UNIQUE KEY uq_conv_invite_token (token),
  CONSTRAINT fk_conv_invite_conv FOREIGN KEY (conversID)
    REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_conv_invite_user FOREIGN KEY (createdBy)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Demandes d'adhésion : une ligne par personne et par groupe, mise à jour
--    en place. status : 0 en attente, 1 acceptée, 2 refusée, 3 annulée.
CREATE TABLE IF NOT EXISTS conv_join_request (
  conversID  BIGINT   NOT NULL,
  alanyaID   INT      NOT NULL,
  status     TINYINT  NOT NULL DEFAULT 0,
  createdAt  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decidedBy  INT      NULL,
  decidedAt  DATETIME NULL,
  PRIMARY KEY (conversID, alanyaID),
  KEY idx_conv_join_request_pending (conversID, status, createdAt),
  CONSTRAINT fk_conv_join_conv FOREIGN KEY (conversID)
    REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_conv_join_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Membres retirés par un admin. Jusqu'ici le retrait était un simple DELETE
--    sans trace : un exclu aurait pu revenir seul par le lien. La ligne est
--    effacée quand un membre le rajoute (ajout direct ou approbation).
CREATE TABLE IF NOT EXISTS conv_removed_member (
  conversID  BIGINT   NOT NULL,
  alanyaID   INT      NOT NULL,
  removedBy  INT      NULL,
  removedAt  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (conversID, alanyaID),
  CONSTRAINT fk_conv_removed_conv FOREIGN KEY (conversID)
    REFERENCES conversation(conversID) ON DELETE CASCADE,
  CONSTRAINT fk_conv_removed_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
