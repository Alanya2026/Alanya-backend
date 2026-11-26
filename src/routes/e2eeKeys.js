// Annuaire des clés publiques du chiffrement de bout en bout.
//
// Toutes les routes sont authentifiées et travaillent sur l'appareil du
// jeton : rien ici ne prend d'identifiant d'appareil dans le corps de la
// requête. Voir `controllers/e2eeKeysController.js`.

const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const requireE2ee = require('../middleware/requireE2ee');
const {
  deleteKeys,
  postKeys,
  postSignedPreKey,
  postOneTimePreKeys,
  getKeysState,
  postBundles,
  getConversationDevices,
  getEnAttente,
} = require('../controllers/e2eeKeysController');

/**
 * @swagger
 * /api/e2ee/keys:
 *   post:
 *     summary: Publie (ou remplace) le bundle de clés publiques de cet appareil
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [registrationId, identityKey, capacite, signedPreKey]
 *             properties:
 *               registrationId: { type: integer, description: 0 à 16383 }
 *               identityKey:    { type: string, description: "clé d'identité Signal : 0x05 + 32 octets, en base64" }
 *               capacite:       { type: integer, description: "0 = rien encore, 1 = texte, 2 = médias, 3 = groupes" }
 *               signedPreKey:
 *                 type: object
 *                 required: [keyId, publicKey, signature]
 *                 properties:
 *                   keyId:     { type: integer, description: 0 à 16777215 }
 *                   publicKey: { type: string, description: "0x05 + 32 octets, en base64" }
 *                   signature: { type: string, description: "XEdDSA, 64 octets en base64" }
 *               oneTimePreKeys:
 *                 type: array
 *                 maxItems: 100
 *                 items:
 *                   type: object
 *                   properties:
 *                     keyId:     { type: integer }
 *                     publicKey: { type: string }
 *     responses:
 *       200: { description: Bundle publié }
 *       400: { description: Bundle invalide (E2EE_CLE_*, E2EE_CAPACITE_INVALIDE, E2EE_OTPK_*) }
 *       404: { description: E2EE_INACTIF — chiffrement fermé pour ce compte }
 *       409: { description: E2EE_APPAREIL_INCONNU — reconnexion requise }
 */
router.post('/keys', auth, requireE2ee, postKeys);

/**
 * @swagger
 * /api/e2ee/keys:
 *   delete:
 *     summary: Retire l'identité de chiffrement de cet appareil (déconnexion)
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ retire: boolean } — toujours 200, même sans bundle publié" }
 *       409: { description: E2EE_APPAREIL_INCONNU — reconnexion requise }
 */
// Sans `requireE2ee` : retirer est toujours permis, y compris après qu'un
// palier a été refermé.
router.delete('/keys', auth, deleteKeys);

/**
 * @swagger
 * /api/e2ee/keys/signed-prekey:
 *   post:
 *     summary: Tourne le signed prekey de cet appareil (l'ancien reste servi)
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "Tourné, ou déjà en place (`tourne: false`)" }
 */
router.post('/keys/signed-prekey', auth, requireE2ee, postSignedPreKey);

/**
 * @swagger
 * /api/e2ee/keys/prekeys:
 *   post:
 *     summary: Regarnit le stock de clés à usage unique de cet appareil
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Stock mis à jour }
 */
router.post('/keys/prekeys', auth, requireE2ee, postOneTimePreKeys);

/**
 * @swagger
 * /api/e2ee/keys/state:
 *   get:
 *     summary: Bundle publié ? combien de clés à usage unique restent libres ?
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ appareilId, publie, registrationId, identityKey, capacite, signedPreKeyId, otpkLibres, seuil, regarnissageNecessaire }" }
 *       404: { description: E2EE_INACTIF — chiffrement fermé pour ce compte }
 */
router.get('/keys/state', auth, requireE2ee, getKeysState);

/**
 * @swagger
 * /api/e2ee/bundles:
 *   post:
 *     summary: Sert les bundles d'appareils tiers, une clé à usage unique réservée par appareil
 *     description: >
 *       POST et non GET malgré la lecture : chaque appel consomme des clés à
 *       usage unique, donc il n'est ni rejouable sans effet ni cachable.
 *       Un appareil n'est servi que s'il appartient à l'appelant ou à quelqu'un
 *       avec qui l'appelant partage déjà une conversation.
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [appareilIds]
 *             properties:
 *               appareilIds:
 *                 type: array
 *                 maxItems: 200
 *                 items: { type: integer }
 *     responses:
 *       200:
 *         description: >
 *           `bundles` (servis), `sansCles` (appareil connu mais sans bundle
 *           publié — l'émetteur enverra en clair), `refuses` (inconnu, révoqué
 *           ou sans conversation partagée)
 *       400: { description: E2EE_APPAREILS_INVALIDE / E2EE_APPAREILS_TROP }
 *       409: { description: E2EE_APPAREIL_INCONNU — reconnexion requise }
 */
router.post('/bundles', auth, requireE2ee, postBundles);

/**
 * @swagger
 * /api/e2ee/devices:
 *   get:
 *     summary: Appareils à qui chiffrer dans une conversation
 *     description: >
 *       `cibles` liste les appareils actifs des autres participants ET les
 *       autres appareils de l'appelant. `chiffrable` est faux dès qu'un
 *       appareil tiers n'a pas publié de bundle : l'émetteur envoie alors en
 *       clair, et aucun cadenas n'est affiché.
 *     tags: [E2EE]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: conversationID
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ conversationID, chiffrable, cibles, autresSansCles, mesAppareilsSansCles }" }
 *       400: { description: VALIDATION_FAILED }
 *       404: { description: NOT_A_MEMBER }
 *       409: { description: E2EE_APPAREIL_INCONNU — reconnexion requise }
 */
router.get('/devices', auth, requireE2ee, getConversationDevices);

/**
 * @swagger
 * /api/e2ee/en-attente:
 *   get:
 *     summary: Messages chiffrés dont l'enveloppe de cet appareil n'est pas remise (rattrapage des modifications et renvois manqués)
 *     tags: [E2EE]
 *     parameters:
 *       - in: query
 *         name: apres
 *         schema: { type: integer }
 *     responses:
 *       200: { description: "{ messages, hasMore, cursor }" }
 *       409: { description: E2EE_APPAREIL_INCONNU — reconnexion requise }
 */
router.get('/en-attente', auth, requireE2ee, getEnAttente);

module.exports = router;
