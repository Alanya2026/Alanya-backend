/**
 * Routes utilisateur des PACKS personnels (V1b : T4d « packs perso » et T6
 * « partage ») — contrat §4b, plan §6.1.
 *
 * La garde `requireStickerCreation` (posée par les routes) a déjà vérifié les
 * deux interrupteurs. Ici on valide la FORME de la requête, on appelle
 * `services/stickerPackService` (qui décide : propriétaire, quotas, copie) et on
 * met la réponse en forme. Le client ne fournit jamais d'URL : les adresses
 * des fichiers sont recalculées depuis les clés de stockage.
 *
 * Erreurs : un `code` + un statut portés par l'exception du service sont
 * renvoyés tels quels ; toute autre exception est un 500 neutre.
 *
 * Toute mutation émet `stickers:sync` (`reason: "packs"`).
 */

const persist = require('../services/stickerPackService');
const { MAX_STICKERS_PACK } = require('../services/stickerPersonalService');
const { emitStickersSync } = require('../services/stickerSync');
const { publicUrl } = require('../services/mediaStorage');
const { langueDeRequete } = require('./stickerController');
const { presentMesPacks, presentPartage } = require('../utils/stickerPresenter');
const { fail, failInternal } = require('../utils/apiError');

const repondreErreur = (res, e, contexte) => {
  if (e && typeof e.code === 'string' && Number.isInteger(e.status)) {
    return fail(res, e.status, e.code, e.message);
  }
  console.error(`[stickers] ${contexte}`, e);
  return failInternal(res);
};

const syncPacks = (req, alanyaID) => {
  try {
    emitStickersSync(req.app.get('io'), alanyaID, 'packs');
  } catch (e) {
    console.warn('[stickers] sync non émis :', e.code || e.message);
  }
};

const entierPositif = (v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const objetSimple = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** GET /api/stickers/me/created — mes packs perso, stickers compris. */
async function getMesPacks(req, res) {
  try {
    const [lang, { packs, stickers }] = await Promise.all([
      langueDeRequete(req),
      persist.listerMesPacks(req.user.alanyaID),
    ]);
    res.set('Cache-Control', 'private, no-store');
    return res.json(presentMesPacks({ packs, stickers, lang, urlDe: publicUrl }));
  } catch (e) {
    return repondreErreur(res, e, 'getMesPacks');
  }
}

/**
 * PATCH /api/stickers/packs/:id — corps `{ nameI18n? | name?, coverStickerId? }`.
 * `nameI18n` : `{fr?, en?, zh?}` ; `name` : chaîne (= français) ;
 * `coverStickerId` : un sticker de CE pack, ou `null`.
 */
async function patchPack(req, res) {
  try {
    const corps = req.body;
    if (!objetSimple(corps)) {
      return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'Corps JSON attendu');
    }
    const patch = {};
    if (corps.nameI18n !== undefined) {
      if (!objetSimple(corps.nameI18n)) {
        return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'nameI18n : objet {fr, en, zh}');
      }
      patch.nameI18n = corps.nameI18n;
    }
    if (corps.name !== undefined) {
      if (typeof corps.name !== 'string') {
        return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'name : chaîne');
      }
      patch.name = corps.name;
    }
    if (corps.coverStickerId !== undefined) {
      if (corps.coverStickerId !== null && !entierPositif(corps.coverStickerId)) {
        return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'coverStickerId : identifiant ou null');
      }
      patch.coverStickerId = corps.coverStickerId;
    }
    await persist.modifierPack(req.user.alanyaID, req.params.id, patch);
    syncPacks(req, req.user.alanyaID);
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'patchPack');
  }
}

/** DELETE /api/stickers/packs/:id — archive le pack (propriétaire seul), idempotent. */
async function deletePack(req, res) {
  try {
    await persist.archiverPack(req.user.alanyaID, req.params.id);
    syncPacks(req, req.user.alanyaID);
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'deletePack');
  }
}

