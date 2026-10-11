-- Migration 098 : partage de packs personnels (stickers V1b, T6).
--
-- FICHIER SEULEMENT : à appliquer à la main par le propriétaire, AVANT le push
-- du backend qui lit `source_pack_id`. Aucune migration n'est jouée par le code.
--
-- Réexécutable : MySQL 8 n'a pas `ADD COLUMN IF NOT EXISTS`, donc la colonne et
-- l'index sont gardés par `information_schema` (même patron que 092 et 093).
-- Pas d'ENUM, utf8mb4 hérité de la table.
--
-- ── À quoi elle sert ──
--
-- Installer un pack partagé (`POST /api/stickers/share/:token/add`) crée, chez
-- le destinataire, un pack PRIVÉ dont il est propriétaire, avec des COPIES des
-- fichiers (règle « copie » du plan §4 : l'auteur reste maître des siens, et
-- révoquer le lien ou supprimer ses stickers ne casse pas les packs déjà
-- installés). `source_pack_id` retient de quel pack partagé vient cette copie :
--   - rappeler « ajouter » est idempotent (aucun doublon de pack) ;
--   - la fiche d'un lien dit « déjà ajouté » et donne l'identifiant de la copie.
--
-- NULL = pack créé de zéro (et tous les packs officiels). Aucune clé étrangère :
-- le pack source peut être archivé sans que la copie soit touchée.
--
-- Ordre de déploiement : avant le push. Sans la colonne, les routes de partage
-- répondent 500 (rien d'autre n'est affecté : la création, l'envoi et le
-- catalogue ne lisent pas `source_pack_id`).

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sticker_pack'
    AND COLUMN_NAME = 'source_pack_id');
SET @sql := IF(@has = 0, 'ALTER TABLE sticker_pack
    ADD COLUMN source_pack_id BIGINT UNSIGNED NULL
      COMMENT ''pack partage dont ce pack est la copie (installation d un lien)''', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @has := (SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sticker_pack'
    AND INDEX_NAME = 'idx_pack_owner_source');
SET @sql := IF(@has = 0, 'ALTER TABLE sticker_pack
    ADD KEY idx_pack_owner_source (owner_id, source_pack_id)', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
