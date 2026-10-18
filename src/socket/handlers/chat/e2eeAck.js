const pool = require('../../../config/db');
const { marqueRemises } = require('../../../utils/messageEnvelopes');

/** Plafond d'un accusé : une page d'historique, pas une base entière. */
const ACCUSE_MAX = 500;

/**
 * `e2ee:ack { msgIDs }` — cet appareil a déchiffré ET rangé ces messages.
 *
 * C'est le seul geste qui pose `message_envelope.delivered_at`. Jamais à
 * l'émission, jamais à la lecture de l'historique : l'appareil peut perdre la
 * réponse ou s'arrêter en plein déchiffrement, et un message déchiffré n'est
 * pas encore un message rangé. Tant que l'accusé n'est pas arrivé,
 * l'enveloppe reste servie (docs/e2ee, chapitres 1 et 11).
 *
 * `delivered_at` n'alimente que la purge (`purgeRegistry`, `e2ee_envelope`) ;
 * les coches de remise et de lecture vivent toujours sur `message.status`.
 *
 * L'appareil est celui de la socket, jamais un identifiant fourni : un
 * appareil n'accuse réception que de SES enveloppes.
 */
const e2eeAck = (io, socket) => {
  socket.on('e2ee:ack', async (data) => {
    if (!socket.authenticated || socket.appareilId == null) return;
    const ids = Array.isArray(data && data.msgIDs) ? data.msgIDs.slice(0, ACCUSE_MAX) : [];
    if (ids.length === 0) return;
    try {
      await marqueRemises(pool, ids, socket.appareilId);
    } catch (e) {
      // Table absente (migration 092 non jouée) ou base indisponible : la
      // purge attendra. Rien d'affiché ne dépend de cette date.
      if (e.code !== 'ER_NO_SUCH_TABLE') console.warn('[E2EE] accusé :', e.message);
    }
  });
};

module.exports = { e2eeAck, ACCUSE_MAX };
