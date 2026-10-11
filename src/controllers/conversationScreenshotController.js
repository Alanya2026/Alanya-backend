const pool = require('../config/db');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');
const { postSystemMessage } = require('../utils/systemMessage');

/**
 * POST /conversations/:id/screenshot — « A a fait une capture d'écran ».
 *
 * Le téléphone de A détecte la capture (le serveur ne peut pas la voir) et le
 * dit ici ; le serveur écrit une ligne système `{e:'screenshot'}` dans la
 * discussion, que A et B voient. L'événement étant déclaré par le client, il
 * n'est ni une preuve ni un contrôle d'accès : il ne sert qu'à informer, et
 * celui qui voudrait le taire n'a qu'à ne pas appeler la route. Ce qu'on garde
 * côté serveur est donc ce qui évite de nuire :
 *
 * - discussion à DEUX seulement : jamais un groupe (bruit pour tous), jamais la
 *   conversation avec soi-même ;
 * - même politique de blocage et de comptes officiels que l'envoi d'un message
 *   (`evaluateDirectMessageSend`) : un utilisateur bloqué par B n'écrit pas dans
 *   le fil de B, y compris par cette porte-là ;
 * - au plus UNE ligne par minute et par auteur : une rafale de captures (ou un
 *   client qui boucle) ne remplit pas le fil de l'autre. Le contrôle lit la base,
 *   donc tient quel que soit le nombre de processus.
 *
 * Réponse 200 dans tous les cas utiles : `{ posted: false, reason }` quand rien
 * n'est écrit, pour que le client n'ait ni erreur à afficher ni raison de
 * réessayer. Pas de push (comme les autres messages système) ni de non-lu.
 */
const FENETRE_ANTI_RAFALE_S = 60;

const signalerCapture = async (req, res, next) => {
  try {
    const conversationID = Number(req.membership.conversID);
    const actorID = Number(req.user.alanyaID);

    const politique = await evaluateDirectMessageSend(conversationID, actorID);
    if (!politique.isDirect) return res.json({ posted: false, reason: 'not_direct' });
    if (politique.action !== 'deliver') return res.json({ posted: false, reason: 'not_allowed' });

    const [recents] = await pool.execute(
      `SELECT 1 FROM message
        WHERE conversationID = ? AND senderID = ? AND type = 6
          AND sendAt > (NOW() - INTERVAL ${FENETRE_ANTI_RAFALE_S} SECOND)
          AND content LIKE '%"e":"screenshot"%'
        LIMIT 1`,
      [conversationID, actorID],
    );
    if (recents.length > 0) return res.json({ posted: false, reason: 'throttled' });

    const msg = await postSystemMessage({
      conversationID,
      actorID,
      event: 'screenshot',
      io: req.app.get('io'),
      essential: true,
    });
    res.json(msg ? { posted: true, msgID: Number(msg.msgID) } : { posted: false, reason: 'failed' });
  } catch (error) {
    next(error);
  }
};

module.exports = { signalerCapture, FENETRE_ANTI_RAFALE_S };
