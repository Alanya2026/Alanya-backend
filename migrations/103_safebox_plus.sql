-- Coffre-fort — lot 4 : l'espace vendu avec Alanya Plus (décision du
-- 15/10/2026 : 50 Go au total avec Plus, réglable par plan dans l'admin).
-- Conception : docs/conception/coffre-fort.html, sections 06 et 09.
--
-- `plan.safebox_bytes` : l'espace que donne une période de ce plan. NULL =
-- l'espace de base (safebox_settings.base_quota_bytes). En phase gratuite,
-- tout le monde a l'espace de base, quel que soit son plan.
--
-- ⚠ Prix : Plus annuel coûte 1 000 XAF (migration 082). À environ 2,50 € le To
-- et par mois chez MEGA, un abonné qui remplit 50 Go coûte à peu près ce qu'il
-- paie. La valeur se règle par plan dans l'admin.
--
-- Réexécutable : colonne testée dans information_schema, UPDATE limité aux
-- plans qui n'ont pas encore de valeur.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plan' AND COLUMN_NAME = 'safebox_bytes');
SET @sql := IF(@col = 0,
  'ALTER TABLE plan ADD COLUMN safebox_bytes BIGINT NULL
     COMMENT ''Espace du coffre-fort donné par ce plan ; NULL = espace de base''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

-- 50 Gio pour les plans existants (tous des plans Alanya Plus).
UPDATE plan SET safebox_bytes = 53687091200 WHERE safebox_bytes IS NULL;
