/**
 * Routes utilisateur de CRÉATION de stickers (V1b) — contrat §4, plan §6.1.
 *
 * La garde `requireStickerCreation` (posée par les routes) a déjà vérifié les
 * deux interrupteurs (`enabled` ET `creation_enabled`). Ici, on traduit la
 * requête en appel de `services/stickerPersonalService` et on met la réponse en
 * forme.
 *
 * Les erreurs du service (`StickerPersonalError`) et du pipeline d'image
 * (`StickerAssetError`) portent TOUTES un `code` de contrat et un statut HTTP :
 * on les renvoie tels quels, jamais un 500. Toute autre exception reste une
 * erreur serveur neutre (le message du driver ne franchit pas la frontière).
 *
 * Toute mutation émet `stickers:sync` (`reason: "packs"`) : les autres appareils
 * du compte relisent `GET /me` et le pack perso concerné (contrat §6).
 */

const persist = require('../services/stickerPersonalService');
const { emitStickersSync } = require('../services/stickerSync');
const { fail, failInternal } = require('../utils/apiError');

/** Codes du service, tous porteurs d'un statut HTTP de contrat. */
const repondreErreur = (res, e, contexte) => {
  if (e && typeof e.code === 'string' && Number.isInteger(e.status)) {
    return fail(res, e.status, e.code, e.message, e.feature ? { feature: e.feature } : undefined);
  }
  console.error(`[stickers] ${contexte}`, e);
  return failInternal(res);
};

/** `packId` de corps (multipart ou JSON) : brut, le service tranche la validité. */
const packIdDe = (valeur) => (valeur == null || valeur === '' ? null : valeur);

/** Après une mutation, réveille les autres appareils du compte. */
const syncPacks = (req, alanyaID) => {
  try {
    emitStickersSync(req.app.get('io'), alanyaID, 'packs');
  } catch (e) {
    // Le temps réel n'est pas le contrat : une émission manquée ne fait pas
    // échouer l'écriture, l'appareil relira à sa prochaine ouverture.
    console.warn('[stickers] sync non émis :', e.code || e.message);
  }
};

/**
 * POST /api/stickers/assets — dépose un sticker perso.
 *
 * Champ `file` (un seul PNG/WebP 512×512, ≤ 1 Mo) ; options `packId`, `emoji`,
 * `nom`. Sans `packId`, le pack perso par défaut (créé au besoin).
 */
async function postAsset(req, res) {
  try {
    if (!Buffer.isBuffer(req.file?.buffer) || req.file.buffer.length === 0) {
      return fail(res, 422, 'STICKER_ASSET_INVALID', 'Fichier PNG ou WebP 512×512 requis');
    }
    const r = await persist.creerStickerPerso({
      buffer: req.file.buffer,
      alanyaID: req.user.alanyaID,
      packId: packIdDe(req.body?.packId),
      emoji: req.body?.emoji ?? null,
      nom: req.body?.nom ?? null,
    });
    syncPacks(req, req.user.alanyaID);
    return res.status(201).json({
      assetId: r.assetId,
      stickerId: r.stickerId,
      packId: r.packId,
      reutilise: r.reutilise,
    });
  } catch (e) {
    return repondreErreur(res, e, 'postAsset');
  }
}

/**
 * DELETE /api/stickers/assets/:id — supprime un actif personnel (ses stickers,
 * favoris et signalements), puis ses fichiers. `404` si l'actif n'est pas au
 * demandeur : la propriété est vérifiée côté serveur.
 */
async function deleteAsset(req, res) {
  try {
    await persist.supprimerAssetPerso(req.user.alanyaID, req.params.id);
    syncPacks(req, req.user.alanyaID);
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'deleteAsset');
  }
}

/**
 * POST /api/stickers/assets/:id/copy — copie un sticker REÇU dans mon espace :
 * nouveau propriétaire, fichier copié côté stockage. Sert au « ajouter aux
 * miens » depuis une conversation. Route legacy (par `assetId`, séquentiel donc
 * devinable) : l'actif doit m'appartenir ou m'être accessible comme un sticker
 * reçu ; sinon `404 STICKER_NOT_FOUND` uniforme.
 */
async function postAssetCopy(req, res) {
  try {
    const r = await persist.copierAssetRecu({
      alanyaID: req.user.alanyaID,
      assetId: req.params.id,
      packId: packIdDe(req.body?.packId),
      emoji: req.body?.emoji ?? null,
      nom: req.body?.nom ?? null,
    });
    syncPacks(req, req.user.alanyaID);
    return res.status(201).json({
      assetId: r.assetId,
      stickerId: r.stickerId,
      packId: r.packId,
      reutilise: r.reutilise,
      copie: r.copie,
    });
  } catch (e) {
    return repondreErreur(res, e, 'postAssetCopy');
  }
}

/**
 * POST /api/stickers/report — signale un sticker via sa fiche. Idempotent pour
 * un même rapporteur et un même actif : rappeler ne crée pas de doublon.
 * Même règle d'accès que `assets/:id/copy` (404 uniforme sinon).
 * Corps : `{ assetId, reason }` (`inapproprie|spam|droits|autre`).
 */
async function postReport(req, res) {
  try {
    const r = await persist.signalerAssetRecu({
      alanyaID: req.user.alanyaID,
      assetId: req.body?.assetId,
      reason: req.body?.reason,
    });
    return res.json({ ok: true, deja: r.deja });
  } catch (e) {
    return repondreErreur(res, e, 'postReport');
  }
}

/**
 * POST /api/stickers/stickers/:stickerId/copy — copie un sticker REÇU désigné
 * par son `sid` (jamais d'`assetId` côté application). Mêmes corps et réponse
 * que `assets/:id/copy` ; `emoji` par défaut = celui du sticker.
 */
async function postStickerCopy(req, res) {
  try {
    const r = await persist.copierStickerRecu({
      alanyaID: req.user.alanyaID,
      stickerId: req.params.stickerId,
      packId: packIdDe(req.body?.packId),
      emoji: req.body?.emoji ?? null,
      nom: req.body?.nom ?? null,
    });
    syncPacks(req, req.user.alanyaID);
    return res.status(201).json({
      assetId: r.assetId,
      stickerId: r.stickerId,
      packId: r.packId,
      reutilise: r.reutilise,
      copie: r.copie,
    });
  } catch (e) {
    return repondreErreur(res, e, 'postStickerCopy');
  }
}

/**
 * POST /api/stickers/stickers/:stickerId/report — signale un sticker REÇU par
 * son `sid`. Corps : `{ reason }`. Même réponse et même idempotence que `/report`.
 */
async function postStickerReport(req, res) {
  try {
    const r = await persist.signalerStickerRecu({
      alanyaID: req.user.alanyaID,
      stickerId: req.params.stickerId,
      reason: req.body?.reason,
    });
    return res.json({ ok: true, deja: r.deja });
  } catch (e) {
    return repondreErreur(res, e, 'postStickerReport');
  }
}

/**
 * POST /api/stickers/packs — crée un pack perso vide (privé, publié d'emblée :
 * aucun back-office n'intervient). Plafonné à `MAX_PACKS_PERSO` par compte.
 */
async function postPack(req, res) {
  try {
    const r = await persist.creerPackPerso(req.user.alanyaID);
    return res.status(201).json({ id: r.id, code: r.code });
  } catch (e) {
    return repondreErreur(res, e, 'postPack');
  }
}

module.exports = {
  postAsset,
  deleteAsset,
  postAssetCopy,
  postReport,
  postStickerCopy,
  postStickerReport,
  postPack,
};
