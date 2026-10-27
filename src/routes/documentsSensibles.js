// Documents sensibles — traces de consultation et recherche par empreinte.
// Plan : PLAN-DOCUMENTS-SENSIBLES.md ; table : migration 110.
//
// L'ENVOI n'a pas de route ici : `isSensitive` et `mediaProtection` passent
// par `message:send` et `POST /api/conversations/:id/messages`, via
// `utils/documentSensible`.

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const c = require('../controllers/documentSensibleController');

router.use(auth);

/**
 * @swagger
 * /api/documents-sensibles/consultations:
 *   post:
 *     summary: Note une consultation, ou une copie signée qui sort, d'un document sensible
 *     tags: [Documents sensibles]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [msgID]
 *             properties:
 *               msgID: { type: integer }
 *               geste:
 *                 type: string
 *                 enum: [CONSULTATION, TELECHARGEMENT, PARTAGE, TRANSFERT]
 *                 default: CONSULTATION
 *               empreinte:
 *                 type: string
 *                 description: 32 caractères hexadécimaux, écrits dans la copie ; absente pour une consultation
 *               appareil: { type: string, description: Marque et modèle }
 *     responses:
 *       201: { description: Trace enregistrée }
 *       400: { description: "INVALID_PAYLOAD, NOT_SENSITIVE" }
 *       404: { description: "MESSAGE_NOT_FOUND (absent, ou conversation étrangère)" }
 *       409: { description: FINGERPRINT_EXISTS }
 *       422: { description: INVALID_FINGERPRINT }
 */
router.post('/consultations', c.enregistrerConsultation);

/**
 * @swagger
 * /api/documents-sensibles/empreintes/{code}:
 *   get:
 *     summary: Qui a fait sortir la copie qui porte cette empreinte
 *     description: >
 *       Réservé aux membres de la conversation du document, à son expéditeur
 *       et à l'auteur de la copie ; pour tout autre, 404 comme une empreinte inconnue.
 *     tags: [Documents sensibles]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *         description: 32 caractères hexadécimaux, espaces et casse indifférents
 *     responses:
 *       200: { description: "empreinte, geste, date, appareil, utilisateur, expediteur, document" }
 *       404: { description: FINGERPRINT_NOT_FOUND }
 *       422: { description: INVALID_FINGERPRINT }
 */
router.get('/empreintes/:code', c.trouverEmpreinte);

module.exports = router;
