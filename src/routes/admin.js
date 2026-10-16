const express = require('express');
const router = express.Router();
// `superAdminAuth` n'est plus utilisé ici : chaque route déclare désormais la
// permission qu'elle exige plutôt que le niveau qu'elle suppose. Le middleware
// reste exporté — il redevient utile le jour où une route hors de ce routeur
// aurait besoin d'un garde par niveau.
const { adminAuth, requirePermission } = require('../middleware/adminAuth');
const { adminAudit } = require('../middleware/adminAudit');

// Journal des actions : monté une fois pour tout le routeur, avant les routes.
// L'écriture a lieu après la réponse — voir `middleware/adminAudit.js` pour
// pourquoi ce n'est pas dans les contrôleurs.
router.use(adminAudit);
const { getPurges, updatePurge, runPurgeNow } = require('../controllers/admin/purges');
const { getSafeboxAdmin, updateSafeboxSettings } = require('../controllers/admin/safebox');
const { getServiceHealth } = require('../controllers/admin/health');
const { getAudit, getAuditActions } = require('../controllers/admin/audit');
const {
  getBackupKeyAccess,
  getBackupKeyAccessSummary,
} = require('../controllers/admin/backupAccess');
const {
  getBackupOverview,
  getBackupKeyUsage,
} = require('../controllers/admin/backups');
const {
  getKeys,
  rotateKey,
  retireKey,
} = require('../controllers/admin/backupKeys');
const {
  getSecuritySettings,
  updateSecuritySettings,
} = require('../controllers/admin/securitySettings');
const {
  getE2eeSettings,
  updateE2eeSettings,
} = require('../controllers/admin/e2eeSettings');
const { getReports, getReportActions, postReportAction } = require('../controllers/admin/reports');
const {
  adminLogin,
  getStats,
  getAnalytics,
  getTripStats,
  getTripRetention,
  runTripPurge,
  getActivityFeed,
  getAllMedia,
  deleteMedia,
  getAllGroups,
  getGroupById,
  deleteGroup,
  getAllMeetings,
  endMeeting,
  deleteMeeting,
  getSettings,
  updateSettings,
  getUsers,
  getUserById,
  getUserActivity,
  getUserLogins,
  banUser,
  unbanUser,
  setAccountType,
  setUserSocle,
  deleteUser,
  createUser,
  updateUserPhone,
  getUserPhoneHistory,
  listReservedPhones,
  checkAssignablePhone,
  addReservedPhone,
  removeReservedPhone,
  getMe,
  updateMe,
  updatePassword,
  exportUsers,
  exportAnalytics,
} = require('../controllers/adminController');
const { getAiStatus, postTranslate, postReview } = require('../controllers/admin/aiEditorial');
const {
  broadcastSendLimiter,
  broadcastEstimateLimiter,
  aiEditorialLimiter,
} = require('../middleware/rateLimiter');

/**
 * @swagger
 * /api/admin/auth/login:
 *   post:
 *     summary: Connexion admin
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Connexion réussie
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:
 *                   type: string
 *                 refreshToken:
 *                   type: string
 *                 user:
 *                   type: object
 */
router.post('/auth/login', adminLogin);

// ── Profil admin ──
router.get('/me',                            adminAuth, requirePermission('profile.read'), getMe);
router.put('/me',                            adminAuth, requirePermission('profile.update'), updateMe);
router.put('/me/password',                   adminAuth, requirePermission('profile.password'), updatePassword);

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Statistiques du tableau de bord
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Date début (ISO)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Date fin (ISO)
 *     responses:
 *       200:
 *         description: Statistiques
 */
router.get('/stats',                       adminAuth, requirePermission('stats.read'), getStats);

/**
 * @swagger
 * /api/admin/analytics:
 *   get:
 *     summary: Analytics avancées (messagerie, appels, stories, réunions, users)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Date début (ISO, défaut J-7)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Date fin (ISO, défaut maintenant)
 *     responses:
 *       200:
 *         description: Agrégations analytiques groupées par domaine
 */
router.get('/analytics',                   adminAuth, requirePermission('stats.read'), getAnalytics);

