-- Coffre-fort : l'espace offert passe de 10 Gio à 1 Gio (décision du 02/11/2026).
--
-- Vaut pour tous les comptes sans Alanya Plus, anciens et nouveaux, dans les
-- 30 secondes (cache des réglages) et sans redéploiement. Un compte qui dépasse
-- garde ses fichiers : il peut les lire, les télécharger et les supprimer, mais
-- plus en ajouter. Seule exception, la purge de fin d'Alanya Plus
-- (billing/featurePurge.js) réduit ce compte à ce nouvel espace.
--
-- Ne touche pas à une valeur déjà changée à la main ou par l'admin.
-- Réexécutable. Retour arrière : base_quota_bytes = 10737418240.

ALTER TABLE safebox_settings
  MODIFY base_quota_bytes BIGINT NOT NULL DEFAULT 1073741824 COMMENT 'Espace offert, 1 Gio';

UPDATE safebox_settings SET base_quota_bytes = 1073741824
 WHERE id = 1 AND base_quota_bytes = 10737418240;
