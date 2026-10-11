/**
 * Interrupteurs de lancement des stickers : lecture en cache court, décision
 * « les stickers sont-ils ouverts ? ».
 *
 * Une seule ligne (`sticker_settings`, id = 1, migration 097). La valeur est lue
 * à chaque envoi de sticker et à chaque appel de `/api/stickers/*`, et ne change
 * qu'à la bascule du lancement. Un seul interrupteur décide de l'ouverture :
 * `enabled`. Les colonnes `cohort_ids` et `cohort_percent` de la migration sont
 * conservées mais inertes.
 *
 * ── Une base incomplète n'ouvre rien, mais ne fige pas une panne ──
 *
 * Table absente (migration non jouée) ou ligne absente : FERMÉ. C'est
 * l'interrupteur de la fonctionnalité elle-même qui retombe sur « éteint » —
 * à ne pas confondre avec le verrou Plus (`stickerMessage`), qui, lui, ne
 * ferme jamais faute de calcul.
 *
 * Lecture en ÉCHEC (base injoignable, driver en erreur) : `getStickerSettings`
 * LÈVE `StickerSettingsInaccessibles`. L'appelant choisit :
 *   - les routes `/api/stickers/*` (`requireStickers`) ferment (404 générique) ;
 *   - l'envoi d'un sticker (`stickerMessage`) répond 503 RETRYABLE — jamais
 *     un `STICKER_*` terminal qui ferait marquer la bulle en échec définitif
 *     alors que la base peut revenir dans la seconde qui suit.
 *
 * L'échec n'est PAS mis en cache (contrairement au repli « ligne absente ») :
 * un cache de 30 s transformerait une panne transitoire en « stickers
 * fermés », et une base qui revient serait ignorée pendant toute la fenêtre.
 *
 * Le cache vit dans le processus : une bascule est visible des autres
 * instances au plus tard 30 secondes après. Il n'y a rien à reprendre au
 * redémarrage de pm2 : la valeur est relue.
 */

const pool = require('../config/db');

const TTL_MS = 30_000;

let _cache = null;

/** Valeurs de la migration 097 : tout fermé. */
const DEFAULTS = Object.freeze({
  id: 1,
  enabled: 0,
  creation_enabled: 0,
  animated_enabled: 0,
  min_app_version: null,
  updated_at: null,
});

/**
 * Réglages illisibles : base injoignable, table absente (migration non jouée),
 * driver en erreur. Distinct du repli « ligne absente », qui, lui, est une
 * valeur lue et connue (FERMÉ). L'appelant décide : 404 sur les routes,
 * 503 retryable à l'envoi.
 */
class StickerSettingsInaccessibles extends Error {
  constructor(cause) {
    super('Réglages des stickers illisibles');
    this.name = 'StickerSettingsInaccessibles';
    this.code = cause?.code || 'STICKER_SETTINGS_UNREADABLE';
  }
}

/**
 * Stickers ouverts ? Un seul interrupteur : `enabled`. Les valeurs par défaut
 * (migration non jouée, ligne absente) retombent sur `0` : FERMÉ. Fonction
 * pure, testée sans base.
 */
function stickersOuverts(settings) {
  return Number(settings?.enabled) === 1;
}

/**
 * La CRÉATION (V1b) est-elle ouverte ? Deux interrupteurs, jamais un seul :
 * `enabled` ferme tout, `creation_enabled` ne fait qu'ajouter la création.
 * Fonction pure, testée sans base.
 */
function creationOuverte(settings) {
  return stickersOuverts(settings) && Number(settings?.creation_enabled) === 1;
}

/**
 * Les stickers ANIMÉS (V1c) sont-ils ouverts ? `animated_enabled` s'ajoute à
 * `enabled` (jamais seul) : fermé, les animés sont omis des lectures, leur envoi
 * répond `STICKER_NOT_FOUND`, leur création `NOT_FOUND`. Fonction pure.
 */
function animesOuverts(settings) {
  return stickersOuverts(settings) && Number(settings?.animated_enabled) === 1;
}

/**
 * La CRÉATION animée est-elle ouverte ? Les trois interrupteurs, jamais moins :
 * `enabled`, `creation_enabled` ET `animated_enabled`. Fonction pure.
 */
function creationAnimeeOuverte(settings) {
  return creationOuverte(settings) && animesOuverts(settings);
}

/**
 * Réglage global, en cache 30 s par instance.
 *
 * @throws {StickerSettingsInaccessibles} lecture en échec — rien n'est mis en
 *         cache, l'appelant décide de la posture (routes : fermer ; envoi :
 *         retryable)
 * @returns {Promise<object>}
 */
async function getStickerSettings() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value;

  let row = null;
  try {
    const [rows] = await pool.execute('SELECT * FROM sticker_settings WHERE id = 1');
    row = rows[0] || null;
  } catch (error) {
    console.warn('[stickerSettings] lecture impossible :', error.code || error.message);
    throw new StickerSettingsInaccessibles(error);
  }

  const value = row ? { ...DEFAULTS, ...row } : { ...DEFAULTS };
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateStickerSettings() {
  _cache = null;
}

/** Les stickers sont-ils ouverts (V1a) ? */
async function peutUtiliserStickers() {
  return stickersOuverts(await getStickerSettings());
}

/** La création de stickers est-elle ouverte (V1b) ? */
async function peutCreerStickers() {
  return creationOuverte(await getStickerSettings());
}

/** Les stickers animés sont-ils ouverts (V1c) ? */
async function peutLireAnimes() {
  return animesOuverts(await getStickerSettings());
}

/** La création de stickers animés est-elle ouverte (V1c) ? */
async function peutCreerAnimes() {
  return creationAnimeeOuverte(await getStickerSettings());
}

module.exports = {
  DEFAULTS,
  StickerSettingsInaccessibles,
  stickersOuverts,
  creationOuverte,
  animesOuverts,
  creationAnimeeOuverte,
  peutLireAnimes,
  peutCreerAnimes,
  getStickerSettings,
  invalidateStickerSettings,
  peutUtiliserStickers,
  peutCreerStickers,
};
