const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireOutgoing = require('../middleware/requireOutgoing');
const { getMessageReceipts } = require('../controllers/messageReceiptsController');
const { updateMessage, deleteMessage, batchDeleteMessages, batchForwardMessages, pinMessage, markMessageViewed, setReaction, removeReaction, getMessagesSince, getMessageStatusByClientId, getPendingOutgoingMessages, markMessagesDelivered } = require('../controllers/messageController');

/**
 * @swagger
 * /api/messages/{id}:
 *   put:
 *     summary: Modifier un message
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - content
 *             properties:
 *               content:
 *                 type: string
 *     responses:
 *       200:
 *         description: Message modifié
 *   delete:
 *     summary: Supprimer un message
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *         description: >
 *           Supprimer pour tous (true) ou seulement pour soi. Pour tous : dans les
 *           72 heures suivant l'envoi (sinon 403 DELETE_WINDOW_EXPIRED), par
 *           l'expéditeur ou, dans un groupe, par un administrateur (message d'un
 *           membre) ou le propriétaire (membre ou administrateur) ; sinon 403
 *           FORBIDDEN. Tout participant absent : 404 MESSAGE_NOT_FOUND.
 *     responses:
 *       200:
 *         description: Message supprimé
 *       403:
 *         description: DELETE_WINDOW_EXPIRED ou FORBIDDEN
 *       404:
 *         description: MESSAGE_NOT_FOUND
 */
// Sync delta globale multi-conversations (curseur par conv). Déclarée avant
// les routes `/:id` pour éviter toute capture par un pattern paramétré.
router.post('/sync', auth, getMessagesSince);
// Accusé de remise émis par la couche push (app fermée, pas de socket).
// Équivalent HTTP de l'event socket `message:delivered`, idempotent.
router.post('/delivered', auth, markMessagesDelivered);
router.get('/status', auth, getMessageStatusByClientId);
router.get('/pending', auth, getPendingOutgoingMessages);

/**
 * @swagger
 * /api/messages/{id}/receipts:
 *   get:
 *     summary: Qui a lu, reçu ou pas encore reçu un de mes messages de groupe
 *     description: >
 *       Réservé à l'expéditeur. Membres arrivés après l'envoi exclus. Une heure
 *       nulle signifie « avant la migration 096 », où les heures n'étaient pas
 *       journalisées.
 *     tags: [Messages]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: >
 *           { msgID, sentAt, total, readCount, deliveredCount, read[], delivered[],
 *           pending[] } — chaque entrée { alanyaID, nom, pseudo, avatar, at }.
 *           deliveredCount inclut les lecteurs ; la liste delivered, non.
 *       400:
 *         description: NOT_GROUP_MESSAGE — message d'une discussion à deux
 *       404:
 *         description: MESSAGE_NOT_FOUND — inconnu, supprimé, ou pas de moi
 */
router.get('/:id/receipts', auth, getMessageReceipts);
router.post('/batch-delete', auth, batchDeleteMessages);
router.post('/batch-forward', auth, requireOutgoing, batchForwardMessages);
router.put('/:id/reactions', auth, requireOutgoing, setReaction);
router.delete('/:id/reactions', auth, removeReaction);
router.put('/:id', auth, requireOutgoing, updateMessage);
router.delete('/:id', auth, deleteMessage);
router.patch('/:id/pin', auth, pinMessage);
router.post('/:id/view', auth, markMessageViewed);

module.exports = router;
