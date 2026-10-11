/**
 * Pierres tombales des suppressions POUR TOUS (migration 099).
 *
 * Écriture : tolérante. Si la table n'existe pas encore (migration pas encore
 * appliquée), la suppression elle-même réussit comme avant : on perd seulement le
 * rattrapage des appareils hors ligne, jamais la suppression.
 *
 * Lecture : curseur `id` global, filtré par appartenance. Le premier appel d'un
 * appareil (sans curseur) ne rejoue RIEN et renvoie la position courante : on ne
 * remonte pas l'histoire d'avant la fonctionnalité.
 */

const LIMITE_MAX = 500;

/**
 * Le curseur ne saute jamais au-delà de ce qui est « assis ». Deux transactions
 * peuvent tirer les `id` 10 et 11 et valider dans l'ordre inverse : si l'on
 * renvoyait MAX(id) = 11 entre les deux, l'appareil ne verrait jamais le 10. Un
 * horizon de 30 s laisse largement le temps à une transaction de suppression
 * (quelques millisecondes) de valider.
 */
const HORIZON_SQL = `SELECT COALESCE(MAX(id), 0) AS maxID FROM message_deletion
                      WHERE deletedAt <= (NOW(3) - INTERVAL 30 SECOND)`;

const tableAbsente = (e) => e && (e.code === 'ER_NO_SUCH_TABLE' || e.errno === 1146);

/**
 * @param {{execute: Function}} db  connexion (dans la transaction de suppression)
 * @param {number} acteurID
 * @param {Array<{msgID:number, conversationID:number}>} lignes  messages RÉELLEMENT supprimés
 */
async function enregistrerSuppressions(db, acteurID, lignes) {
  if (!lignes || lignes.length === 0) return;
  try {
    await db.execute(
      `INSERT IGNORE INTO message_deletion (msgID, conversationID, deletedByID)
       VALUES ${lignes.map(() => '(?, ?, ?)').join(',')}`,
      lignes.flatMap((l) => [Number(l.msgID), Number(l.conversationID), Number(acteurID)]),
    );
  } catch (e) {
    if (tableAbsente(e)) return;
    throw e;
  }
}

/** `apres` : entier > 0 ou absent. Retourne `{deletions, cursor, hasMore}`. */
async function lireSuppressions(db, alanyaID, { apres, limite } = {}) {
  const borne = Math.min(Math.max(parseInt(limite, 10) || 200, 1), LIMITE_MAX);
  const curseur = parseInt(apres, 10);
  try {
    if (!Number.isInteger(curseur) || curseur < 0) {
      const [[r]] = await db.execute(HORIZON_SQL);
      return { deletions: [], cursor: Number(r.maxID), hasMore: false };
    }
    const [rows] = await db.execute(
      `SELECT d.id, d.msgID, d.conversationID, d.deletedByID
         FROM message_deletion d
         JOIN conv_participants cp
           ON cp.conversID = d.conversationID AND cp.alanyaID = ?
        WHERE d.id > ?
        ORDER BY d.id ASC
        LIMIT ?`,
      [alanyaID, curseur, borne + 1],
    );
    const hasMore = rows.length > borne;
    const page = hasMore ? rows.slice(0, borne) : rows;
    // Le curseur avance aussi quand tout est filtré (suppressions d'autres
    // conversations), jusqu'à l'horizon : sinon chaque appel rescannerait tout.
    let cursor = curseur;
    if (page.length > 0) cursor = Number(page[page.length - 1].id);
    if (!hasMore) {
      const [[r]] = await db.execute(HORIZON_SQL);
      cursor = Math.max(cursor, Number(r.maxID));
    }
    return {
      deletions: page.map((r) => ({
        msgID: Number(r.msgID),
        conversationID: Number(r.conversationID),
        deletedBy: r.deletedByID == null ? null : Number(r.deletedByID),
      })),
      cursor,
      hasMore,
    };
  } catch (e) {
    if (tableAbsente(e)) return { deletions: [], cursor: 0, hasMore: false };
    throw e;
  }
}

module.exports = { LIMITE_MAX, enregistrerSuppressions, lireSuppressions };
