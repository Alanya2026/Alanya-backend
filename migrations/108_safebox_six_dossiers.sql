-- Coffre-fort : six dossiers (conception : docs/conception/coffre-fort.html,
-- version 13, section 02, décision du 24/10/2026).
--
-- Le coffre passe de quatre à six dossiers racines :
--   photos, videos, audios, documents — un type chacun, remplis depuis le
--     téléphone ;
--   albums, partager — remplis à la main, tous types acceptés.
-- L'ancien « albums » ne contenait que des photos : il devient « photos », et
-- le mot « albums » prend son nouveau sens. Le type d'un fichier (`family`)
-- suit : « albums » devient « photos ». Les racines « albums » et « partager »
-- se créent à la première ouverture du coffre, comme les autres.
--
-- ⚠ Le code du lot 6 et cette migration vont ensemble : l'appliquer AU
-- MOMENT de déployer le lot 6. L'ancien code écrit encore `family = 'albums'`,
-- que la colonne n'accepte plus ensuite.
--
-- Réexécutable : le renommage n'a lieu que tant que `safebox_file.family`
-- accepte encore 'albums'. Repasser après coup ne touche pas aux nouveaux
-- dossiers « albums ».

SET @avant := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_file' AND COLUMN_NAME = 'family'
    AND COLUMN_TYPE LIKE '%''albums''%');

-- 1. Les racines acceptent les six valeurs.
ALTER TABLE safebox_folder
  MODIFY root ENUM('albums','videos','audios','documents','photos','partager') NOT NULL,
  MODIFY root_slot ENUM('albums','videos','audios','documents','photos','partager') NULL
    COMMENT 'Égal à root pour un dossier racine, NULL sinon : un seul par racine';

-- 2. Le type « photos » s'ajoute à côté de l'ancien, le temps de renommer.
SET @sql := IF(@avant > 0,
  'ALTER TABLE safebox_file MODIFY family ENUM(''albums'',''photos'',''videos'',''audios'',''documents'') NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 3. L'ancien « albums » (des photos) devient « photos », dossiers et fichiers.
SET @sql := IF(@avant > 0, 'UPDATE safebox_folder SET root = ''photos'' WHERE root = ''albums''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := IF(@avant > 0, 'UPDATE safebox_folder SET root_slot = ''photos'' WHERE root_slot = ''albums''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := IF(@avant > 0, 'UPDATE safebox_file SET family = ''photos'' WHERE family = ''albums''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 4. Les partages (migration 102) portent le type copié du fichier.
SET @partage := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_share' AND COLUMN_NAME = 'family'
    AND COLUMN_TYPE LIKE '%''albums''%');
SET @sql := IF(@partage > 0,
  'ALTER TABLE safebox_share MODIFY family ENUM(''albums'',''photos'',''videos'',''audios'',''documents'') NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := IF(@partage > 0, 'UPDATE safebox_share SET family = ''photos'' WHERE family = ''albums''', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
SET @sql := IF(@partage > 0,
  'ALTER TABLE safebox_share MODIFY family ENUM(''photos'',''videos'',''audios'',''documents'') NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 5. Les extensions réglées dans l'admin, rangées par type.
SET @sql := IF(@avant > 0,
  'UPDATE safebox_settings
      SET extensions = JSON_REMOVE(JSON_SET(extensions, ''$.photos'', JSON_EXTRACT(extensions, ''$.albums'')), ''$.albums'')
    WHERE extensions IS NOT NULL AND JSON_CONTAINS_PATH(extensions, ''one'', ''$.albums'')',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 6. Plus aucun fichier de type « albums » : le type ne l'accepte plus.
SET @sql := IF(@avant > 0,
  'ALTER TABLE safebox_file MODIFY family ENUM(''photos'',''videos'',''audios'',''documents'') NOT NULL',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
