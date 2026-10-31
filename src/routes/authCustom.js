const express = require('express');
const router  = express.Router();
const { authCustom } = require('../middleware/authCustom');
const { authLimiter, registerLimiter } = require('../middleware/rateLimiter');
const {
  register,
  login,
  refreshToken,
  resetPassword,
  requestPasswordReset,
  validateOTP,
  completePasswordReset,
  getMe,
  updateMe,
  updateFcmToken,
  requestEmailChangeOtp,
  confirmEmailChange,
  changePassword,
  validateRecoveryCode,
  revealRecoveryCode,
} = require('../controllers/authCustomController');
const {
  createQrSession,
  getQrSessionStatus,
  approveQrSession,
  denyQrSession,
  listDeviceSessions,
  revokeDeviceSession,
} = require('../controllers/qrAuthController');
const {
  registerPushDevice,
  updatePushDeviceState,
  deletePushDevice,
} = require('../controllers/pushDevicesController');
const {
  getNotificationPrefs,
  patchNotificationPrefs,
} = require('../controllers/notificationPrefsController');
const {
  getPrivacyPrefs,
  patchPrivacyPrefs,
} = require('../controllers/privacyPrefsController');
const {
  getAppSettings,
  patchAppSettings,
} = require('../controllers/appSettingsController');
const {
  getDndSchedule,
  patchDndSchedule,
} = require('../controllers/dndScheduleController');
const {
  getVoicemailSchedule,
  patchVoicemailSchedule,
} = require('../controllers/voicemailScheduleController');
const {
  deleteAccount,
  cancelAccountDeletionHandler,
  exportAccountData,
  downloadExportJob,
  startAccountLifecycleSchedulers,
} = require('../controllers/accountLifecycleController');
const { getMyMedia } = require('../controllers/profileMediaController');

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Inscription (email optionnel, mot de passe requis)
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 description: Optionnel — uniquement pour la récupération de mot de passe
 *               password:
 *                 type: string
 *                 minLength: 6
 *                 description: Sans espace
 *               nom:
 *                 type: string
 *                 minLength: 3
 *                 description: Lettres, chiffres, espaces, - ' et _ (pas de ponctuation)
 *               pseudo:
 *                 type: string
 *                 minLength: 3
 *                 description: Mêmes règles que nom
 *               idPays:
 *                 type: integer
 *     responses:
 *       201:
 *         description: Compte créé
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *       429:
 *         description: "`REGISTER_RATE_LIMITED` — plafond d'inscriptions réussies par IP (défaut 3 / 24 h)"
 */
router.post('/register', authLimiter, registerLimiter, register);

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Connexion par numéro Alanya / mot de passe
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - alanyaPhone
 *               - password
 *             properties:
 *               alanyaPhone:
 *                 type: string
 *               password:
 *                 type: string
 *               fcm_token:
 *                 type: string
 *               device_ID:
 *                 type: string
 *               device_model:
 *                 type: string
 *               os_system:
 *                 type: string
 *     responses:
 *       200:
 *         description: Connexion réussie
 */
router.post('/login', authLimiter, login);

/**
 * @swagger
 * /api/auth/refresh:
 *   post:
 *     summary: Rafraîchit le token d'accès
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - refreshToken
 *             properties:
 *               refreshToken:
 *                 type: string
 *     responses:
 *       200:
 *         description: Nouveaux tokens
 */
router.post('/refresh',                   refreshToken);

/**
 * @swagger
 * /api/auth/reset-password:
 *   post:
 *     summary: Réinitialisation directe du mot de passe (ancien endpoint)
 *     tags: [Auth Custom]
 *     deprecated: true
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               email:
 *                 type: string
 *               newPassword:
 *                 type: string
 *     responses:
 *       200:
 *         description: Mot de passe réinitialisé
 */
router.post('/reset-password',            resetPassword);

/**
 * @swagger
 * /api/auth/forgot-password:
 *   post:
 *     summary: Étape 1 - Demande de réinitialisation (envoie un OTP par email)
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP envoyé si l'email existe
 */
router.post('/forgot-password', authLimiter, requestPasswordReset);

/**
 * @swagger
 * /api/auth/validate-otp:
 *   post:
 *     summary: Étape 2 - Valide l'OTP reçu par email
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: OTP valide, retourne un resetToken
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 resetToken:
 *                   type: string
 */
router.post('/validate-otp',              validateOTP);

/**
 * @swagger
 * /api/auth/reset-password-confirm:
 *   post:
 *     summary: Étape 3 - Réinitialisation du mot de passe avec le resetToken
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - resetToken
 *               - newPassword
 *             properties:
 *               resetToken:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Mot de passe réinitialisé avec succès
 */
