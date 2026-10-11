/**
 * Routes utilisateur des stickers (V1a) — `/api/stickers/*`, contrat §4.
 *
 * Les décisions de droit sont prises ICI, côté serveur : le client ne fait que
 * refléter. Verrou Plus : seul un « non » explicite des droits ferme (voir
 * `utils/stickerMessage`) ; droits indisponibles = ouvert.
 */

const crypto = require('crypto');
const pool = require('../config/db');
const { fail, failInternal } = require('../utils/apiError');
const store = require('../services/stickerStore');
const {
  getStickerSettings, creationOuverte, animesOuverts,
} = require('../services/stickerSettingsService');
const { emitStickersSync } = require('../services/stickerSync');
const { entitlementsOrNull } = require('../services/billing/entitlements');
const { publicUrl } = require('../services/mediaStorage');
const { langueDe, langueDeEntete } = require('../utils/stickerI18n');
const { presentCatalog, presentPack, presentMe } = require('../utils/stickerPresenter');
const { FEATURE_PREMIUM, PACK_STATUS } = require('../utils/stickerMessage');

/** Langue du lecteur : `Accept-Language`, sinon la locale de son profil. */
async function langueDeRequete(req) {
  const entete = langueDeEntete(req.headers['accept-language']);
  if (entete) return entete;
  try {
    const [rows] = await pool.execute(
      'SELECT locale FROM user_settings WHERE alanyaID = ? LIMIT 1',
      [req.user.alanyaID],
    );
    return langueDe(rows[0]?.locale) || 'fr';
  } catch (_) {
    return 'fr';
  }
}

/** Le compte n'a-t-il PAS le droit Plus des stickers ? Droits illisibles : non. */
async function sansDroitPlus(alanyaID) {
  const droits = await entitlementsOrNull(alanyaID);
  return Boolean(droits && droits.features && droits.features[FEATURE_PREMIUM] === false);
}

/**
 * Réglages lus une fois pour la requête (cache 30 s). Illisibles : tout fermé
 * (`{}`) — ces routes ne révèlent rien et n'accusent pas réception.
 */
async function reglagesDeRequete() {
  try {
    return await getStickerSettings();
  } catch (_) {
    return {};
  }
}

/** Les stickers animés sont-ils ouverts pour cette requête (V1c) ? Illisible : non. */
async function animesOuvertsPourRequete() {
  return animesOuverts(await reglagesDeRequete());
}

const idPositif = (raw) => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * Un pack officiel n'est disponible que PUBLIÉ (A14). Archivé, il est
 * « indisponible » partout (lecture, installation, envoi, copie), installé ou
 * non ; brouillon, jamais. Ses anciens messages restent affichés côté app
 * (`mediaUrl` recopiée, fichier conservé) : rien ici ne les touche.
 */
const packVisible = (p) => Number(p.status) === PACK_STATUS.PUBLIE;

const refuseServeur = (res, tag, e) => {
  console.error(`[stickers] ${tag}`, e);
  return failInternal(res);
};

async function getCatalog(req, res) {
  try {
    const animes = await animesOuvertsPourRequete();
    const [lang, verrouille, { packs, version }] = await Promise.all([
      langueDeRequete(req),
      sansDroitPlus(req.user.alanyaID),
      store.listeCatalogue(undefined, { animes }),
    ]);
    const corps = presentCatalog({ packs, version, lang, urlDe: publicUrl, verrouille });
    // L'ETag couvre tout ce qui varie pour CE lecteur : langue et verrous
    // compris. `since` n'est pas nécessaire à la validation : un client qui le
    // rejoue sans `If-None-Match` reçoit simplement le corps.
    const etag = `W/"${crypto.createHash('sha1').update(JSON.stringify(corps)).digest('hex')}"`;
    res.set('ETag', etag);
    res.set('Cache-Control', 'private, no-cache');
    res.set('Vary', 'Authorization, Accept-Language');
    if (req.headers['if-none-match'] === etag) return res.status(304).end();
    return res.json(corps);
  } catch (e) {
    return refuseServeur(res, 'catalog', e);
  }
}

