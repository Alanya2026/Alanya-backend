/**
 * Passage d'une conversation en chiffré de bout en bout.
 *
 * Le serveur décide, une seule fois, et à sens unique : `conversation.e2ee_since`
 * est posée et ne revient jamais à NULL (migration 104).
 *
 * ── Quand ──
 *
 * Toutes les conditions ensemble, sans exception :
 *
 *  - une conversation à DEUX, pas un groupe (les groupes viennent avec les
 *    Sender Keys, étape 8), ni un fil avec soi-même ;
 *  - deux comptes PERSONNELS : un compte officiel ou professionnel parle à
 *    des milliers de gens depuis le serveur, sans appareil pour tenir une clé ;
 *  - TOUS les appareils actifs des deux comptes ont publié des clés, avec une
 *    capacité qui sait lire du texte (≥ 1). Un seul appareil en retard — une
 *    tablette pas encore mise à jour — et la conversation reste en clair :
 *    après l'activation, cet appareil ne lirait plus rien, et rien ne lui dirait
 *    pourquoi ;
 *  - les deux comptes sont dans la cohorte, et le second cran de l'interrupteur
 *    est ouvert (`e2eeSettingsService.peutActiver`).
 *
 * ── Qui déclenche ──
 *
 * L'application, en demandant pour qui chiffrer (`GET /api/e2ee/devices`)
 * avant d'écrire dans une conversation à deux. C'est le seul moment où la
 * question se pose, et il ne coûte rien aux comptes hors cohorte : ils ne
 * posent jamais la question.
 *
 * Une conversation qui ne remplit pas les conditions reste en clair, comme
 * aujourd'hui. Ce n'est jamais une erreur.
 */

const pool = require('../config/db');
const { ACCOUNT_TYPE } = require('../constants/accountTypes');
const { peutActiver } = require('./e2eeSettingsService');

/** Capacité minimale d'un appareil pour qu'une conversation s'active. */
const CAPACITE_TEXTE = 1;

/**
 * La règle, sans base. Rend le premier motif de refus, ou `null`.
 *
 * @param {object} p
 * @param {boolean} p.isGroup
 * @param {Array<{alanyaID, accountType}>} p.participants
 * @param {Array<{id, alanyaID, capacite}>} p.appareils  appareils actifs des
 *   participants ; `capacite` à null quand l'appareil n'a pas publié de clés
 */
function motifNonEligible({ isGroup, participants, appareils }) {
  if (isGroup) return 'GROUPE';
  const comptes = [...new Set((participants || []).map((p) => Number(p.alanyaID)))];
  if (comptes.length !== 2) return 'PAS_DEUX_COMPTES';
  if (participants.some((p) => Number(p.accountType ?? ACCOUNT_TYPE.PERSONNEL) !== ACCOUNT_TYPE.PERSONNEL)) {
    return 'COMPTE_NON_PERSONNEL';
  }
  for (const compte of comptes) {
    const siens = (appareils || []).filter((a) => Number(a.alanyaID) === compte);
    // Aucun appareil actif : personne ne pourrait lire. Pas une raison de
    // chiffrer « pour personne ».
    if (siens.length === 0) return 'AUCUN_APPAREIL';
    if (siens.some((a) => a.capacite == null)) return 'APPAREIL_SANS_CLES';
    if (siens.some((a) => Number(a.capacite) < CAPACITE_TEXTE)) return 'CAPACITE_INSUFFISANTE';
  }
  return null;
}

/**
 * Active la conversation si elle remplit les conditions.
 *
 * @param {number} conversationID
 * @param {object} [options]
 * @param {object} [options.io]  Socket.IO : prévient les deux comptes
 * @returns {Promise<{ e2eeSince: Date|null, motif: string|null }>}
 *   `e2eeSince` non nul : la conversation est chiffrée (avant ou maintenant).
 */
async function activerSiEligible(conversationID, { io = null } = {}) {
  let conv;
  try {
    const [rows] = await pool.execute(
      'SELECT isGroup, e2ee_since FROM conversation WHERE conversID = ?',
      [conversationID],
    );
    conv = rows[0];
  } catch (e) {
    // Migration 104 absente : rien ne s'active, tout reste en clair.
    if (e.code === 'ER_BAD_FIELD_ERROR') return { e2eeSince: null, motif: 'MIGRATION_ABSENTE' };
    throw e;
  }
  if (!conv) return { e2eeSince: null, motif: 'INTROUVABLE' };
  if (conv.e2ee_since) return { e2eeSince: conv.e2ee_since, motif: null };

  const [participants] = await pool.execute(
    `SELECT p.alanyaID, u.account_type AS accountType
       FROM conv_participants p
       JOIN users u ON u.alanyaID = p.alanyaID
      WHERE p.conversID = ?`,
    [conversationID],
  );
  const comptes = participants.map((p) => Number(p.alanyaID));
  let appareils = [];
  if (comptes.length > 0) {
    [appareils] = await pool.query(
      `SELECT a.id, a.alanyaID, k.capacite
         FROM appareils a
         LEFT JOIN e2ee_device_keys k ON k.appareil_id = a.id
        WHERE a.alanyaID IN (?) AND a.revoked_at IS NULL`,
      [comptes],
    );
  }

  const motif = motifNonEligible({ isGroup: !!conv.isGroup, participants, appareils });
  if (motif) return { e2eeSince: null, motif };
  if (!(await peutActiver(...comptes))) return { e2eeSince: null, motif: 'HORS_COHORTE' };

  // `e2ee_since IS NULL` dans la condition : deux appareils qui demandent au
  // même instant n'activent qu'une fois, et le second relit la date posée par
  // le premier.
  const [maj] = await pool.execute(
    'UPDATE conversation SET e2ee_since = NOW() WHERE conversID = ? AND e2ee_since IS NULL',
    [conversationID],
  );
  const [[relu]] = await pool.execute(
    'SELECT e2ee_since FROM conversation WHERE conversID = ?',
    [conversationID],
  );
  const e2eeSince = relu ? relu.e2ee_since : null;

  if (maj.affectedRows > 0 && io && e2eeSince) {
    console.log(`[E2EE] conversation ${conversationID} passée en chiffré`);
    const charge = { conversationID: Number(conversationID), e2eeSince };
    for (const compte of comptes) {
      io.to(`user_${compte}`).emit('conversation:e2ee', charge);
    }
  }
  return { e2eeSince, motif: null };
}

module.exports = { CAPACITE_TEXTE, motifNonEligible, activerSiEligible };