/**
 * @swagger
 * /api/admin/trips:
 *   get:
 *     summary: Compteurs agrégés des trajets de confiance (sans identité ni coordonnées)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *         description: Date début (ISO, défaut J-7)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *         description: Date fin (ISO, défaut maintenant)
 *     responses:
 *       200:
 *         description: KPIs anonymes (démarrés, issues, durées, SOS)
 */
router.get('/trips',                       adminAuth, requirePermission('trips.read'), getTripStats);

/**
 * @swagger
 * /api/admin/trips/retention:
 *   get:
 *     summary: État de la rétention des traces GPS (compteurs seuls, sans identité)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Durées de rétention, volumes stockés et purgeables, journal des purges
 */
router.get('/trips/retention',             adminAuth, requirePermission('trips.read'), getTripRetention);

/**
 * @swagger
 * /api/admin/trips/retention/purge:
 *   post:
 *     summary: Purge manuelle des traces GPS (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               scope:
 *                 type: string
 *                 enum: [retention, all]
 *                 description: >
 *                   `retention` applique la politique tout de suite ;
 *                   `all` efface la trace de tous les trajets clos.
 *                   Les trajets en cours ne sont jamais touchés.
 *     responses:
 *       200:
 *         description: Compteurs après purge et journal mis à jour
 */
router.post('/trips/retention/purge',      adminAuth, requirePermission('trips.purge'), runTripPurge);

/**
 * @swagger
 * /api/admin/health:
 *   get:
 *     summary: Santé du service — file de jobs, purges, Redis, pool MySQL
 *     tags: [Admin]
 *     description: >
 *       Le versant qu'une sonde externe ne peut pas voir : un job en échec
 *       silencieux, une purge qui ne tourne plus, un pool saturé. Distinct de
 *       `/health`, qui est public et se limite à « le serveur répond-il ».
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: État des dépendances et des traitements de fond }
 */
router.get('/health',                      adminAuth, requirePermission('stats.read'), getServiceHealth);

/**
 * @swagger
 * /api/admin/purges:
 *   get:
 *     summary: État des purges de rétention (réglages, volumétrie purgeable, historique)
 *     tags: [Admin]
 *     description: >
 *       `?stats=0` renvoie les réglages sans les comptages, qui balaient
 *       plusieurs tables — utile pour un simple rafraîchissement d'état.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Liste des purges }
 */
router.get('/purges',                      adminAuth, requirePermission('purges.read'), getPurges);

/**
 * @swagger
 * /api/admin/purges/{name}:
 *   put:
 *     summary: Activer/desactiver une purge ou changer ses durees de retention
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Reglage mis a jour }
 *       404: { description: Purge inconnue }
 */
router.put('/purges/:name',                adminAuth, requirePermission('purges.settings'), updatePurge);

/**
 * @swagger
 * /api/admin/purges/{name}/run:
 *   post:
 *     summary: Executer une purge immediatement
 *     tags: [Admin]
 *     description: >
 *       Independant de l'interrupteur : garder la main pour purger
 *       ponctuellement tout en laissant le balayage automatique coupe est
 *       l'usage attendu.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Purge executee }
 *       404: { description: Purge inconnue }
 */
router.post('/purges/:name/run',           adminAuth, requirePermission('purges.run'), runPurgeNow);

/**
 * @swagger
 * /api/admin/safebox:
 *   get:
 *     summary: Coffre-fort — volume stocké (compté et réel chez MEGA), coffres, familles, plus gros consommateurs, partages, réglages
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 * /api/admin/safebox/settings:
 *   put:
 *     summary: Coffre-fort — espace de base, tailles maximales, profondeur, nombre de dossiers, téléchargements par jour, extensions (super-admin)
 *     tags: [Admin]
 *     security: [{ bearerAuth: [] }]
 */
router.get('/safebox',                     adminAuth, requirePermission('safebox.read'), getSafeboxAdmin);
router.put('/safebox/settings',            adminAuth, requirePermission('safebox.settings'), updateSafeboxSettings);

/**
 * @swagger
 * /api/admin/activity:
 *   get:
 *     summary: Feed d'activité récente (événements fusionnés et triés)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Liste des derniers événements
 */
router.get('/activity',                    adminAuth, requirePermission('stats.read'), getActivityFeed);

