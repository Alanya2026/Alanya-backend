const { fail } = require('../utils/apiError');
const { peutCreerStickers } = require('../services/stickerSettingsService');

/**
 * Garde des routes de CRÉATION de stickers (V1b) : `enabled` ET
 * `creation_enabled` (migration 097).
 *
 * Fermé, ou création non ouverte : 404 `NOT_FOUND` générique, comme
 * `requireStickers` — rien n'est révélé, la fonctionnalité n'existe pas pour ce
 * client. Même posture sur lecture en échec : fermer un 404 n'accuse pas de
 * réception, contrairement à l'envoi (503 retryable).
 *
 * À poser APRÈS `requireStickers` (la liste des routes `/api/stickers/*` est
 * déjà derrière) : cette garde n'ajoute que le second interrupteur.
 */
async function requireStickerCreation(req, res, next) {
  try {
    if (await peutCreerStickers()) return next();
  } catch (e) {
    console.warn('[stickers] réglages illisibles, création fermée :', e.code || e.message);
  }
  return fail(res, 404, 'NOT_FOUND', 'Introuvable');
}

module.exports = requireStickerCreation;
