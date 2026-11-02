-- Migration 113 : le répondeur entre dans les plans Alanya Plus
--
-- Appliquer après 112. Application MANUELLE, réexécutable sans erreur
-- (INSERT IGNORE).
--
-- Le répondeur est passé payant depuis le back-office le 03/10/2026
-- (admin_audit n° 64), sans être ajouté aux plans : le bouton « payant » ne
-- touche pas au contenu des plans. En régime essai, cela voulait dire qu'après
-- l'essai même un abonné l'aurait perdu.
--
-- Régime essai : ouvert à tous pendant l'essai, puis réservé aux comptes qui
-- ont payé (code d'activation ou paiement). Le serveur le garde à l'allumage
-- (PATCH /auth/voicemail-schedule) et à l'interception des appels ; éteindre
-- reste toujours permis, et le réglage est conservé pour l'abonnement.

INSERT IGNORE INTO plan_feature (plan_id, feature_code)
  SELECT p.id, 'voicemail' FROM plan p
   WHERE p.code IN ('plus_mensuel', 'plus_annuel');
