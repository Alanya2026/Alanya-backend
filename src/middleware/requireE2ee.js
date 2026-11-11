const { fail } = require('../utils/apiError');
const { peutPublier } = require('../services/e2eeSettingsService');
const { appareilPublie } = require('../services/e2eeKeyService');

/**
 * Garde des routes `/api/e2ee/*` : le compte doit être dans la cohorte, et le
 * premier cran de l'interrupteur ouvert (migration 094).
 *
 * Refus en 404 `E2EE_INACTIF`. 404 et non 403 : pour l'application, le
 * chiffrement n'existe simplement pas encore pour ce compte — elle ne publie
 * rien et continue en clair, sans afficher d'erreur ni réessayer en boucle.
 *
 * Un appareil qui a DÉJÀ publié passe toujours, même si l'on referme le
 * premier cran ou qu'on retire son compte de la cohorte : ses conversations
 * déjà chiffrées le restent, et il doit pouvoir continuer d'y écrire
 * (paquets, liste des appareils) et de regarnir son stock. Refermer arrête
 * l'arrivée de NOUVEAUX appareils, pas le fonctionnement des existants.
 */
async function requireE2ee(req, res, next) {
  if (await peutPublier(req.user.alanyaID)) return next();
  if (await appareilPublie(req.user.appareilId)) return next();
  return fail(res, 404, 'E2EE_INACTIF', 'Chiffrement de bout en bout non disponible pour ce compte');
}

module.exports = requireE2ee;
