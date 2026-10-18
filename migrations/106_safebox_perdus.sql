-- Coffre-fort : fichiers perdus chez MEGA (conception : docs/conception/
-- coffre-fort.html, section 08, décision du 18/10/2026).
--
-- Chaque fichier existe deux fois : sa fiche en base, son contenu chez MEGA.
-- Le rapprochement hebdomadaire supprimait déjà le contenu sans fiche ; il
-- repère désormais aussi la fiche dont le contenu manque (incident chez MEGA,
-- suppression à la main dans la console, défaut d'une purge). `lost_at` dit
-- quand : l'admin les compte, l'application affiche « Fichier endommagé » au
-- lieu d'une erreur de téléchargement. MEGA ne garde pas de copie : rien ne
-- se récupère, mais on le sait. Un contenu retrouvé au passage suivant (lecture
-- incomplète du bucket) remet `lost_at` à NULL.
--
-- Réexécutable : colonne et index testés dans information_schema. Le code
-- tolère l'absence de cette migration (pas de détection), mais elle
-- s'applique AVANT de déployer.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND COLUMN_NAME = 'lost_at');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_blob ADD COLUMN lost_at DATETIME NULL
     COMMENT ''Contenu introuvable chez MEGA au dernier rapprochement''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

SET @idx := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND INDEX_NAME = 'idx_safebox_blob_lost');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_safebox_blob_lost ON safebox_blob (lost_at)', 'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