/**
 * @swagger
 * /api/admin/media:
 *   get:
 *     summary: Médias partagés (images, vidéos, audios, fichiers)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: integer
 *           enum: [1, 2, 3, 4]
 *         description: 1=image 2=vidéo 3=audio 4=fichier
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *     responses:
 *       200:
 *         description: Liste des médias
 */
router.get('/media',                       adminAuth, requirePermission('media.read'), getAllMedia);

/**
 * @swagger
 * /api/admin/media/{id}:
 *   delete:
 *     summary: Masque un média (soft-delete du message)
 *     tags: [Admin]
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
 *         description: Média supprimé
 *       404:
 *         description: Média introuvable
 */
router.delete('/media/:id',                adminAuth, requirePermission('media.delete'), deleteMedia);

/**
 * @swagger
 * /api/admin/meetings:
 *   get:
 *     summary: Toutes les réunions de l'application
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *     responses:
 *       200:
 *         description: Liste des réunions
 */
router.get('/meetings',                    adminAuth, requirePermission('meetings.read'), getAllMeetings);

/**
 * @swagger
 * /api/admin/meetings/{id}/end:
 *   post:
 *     summary: Termine une réunion en cours
 *     tags: [Admin]
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
 *         description: Réunion terminée
 *       404:
 *         description: Réunion introuvable
 */
router.post('/meetings/:id/end',           adminAuth, requirePermission('meetings.end'), endMeeting);

/**
 * @swagger
 * /api/admin/meetings/{id}:
 *   delete:
 *     summary: Supprime une réunion (+ participants)
 *     tags: [Admin]
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
 *         description: Réunion supprimée
 *       404:
 *         description: Réunion introuvable
 */
router.delete('/meetings/:id',             adminAuth, requirePermission('meetings.delete'), deleteMeeting);

/**
 * @swagger
 * /api/admin/settings:
 *   get:
 *     summary: Paramètres applicatifs (maintenance, nom, URL API)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Paramètres courants
 *   put:
 *     summary: Met à jour les paramètres (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               maintenance:
 *                 type: boolean
 *               appName:
 *                 type: string
 *               apiUrl:
 *                 type: string
 *     responses:
 *       200:
 *         description: Paramètres mis à jour
 */
router.get('/settings',                    adminAuth, requirePermission('settings.read'), getSettings);
router.put('/settings',                    adminAuth, requirePermission('settings.write'), updateSettings);

/**
 * @swagger
 * /api/admin/security-settings:
 *   get:
 *     summary: Verrouillage de la connexion sur les appareils enrôlés
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: État du verrou
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deviceBindingEnabled:
 *                   type: boolean
 *                 updatedAt:
 *                   type: string
 *   put:
 *     summary: Arme ou désarme le verrou (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - deviceBindingEnabled
 *             properties:
 *               deviceBindingEnabled:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Verrou mis à jour — propagation aux autres instances en 30 s
 */
// Mêmes permissions que les réglages applicatifs : `settings.write` est déjà
// réservée au super-admin, et désarmer un verrou de sécurité n'appelle pas un
// niveau plus bas.
router.get('/security-settings',           adminAuth, requirePermission('settings.read'), getSecuritySettings);
router.put('/security-settings',           adminAuth, requirePermission('settings.write'), updateSecuritySettings);

/**
 * @swagger
 * /api/admin/e2ee-settings:
 *   get:
 *     summary: État de l'interrupteur du chiffrement de bout en bout
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Crans ouverts et cohorte
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enrolEnabled:
 *                   type: boolean
 *                 activateEnabled:
 *                   type: boolean
 *                 cohortPercent:
 *                   type: integer
 *                 cohortIds:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 updatedAt:
 *                   type: string
 *   put:
 *     summary: Ouvre ou ferme un cran, règle la cohorte (super-admin)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enrolEnabled:
 *                 type: boolean
 *               activateEnabled:
 *                 type: boolean
 *               cohortPercent:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *               cohortIds:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Interrupteur mis à jour — propagation aux autres instances en 30 s
 *       400:
 *         description: Réglage invalide (INVALID_E2EE_SETTING)
 */
