const { fail } = require('../utils/apiError');
const { peutCreerAnimes } = require('../services/stickerSettingsService');

/**
 * Garde de la CRÉATION de stickers animés (V1c) : `enabled`, `creation_enabled`
 * ET `animated_enabled` (migration 097, colonnes déjà présentes).
 *
 * Fermé, ou réglages illisibles : 404 `NOT_FOUND` générique, comme les gardes
 * voisines — rien n'est révélé, et la garde précède multer et le limiteur : un
 * fichier de 3 Mo n'est même pas lu, et le 404 ne consomme aucun quota.
 *
 * À poser APRÈS `requireStickerCreation`.
 */
async function requireStickerAnimated(req, res, next) {
  try {
    if (await peutCreerAnimes()) return next();
  } catch (e) {
    console.warn('[stickers] réglages illisibles, création animée fermée :', e.code || e.message);
  }
  return fail(res, 404, 'NOT_FOUND', 'Introuvable');
}

module.exports = requireStickerAnimated;
