/**
 * Politique de rétention des fichiers média envoyés en message.
 *
 * Ce que ça borne : le stockage Backblaze du SERVEUR, pas la copie locale sur
 * le téléphone. Une fois le fichier purgé côté serveur, la ligne
 * `message` reste intacte (le message n'est jamais supprimé) — seule
 * `mediaUrl` est vidée, exactement comme le fait déjà la consommation d'un
 * média « vue unique » (`messageController.js`, `markMessageViewed`). Un
 * appareil qui avait déjà téléchargé le fichier avant la purge garde sa copie
 * locale sans limite de durée : voir `chat_dao.dart` côté client.
 *
 * Réglage : variable d'environnement, comme TRIP_POINTS_RETENTION_H.
 */

const readInt = (name, defaultValue, { min, max }) => {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return defaultValue;
  return Math.min(max, Math.max(min, n));
};

const RETENTION = {
  // Tous types de médias confondus (image, vidéo, audio, fichier) : l'objectif
  // est de borner le stockage du serveur, pas seulement ce qu'affiche
  // « Mes médias » (qui, lui, ne montre que images/vidéos).
  //
  // ⚠ VALEUR TEMPORAIRE — 365 jours depuis le 25/08/2026, au lieu des 30 jours
  // de la politique réelle.
  //
  // Pourquoi : la mise en service du stockage partitionné doit pouvoir être
  // vérifiée de bout en bout — écriture dans la tranche du jour, relais de
  // lecture des anciennes adresses, journal des balayages — SANS que la
  // première exécution supprime quoi que ce soit. Les médias présents sur le
  // serveur s'étalent de mai à juillet 2026 : à 30 jours, la quasi-totalité
  // serait effacée au premier rattrapage. On ne fait pas d'une suppression de
  // masse le test inaugural d'un système de suppression.
  //
  // À 365 jours, aucune partition n'est échue, donc rien ne tombe, et les deux
  // purges (référentielle et par partitions) sont neutralisées de la même
  // façon.
  //
  // Pour revenir à la politique réelle : remettre 30 ci-dessous, ou poser
  // MEDIA_RETENTION_DAYS=30 dans le `.env` — ce qui a l'avantage de ne pas
  // demander de redéploiement. La valeur est aussi surchargeable depuis
  // l'espace super-admin des purges (réglage « Rétention des médias »).
  mediaDays: readInt('MEDIA_RETENTION_DAYS', 365, { min: 1, max: 365 }),

  // Durée longue, celle d'Alanya Plus. Un média la garde tant qu'au moins une
  // personne de sa discussion (expéditeur compris) y a droit — voir
  // `mediaRetentionCovered` dans billing/rules.js. Hors phase payante, elle
  // ne s'applique à personne.
  //
  // Plafonnée à 365 : la règle de cycle de vie du bucket, filet de sécurité,
  // masque les objets de `media/` à 366 jours. Une durée plus longue ici
  // serait démentie par Backblaze sans que personne ne le voie.
  plusDays: readInt('MEDIA_PLUS_RETENTION_DAYS', 365, { min: 1, max: 365 }),

  // Au-delà de ce nombre de fichiers en une nuit, la purge automatique
  // s'arrête et attend qu'un super-admin la lance à la main. Le seuil réel
  // est le plus grand de cette valeur et de trois fois la moyenne des
  // dernières nuits : il suit la croissance de l'application.
  alertFloor: readInt('MEDIA_PURGE_ALERT_FLOOR', 1000, { min: 1, max: 1_000_000 }),
};

/**
 * Préfixes de stockage que la purge « média de conversation » ne vise JAMAIS
 * (plan stickers §9) :
 *  - `official/` : médias officiels (accueil, diffusion, stickers officiels),
 *    partagés par des milliers de messages ;
 *  - `stickers/` : stickers personnels. Un sticker envoyé reste servi, même
 *    après des années ; c'est la suppression du plan §4 qui s'applique
 *    (suppression par l'auteur, du compte, ou retrait admin), jamais l'âge.
 * La purge ne vise que `/uploads/media/` (`expiredMediaWhere`) ; cette liste
 * le DÉCLARE pour l'écran des purges et pour les tests.
 */
const PREFIXES_JAMAIS_PURGES = Object.freeze(['official/', 'stickers/']);

module.exports = { RETENTION, PREFIXES_JAMAIS_PURGES };
