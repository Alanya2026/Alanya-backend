const pool = require('../config/db');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');
const { postSystemMessage } = require('../utils/systemMessage');

/**
 * POST /conversations/:id/screenshot — « A a fait une capture d'écran ».
 * POST /conversations/:id/screen-recording — « A a enregistré l'écran ».
 *
 * Le téléphone de A détecte la capture (le serveur ne peut pas la voir) et le
 * dit ici ; le serveur écrit une ligne système `{e:'screenshot'}` (ou
 * `{e:'screen_recording'}`) dans la discussion, que A et B voient. L'événement étant déclaré par le client, il
 * n'est ni une preuve ni un contrôle d'accès : il ne sert qu'à informer, et
 * celui qui voudrait le taire n'a qu'à ne pas appeler la route. Ce qu'on garde
 * côté serveur est donc ce qui évite de nuire :
 *
 * - discussion à DEUX seulement : jamais un groupe (bruit pour tous), jamais la
 *   conversation avec soi-même ;
 * - même politique de blocage et de comptes officiels que l'envoi d'un message
 *   (`evaluateDirectMessageSend`) : un utilisateur bloqué par B n'écrit pas dans
 *   le fil de B, y compris par cette porte-là ;
 * - au plus UNE ligne par minute, par auteur et par événement : une rafale de
 *   captures (ou un client qui boucle) ne remplit pas le fil de l'autre ; une
 *   capture prise pendant un enregistrement reste dite, elle. Le contrôle lit la base,
 *   donc tient quel que soit le nombre de processus.
 *
 * Réponse 200 dans tous les cas utiles : `{ posted: false, reason }` quand rien
 * n'est écrit, pour que le client n'ait ni erreur à afficher ni raison de
 * réessayer. Pas de push (comme les autres messages système) ni de non-lu.
 */
const FENETRE_ANTI_RAFALE_S = 60;

/** Événements d'écran qu'un client peut signaler. */
const EVENEMENTS_ECRAN = new Set(['screenshot', 'screen_recording']);

const signalerEvenementEcran = (event) => {
  if (!EVENEMENTS_ECRAN.has(event)) throw new Error(`événement d'écran inconnu : ${event}`);
  return async (req, res, next) => {
    try {
      const conversationID = Number(req.membership.conversID);
      const actorID = Number(req.user.alanyaID);

      const politique = await evaluateDirectMessageSend(conversationID, actorID);
      if (!politique.isDirect) return res.json({ posted: false, reason: 'not_direct' });
      if (politique.action !== 'deliver') return res.json({ posted: false, reason: 'not_allowed' });

      // `event` vient de la liste ci-dessus, jamais du client : l'interpoler
      // dans le motif LIKE est sans risque.
      const [recents] = await pool.execute(
        `SELECT 1 FROM message
          WHERE conversationID = ? AND senderID = ? AND type = 6
            AND sendAt > (NOW() - INTERVAL ${FENETRE_ANTI_RAFALE_S} SECOND)
            AND content LIKE '%"e":"${event}"%'
          LIMIT 1`,
        [conversationID, actorID],
      );
      if (recents.length > 0) return res.json({ posted: false, reason: 'throttled' });

      const msg = await postSystemMessage({
        conversationID,
        actorID,
        event,
        io: req.app.get('io'),
        essential: true,
      });
      res.json(msg ? { posted: true, msgID: Number(msg.msgID) } : { posted: false, reason: 'failed' });
    } catch (error) {
      next(error);
    }
  };
};

const signalerCapture = signalerEvenementEcran('screenshot');
const signalerEnregistrement = signalerEvenementEcran('screen_recording');

module.exports = { signalerCapture, signalerEnregistrement, FENETRE_ANTI_RAFALE_S };