async function getPack(req, res) {
  try {
    const pack = await store.chargePackParCode(req.params.code, req.user.alanyaID);
    if (!pack || !packVisible(pack)) {
      return fail(res, 404, 'STICKER_PACK_UNAVAILABLE', 'Pack de stickers indisponible');
    }
    const animes = await animesOuvertsPourRequete();
    const [lang, verrouille, stickers] = await Promise.all([
      langueDeRequete(req),
      sansDroitPlus(req.user.alanyaID),
      store.listeStickersDuPack(pack.id),
    ]);
    res.set('Vary', 'Authorization, Accept-Language');
    // Animés fermés : omis ici, dans le présentateur (V1c, contrat §4c).
    return res.json(presentPack({ pack, stickers, lang, urlDe: publicUrl, verrouille, animes }));
  } catch (e) {
    return refuseServeur(res, 'pack', e);
  }
}

async function getMe(req, res) {
  try {
    const reglages = await reglagesDeRequete();
    const animes = animesOuverts(reglages);
    const moi = await store.chargeMoi(req.user.alanyaID, undefined, { animes });
    // `features` (V1c, additif) : ce que le serveur ouvre pour ce compte. L'app s'y
    // fie pour montrer la création et l'animé ; absent = faux.
    return res.json(presentMe({
      ...moi,
      features: { creation: creationOuverte(reglages), animated: animes },
    }));
  } catch (e) {
    return refuseServeur(res, 'me', e);
  }
}

async function putMyPack(req, res) {
  try {
    const id = idPositif(req.params.id);
    const alanyaID = req.user.alanyaID;
    const pack = id && await store.chargePackParId(id, alanyaID);
    if (!pack || !packVisible(pack)) {
      return fail(res, 404, 'STICKER_PACK_UNAVAILABLE', 'Pack de stickers indisponible');
    }
    if (Number(pack.installed) === 1) return res.status(204).end(); // idempotent

    if (Number(pack.is_premium) === 1 && await sansDroitPlus(alanyaID)) {
      return fail(res, 403, 'SUBSCRIPTION_REQUIRED', 'Pack réservé à Alanya Plus', {
        feature: FEATURE_PREMIUM,
      });
    }
    if (await store.compteInstalles(alanyaID) >= store.MAX_PACKS_INSTALLES) {
      return fail(res, 409, 'STICKER_PACK_LIMIT', 'Limite de packs installés atteinte');
    }
    await store.installerPack(alanyaID, id);
    emitStickersSync(req.app.get('io'), alanyaID, 'packs');
    return res.status(204).end();
  } catch (e) {
    return refuseServeur(res, 'install', e);
  }
}

async function deleteMyPack(req, res) {
  try {
    const id = idPositif(req.params.id);
    if (!id) return fail(res, 404, 'STICKER_PACK_UNAVAILABLE', 'Pack de stickers indisponible');
    await store.retirerPack(req.user.alanyaID, id);
    emitStickersSync(req.app.get('io'), req.user.alanyaID, 'packs');
    return res.status(204).end();
  } catch (e) {
    return refuseServeur(res, 'retrait', e);
  }
}

async function putPacksOrder(req, res) {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > store.MAX_PACKS_INSTALLES
      || !ids.every((n) => idPositif(n) !== null && typeof n === 'number')) {
      return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'ids : liste d\'identifiants de packs');
    }
    await store.ordonnerPacks(req.user.alanyaID, ids);
    emitStickersSync(req.app.get('io'), req.user.alanyaID, 'packs');
    return res.status(204).end();
  } catch (e) {
    return refuseServeur(res, 'ordre', e);
  }
}

async function putFavorite(req, res) {
  try {
    const id = idPositif(req.params.stickerId);
    const s = id && await store.chargeStickerFavorisable(id);
    if (!s) return fail(res, 404, 'STICKER_NOT_FOUND', 'Sticker introuvable');
    await store.ajouterFavori(req.user.alanyaID, id);
    emitStickersSync(req.app.get('io'), req.user.alanyaID, 'favorites');
    return res.status(204).end();
  } catch (e) {
    return refuseServeur(res, 'favori', e);
  }
}

async function deleteFavorite(req, res) {
  try {
    const id = idPositif(req.params.stickerId);
    if (!id) return fail(res, 404, 'STICKER_NOT_FOUND', 'Sticker introuvable');
    await store.retirerFavori(req.user.alanyaID, id);
    emitStickersSync(req.app.get('io'), req.user.alanyaID, 'favorites');
    return res.status(204).end();
  } catch (e) {
    return refuseServeur(res, 'favori', e);
  }
}

module.exports = {
  langueDeRequete,
  animesOuvertsPourRequete,
  getCatalog,
  getPack,
  getMe,
  putMyPack,
  deleteMyPack,
  putPacksOrder,
  putFavorite,
  deleteFavorite,
};
