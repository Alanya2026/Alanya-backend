-- Coffre-fort — lot 9 : partager plusieurs fichiers en un seul message, et
-- retirer un partage (conception : docs/conception/coffre-fort.html,
-- sections 08 et 12, décision du 24/10/2026 : « un album en une seule carte »).
--
-- 1. `safebox_share.kind` : « file », un fichier (comme avant, `file_id`
--    renseigné) ; « batch », un lot — un album ou une sélection — dont les
--    éléments sont dans `safebox_share_item` (`file_id` reste NULL). Pour un
--    lot, `name` est son titre, `plain_bytes` la somme, `family` le type le
--    plus nombreux, `item_count` et `families` ce qu'affiche la carte
--    (« 42 éléments · 35 photos, 6 vidéos, 1 document »).
--
-- 2. `safebox_share.revoked_by` : « sender » quand l'expéditeur retire son
--    partage (« Retirer le partage » du suivi), « moderation » sinon. Les
--    partages déjà retirés l'ont été par la modération : NULL vaut
--    « moderation ».
--
-- 3. `safebox_share_item` : les éléments d'un lot, dans l'ordre. Nom, type et
--    taille sont copiés à la création, comme pour un partage simple : la
--    grille reste lisible après la suppression d'un fichier par l'expéditeur.
--
-- Réexécutable : colonnes testées dans information_schema, CREATE TABLE IF
-- NOT EXISTS. Ajouts seulement, avec valeurs par défaut : l'ancien code n'est
-- pas gêné. L'appliquer AVANT de déployer le lot 9.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_share' AND COLUMN_NAME = 'kind');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_share ADD COLUMN kind ENUM(''file'',''batch'') NOT NULL DEFAULT ''file''
     COMMENT ''file : un fichier (file_id) ; batch : un lot (safebox_share_item)'' AFTER file_id',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_share' AND COLUMN_NAME = 'item_count');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_share ADD COLUMN item_count INT NOT NULL DEFAULT 1 AFTER plain_bytes',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_share' AND COLUMN_NAME = 'families');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_share ADD COLUMN families JSON NULL
     COMMENT ''Lot : nombre d''''éléments par type'' AFTER item_count',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_share' AND COLUMN_NAME = 'revoked_by');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_share ADD COLUMN revoked_by ENUM(''sender'',''moderation'') NULL
     COMMENT ''NULL avec revoked_at : la modération (partages retirés avant le lot 9)'' AFTER revoked_at',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS safebox_share_item (
  id          BIGINT       NOT NULL AUTO_INCREMENT,
  share_id    BIGINT       NOT NULL,
  position    INT          NOT NULL COMMENT 'Ordre dans le lot, à partir de 0',
  file_id     BIGINT       NULL COMMENT 'NULL une fois le fichier supprimé : l''élément n''est plus disponible',
  name        VARCHAR(180) NOT NULL,
  mime        VARCHAR(127) NULL,
  family      ENUM('photos','videos','audios','documents') NOT NULL,
  plain_bytes BIGINT       NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_safebox_share_item_pos (share_id, position),
  KEY idx_safebox_share_item_file (file_id),
  CONSTRAINT fk_safebox_share_item_share FOREIGN KEY (share_id)
    REFERENCES safebox_share(id) ON DELETE CASCADE,
  CONSTRAINT fk_safebox_share_item_file FOREIGN KEY (file_id)
    REFERENCES safebox_file(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
