-- Coffre-fort — lot 10 : la sauvegarde automatique (conception :
-- docs/conception/coffre-fort.html, section 03, décisions du 24/10/2026).
--
-- 1. `safebox_blob.source_fp` : l'empreinte de l'ORIGINAL (avant compression)
--    calculée par le téléphone, liée au compte par le serveur (HMAC sous
--    SAFEBOX_KEY, avec le numéro du compte) : deux comptes qui envoient la
--    même photo n'ont pas la même empreinte, et l'empreinte ne dit rien du
--    fichier. Elle évite les doublons : une photo déjà dans le coffre (ajoutée
--    à la main dans un album, par exemple) n'est pas renvoyée.
--
-- 2. `safebox_backup_skip` : « ne plus sauvegarder ». Un fichier supprimé du
--    coffre alors qu'il est encore sur le téléphone n'est pas renvoyé, même
--    après une réinstallation de l'application.
--
-- Réexécutable : colonne et index testés dans information_schema, CREATE
-- TABLE IF NOT EXISTS. Ajouts seulement : l'appliquer AVANT de déployer le
-- lot 10 (l'ancien code n'est pas gêné).
--
-- Numérotée 111 : la 110 est celle des documents sensibles (110_documents_sensibles.sql).

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND COLUMN_NAME = 'source_fp');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_blob ADD COLUMN source_fp CHAR(64) NULL
     COMMENT ''Empreinte de l''''original, liée au compte (HMAC) : doublons de la sauvegarde automatique''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND INDEX_NAME = 'idx_safebox_blob_fp');
SET @sql := IF(@idx = 0, 'ALTER TABLE safebox_blob ADD KEY idx_safebox_blob_fp (alanyaID, source_fp)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS safebox_backup_skip (
  alanyaID   INT      NOT NULL,
  source_fp  CHAR(64) NOT NULL COMMENT 'Même empreinte liée au compte que safebox_blob.source_fp',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (alanyaID, source_fp),
  CONSTRAINT fk_safebox_skip_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