// Mêmes permissions que le verrouillage d'appareil : `settings.write` est
// réservée au super-admin, et ouvrir un palier du chiffrement est un geste qui
// ne se défait pas pour les conversations déjà activées.
router.get('/e2ee-settings',               adminAuth, requirePermission('settings.read'), getE2eeSettings);
router.put('/e2ee-settings',               adminAuth, requirePermission('settings.write'), updateE2eeSettings);

/**
 * @swagger
 * /api/admin/groups:
 *   get:
 *     summary: Tous les groupes de l'application
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 200
 *     responses:
 *       200:
 *         description: Liste des groupes
 */
router.get('/groups',                      adminAuth, requirePermission('groups.read'), getAllGroups);

/**
 * @swagger
 * /api/admin/groups/{id}:
 *   get:
 *     summary: Détails d'un groupe + membres
 *     tags: [Admin]
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
 *         description: Détails du groupe
 *       404:
 *         description: Groupe introuvable
 *   delete:
 *     summary: Supprime un groupe (messages + participants)
 *     tags: [Admin]
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
 *         description: Groupe supprimé
 */
router.get('/groups/:id',                  adminAuth, requirePermission('groups.read'), getGroupById);
router.delete('/groups/:id',               adminAuth, requirePermission('groups.delete'), deleteGroup);

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Liste paginée des utilisateurs
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [online, banned, admin]
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date
 *       - in: query
 *         name: idPays
 *         schema:
 *           type: integer
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *     responses:
 *       200:
 *         description: Liste des utilisateurs
 */
router.get('/users/export',                   adminAuth, requirePermission('users.export'), exportUsers);
router.get('/analytics/export',               adminAuth, requirePermission('analytics.export'), exportAnalytics);
router.get('/users',                       adminAuth, requirePermission('users.read'), getUsers);
router.post('/users',                      adminAuth, requirePermission('users.create'), createUser);

/**
 * @swagger
 * /api/admin/users/{id}:
 *   get:
 *     summary: Détails d'un utilisateur
 *     tags: [Admin]
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
 *         description: Détails utilisateur
 *   delete:
 *     summary: Supprime un utilisateur (super-admin)
 *     tags: [Admin]
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
 *         description: Utilisateur supprimé
 */
router.get('/users/:id',                   adminAuth, requirePermission('users.read'), getUserById);

/**
 * @swagger
 * /api/admin/users/{id}/activity:
 *   get:
 *     summary: Activité d'un utilisateur
 *     tags: [Admin]
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
 *         description: Compteurs d'activité
 */
router.get('/users/:id/activity',          adminAuth, requirePermission('users.read'), getUserActivity);

/**
 * @swagger
 * /api/admin/users/{id}/logins:
 *   get:
 *     summary: Historique des connexions d'un utilisateur
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *     responses:
 *       200:
 *         description: Historique des connexions
 */
router.get('/users/:id/logins',            adminAuth, requirePermission('users.read'), getUserLogins);

// Journal des actions administrateur. Filtrable : sans filtre pour la page
// « Activité admin », avec `targetType`/`targetId` pour l'encart d'une fiche.
router.get('/audit',                       adminAuth, requirePermission('audit.read'), getAudit);
router.get('/audit/actions',               adminAuth, requirePermission('audit.read'), getAuditActions);

// Journal des clés de sauvegarde. Même permission que l'audit — c'est le même
// métier — mais une route à part : ce sont des milliers d'opérations de
// routine, elles n'ont rien à faire dans le journal des gestes d'administrateur.
router.get('/backup/key-access',            adminAuth, requirePermission('audit.read'), getBackupKeyAccess);
router.get('/backup/key-access/summary',    adminAuth, requirePermission('audit.read'), getBackupKeyAccessSummary);

// État des sauvegardes du parc. Lecture seule, et il ne peut pas en être
// autrement : le serveur ne détient aucune archive.
router.get('/backup/overview',              adminAuth, requirePermission('stats.read'), getBackupOverview);
router.get('/backup/key-usage',             adminAuth, requirePermission('stats.read'), getBackupKeyUsage);

// Versions de clé. La lecture au niveau admin — savoir où l'on en est n'est
// pas un pouvoir. L'écriture au super-admin : une rotation mal conduite rend
// illisibles les sauvegardes déjà déposées. Aucune route ne SUPPRIME une
// version, et c'est délibéré.
router.get('/backup/keys',                  adminAuth, requirePermission('settings.read'), getKeys);
router.post('/backup/keys',                 adminAuth, requirePermission('backup.keys'), rotateKey);
router.post('/backup/keys/:kid/retire',     adminAuth, requirePermission('backup.keys'), retireKey);

