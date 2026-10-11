// Stickers (type de message 10) — V1a (catalogue officiel) et V1b (création
// personnelle). Contrat : CONTRAT-STICKERS.md §4.
//
// TOUT est derrière `sticker_settings.enabled` (`requireStickers`) : fermé, tout
// répond 404. Les routes de CRÉATION (V1b) ajoutent `requireStickerCreation`
// (`creation_enabled`) : même 404 générique, rien de spécifique n'est révélé.
//
// L'ENVOI n'a pas de route ici : il passe par `message:send` et
// `POST /api/conversations/:id/messages`, via `utils/stickerMessage`.

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireStickers = require('../middleware/requireStickers');
const requireStickerCreation = require('../middleware/requireStickerCreation');
const requireStickerAnimated = require('../middleware/requireStickerAnimated');
const { uploadSticker, uploadStickerAnime, handleMulterError } = require('../middleware/upload');
const c = require('../controllers/stickerController');
const perso = require('../controllers/stickerPersonalController');
const packs = require('../controllers/stickerPackController');
const {
  stickerShareReadLimiter, stickerShareAddLimiter, stickerShareManageLimiter, stickerAnimeLimiter,
} = require('../middleware/rateLimiter');

router.use(auth, requireStickers);

/**
 * @swagger
 * /api/stickers/catalog:
 *   get:
 *     summary: Packs officiels publiés (ETag, 304 si inchangé)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/catalog', c.getCatalog);

/**
 * @swagger
 * /api/stickers/packs/{code}:
 *   get:
 *     summary: Stickers actifs d'un pack, dans l'ordre
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/packs/:code', c.getPack);

/**
 * @swagger
 * /api/stickers/me:
 *   get:
 *     summary: Packs installés et favoris (ids seulement), un seul appel
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/me', c.getMe);

// `order` AVANT `:id` : sinon « order » serait lu comme un identifiant de pack.
router.put('/me/packs/order', c.putPacksOrder);
router.put('/me/packs/:id', c.putMyPack);
router.delete('/me/packs/:id', c.deleteMyPack);
router.put('/me/favorites/:stickerId', c.putFavorite);
router.delete('/me/favorites/:stickerId', c.deleteFavorite);

// ── V1b : création personnelle (plan §6.1) ────────────────────────────────
// Derrière `enabled` ET `creation_enabled` (`requireStickerCreation`), posé
// AVANT multer : création fermée, on ne lit même pas le fichier. Le pipeline
// d'image est celui de l'admin (`uploadSticker`) : PNG/WebP 512×512, ≤ 1 Mo.

/**
 * @swagger
 * /api/stickers/assets:
 *   post:
 *     summary: Dépose un sticker perso (V1b) → {assetId, stickerId}
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post(
  '/assets',
  requireStickerCreation,
  uploadSticker.single('file'),
  handleMulterError,
  perso.postAsset,
);

/**
 * @swagger
 * /api/stickers/assets/animated:
 *   post:
 *     summary: Crée un sticker animé depuis un GIF ou un WebP animé (V1c) → {assetId, stickerId, animated, bytes, frames, durationMs}
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
// V1c : trois interrupteurs (`enabled`, `creation_enabled`, `animated_enabled`),
// puis 10 créations par heure et par compte, puis multer dédié (≤ 3 Mo). Les 404
// « fermé » précèdent le limiteur : ils ne consomment aucun quota et ne lisent
// pas le fichier. La route littérale est posée AVANT `/assets/:id`.
router.post(
  '/assets/animated',
  requireStickerCreation,
  requireStickerAnimated,
  stickerAnimeLimiter,
  uploadStickerAnime.single('file'),
  handleMulterError,
  perso.postAssetAnime,
);

/**
 * @swagger
 * /api/stickers/assets/:id:
 *   delete:
 *     summary: Supprime un sticker perso (propriétaire seul)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.delete('/assets/:id', requireStickerCreation, perso.deleteAsset);

/**
 * @swagger
 * /api/stickers/assets/:id/copy:
 *   post:
 *     summary: Copie un sticker reçu dans mon espace
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/assets/:id/copy', requireStickerCreation, perso.postAssetCopy);

/**
 * @swagger
 * /api/stickers/report:
 *   post:
 *     summary: Signale un sticker (idempotent)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/report', requireStickerCreation, perso.postReport);

/**
 * @swagger
 * /api/stickers/stickers/{stickerId}/copy:
 *   post:
 *     summary: Copie un sticker reçu (par son sid) dans mon espace
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 * /api/stickers/stickers/{stickerId}/report:
 *   post:
 *     summary: Signale un sticker reçu (par son sid), idempotent
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/stickers/:stickerId/copy', requireStickerCreation, perso.postStickerCopy);
router.post('/stickers/:stickerId/report', requireStickerCreation, perso.postStickerReport);

/**
 * @swagger
 * /api/stickers/packs:
 *   post:
 *     summary: Crée un pack perso privé (V1b)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/packs', requireStickerCreation, perso.postPack);

// ── V1b : packs perso et partage (plan §6.1) ─────────────────────────────
// Même garde (`enabled` + `creation_enabled`) ; propriétaire seul côté service.
// Le partage est limité en débit, par compte.

/**
 * @swagger
 * /api/stickers/me/created:
 *   get:
 *     summary: Mes packs perso (stickers compris), un seul appel (V1b)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/me/created', requireStickerCreation, packs.getMesPacks);

/**
 * @swagger
 * /api/stickers/packs/{id}:
 *   patch:
 *     summary: Renomme un pack perso / change sa couverture (propriétaire seul)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 *   delete:
 *     summary: Archive un pack perso (propriétaire seul)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.patch('/packs/:id', requireStickerCreation, packs.patchPack);
router.delete('/packs/:id', requireStickerCreation, packs.deletePack);

/**
 * @swagger
 * /api/stickers/packs/{id}/order:
 *   put:
 *     summary: Réordonne les stickers d'un pack perso
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.put('/packs/:id/order', requireStickerCreation, packs.putPackOrder);

/**
 * @swagger
 * /api/stickers/packs/{id}/stickers:
 *   post:
 *     summary: Ajoute à un pack perso un sticker que je possède déjà
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/packs/:id/stickers', requireStickerCreation, packs.postPackSticker);
router.delete('/packs/:id/stickers/:stickerId', requireStickerCreation, packs.deletePackSticker);

/**
 * @swagger
 * /api/stickers/packs/{id}/share:
 *   post:
 *     summary: Crée le lien de partage d'un pack perso → {token}
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 *   delete:
 *     summary: Révoque le lien de partage
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/packs/:id/share', requireStickerCreation, stickerShareManageLimiter, packs.postShare);
router.delete('/packs/:id/share', requireStickerCreation, stickerShareManageLimiter, packs.deleteShare);

/**
 * @swagger
 * /api/stickers/share/{token}:
 *   get:
 *     summary: Résout un lien de partage (lecture seule)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/share/:token', requireStickerCreation, stickerShareReadLimiter, packs.getShare);

/**
 * @swagger
 * /api/stickers/share/{token}/add:
 *   post:
 *     summary: Installe un pack partagé chez moi (copie des fichiers, quotas)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/share/:token/add', requireStickerCreation, stickerShareAddLimiter, packs.postShareAdd);

module.exports = router;