router.post('/reset-password-confirm',    completePasswordReset);

/**
 * @swagger
 * /api/auth/recovery-code/validate:
 *   post:
 *     summary: Récupération sans e-mail - valide un code de récupération
 *     description: >
 *       Voie de secours des comptes sans adresse e-mail. Retourne le même
 *       resetToken que /validate-otp : enchaîner ensuite sur
 *       /reset-password-confirm. Réponse volontairement indifférenciée en cas
 *       d'échec (numéro inconnu, absence de code, code faux).
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - alanyaPhone
 *               - recoveryCode
 *             properties:
 *               alanyaPhone:
 *                 type: string
 *                 example: "12345678"
 *               recoveryCode:
 *                 type: string
 *                 description: Tirets, espaces et minuscules acceptés
 *                 example: "TQMP-KX3C-P6P5"
 *     responses:
 *       200:
 *         description: Code valide, retourne un resetToken (15 min)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 resetToken:
 *                   type: string
 *       401:
 *         description: Numéro ou code de récupération invalide
 *       403:
 *         description: Compte banni ou suppression en cours
 */
router.post('/recovery-code/validate', authLimiter, validateRecoveryCode);

/**
 * @swagger
 * /api/auth/me:
 *   get:
 *     summary: Récupère mon profil (Custom Auth)
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Profil utilisateur
 *   put:
 *     summary: Met à jour mon profil (Custom Auth)
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nom:
 *                 type: string
 *               pseudo:
 *                 type: string
 *               avatar_url:
 *                 type: string
 *               fcm_token:
 *                 type: string
 *               device_ID:
 *                 type: string
 *               is_online:
 *                 type: boolean
 *               idPays:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Profil mis à jour
 */
router.get('/me',         authCustom, getMe);
router.put('/me',         authCustom, updateMe);

/**
 * @swagger
 * /api/auth/me/email/request-otp:
 *   post:
 *     summary: Demande un OTP pour ajouter ou remplacer l'email du compte
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *     responses:
 *       200:
 *         description: OTP envoyé à la nouvelle adresse
 */
router.post('/me/email/request-otp', authCustom, authLimiter, requestEmailChangeOtp);

/**
 * @swagger
 * /api/auth/me/email/confirm:
 *   post:
 *     summary: Confirme l'OTP et applique le nouvel email
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - otp
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *     responses:
 *       200:
 *         description: Email mis à jour
 */
router.post('/me/email/confirm', authCustom, confirmEmailChange);

/**
 * @swagger
 * /api/auth/me/password:
 *   put:
 *     summary: Change le mot de passe (authentifié, mot de passe actuel requis)
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - currentPassword
 *               - newPassword
 *             properties:
 *               currentPassword:
 *                 type: string
 *               newPassword:
 *                 type: string
 *                 minLength: 6
 *     responses:
 *       200:
 *         description: Mot de passe modifié
 */
router.put('/me/password', authCustom, changePassword);

/**
 * @swagger
 * /api/auth/me/recovery-code/reveal:
 *   post:
 *     summary: Affiche le code de récupération du compte connecté
 *     description: >
 *       Le mot de passe est exigé : un appareil déverrouillé laissé sans
 *       surveillance ne doit pas suffire à repartir avec la clé de secours du
 *       compte. Le code ne change jamais, y compris après un changement de mot de
 *       passe. S'il est absent (compte antérieur à la migration 037), il est émis
 *       à la volée et persisté.
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Code de récupération en clair
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 recoveryCode:
 *                   type: string
 *                   example: "TQMP-KX3C-P6P5"
 *       401:
 *         description: Mot de passe incorrect
 */
router.post('/me/recovery-code/reveal', authCustom, authLimiter, revealRecoveryCode);

/**
 * @swagger
 * /api/auth/fcm-token:
 *   put:
 *     summary: Met à jour le token FCM pour les notifications push
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fcm_token
 *             properties:
 *               fcm_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: Token FCM mis à jour
 */
router.put('/fcm-token',  authCustom, updateFcmToken);

/**
 * @swagger
 * /api/auth/qr-session:
 *   post:
 *     summary: Ouvre une session de connexion par QR (appareil non connecté)
 *     description: >
 *       Sans authentification — c'est l'appareil qui n'est pas encore connecté
 *       qui appelle. Le `pollToken` retourné ici n'est jamais dans le QR : il
 *       est le seul moyen d'interroger la session et de récupérer les tokens.
 *     tags: [Auth Custom]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceId
 *             properties:
 *               deviceId:
 *                 type: string
 *                 description: Identifiant matériel de l'appareil demandeur
 *               deviceName:
 *                 type: string
 *               platform:
 *                 type: string
 *                 enum: [android, ios, web, unknown]
 *     responses:
 *       200:
 *         description: Session créée
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 sessionId:
 *                   type: string
 *                 scanSecret:
 *                   type: string
 *                 pollToken:
 *                   type: string
 *                 payload:
 *                   type: string
 *                   description: URL à encoder dans le QR
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 */
router.post('/qr-session', authLimiter, createQrSession);

