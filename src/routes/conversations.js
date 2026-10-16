const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  requireParticipant,
  requireGroup,
  requireGroupAdmin,
  requireGroupOwner,
} = require('../middleware/groupAuth');
const {
  getConversations,
  getConversationById,
  createConversation,
  createGroup,
  updateConversation,
  deleteConversation,
  markAsRead,
  leaveGroup,
  addParticipants,
  batchUpdateConversations,
  batchDeleteConversations,
  updateGroupInfo,
  updateGroupSettings,
  removeParticipant,
  setParticipantRole,
  updateConversationMute,
  ackGroupJoin,
} = require('../controllers/conversationController');
const { effacerDiscussion } = require('../controllers/conversationClearController');
const { signalerCapture, signalerEnregistrement } = require('../controllers/conversationScreenshotController');
const { getConversationVideoCodecs } = require('../controllers/videoCodecsController');

/**
 * @swagger
 * /api/conversations:
 *   get:
 *     summary: Liste des conversations
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des conversations
 *   post:
 *     summary: Créer une conversation privée (1-1)
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - participantID
 *             properties:
 *               participantID:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Conversation créée
 */
router.get('/', auth, getConversations);
router.post('/', auth, createConversation);
router.patch('/batch', auth, batchUpdateConversations);
router.post('/batch-delete', auth, batchDeleteConversations);

/**
 * @swagger
 * /api/conversations/group:
 *   post:
 *     summary: Créer un groupe
 *     tags: [Conversations]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - participantIDs
 *             properties:
 *               participantIDs:
 *                 type: array
 *                 items:
 *                   type: integer
 *               groupName:
 *                 type: string
 *               groupPhoto:
 *                 type: string
 *     responses:
 *       201:
 *         description: Groupe créé
 */
router.post('/group', auth, createGroup);

/**
 * @swagger
 * /api/conversations/{id}:
 *   get:
 *     summary: Détails d'une conversation
 *     tags: [Conversations]
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
 *         description: Détails de la conversation
 *   put:
 *     summary: Flags par utilisateur (épinglage, archivage)
 *     description: >
 *       Ne modifie QUE les champs propres à l'utilisateur courant, stockés dans
 *       `conv_participants`. `GroupName` et `groupPhoto` y étaient acceptés sans
 *       contrôle d'appartenance ; ils sont désormais refusés (400
 *       `USE_GROUP_ENDPOINT`) et relèvent de `PATCH /{id}/group`.
 *     tags: [Conversations]
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
 *             properties:
 *               isPinned:
 *                 type: integer
 *                 enum: [0, 1]
 *               isArchived:
 *                 type: integer
 *                 enum: [0, 1]
 *     responses:
 *       200:
 *         description: Conversation mise à jour
 *       400:
 *         description: USE_GROUP_ENDPOINT — infos de groupe envoyées ici
 *       404:
 *         description: Conversation introuvable ou non autorisée
 *   delete:
 *     summary: Supprimer une conversation (quitter)
 *     tags: [Conversations]
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
 *         description: Conversation supprimée
 */
router.get('/:id', auth, getConversationById);

/**
 * @swagger
 * /api/conversations/{id}/video-codecs:
 *   get:
 *     summary: Codecs vidéo lisibles par tous les appareils actifs des membres
 *     description: >
 *       `hevc: true` quand aucun membre n'a d'appareil actif qui ne lit pas le
 *       HEVC (ou ne l'a pas déclaré). L'app envoie alors ses vidéos en HEVC,
 *       plus légères ; sinon en H.264.
 *     tags: [Conversations]
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
 *         description: "{ hevc: boolean }"
 */
router.get('/:id/video-codecs', auth, requireParticipant, getConversationVideoCodecs);
// requireParticipant : la route écrivait dans `conversation` sans vérifier
// l'appartenance (voir le commentaire du contrôleur).
router.put('/:id', auth, requireParticipant, updateConversation);
router.delete('/:id', auth, deleteConversation);

/**
 * @swagger
 * /api/conversations/{id}/read:
 *   post:
 *     summary: Marquer les messages comme lus
 *     tags: [Conversations]
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
 *         description: Messages marqués comme lus
 */
// requireParticipant : la route écrivait `status = 3` / `readAt` sur les messages
// de n'importe quelle conversation du système, et remettait son unreadCount à
// zéro, sans vérifier l'appartenance. C'est le chemin appelé par l'action
// « Lu » de la notification, app fermée, donc sans écran pour s'en apercevoir.
router.post('/:id/read', auth, requireParticipant, markAsRead);

/**
 * @swagger
 * /api/conversations/{id}/clear:
 *   post:
 *     summary: Effacer la discussion (pour moi seulement)
 *     description: >
 *       Vide la discussion pour l'appelant sans la quitter ni la supprimer : seuls
 *       les messages postérieurs restent visibles. Les autres membres ne voient
 *       rien. Diffuse `conversation:cleared` aux autres appareils du compte.
 *     tags: [Conversations]
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
 *         description: "{ conversationID, historyCutoffAt }"
 *       404:
 *         description: Conversation introuvable ou non participant
 */
router.post('/:id/clear', auth, requireParticipant, effacerDiscussion);

/**
 * @swagger
 * /api/conversations/{id}/screenshot:
 *   post:
 *     summary: Signaler une capture d'écran de la discussion
 *     description: >
 *       Le client a détecté une capture d'écran : le serveur écrit une ligne
 *       système `screenshot` visible des deux participants. Discussion à deux
 *       uniquement, une ligne par minute et par auteur au plus ; sinon
 *       `posted: false` avec une raison (`not_direct`, `not_allowed`, `throttled`).
 *     tags: [Conversations]
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
 *         description: "{ posted: boolean, msgID?, reason? }"
 *       404:
 *         description: Conversation introuvable ou non participant
 */
