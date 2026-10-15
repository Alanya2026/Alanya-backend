-- Coffre-fort (`safebox`) — lot 1. Conception : docs/conception/coffre-fort.html.
--
-- L'inscrit range ses fichiers dans quatre dossiers fixes (albums, videos,
-- audios, documents) et leurs sous-dossiers. Les fichiers vivent chez MEGA S4
-- (bucket `safebox`), chiffrés par le téléphone, découpés en blocs
-- indépendants de 8 Mio : un objet S4 par bloc, `u/<empreinte>/<uuid>/00001`.
-- Les dossiers et les noms n'existent qu'ici : renommer ou déplacer ne touche
-- jamais MEGA.
--
-- Un « blob » est le contenu chez MEGA ; un « fichier » est sa place dans un
-- coffre. Plusieurs fichiers peuvent désigner le même blob (« Enregistrer dans
-- mon coffre », lot 3) : il n'est supprimé chez MEGA que lorsque plus aucun
-- fichier ne le désigne (purge `safebox`).
--
-- Idempotente : CREATE TABLE IF NOT EXISTS et INSERT IGNORE partout. Le code
-- tolère son absence (le coffre répond 503 tant que MEGA S4 et SAFEBOX_KEY ne
-- sont pas configurés).

-- Une seule ligne : les réglages que l'admin pourra changer (lot 5).
CREATE TABLE IF NOT EXISTS safebox_settings (
  id                  TINYINT  NOT NULL DEFAULT 1,
  base_quota_bytes    BIGINT   NOT NULL DEFAULT 10737418240 COMMENT 'Espace offert, 10 Gio',
  max_file_bytes      BIGINT   NOT NULL DEFAULT 1073741824  COMMENT 'Fichier le plus gros, 1 Gio',
  max_file_bytes_plus BIGINT   NOT NULL DEFAULT 1073741824  COMMENT 'Idem pour Alanya Plus (lot 4)',
  max_depth           TINYINT  NOT NULL DEFAULT 5           COMMENT 'Niveaux de sous-dossiers',
  max_folders         INT      NOT NULL DEFAULT 500         COMMENT 'Sous-dossiers par compte',
  extensions          JSON     NULL COMMENT 'Listes par famille ; NULL = celles du code',
  updated_by          INT      NULL,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT ck_safebox_settings_singleton CHECK (id = 1),
  CONSTRAINT ck_safebox_settings_bounds CHECK (
    base_quota_bytes >= 0 AND max_file_bytes > 0 AND max_file_bytes_plus > 0
    AND max_depth BETWEEN 1 AND 20 AND max_folders > 0),
  CONSTRAINT fk_safebox_settings_updater FOREIGN KEY (updated_by)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO safebox_settings (id) VALUES (1);

-- Un coffre ouvert. La ligne sert aussi de verrou : une réservation d'espace la
-- verrouille, si bien que deux envois en parallèle ne dépassent pas l'espace.
CREATE TABLE IF NOT EXISTS safebox_account (
  alanyaID   INT      NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID),
  CONSTRAINT fk_safebox_account_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS safebox_folder (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID          INT          NOT NULL,
  parent_id         BIGINT       NULL COMMENT 'NULL pour un dossier racine',
  root              ENUM('albums','videos','audios','documents') NOT NULL,
  root_slot         ENUM('albums','videos','audios','documents') NULL
                      COMMENT 'Égal à root pour un dossier racine, NULL sinon : un seul par famille',
  name              VARCHAR(80)  NULL COMMENT 'NULL pour un dossier racine : l''application le traduit',
  path              VARCHAR(255) NOT NULL DEFAULT '' COMMENT '/<id racine>/…/<id>/',
  depth             TINYINT      NOT NULL DEFAULT 0 COMMENT '0 = racine',
  trashed_at        DATETIME     NULL,
  trashed_by_folder BIGINT       NULL
                      COMMENT 'Mis à la corbeille avec ce dossier ; NULL = mis à la corbeille lui-même',
  -- Deux frères vivants ne portent pas le même nom ; un dossier à la corbeille
  -- libère le sien.
  name_key          VARCHAR(80)  GENERATED ALWAYS AS (IF(trashed_at IS NULL, name, NULL)) STORED,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_safebox_root (alanyaID, root_slot),
  UNIQUE KEY uq_safebox_sibling (parent_id, name_key),
  KEY idx_safebox_folder_path (alanyaID, path),
  KEY idx_safebox_folder_trash (trashed_at),
  CONSTRAINT fk_safebox_folder_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_safebox_folder_parent FOREIGN KEY (parent_id)
    REFERENCES safebox_folder(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS safebox_blob (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID      INT          NULL COMMENT 'Qui l''a envoyé',
  prefix        VARCHAR(100) NOT NULL COMMENT 'u/<empreinte>/<uuid>/ chez MEGA',
  block_size    INT          NOT NULL,
  block_count   INT          NOT NULL,
  stored_bytes  BIGINT       NOT NULL COMMENT 'Octets chiffrés, blocs seuls',
  plain_bytes   BIGINT       NOT NULL COMMENT 'Octets en clair, après compression',
  preview_bytes INT          NOT NULL DEFAULT 0 COMMENT 'Aperçu chiffré, objet <prefix>apercu',
  cipher_format VARCHAR(16)  NOT NULL,
  wrapped_key   VARBINARY(96) NULL COMMENT 'Clé du fichier sous SAFEBOX_KEY, posée à la fin de l''envoi',
  status        ENUM('pending','ready','deleting') NOT NULL DEFAULT 'pending',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activity_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Dernier signe de l''envoi en cours',
  completed_at  DATETIME     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_safebox_blob_prefix (prefix),
  KEY idx_safebox_blob_status (status, activity_at),
  CONSTRAINT ck_safebox_blob_sizes CHECK (
    block_size > 0 AND block_count >= 1 AND stored_bytes >= 1
    AND plain_bytes >= 1 AND preview_bytes >= 0),
  CONSTRAINT fk_safebox_blob_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS safebox_file (
  id                BIGINT       NOT NULL AUTO_INCREMENT,
  alanyaID          INT          NOT NULL,
  folder_id         BIGINT       NOT NULL,
  blob_id           BIGINT       NOT NULL,
  name              VARCHAR(180) NOT NULL,
  ext               VARCHAR(10)  NOT NULL DEFAULT '',
  mime              VARCHAR(127) NULL,
  family            ENUM('albums','videos','audios','documents') NOT NULL,
  original_bytes    BIGINT       NULL COMMENT 'Avant compression, pour afficher le gain',
  compressed        TINYINT      NOT NULL DEFAULT 0,
  trashed_at        DATETIME     NULL,
  trashed_by_folder BIGINT       NULL
                      COMMENT 'Mis à la corbeille avec ce dossier ; NULL = mis à la corbeille lui-même',
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_safebox_file_folder (folder_id, trashed_at),
  KEY idx_safebox_file_user (alanyaID, trashed_at),
  KEY idx_safebox_file_blob (blob_id),
  KEY idx_safebox_file_trash (trashed_at),
  CONSTRAINT fk_safebox_file_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE,
  CONSTRAINT fk_safebox_file_folder FOREIGN KEY (folder_id)
    REFERENCES safebox_folder(id) ON DELETE CASCADE,
  -- Un blob désigné ne se supprime pas : la purge vérifie qu'il est orphelin.
  CONSTRAINT fk_safebox_file_blob FOREIGN KEY (blob_id)
    REFERENCES safebox_blob(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO scheduler_leases (name) VALUES ('safebox_purge');
