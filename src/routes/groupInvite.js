// Côté invité d'un lien de groupe (`/api/groups/invite/:token`). Voir
// groupInviteController.js pour les règles.

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const { groupInviteJoinLimiter } = require('../middleware/rateLimiter');
const {
  previewInvite, joinByInvite, cancelJoinRequest,
} = require('../controllers/groupInviteController');

/**
 * @swagger
 * /api/groups/invite/{token}:
 *   get:
 *     summary: Aperçu d'un groupe à partir de son lien d'invitation
 *     description: >
 *       Ne modifie rien. `state` vaut `can_join`, `already_member`, `pending`,
 *       `removed` ou `full`. `group.conversID` n'est donné qu'à un membre.
 *     tags: [Groupes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: "{ state, group: { name, photo, description, memberCount, hideHistory, approval } }" }
 *       404: { description: INVITE_LINK_INVALID }
 */
router.get('/:token', auth, groupInviteJoinLimiter, previewInvite);

/**
 * @swagger
 * /api/groups/invite/{token}/join:
 *   post:
 *     summary: Rejoint le groupe, ou envoie une demande si l'approbation est active
 *     tags: [Groupes]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: "{ state: joined | already_member | pending, conversation? }" }
 *       202: { description: "{ state: pending } — demande créée" }
 *       403: { description: GROUP_REMOVED }
 *       404: { description: INVITE_LINK_INVALID }
 *       409: { description: GROUP_FULL }
 */
router.post('/:token/join', auth, groupInviteJoinLimiter, joinByInvite);

/**
 * @swagger
 * /api/groups/invite/{token}/request:
 *   delete:
 *     summary: Annule ma demande en attente
 *     tags: [Groupes]
 *     security:
 *       - bearerAuth: []
 */
router.delete('/:token/request', auth, groupInviteJoinLimiter, cancelJoinRequest);

module.exports = router;