router.post('/:id/screenshot', auth, requireParticipant, signalerCapture);

/**
 * @swagger
 * /api/conversations/{id}/screen-recording:
 *   post:
 *     summary: Signaler un enregistrement d'écran de la discussion
 *     description: >
 *       Le client a détecté que la discussion est filmée (enregistrement vidéo de
 *       l'écran) : le serveur écrit une ligne système `screen_recording` visible
 *       des deux participants. Mêmes règles que `/screenshot` (discussion à deux,
 *       une ligne par minute et par auteur), comptées à part des captures.
 *     tags: [Conversations]
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
 *         description: "{ posted: boolean, msgID?, reason? }"
 *       404:
 *         description: Conversation introuvable ou non participant
 */
router.post('/:id/screen-recording', auth, requireParticipant, signalerEnregistrement);
router.patch('/:id/mute', auth, updateConversationMute);

/**
 * @swagger
 * /api/conversations/{id}/leave:
 *   post:
 *     summary: Quitter un groupe
 *     tags: [Conversations]
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
 *         description: Groupe quitté
 */
router.post('/:id/leave', auth, leaveGroup);

/**
 * @swagger
 * /api/conversations/{id}/participants:
 *   post:
 *     summary: Ajouter des participants à un groupe
 *     tags: [Conversations]
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
 *               - participantIDs
 *             properties:
 *               participantIDs:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Participants ajoutés
 */
// requireParticipant + requireGroup : le contrôleur applique ensuite le verrou
// onlyAdminsCanAddMembers. Sans règle de rôle, un simple membre pouvait
// RÉINTÉGRER immédiatement la personne qu'un admin venait d'exclure — le
// retrait, lui, est réservé aux admins. L'exclusion n'était donc pas tenable.
router.post('/:id/participants', auth, requireParticipant, requireGroup, addParticipants);

/** Nouvel ajouté : « Rester » → clear pendingJoinMsgID (sync multi-appareil). */
router.post('/:id/ack-join', auth, requireParticipant, requireGroup, ackGroupJoin);

/**
 * @swagger
 * /api/conversations/{id}/group:
 *   patch:
 *     summary: Modifier les infos du groupe (nom, photo, description)
 *     description: >
 *       Réservé aux administrateurs si `onlyAdminsCanEditInfo` est actif,
 *       ouvert à tous les membres sinon. Chemin distinct de `PUT /{id}`, qui
 *       porte les flags par utilisateur (épinglage, archivage).
 *     tags: [Conversations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               GroupName: { type: string, maxLength: 255 }
 *               groupPhoto: { type: string, nullable: true }
 *               description: { type: string, maxLength: 512, nullable: true }
 *     responses:
 *       200: { description: Conversation enrichie }
 *       403: { description: GROUP_INFO_LOCKED }
 *       404: { description: Conversation introuvable ou non autorisée }
 */
router.patch('/:id/group', auth, requireParticipant, requireGroup, updateGroupInfo);

/**
 * @swagger
 * /api/conversations/{id}/settings:
 *   patch:
 *     summary: Verrous du groupe (mode annonce, édition réservée)
 *     description: Toujours réservé aux administrateurs.
 *     tags: [Conversations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               onlyAdminsCanSend: { type: integer, enum: [0, 1] }
 *               onlyAdminsCanEditInfo: { type: integer, enum: [0, 1] }
 *               hideHistoryForNewMembers: { type: integer, enum: [0, 1] }
 *               onlyAdminsCanAddMembers: { type: integer, enum: [0, 1] }
 *     responses:
 *       200: { description: Conversation enrichie }
 *       403: { description: GROUP_ADMIN_REQUIRED }
 */
router.patch('/:id/settings', auth, requireGroupAdmin, updateGroupSettings);

/**
 * @swagger
 * /api/conversations/{id}/participants/{userId}:
 *   delete:
 *     summary: Retirer un membre du groupe
 *     description: >
 *       Administrateur ou propriétaire. On ne peut retirer ni un rôle supérieur
 *       ou égal au sien, ni le propriétaire, ni soi-même (utiliser `/leave`).
 *       Idempotent : un membre déjà parti renvoie 200 avec `alreadyGone`.
 *     tags: [Conversations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Membre retiré }
 *       400: { description: USE_LEAVE_ENDPOINT }
 *       403: { description: CANNOT_REMOVE_OWNER ou INSUFFICIENT_ROLE }
 */
router.delete('/:id/participants/:userId', auth, requireGroupAdmin, removeParticipant);

/**
 * @swagger
 * /api/conversations/{id}/participants/{userId}/role:
 *   patch:
 *     summary: Promouvoir ou rétrograder un membre
 *     description: >
 *       Propriétaire uniquement — un administrateur ne crée pas
 *       d'administrateur. Le transfert de propriété (role 2) n'est pas exposé :
 *       la succession se fait automatiquement au départ du propriétaire.
 *     tags: [Conversations]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: integer, enum: [0, 1] }
 *     responses:
 *       200: { description: Conversation enrichie }
 *       403: { description: GROUP_OWNER_REQUIRED }
 *       404: { description: Membre introuvable dans ce groupe }
 */
router.patch(
  '/:id/participants/:userId/role',
  auth,
  requireGroupOwner,
  setParticipantRole,
);

module.exports = router;