// ── File de modération ──
router.get('/reports',                     adminAuth, requirePermission('reports.read'), getReports);
router.get('/reports/:id/actions',         adminAuth, requirePermission('reports.read'), getReportActions);
router.post('/reports/:id/actions',        adminAuth, requirePermission('reports.handle'), postReportAction);

/**
 * @swagger
 * /api/admin/users/{id}/ban:
 *   post:
 *     summary: Bannir un utilisateur
 *     tags: [Admin]
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
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Utilisateur banni
 *   delete:
 *     summary: Débannir un utilisateur
 *     tags: [Admin]
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
 *         description: Utilisateur débanni
 */
router.post('/users/:id/ban',              adminAuth, requirePermission('users.ban'), banUser);
router.delete('/users/:id/ban',            adminAuth, requirePermission('users.unban'), unbanUser);

/**
 * @swagger
 * /api/admin/users/{id}/role:
 *   put:
 *     summary: Modifie le rôle d'un utilisateur (super-admin)
 *     tags: [Admin]
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
 *               - type_compte
 *             properties:
 *               type_compte:
 *                 type: integer
 *                 enum: [0, 1, 2]
 *                 description: 0=utilisateur, 1=admin, 2=super-admin
 *     responses:
 *       200:
 *         description: Rôle mis à jour
 */
router.put('/users/:id/role',              adminAuth, requirePermission('users.role'), setAccountType);
router.put('/users/:id/socle',             adminAuth, requirePermission('users.socle'), setUserSocle);
router.put('/users/:id/phone',             adminAuth, requirePermission('users.phone'), updateUserPhone);
router.get('/users/:id/phone-history',     adminAuth, requirePermission('users.read'), getUserPhoneHistory);
router.delete('/users/:id',                adminAuth, requirePermission('users.delete'), deleteUser);

router.get('/alanya-phones/check-assignable', adminAuth, requirePermission('phones.read'), checkAssignablePhone);
router.get('/reserved-alanya-phones',      adminAuth, requirePermission('phones.read'), listReservedPhones);
router.post('/reserved-alanya-phones',     adminAuth, requirePermission('phones.reserve'), addReservedPhone);
router.delete('/reserved-alanya-phones/:phone', adminAuth, requirePermission('phones.release'), removeReservedPhone);

const {
  listBroadcasts,
  getBroadcast,
  estimateBroadcast,
  createBroadcast,
  cancelScheduled,
} = require('../controllers/admin/broadcast');
const { getVilles } = require('../controllers/admin/villes');
const {
  getOfficialAccount,
  createOfficialAccount,
} = require('../controllers/admin/officialAccount');
const {
  getWelcome,
  updateDraft,
  publish,
  backfill,
  getStatusConfig,
  updateStatusConfig,
} = require('../controllers/admin/welcome');

// Le compte officiel est unique et se crée sans aucune saisie. Sa création est
// un acte irréversible : super-admin, comme setUserSocle et deleteUser.
router.get('/official-account', adminAuth, requirePermission('official.read'), getOfficialAccount);
router.post('/official-account', adminAuth, requirePermission('official.create'), createOfficialAccount);

router.get('/broadcasts', adminAuth, requirePermission('broadcasts.read'), listBroadcasts);
router.get('/broadcasts/:id', adminAuth, requirePermission('broadcasts.read'), getBroadcast);
router.post('/broadcasts/estimate', adminAuth, requirePermission('broadcasts.read'), broadcastEstimateLimiter, estimateBroadcast);
router.post('/broadcasts', adminAuth, requirePermission('broadcasts.send'), broadcastSendLimiter, createBroadcast);
router.delete('/broadcasts/scheduled/:jobId', adminAuth, requirePermission('broadcasts.cancel'), cancelScheduled);
router.get('/villes', adminAuth, requirePermission('villes.read'), getVilles);