/** PUT /api/stickers/packs/:id/order — corps `{ ids: [stickerId…] }`. */
async function putPackOrder(req, res) {
  try {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > MAX_STICKERS_PACK || !ids.every(entierPositif)) {
      return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'ids : liste d\'identifiants de stickers');
    }
    await persist.ordonnerStickers(req.user.alanyaID, req.params.id, ids);
    syncPacks(req, req.user.alanyaID);
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'putPackOrder');
  }
}

/**
 * POST /api/stickers/packs/:id/stickers — corps `{ assetId, emoji?, nom? }` :
 * ajoute à ce pack un actif que je possède déjà (aucune copie de fichier).
 */
async function postPackSticker(req, res) {
  try {
    const corps = req.body;
    if (!objetSimple(corps) || !entierPositif(corps.assetId)) {
      return fail(res, 400, 'STICKER_INVALID_PAYLOAD', 'assetId : identifiant d\'un de mes stickers');
    }
    const r = await persist.ajouterStickerAuPack(req.user.alanyaID, req.params.id, {
      assetId: corps.assetId,
      emoji: typeof corps.emoji === 'string' ? corps.emoji : null,
      nom: typeof corps.nom === 'string' ? corps.nom : null,
    });
    syncPacks(req, req.user.alanyaID);
    return res.status(201).json({ stickerId: r.stickerId, packId: r.packId, assetId: r.assetId });
  } catch (e) {
    return repondreErreur(res, e, 'postPackSticker');
  }
}

/** DELETE /api/stickers/packs/:id/stickers/:stickerId — retire du pack (règle §4). */
async function deletePackSticker(req, res) {
  try {
    await persist.retirerStickerDuPack(req.user.alanyaID, req.params.id, req.params.stickerId);
    syncPacks(req, req.user.alanyaID);
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'deletePackSticker');
  }
}

/** POST /api/stickers/packs/:id/share — crée (ou rend) le jeton : `{ token }`. */
async function postShare(req, res) {
  try {
    const r = await persist.partagerPack(req.user.alanyaID, req.params.id);
    syncPacks(req, req.user.alanyaID);
    return res.status(r.cree ? 201 : 200).json({ token: r.token });
  } catch (e) {
    return repondreErreur(res, e, 'postShare');
  }
}

/** DELETE /api/stickers/packs/:id/share — révoque le lien, idempotent. */
async function deleteShare(req, res) {
  try {
    await persist.revoquerPartage(req.user.alanyaID, req.params.id);
    syncPacks(req, req.user.alanyaID);
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'deleteShare');
  }
}

/** GET /api/stickers/share/:token — fiche en lecture seule d'un pack partagé. */
async function getShare(req, res) {
  try {
    const [lang, r] = await Promise.all([
      langueDeRequete(req),
      persist.resoudrePartage(req.user.alanyaID, req.params.token),
    ]);
    res.set('Cache-Control', 'private, no-store');
    return res.json(presentPartage({ ...r, lang, urlDe: publicUrl }));
  } catch (e) {
    return repondreErreur(res, e, 'getShare');
  }
}

/**
 * POST /api/stickers/share/:token/add — installe le pack partagé chez moi
 * (copie). `201` à la création ; `200` si rien de nouveau (déjà installé, ou
 * c'est mon propre pack).
 */
async function postShareAdd(req, res) {
  try {
    const r = await persist.ajouterPackPartage(req.user.alanyaID, req.params.token);
    if (r.deja) return res.status(200).json({ packId: r.packId, deja: true, mine: Boolean(r.mine) });
    syncPacks(req, req.user.alanyaID);
    return res.status(201).json({
      packId: r.packId, code: r.code, deja: false, stickers: r.stickers, ignores: r.ignores,
    });
  } catch (e) {
    return repondreErreur(res, e, 'postShareAdd');
  }
}

module.exports = {
  getMesPacks,
  patchPack,
  deletePack,
  putPackOrder,
  postPackSticker,
  deletePackSticker,
  postShare,
  deleteShare,
  getShare,
  postShareAdd,
};