/**
 * @swagger
 * /api/auth/qr-session/{sessionId}:
 *   get:
 *     summary: Statut d'une session de connexion par QR
 *     description: >
 *       Sans authentification. Les tokens ne sont livrés qu'une seule fois :
 *       le premier appel retournant `approved` détruit la session.
 *     tags: [Auth Custom]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: pollToken
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Statut (pending, scanned, approved, denied, expired)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 user:
 *                   type: object
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *       404:
 *         description: Session inconnue ou pollToken invalide
 */
router.get('/qr-session/:sessionId', getQrSessionStatus);

/**
 * @swagger
 * /api/auth/qr-session/{sessionId}/approve:
 *   post:
 *     summary: Approuve une connexion par QR (appareil déjà connecté)
 *     description: >
 *       Seul point d'approbation — appelé après confirmation explicite de
 *       l'utilisateur sur un écran dédié, jamais depuis /api/qr/resolve.
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - scanSecret
 *             properties:
 *               scanSecret:
 *                 type: string
 *                 description: Secret lu dans le QR scanné
 *     responses:
 *       200:
 *         description: Connexion approuvée
 *       404:
 *         description: Session inconnue, expirée ou scanSecret invalide
 *       409:
 *         description: Session déjà traitée
 */
router.post('/qr-session/:sessionId/approve', authCustom, approveQrSession);

/**
 * @swagger
 * /api/auth/qr-session/{sessionId}/deny:
 *   post:
 *     summary: Refuse une connexion par QR (appareil déjà connecté)
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - scanSecret
 *             properties:
 *               scanSecret:
 *                 type: string
 *     responses:
 *       200:
 *         description: Connexion refusée
 */
router.post('/qr-session/:sessionId/deny', authCustom, denyQrSession);

/**
 * @swagger
 * /api/auth/device-sessions:
 *   get:
 *     summary: Liste les appareils connectés au compte
 *     tags: [Auth Custom]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Appareils actifs, le plus récemment actif en premier
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:
 *                     type: integer
 *                   deviceName:
 *                     type: string
 *                   platform:
 *                     type: string
 *                   loginMethod:
 *                     type: string
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *                   lastActiveAt:
 *                     type: string
 *                     format: date-time
 *                   current:
 *                     type: boolean
 */
router.get('/device-sessions', authCustom, listDeviceSessions);

/**
 * @swagger
 * /api/auth/device-sessions/{id}:
 *   delete:
 *     summary: Déconnecte un appareil (révocation immédiate de ses tokens)
 *     tags: [Auth Custom]
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
 *         description: Appareil déconnecté
 *       404:
 *         description: Appareil introuvable
 */
router.delete('/device-sessions/:id', authCustom, revokeDeviceSession);

router.post('/push-devices/register', authCustom, registerPushDevice);
router.post('/push-devices/state', authCustom, updatePushDeviceState);
router.delete('/push-devices/:deviceId', authCustom, deletePushDevice);

router.get('/notification-prefs', authCustom, getNotificationPrefs);
router.patch('/notification-prefs', authCustom, patchNotificationPrefs);

router.get('/privacy-prefs', authCustom, getPrivacyPrefs);
router.patch('/privacy-prefs', authCustom, patchPrivacyPrefs);

router.get('/app-settings', authCustom, getAppSettings);
router.patch('/app-settings', authCustom, patchAppSettings);

router.get('/dnd-schedule', authCustom, getDndSchedule);
router.patch('/dnd-schedule', authCustom, patchDndSchedule);

// Le répondeur est un réglage distinct du « Ne pas déranger » : celui-ci ne
// coupe que les notifications de messages, celui-là empêche le téléphone de
// sonner. Les greffer sur le même interrupteur détournerait les appels de tous
// ceux qui ont déjà réglé un créneau DND.
router.get('/voicemail-schedule', authCustom, getVoicemailSchedule);
router.patch('/voicemail-schedule', authCustom, patchVoicemailSchedule);

router.delete('/me', authCustom, deleteAccount);
router.post('/me/cancel-deletion', authCustom, cancelAccountDeletionHandler);
router.get('/me/media', authCustom, getMyMedia);
router.post('/me/export', authCustom, exportAccountData);
router.get('/me/export/:jobId', authCustom, downloadExportJob);

module.exports = router;
