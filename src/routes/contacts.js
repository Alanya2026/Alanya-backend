const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');
const {
  getPreferredContacts,
  addPreferredContact,
  removePreferredContact,
  checkIsContact,
  setContactNote,
  setContactName,
} = require('../controllers/preferredContactController');

/**
 * @swagger
 * /api/contacts:
 *   get:
 *     summary: Liste des contacts préférés
 *     tags: [Contacts]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Liste des contacts
 */
router.get('/',          auth, getPreferredContacts);

/**
 * @swagger
 * /api/contacts/check/{id}:
 *   get:
 *     summary: Vérifie si un utilisateur est un contact préféré
 *     tags: [Contacts]
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
 *         description: Statut du contact
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isContact:
 *                   type: boolean
 */
router.get('/check/:id', auth, checkIsContact);

/**
 * @swagger
 * /api/contacts/{id}:
 *   post:
 *     summary: Ajouter un contact préféré
 *     tags: [Contacts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID de l'utilisateur à ajouter
 *     responses:
 *       201:
 *         description: Contact ajouté
 *   delete:
 *     summary: Supprimer un contact préféré
 *     tags: [Contacts]
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
 *         description: Contact supprimé
 */
router.post('/:id',      auth, addPreferredContact);

/**
 * @swagger
 * /api/contacts/{id}/note:
 *   put:
 *     summary: Pose ou remplace la note contextuelle d'un contact préféré
 *     tags: [Contacts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               note:
 *                 type: string
 *                 maxLength: 200
 *                 description: Vide ou absente pour effacer
 *     responses:
 *       200:
 *         description: Note enregistrée
 *       404:
 *         description: Pas un contact préféré
 */
router.put('/:id/note',  auth, setContactNote);

/**
 * @swagger
 * /api/contacts/{id}/name:
 *   put:
 *     summary: Pose ou remplace le nom personnalisé d'un contact préféré
 *     tags: [Contacts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 maxLength: 60
 *                 description: Vide ou absent pour revenir au nom du profil
 *     responses:
 *       200:
 *         description: Nom enregistré
 *       404:
 *         description: Pas un contact préféré
 */
router.put('/:id/name',  auth, setContactName);
router.delete('/:id',    auth, removePreferredContact);

module.exports = router;