router.get('/welcome', adminAuth, requirePermission('welcome.read'), getWelcome);
router.put('/welcome/draft', adminAuth, requirePermission('welcome.draft'), updateDraft);
router.post('/welcome/publish', adminAuth, requirePermission('welcome.publish'), publish);
router.post('/welcome/backfill', adminAuth, requirePermission('welcome.backfill'), backfill);
// Statut de bienvenue : réglage global, appliqué sans publication.
router.get('/welcome/status', adminAuth, requirePermission('welcome.read'), getStatusConfig);
router.put('/welcome/status', adminAuth, requirePermission('welcome.status'), updateStatusConfig);

// ── Assistance éditoriale ──
// Traduire et relire le contenu officiel. N'écrit rien en base : ces routes
// remplissent le formulaire, la publication reste gardée par `welcome.*` et
// `broadcasts.send`. POST malgré tout — le texte voyage dans le corps.
router.get('/ai/status', adminAuth, requirePermission('ai.editorial'), getAiStatus);
router.post('/ai/translate', adminAuth, requirePermission('ai.editorial'), aiEditorialLimiter, postTranslate);
router.post('/ai/review', adminAuth, requirePermission('ai.editorial'), aiEditorialLimiter, postReview);

const {
  getBillingSettings,
  updateBillingSettings,
  setBillingModel,
  activateBilling,
  deactivateBilling,
  extendBillingGrace,
  listBillingPlans,
  createBillingPlan,
  updateBillingPlan,
  listBillingFeatures,
  updateBillingFeature,
} = require('../controllers/admin/billing');
const {
  generateBillingCodes,
  listBillingCodes,
  revokeBillingCode,
} = require('../controllers/admin/billingCodes');

// Abonnement Alanya Plus. Lecture au niveau admin ; l'interrupteur, ses
// réglages et le catalogue au super-admin. Une route par transition — activer,
// désactiver, prolonger — et non un PUT générique : chacune a ses
// préconditions, et le journal enregistre un verbe explicite avec le motif.
router.get('/billing/settings',           adminAuth, requirePermission('billing.read'), getBillingSettings);
router.put('/billing/settings',           adminAuth, requirePermission('billing.settings'), updateBillingSettings);
router.post('/billing/model',             adminAuth, requirePermission('billing.settings'), setBillingModel);
router.post('/billing/activate',          adminAuth, requirePermission('billing.settings'), activateBilling);
router.post('/billing/deactivate',        adminAuth, requirePermission('billing.settings'), deactivateBilling);
router.post('/billing/extend-grace',      adminAuth, requirePermission('billing.settings'), extendBillingGrace);
router.get('/billing/plans',              adminAuth, requirePermission('billing.read'), listBillingPlans);
router.post('/billing/plans',             adminAuth, requirePermission('billing.plans'), createBillingPlan);
router.put('/billing/plans/:id',          adminAuth, requirePermission('billing.plans'), updateBillingPlan);
router.get('/billing/features',           adminAuth, requirePermission('billing.read'), listBillingFeatures);
router.put('/billing/features/:code',     adminAuth, requirePermission('billing.plans'), updateBillingFeature);

// Codes d'activation (régime essai). Les lister est une lecture ; en générer ou
// en annuler un décide de l'argent des autres : super-admin, avec motif pour
// l'annulation. Les codes en clair ne sortent que de la génération.
router.get('/billing/codes',              adminAuth, requirePermission('billing.read'), listBillingCodes);
router.post('/billing/codes',             adminAuth, requirePermission('billing.codes'), generateBillingCodes);
router.post('/billing/codes/:id/revoke',  adminAuth, requirePermission('billing.codes'), revokeBillingCode);

const {
  listBillingPayments,
  listBillingSubscribers,
  getUserBilling,
  giftSubscription,
  revokeBadge,
  restoreBadge,
} = require('../controllers/admin/billingAccounts');

// Paiements et abonnés : lecture au niveau admin. Offrir un abonnement est un
// geste commercial — une période sans paiement — réservé au super-admin et
// journalisé avec son motif.
router.get('/billing/payments',           adminAuth, requirePermission('billing.read'), listBillingPayments);
router.get('/billing/subscribers',        adminAuth, requirePermission('billing.read'), listBillingSubscribers);
router.get('/users/:id/billing',          adminAuth, requirePermission('billing.read'), getUserBilling);
router.post('/users/:id/billing/gift',    adminAuth, requirePermission('billing.gift'), giftSubscription);
router.post('/users/:id/badge/revoke',    adminAuth, requirePermission('verifications.decide'), revokeBadge);
router.post('/users/:id/badge/restore',   adminAuth, requirePermission('verifications.decide'), restoreBadge);

