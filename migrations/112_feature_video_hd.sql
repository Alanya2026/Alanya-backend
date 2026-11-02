-- Migration 112 : les appels vidéo HD entrent au catalogue des fonctionnalités
--
-- Appliquer après 111. Application MANUELLE, réexécutable sans erreur
-- (INSERT IGNORE), sur le modèle des seeds des migrations 080 et 087.
--
-- L'application propose trois niveaux de vidéo en appel : basse résolution
-- (360p), standard (480p, par défaut) et haute définition (720p). Les deux
-- premiers sont ouverts à tous ; la HD est réservée à Alanya Plus.
--
-- Aucun code serveur ne garde ce droit : la caméra et l'encodeur sont réglés
-- par le téléphone, qui lit `features.video_hd` dans /api/billing/me. Sans ce
-- droit, l'application part en standard et garde le choix HD pour l'abonnement.
--
-- `is_paid = 1` : en régime TRIAL, rules.js ouvre tout pendant l'essai, HD
-- comprise ; ensuite, seuls les plans qui la listent la rouvrent. Une ligne
-- absente du catalogue serait lue comme ouverte par l'application
-- (`features[code] ?? true`) : la HD serait offerte à tous.

INSERT IGNORE INTO feature (code, name_i18n, description_i18n, is_paid, is_available, sort_order) VALUES
  ('video_hd',
   JSON_OBJECT('fr', 'Appels vidéo HD', 'en', 'HD video calls', 'zh', '高清视频通话'),
   JSON_OBJECT('fr', 'Appels vidéo en haute définition (720p) quand la connexion le permet',
               'en', 'High-definition (720p) video calls when the connection allows',
               'zh', '网络允许时进行高清（720p）视频通话'),
   1, 1, 90);

INSERT IGNORE INTO plan_feature (plan_id, feature_code)
  SELECT p.id, 'video_hd' FROM plan p
   WHERE p.code IN ('plus_mensuel', 'plus_annuel');
