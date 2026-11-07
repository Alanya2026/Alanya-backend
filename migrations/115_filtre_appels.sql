-- Migration 115 : filtre d'appels (seuls mes contacts peuvent m'appeler)
--
-- Appliquer après 114. Application MANUELLE, réexécutable sans erreur :
-- colonne testée dans information_schema, INSERT IGNORE pour le catalogue.
-- Le code tolère l'absence de cette migration (filtre éteint, et l'allumer
-- échoue), mais elle s'applique AVANT de déployer.
--
-- Filtre allumé, un appel venant de quelqu'un qui n'est pas dans mes contacts
-- ne passe pas : l'appelant lit « Appel impossible », mon téléphone ne sonne
-- pas et je ne reçois rien. Le serveur le garde pour les trois chemins qui font
-- sonner (appel direct, ajout à un appel, appel de groupe).
--
-- `is_paid = 1` : en régime TRIAL, rules.js ouvre tout pendant l'essai, le
-- filtre compris ; ensuite, seuls les plans qui le listent le rouvrent. Sans le
-- droit, le serveur refuse de l'allumer et ne l'applique plus aux appels ;
-- l'éteindre reste toujours permis, et le réglage est conservé pour
-- l'abonnement. Même principe que le répondeur (migration 114).

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_privacy_prefs' AND COLUMN_NAME = 'callsFromContactsOnly');
SET @sql := IF(@col = 0,
  'ALTER TABLE user_privacy_prefs ADD COLUMN callsFromContactsOnly TINYINT NOT NULL DEFAULT 0
     COMMENT ''1 = appels reçus de mes contacts seulement''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

INSERT IGNORE INTO feature (code, name_i18n, description_i18n, is_paid, is_available, sort_order) VALUES
  ('call_filter',
   JSON_OBJECT('fr', 'Filtre d''appels', 'en', 'Call filter', 'zh', '来电过滤'),
   JSON_OBJECT('fr', 'Seules les personnes de vos contacts peuvent vous appeler',
               'en', 'Only people in your contacts can call you',
               'zh', '只有您的联系人才能给您打电话'),
   1, 1, 100);

INSERT IGNORE INTO plan_feature (plan_id, feature_code)
  SELECT p.id, 'call_filter' FROM plan p
   WHERE p.code IN ('plus_mensuel', 'plus_annuel');
