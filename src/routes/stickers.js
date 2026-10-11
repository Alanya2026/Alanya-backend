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
const { uploadSticker, handleMulterError } = require('../middleware/upload');
const c = require('../controllers/stickerController');
const perso = require('../controllers/stickerPersonalController');

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
 * /api/stickers/packs:
 *   post:
 *     summary: Crée un pack perso privé (V1b)
 *     tags: [Stickers]
 *     security: [{ bearerAuth: [] }]
 */
router.post('/packs', requireStickerCreation, perso.postPack);

module.exports = router;
