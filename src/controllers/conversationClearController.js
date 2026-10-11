const pool = require('../config/db');

/**
 * POST /conversations/:id/clear — « Effacer la discussion ».
 *
 * Distinct de « Supprimer la discussion » (DELETE /conversations/:id), qui fait
 * QUITTER la conversation : ici le participant reste membre, la conversation
 * reste dans sa liste, mais il repart d'une page blanche. Les autres membres ne
 * voient rien changer.
 *
 * Mécanisme : le curseur par participant `historyCutoffAt` (migration 028), déjà
 * appliqué par les lectures de messages (`HISTORY_CUTOFF_SQL`) et que l'app
 * respecte déjà au moment d'enregistrer une conversation. Aucune ligne `message`
 * n'est touchée : les messages restent chez l'interlocuteur, et un message reçu
 * APRÈS l'effacement (`sendAt >= curseur`) s'affiche normalement.
 *
 * `NOW()` est tronqué à la seconde (colonne DATETIME) : un message envoyé dans
 * la même seconde que l'effacement, juste avant, peut réapparaître à une
 * resynchronisation — jamais l'inverse, un message postérieur n'est jamais caché.
 *
 * `conversation:cleared` part vers la room personnelle `user_<id>` : les autres
 * appareils du même compte vident leur copie locale. Idempotent et rejouable.
 */
const effacerDiscussion = async (req, res, next) => {
  try {
    const conversationID = Number(req.membership.conversID);
    const alanyaID = Number(req.user.alanyaID);

    await pool.execute(
      `UPDATE conv_participants
          SET historyCutoffAt = NOW(), unreadCount = 0
        WHERE conversID = ? AND alanyaID = ?`,
      [conversationID, alanyaID],
    );
    const [rows] = await pool.execute(
      'SELECT historyCutoffAt FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversationID, alanyaID],
    );
    const coupure = rows[0]?.historyCutoffAt ? new Date(rows[0].historyCutoffAt) : new Date();
    const historyCutoffAt = coupure.toISOString();

    const io = req.app.get('io');
    if (io) {
      io.to(`user_${alanyaID}`).emit('conversation:cleared', { conversationID, historyCutoffAt });
    }
    res.json({ conversationID, historyCutoffAt });
  } catch (error) {
    next(error);
  }
};

module.exports = { effacerDiscussion };