const {
  listVerifications,
  countVerifications,
  getVerification,
  getVerificationDocument,
  approveVerification,
  refuseVerification,
  requestVerificationDocument,
  revokeVerification,
  reconfirmVerification,
} = require('../controllers/admin/verification');

// Dossiers de vérification d'identité. Tout administrateur instruit (volet 5),
// l'auteur de chaque décision est tracé ; chaque ouverture de pièce est
// journalisée dans sa propre table.
router.get('/verifications',                        adminAuth, requirePermission('verifications.read'), listVerifications);
router.get('/verifications/count',                  adminAuth, requirePermission('verifications.read'), countVerifications);
router.get('/verifications/documents/:docId',       adminAuth, requirePermission('verifications.read'), getVerificationDocument);
router.get('/verifications/:id',                    adminAuth, requirePermission('verifications.read'), getVerification);
router.post('/verifications/:id/approve',           adminAuth, requirePermission('verifications.decide'), approveVerification);
router.post('/verifications/:id/refuse',            adminAuth, requirePermission('verifications.decide'), refuseVerification);
router.post('/verifications/:id/request-document',  adminAuth, requirePermission('verifications.decide'), requestVerificationDocument);
router.post('/verifications/:id/revoke',            adminAuth, requirePermission('verifications.decide'), revokeVerification);
router.post('/verifications/:id/reconfirm',         adminAuth, requirePermission('verifications.decide'), reconfirmVerification);

// ── Stickers (type 10) — plan §6.4 ──────────────────────────────────────
// Charger le catalogue et modérer est le travail de l'admin ; publier un pack
// et régler le lancement engagent tous les comptes, donc super-admin. Le même
// pipeline d'upload que le script de chargement est réutilisé (uploadSticker).
const {
  listPacks: listStickerPacks,
  getPack: getStickerPack,
  createPack: createStickerPack,
  updatePack: updateStickerPack,
  addStickers: addStickerAssets,
  updateSticker: updateStickerItem,
  deleteSticker: deleteStickerItem,
  publishPack: publishStickerPack,
  archivePack: archiveStickerPack,
  getSettings: getStickersSettings,
  updateSettings: updateStickersSettings,
  listReports: listStickerReports,
  takedownAsset: takedownStickerAsset,
} = require('../controllers/admin/stickers');
const { uploadSticker, handleMulterError } = require('../middleware/upload');

router.get('/sticker-packs',                      adminAuth, requirePermission('stickers.read'), listStickerPacks);
router.get('/sticker-packs/:id',                  adminAuth, requirePermission('stickers.read'), getStickerPack);
router.post('/sticker-packs',                     adminAuth, requirePermission('stickers.write'), createStickerPack);
router.patch('/sticker-packs/:id',                adminAuth, requirePermission('stickers.write'), updateStickerPack);
router.post(
  '/sticker-packs/:id/stickers',
  adminAuth,
  requirePermission('stickers.write'),
  uploadSticker.array('files', 40),
  handleMulterError,
  addStickerAssets,
);
router.patch('/stickers/:id',                     adminAuth, requirePermission('stickers.write'), updateStickerItem);
router.delete('/stickers/:id',                    adminAuth, requirePermission('stickers.write'), deleteStickerItem);
router.post('/sticker-packs/:id/publish',         adminAuth, requirePermission('stickers.publish'), publishStickerPack);
router.post('/sticker-packs/:id/archive',         adminAuth, requirePermission('stickers.publish'), archiveStickerPack);
router.get('/sticker-settings',                   adminAuth, requirePermission('stickers.read'), getStickersSettings);
router.put('/sticker-settings',                   adminAuth, requirePermission('stickers.settings'), updateStickersSettings);
router.get('/sticker-reports',                    adminAuth, requirePermission('stickers.moderate'), listStickerReports);
router.post('/sticker-assets/:id/takedown',       adminAuth, requirePermission('stickers.moderate'), takedownStickerAsset);

module.exports = router;
