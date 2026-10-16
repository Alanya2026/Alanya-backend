/**
 * Purge des données payantes d'un compte, fonctionnalité par fonctionnalité
 * (volet 8, « Verrouillage, fonctionnalité par fonctionnalité »).
 *
 * - Trajets : les trajets clos du compte, avec leurs positions, événements et
 *   suiveurs (cascade). Un trajet encore ouvert va à son terme.
 * - Sonneries par liste : les colonnes de son des listes du compte, et les
 *   fichiers des sonneries importées (`ringtones/<compte>/`). Le téléphone
 *   efface ses préférences locales en lisant `purgedAt`.
 * - Traduction : tout vit sur le téléphone (modèles, traductions) — c'est lui
 *   qui efface, à la même lecture.
 * - Sauvegarde : jamais. Les archives sont chez l'utilisateur ; refuser la clé
 *   de restauration les rendrait illisibles pour toujours (écart validé).
 * - Coffre-fort : seulement ce qui dépasse l'espace de base — envois en cours,
 *   corbeille, puis les fichiers les plus récents (décision du 15/10/2026).
 *   Le reste du coffre est gardé sans limite de durée.
 */

const pool = require('../../config/db');
const { releaseRingtones } = require('../ringtoneFiles');

async function purgeFeatureData(alanyaID, db = pool) {
  const [trips] = await db.execute(
    'DELETE FROM trip WHERE owner_id = ? AND closed_at IS NOT NULL',
    [alanyaID],
  );
  const [lists] = await db.execute(
    `UPDATE contact_list
        SET msg_sound_type = NULL, msg_sound_id = NULL, msg_sound_name = NULL,
            call_sound_type = NULL, call_sound_id = NULL, call_sound_name = NULL,
            sound_priority = NULL
      WHERE alanyaID = ?
        AND (msg_sound_id IS NOT NULL OR call_sound_id IS NOT NULL OR sound_priority IS NOT NULL)`,
    [alanyaID],
  );
  // Les fichiers suivent les colonnes : plus aucune liste ne les désigne.
  releaseRingtones(alanyaID, { tout: true });
  // Chargé ici : le coffre dépend lui-même du module d'abonnement.
  const { safeboxService } = require('../safebox/service');
  let coffre;
  try {
    coffre = await safeboxService().purgeExcess(alanyaID);
  } catch (e) {
    // Jamais bloquant pour le reste de la purge ; repris à la purge suivante
    // de ce compte s'il en a une, sinon visible dans les journaux.
    console.error(`[billing] coffre du compte ${alanyaID} non réduit :`, e.message);
    coffre = { files: 0, bytes: 0, erreur: e.message };
  }
  return { trips: trips.affectedRows, lists: lists.affectedRows, safebox: coffre };
}

module.exports = { purgeFeatureData };
