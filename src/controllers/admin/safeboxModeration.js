/**
 * Modération d'un fichier du coffre signalé dans une discussion (message de
 * type 11). Décision du 18/10/2026, point 7 :
 *  A. voir l'aperçu du fichier, déchiffré par le serveur (quelques Ko) ;
 *  B. retirer tous ses partages : plus personne ne le télécharge ;
 *  C. le supprimer partout, copies enregistrées comprises — super-admin.
 *
 * Le partage se retrouve depuis le signalement, jamais depuis un numéro
 * fourni par la console : le contenu du message (ou, dans une discussion
 * chiffrée, l'extrait joint par l'auteur du signalement) donne un numéro de
 * partage, qui n'est retenu que s'il appartient à la même discussion ET au
 * même expéditeur que le message signalé. Un extrait falsifié ne peut donc
 * désigner que les partages de la personne signalée, dans cette discussion.
 */

const pool = require('../../config/db');
const { fail, failInternal } = require('../../utils/apiError');
const { SafeboxError } = require('../../services/safebox/errors');
const { safeboxService } = require('../../services/safebox/service');

const SAFEBOX_SHARE_TYPE = 11;

/** Numéro de partage lu dans un contenu de type 11, ou null. */
function shareIdDe(brut) {
  if (typeof brut !== 'string' || !brut) return null;
  try {
    const d = JSON.parse(brut);
    return d && Number.isSafeInteger(d.share) && d.share > 0 ? d.share : null;
  } catch {
    return null;
  }
}

/**
 * Le partage désigné par un signalement, vérifié contre le message signalé.
 * @returns {Promise<number|null>}
 */
async function partageDuSignalement(reportId, db = pool) {
  const id = Number.parseInt(reportId, 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const [[r]] = await db.query(
    `SELECT r.target_excerpt, m.type, m.content, m.conversationID, m.senderID
       FROM report r JOIN message m ON m.msgID = r.target_msg_id
      WHERE r.id = ?`,
    [id],
  );
  if (!r || Number(r.type) !== SAFEBOX_SHARE_TYPE) return null;
  for (const brut of [r.content, r.target_excerpt]) {
    const shareId = shareIdDe(brut);
    if (!shareId) continue;
    const [[s]] = await db.query(
      'SELECT id FROM safebox_share WHERE id = ? AND conversation_id = ? AND sender_id = ?',
      [shareId, r.conversationID, r.senderID],
    );
    if (s) return Number(s.id);
  }
  return null;
}

function sendError(res, err, tag) {
  if (err instanceof SafeboxError) return fail(res, err.status, err.code, err.message, err.extra);
  if (err.code === 'ER_NO_SUCH_TABLE') return fail(res, 503, 'SAFEBOX_UNAVAILABLE', 'Coffre-fort non installé');
  console.error(`[Admin] ${tag} :`, err);
  return failInternal(res);
}

const note = (body) => (typeof body?.note === 'string' && body.note.trim() ? body.note.trim().slice(0, 500) : null);

async function tracer(reportId, adminId, action, texte) {
  await pool.query(
    'INSERT INTO report_action (report_id, admin_id, action, note) VALUES (?, ?, ?, ?)',
    [reportId, adminId ?? null, action, texte],
  );
}

/** GET /api/admin/reports/:id/safebox — A : le fichier signalé, son état, son aperçu. */
const getReportSafebox = async (req, res) => {
  try {
    const shareId = await partageDuSignalement(req.params.id);
    if (!shareId) return fail(res, 404, 'SAFEBOX_NOT_FOUND', 'Aucun fichier du coffre dans ce signalement');
    return res.json(await safeboxService().moderationView(shareId));
  } catch (err) {
    return sendError(res, err, 'getReportSafebox');
  }
};

/** POST /api/admin/reports/:id/safebox/revoke — B : retirer tous ses partages. */
const revokeReportSafebox = async (req, res) => {
  try {
    const shareId = await partageDuSignalement(req.params.id);
    if (!shareId) return fail(res, 404, 'SAFEBOX_NOT_FOUND', 'Aucun fichier du coffre dans ce signalement');
    const { revoked } = await safeboxService().moderationRevoke(shareId);
    await tracer(req.params.id, req.user?.alanyaID, 'safebox_revoked',
      note(req.body) ?? `${revoked} partage(s) du fichier retiré(s)`);
    return res.json({ revoked, share: await safeboxService().moderationView(shareId) });
  } catch (err) {
    return sendError(res, err, 'revokeReportSafebox');
  }
};

/** POST /api/admin/reports/:id/safebox/delete — C : supprimer partout (super-admin). */
const deleteReportSafebox = async (req, res) => {
  try {
    const shareId = await partageDuSignalement(req.params.id);
    if (!shareId) return fail(res, 404, 'SAFEBOX_NOT_FOUND', 'Aucun fichier du coffre dans ce signalement');
    const r = await safeboxService().moderationDelete(shareId);
    await tracer(req.params.id, req.user?.alanyaID, 'safebox_deleted',
      note(req.body) ?? `fichier supprimé de ${r.vaults} coffre(s), ${r.revoked} partage(s) retiré(s)`);
    console.log(`[Admin] fichier du coffre supprimé partout (signalement ${req.params.id}, partage ${shareId}) par ${req.user?.email || req.user?.alanyaID}`);
    return res.json({ ...r, share: await safeboxService().moderationView(shareId) });
  } catch (err) {
    return sendError(res, err, 'deleteReportSafebox');
  }
};

module.exports = {
  getReportSafebox,
  revokeReportSafebox,
  deleteReportSafebox,
  // Pour les tests.
  partageDuSignalement,
  shareIdDe,
};
