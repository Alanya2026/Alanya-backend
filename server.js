require('dotenv').config();

// ── Sentry — AVANT tout le reste ──────────────────────────────────────
// Le SDK instrumente Express, MySQL et HTTP en les remplaçant au chargement :
// requis après eux, il n'accrocherait plus rien. Inerte sans `SENTRY_DSN`.
const { Sentry, capturer: capturerSentry, vider: viderSentry } = require('./src/config/sentry');

// ── Firebase Admin — initialisé avant tout autre require ──────────────
require('./src/config/firebase');

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const cors       = require('cors');
const { REDIS_ENABLED, REDIS_URL, createRedisClient, connectWithTimeout } = require('./src/config/redis');
const { setDataClient } = require('./src/config/redisData');
const pool = require('./src/config/db');

// Rempli par `start()` quand Redis est configuré, pour que l'arrêt propre
// puisse rendre ces connexions au lieu de les abandonner.
const clientsRedis = [];

const errorHandler = require('./src/middleware/errorHandler');
const { generalLimiter, mediaReadLimiter } = require('./src/middleware/rateLimiter');

const swaggerUi   = require('swagger-ui-express');
const swaggerSpec = require('./src/config/swagger');

// ── Routes ────────────────────────────────────────────────────────────
const authCustomRoutes   = require('./src/routes/authCustom');
const paysRoutes         = require('./src/routes/pays');
const userRoutes         = require('./src/routes/users');
const conversationRoutes = require('./src/routes/conversations');
const messageRoutes      = require('./src/routes/messages');
const messageOpsRoutes   = require('./src/routes/messageOps');
const statusRoutes       = require('./src/routes/status');
const callRoutes         = require('./src/routes/calls');
const meetingRoutes      = require('./src/routes/meetings');
const notifyRoutes       = require('./src/routes/notify');
const uploadRoutes       = require('./src/routes/upload');
const contactRoutes      = require('./src/routes/contacts');
const contactListRoutes  = require('./src/routes/contactLists');
const backupRoutes       = require('./src/routes/backup');
const billingRoutes      = require('./src/routes/billing');
const paymentsRoutes     = require('./src/routes/payments');
const alanyaPhoneRoutes  = require('./src/routes/alanyaPhone');
// verificationRoutes : tables et contrôleurs conservés, route non montée
// (comptes personnels sans dossier ; business plus tard).
const mediaAvailRoutes   = require('./src/routes/mediaAvailability');
const tripRoutes         = require('./src/routes/trips');
const qrRoutes           = require('./src/routes/qr');
const turnRoutes         = require('./src/routes/turn');
const mapRoutes          = require('./src/routes/mapTiles');
const adminRoutes        = require('./src/routes/admin');
const welcomeRoutes      = require('./src/routes/welcome');
const reportRoutes       = require('./src/routes/reports');
const e2eeKeysRoutes     = require('./src/routes/e2eeKeys');
const stickerRoutes      = require('./src/routes/stickers');
const safeboxRoutes      = require('./src/routes/safebox');
const documentsSensiblesRoutes = require('./src/routes/documentsSensibles');
const qrLandingRoutes    = require('./src/routes/qrLanding');
const legalRoutes        = require('./src/routes/legal');
const healthRoutes       = require('./src/routes/health');

// ── Socket handlers ───────────────────────────────────────────────────
const socketAuth = require('./src/socket/handlers/auth');
const qrLoginSocket = require('./src/socket/handlers/qrLogin');
const { adminOps } = require('./src/socket/handlers/adminOps');
const {
  joinConversation, messageSend, typingStart, typingStop,
  messageDelivered, messageRead,
  presenceOnline, presenceOffline, handleDisconnect,
} = require('./src/socket/handlers/chat');

const {
  tripSubscribe, tripUnsubscribe, tripPosition, tripPositionBatch,
  tripClaimDevice, tripSignal, tripSeen,
} = require('./src/socket/handlers/trips');

const {
  callUser, answerCall, rejectCall, iceCandidate, endCall,
  addParticipant, cancelAddParticipant, confJoin, confReject,
  confReady,
  createGroupCall, joinGroupCall, leaveGroupCall, endGroupCall,
  groupOffer, groupAnswer, groupIceCandidate,
  callMuteState, groupMuteState, callVideoState, groupVideoState,
  callResumeHandshake, callRejoin, callVideoUpgrade,
} = require('./src/socket/handlers/calls');

const {
  meetingCreate, meetingJoinRoom,
  meetingStart, meetingEnd, meetingChat,
  meetingLeave, meetingOffer, meetingAnswer, meetingIceCandidate,
  meetingMuteState, meetingVideoState,
} = require('./src/socket/handlers/meetings');

const { startMeetingScheduler, stopMeetingScheduler } = require('./src/services/meetingScheduler');
const { startAccountLifecycleSchedulers } = require('./src/controllers/accountLifecycleController');
const { initBroadcastCache, runNightlyDeliveryMaintenance } = require('./src/services/broadcastService');
const { registerBroadcastJobHandlers } = require('./src/services/broadcastWorkers');
const { registerWelcomeJobHandlers } = require('./src/services/welcomeWorkers');
const { purgeExpiredWelcomeStatuses } = require('./src/services/welcomeService');
const { startJobWorker, stopJobWorker } = require('./src/services/jobQueue');
const { setBillingIo } = require('./src/services/billing/subscriptions');
const { registerPaymentJobHandlers } = require('./src/services/payments/paymentService');
const { startBillingSweep, stopBillingSweep } = require('./src/services/billing/billingSweep');
const { startTrialSweep, stopTrialSweep } = require('./src/services/billing/trialSweep');
const { registerBillingJobHandlers } = require('./src/services/billing/billingJobs');
const { withLease } = require('./src/services/schedulerLease');
const { runDataRetentionPurge } = require('./src/services/dataRetentionService');
const { runPurgeIfEnabled } = require('./src/services/purgeRegistry');
const {
  registerTripJobHandlers, setIo: setTripIo,
} = require('./src/services/tripWorkers');
const {
  registerCallStateJobHandlers, setIo: setCallStateIo, setUserSockets: setCallStateUserSockets,
} = require('./src/services/callStateWorkers');
const {
  registerMeetingJobHandlers, setIo: setMeetingIo,
} = require('./src/services/meetingWorkers');
const {
  registerGroupRoomJobHandlers, setIo: setGroupRoomIo,
} = require('./src/services/groupRoomWorkers');
const {
  registerCallSessionsJobHandlers, setIo: setCallSessionsIo,
  setUserSockets: setCallSessionsUserSockets,
} = require('./src/services/callSessionsWorkers');
const {
  startTripStaleSweeper, stopTripStaleSweeper,
} = require('./src/services/tripStaleWorkers');
const { runNightlyTripPurge } = require('./src/services/tripRetention');
const { runNightlyMediaPurge, plafondMedias, rafraichirPlafond } = require('./src/services/mediaRetention');
const { mediaExpiryGuard } = require('./src/middleware/mediaExpiry');
const { mediaRead } = require('./src/middleware/mediaRead');
const { cleanStaleUploadTmp } = require('./src/middleware/upload');

let stopAccountLifecycleSchedulers = () => {};

// ── App ───────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const { createUserSocketRegistry } = require('./src/utils/userSocketRegistry');
const userSockets = createUserSocketRegistry();

app.set('trust proxy', 1);
app.set('io', io);
app.set('userSockets', userSockets);

app.use(cors());
// Le corps brut est gardé pour les webhooks de paiement : la signature d'un
// fournisseur se vérifie sur les octets reçus, pas sur un JSON re-sérialisé.
app.use(express.json({
  verify: (req, _res, buf) => {
    if (req.originalUrl.startsWith('/api/payments/webhook/')) req.rawBody = Buffer.from(buf);
  },
}));
// Médias. Les octets sont chez Backblaze ; `/uploads` ne sert plus aucun
// fichier depuis le disque du serveur (retrait du stockage disque, 28/09/2026) :
// il tranche l'expiration, puis redirige.
//
// Le garde d'expiration passe AVANT : sur un média partitionné, le chemin
// porte le jour de l'upload, donc l'expiration se tranche sans appeler le
// stockage ni interroger la base. Il répond alors `410 Gone`, que le client
// sait distinguer d'une panne réseau — un 404 laisserait croire à un incident
// passager et l'app réessaierait indéfiniment. Le même garde relaie les
// anciennes adresses vers la partition du fichier, ce qui a évité tout
// `UPDATE` de masse sur `message.mediaUrl`.
//
// La durée est le plafond de conservation : la standard, ou celle d'Alanya
// Plus en phase payante. Une URL ne dit pas qui la demande, donc le serveur
// ne tranche qu'au-delà de la plus longue ; c'est au téléphone d'un compte
// non abonné de s'arrêter plus tôt (`mediaRetentionDays` dans ses droits).
// Relu depuis la base au plus une fois par minute, sans bloquer la requête.
//
// Monté AVANT `generalLimiter`, avec son propre quota : une salle de classe
// sort par une seule adresse IP (Wi-Fi de l'école, NAT de l'opérateur), et
// chaque membre d'un groupe télécharge chaque média reçu. Partagés avec l'API
// dans 300 requêtes par minute, quelques médias suffisent à faire répondre 429
// à toute la salle, API comprise (constaté en analysant les signalements du
// groupe 3GI 2029, bug A3).
app.use('/uploads', mediaReadLimiter);
app.use('/uploads', mediaExpiryGuard({ retentionDays: plafondMedias }));
// Redirection `302` vers un lien signé (bucket privé) ou vers le bucket
// public d'une photo, d'une annonce ou d'un média officiel.
app.use('/uploads', mediaRead());
app.use(generalLimiter);
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Fichiers de transit laissés par un envoi interrompu.
cleanStaleUploadTmp().catch(() => {});

// ── Routes API ────────────────────────────────────────────────────────
app.use('/api/auth',          authCustomRoutes);
app.use('/api/pays',          paysRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/conversations', messageRoutes);
app.use('/api/messages',      messageOpsRoutes);
app.use('/api/status',        statusRoutes);
app.use('/api/calls',         callRoutes);
app.use('/api/meetings',      meetingRoutes);
app.use('/api/upload',        uploadRoutes);
app.use('/api/contacts',      contactRoutes);
app.use('/api/contact-lists', contactListRoutes);
app.use('/api/backup',        backupRoutes);
app.use('/api/billing',       billingRoutes);
app.use('/api/payments',      paymentsRoutes);
app.use('/api/alanya-phone',  alanyaPhoneRoutes);
// /api/verification : mis en sommeil (comptes personnels sans dossier).
// Les tables et contrôleurs restent pour les comptes business plus tard.
app.use('/api/media',         mediaAvailRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/qr',            qrRoutes);
app.use('/api/turn',          turnRoutes);
app.use('/api/map',           mapRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/welcome',       welcomeRoutes);
app.use('/api/reports',       reportRoutes);
app.use('/api/e2ee',          e2eeKeysRoutes);
app.use('/api/stickers',      stickerRoutes);
app.use('/api/safebox',       safeboxRoutes);
app.use('/api/documents-sensibles', documentsSensiblesRoutes);
app.use('/notify',            notifyRoutes);

// Pages légales publiques (accueil, confidentialité, CGU, licences) —
// exigées par Google pour publier l'écran OAuth Drive, et déjà liées depuis
// l'application. Avant le volet QR : `GET /` doit décrire Alanya, pas 404.
app.use('/', legalRoutes);

// Routes publiques du volet QR (page d'accueil d'un code, fichiers
// d'association des liens universels) — à la racine du domaine, hors /api :
// c'est cette URL qui est encodée dans les QR d'identité et partagée.
app.use('/', qrLandingRoutes);

// Contrôle de vie : interroge réellement MySQL et Redis, et renvoie 503 dès
// qu'une dépendance ne répond pas. Voir src/routes/health.js.
app.use('/', healthRoutes);

// Avant `errorHandler` : celui-ci répond « Erreur interne du serveur » et
// referme le dossier. Placé après, Sentry ne verrait plus jamais une seule
// erreur de route.
Sentry.setupExpressErrorHandler(app);

app.use(errorHandler);

// ── Socket.IO ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Client connecté:', socket.id);

  socket.authenticated = false;

  socketAuth(io, socket, userSockets);
  qrLoginSocket(io, socket, userSockets);
  adminOps(io, socket);
  presenceOnline(io, socket, userSockets);
  presenceOffline(io, socket, userSockets);
  joinConversation(io, socket, userSockets);
  messageSend(io, socket, userSockets);
  typingStart(io, socket, userSockets);
  typingStop(io, socket, userSockets);
  messageDelivered(io, socket, userSockets);
  messageRead(io, socket, userSockets);
  tripSubscribe(io, socket, userSockets);
  tripUnsubscribe(io, socket, userSockets);
  tripPosition(io, socket, userSockets);
  tripPositionBatch(io, socket, userSockets);
  tripClaimDevice(io, socket, userSockets);
  tripSignal(io, socket, userSockets);
  tripSeen(io, socket, userSockets);
  callUser(io, socket, userSockets);
  answerCall(io, socket, userSockets);
  rejectCall(io, socket, userSockets);
  iceCandidate(io, socket, userSockets);
  endCall(io, socket, userSockets);
  addParticipant(io, socket, userSockets);
  cancelAddParticipant(io, socket, userSockets);
  confJoin(io, socket, userSockets);
  confReject(io, socket, userSockets);
  confReady(io, socket, userSockets);
  createGroupCall(io, socket, userSockets);
  joinGroupCall(io, socket, userSockets);
  leaveGroupCall(io, socket, userSockets);
  endGroupCall(io, socket, userSockets);
  groupOffer(io, socket, userSockets);
  groupAnswer(io, socket, userSockets);
  groupIceCandidate(io, socket, userSockets);
  callMuteState(io, socket, userSockets);
  groupMuteState(io, socket, userSockets);
  callVideoState(io, socket, userSockets);
  groupVideoState(io, socket, userSockets);
  callResumeHandshake(io, socket, userSockets);
  callRejoin(io, socket, userSockets);
  callVideoUpgrade(io, socket, userSockets);
  meetingCreate(io, socket, userSockets);
  meetingJoinRoom(io, socket, userSockets);
  meetingStart(io, socket, userSockets);
  meetingEnd(io, socket, userSockets);
  meetingChat(io, socket, userSockets);
  meetingLeave(io, socket, userSockets);
  meetingOffer(io, socket, userSockets);
  meetingAnswer(io, socket, userSockets);
  meetingIceCandidate(io, socket, userSockets);
  meetingMuteState(io, socket, userSockets);
  meetingVideoState(io, socket, userSockets);

  socket.on('disconnect', async () => {
    console.log('[Socket] Client déconnecté:', socket.id);
    await handleDisconnect(io, socket, userSockets);
  });
});

/**
 * La présence vit dans la mémoire du process (registre des sockets). Après un
 * crash ou un redéploiement, ce registre est vide mais les lignes
 * `user_presence.is_online = 1` survivent : sans ce ménage, ces comptes
 * resteraient « en ligne » indéfiniment, y compris dans les statistiques
 * admin.
 */
const resetStalePresence = async () => {
  try {
    const [res] = await pool.execute(
      'UPDATE user_presence SET is_online = 0 WHERE is_online = 1',
    );
    if (res.affectedRows > 0) {
      console.log(`[Presence] ${res.affectedRows} présence(s) fantôme(s) nettoyée(s) au démarrage`);
    }
  } catch (e) {
    console.error('[Presence] reset au démarrage échoué:', e.code || '', e.message);
  }
};

const PORT = process.env.PORT || 3000;

/**
 * Adapter Socket.IO Redis (intégration Redis phase 1) : sans lui,
 * `io.to(room).emit()` n'atteint que les sockets connectées à CE process —
 * bloquant pour tout passage à `pm2 -i > 1`. `REDIS_URL` absent : aucun
 * changement de comportement, adapter en mémoire. `REDIS_URL` injoignable au
 * démarrage : on préfère un échec bruyant à un serveur qui tourne en pensant
 * émettre cluster-wide alors que ce n'est pas le cas.
 */
async function start() {
  if (REDIS_ENABLED) {
    const pubClient = createRedisClient('pub');
    const subClient = pubClient.duplicate();
    subClient.on('error', (e) => console.error('[Redis:sub] erreur:', e.message));
    // Client « data » (état applicatif : pendingCalls, callDeviceOwnership,
    // callState, …) — distinct du pub/sub ci-dessus, réservé au protocole de
    // l'adapter Socket.IO. Voir src/config/redisData.js.
    const dataClient = createRedisClient('data');
    try {
      await Promise.all([
        connectWithTimeout(pubClient, 5000, 'pub'),
        connectWithTimeout(subClient, 5000, 'sub'),
        connectWithTimeout(dataClient, 5000, 'data'),
      ]);
    } catch (e) {
      console.error('[Redis] connexion échouée au démarrage — arrêt du serveur:', e.message);
      process.exit(1);
    }
    io.adapter(createAdapter(pubClient, subClient));
    setDataClient(dataClient);
    // Conservés pour l'arrêt propre : sans référence, ces trois clients
    // resteraient ouverts côté Redis jusqu'à expiration de leur socket.
    clientsRedis.push(pubClient, subClient, dataClient);
    console.log('[Redis] adapter Socket.IO actif —', REDIS_URL.replace(/:\/\/[^@]*@/, '://***@'));
  } else {
    console.log('[Redis] REDIS_URL absent — adapter en mémoire (mono-instance uniquement)');
  }

  // Plafond de conservation des médias lu AVANT d'accepter des requêtes : sans
  // lui, le garde 410 prend la durée la plus longue possible, par prudence, et
  // laisse passer des médias déjà expirés (404 du stockage au lieu de 410).
  await rafraichirPlafond().catch((e) => {
    console.warn('[Media] plafond de conservation illisible au démarrage:', e.message);
  });

  server.listen(PORT, () => {
    console.log(`Serveur en marche sur le port ${PORT}`);
    resetStalePresence();
    registerBroadcastJobHandlers();
    registerWelcomeJobHandlers();
    // Les jobs de trajet tournent hors requête : ils n'ont pas accès à
    // req.app.get('io'), il faut donc le leur donner explicitement.
    setTripIo(io);
    registerTripJobHandlers();
    setCallStateIo(io);
    setCallStateUserSockets(userSockets);
    registerCallStateJobHandlers();
    setMeetingIo(io);
    registerMeetingJobHandlers();
    setGroupRoomIo(io);
    // Conditionné à Redis, contrairement aux voisins : en repli mémoire, la
    // grâce d'un salon de groupe vit dans un `setTimeout` local et ne passe
    // jamais par la file. Une instance en mémoire qui enregistrerait ce type
    // verrouillerait un job créé par une instance Redis, lirait sa Map vide,
    // obtiendrait « rien à consommer », et la ligne serait supprimée comme un
    // succès — la grâce évaporée sans que personne ne parte.
    if (REDIS_ENABLED) registerGroupRoomJobHandlers();
    setCallSessionsIo(io);
    setCallSessionsUserSockets(userSockets);
    registerCallSessionsJobHandlers();
    // Paiements : le simulateur répond par la file de jobs, et chaque
    // confirmation prévient le téléphone par le socket.
    setBillingIo(io);
    registerPaymentJobHandlers();
    // Échéances : relance, renouvellement automatique, expiration, purge,
    // et les suites de l'interrupteur (annonce, compensation, fin de grâce).
    registerBillingJobHandlers();
    // Péremption des trajets : un balayage unique remplace un minuteur par
    // trajet, sans quoi chaque position GPS coûterait une écriture en base.
    startTripStaleSweeper(io);
    initBroadcastCache().catch((e) => console.error('[Broadcast] init cache:', e.message));
    startJobWorker();
    startMeetingScheduler();
    // Le verificationScheduler (relance des vérifications business) a cédé la
    // place au balayage de l'abonnement : la coche suit désormais l'abonnement,
    // et ses relances sont celles de l'échéance (billingJobs.js).
    startBillingSweep();
    startTrialSweep();
    stopAccountLifecycleSchedulers = startAccountLifecycleSchedulers();

    // Balayage de rétention. Chaque purge passe par le registre
    // (src/services/purgeRegistry.js) : il consulte l'interrupteur réglé
    // depuis l'admin, applique les durées surchargées, et journalise chaque
    // exécution — succès comme échec. Sans ce journal, rien ne distinguait
    // « la purge tourne et n'a rien à faire » de « la purge ne tourne pas »,
    // ce qui a laissé le bug d'alias SQL des médias passer inaperçu.
    //
    // Les baux restent indispensables : ils garantissent qu'une seule
    // instance exécute une purge donnée, sans quoi deux serveurs
    // supprimeraient les mêmes lignes en concurrence.
    const balayageRetention = () => {
      const purges = [
        ['broadcast_nightly_purge', 'broadcast'],
        ['story_purge',             'story'],
        ['welcome_status_purge',    'welcome_status'],
        ['trip_nightly_purge',      'trip'],
        ['data_retention_purge',    'data_retention'],
        // Déclarée dans le registre depuis la migration 079, mais jamais
        // planifiée : la table grossissait sans limite et la page Santé
        // l'affichait « jamais exécutée » en permanence. Le bail n'a pas besoin
        // d'être semé, `tryAcquire` le crée à la volée.
        ['backup_key_access_purge', 'backup_key_access'],
        // Même oubli pour les enveloppes de chiffrement (registre depuis le
        // 02/10) : activée à l'écran, elle ne tournait qu'à la main.
        // `purgeSchedule.test.js` vérifie désormais que tout le registre est ici.
        ['e2ee_envelope_purge',     'e2ee_envelope'],
        // Médias de discussion : 30 jours, ou 365 pour ceux qu'un abonné peut
        // encore demander. Supprimés chez Backblaze, message par message.
        ['media_nightly_purge',     'media'],
        // Coffre-fort : corbeille échue, envois abandonnés, puis blocs
        // orphelins supprimés chez MEGA S4, qui n'a pas de cycle de vie.
        ['safebox_purge',           'safebox'],
      ];
      for (const [bail, purge] of purges) {
        withLease(bail, () => runPurgeIfEnabled(purge)).catch(
          (e) => console.error(`[Purge] ${purge}:`, e.message),
        );
      }
    };

    // Premier tour PEU APRÈS le démarrage, pas à l'instant même.
    //
    // Sans amorce du tout, la première exécution n'avait lieu qu'à T+24 h : un
    // serveur déployé plus d'une fois par jour ne purgeait donc jamais rien.
    // Mais amorcer immédiatement rend tout démarrage de serveur destructeur —
    // y compris un `node server.js` lancé en local pour vérifier un boot, ce
    // dépôt n'ayant pas de base de développement séparée (le .env local vise
    // la production). Ce délai laisse le temps d'interrompre un lancement de
    // test, tout en restant très inférieur à la durée de vie d'un vrai
    // serveur, pour lequel le comportement est inchangé.
    const AMORCE_MS = 10 * 60 * 1000;
    const amorce = setTimeout(balayageRetention, AMORCE_MS);
    amorce.unref?.();
    setInterval(balayageRetention, 24 * 60 * 60 * 1000);
  });
}

start();

// Filet de dernier recours. Express 4 ne capture PAS le rejet d'un handler
// `async` : toute erreur non rattrapée y remonte en unhandled rejection, et
// Node >= 18 termine le process par défaut. Une seule requête malformée
// suffisait donc à tuer le serveur entier — toutes les sockets tombent, tous
// les appels en cours coupent.
//
// Les handlers doivent passer par `next(error)` pour atteindre `errorHandler` ;
// ceci ne les en dispense pas, mais garantit qu'un oubli dégrade une requête
// au lieu d'abattre le service. La trace est complète pour que l'oubli se
// corrige.
process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection] requête dégradée, process préservé :',
    reason instanceof Error ? reason.stack : reason);
  capturerSentry(reason instanceof Error ? reason : new Error(String(reason)));
});

// Une exception non capturée n'est pas du même bois qu'une promesse rejetée.
// La seconde dégrade une requête ; la première laisse le processus dans un état
// indéfini — transaction restée ouverte, connexion à demi fermée, variable
// écrite à moitié. Continuer à servir dans cet état produit des corruptions
// silencieuses, autrement plus coûteuses à diagnostiquer qu'un redémarrage de
// deux secondes que pm2 assure de lui-même.
//
// L'intention de la version précédente — « ne pas abattre le service » — était
// juste ; c'est le remède qui était pire que le mal.
process.on('uncaughtException', (err) => {
  console.error('[UncaughtException] état du processus indéfini, arrêt :', err?.stack || err);
  capturerSentry(err);
  arretPropre(1, 'uncaughtException');
});

// Au-delà, on sort sans attendre. Sans ce couperet, pm2 patienterait jusqu'à
// son propre délai avant d'envoyer SIGKILL — en laissant derrière lui les
// connexions MySQL que le serveur n'a pas rendues.
const DELAI_ARRET_MS = 5000;

let arretEnCours = false;

async function arretPropre(code, cause) {
  if (arretEnCours) return; // SIGTERM après SIGINT, ou deux exceptions de suite
  arretEnCours = true;
  console.log(`[Arrêt] ${cause} — fermeture en cours...`);

  const couperet = setTimeout(() => {
    console.error('[Arrêt] délai dépassé, sortie forcée');
    process.exit(code);
  }, DELAI_ARRET_MS);
  couperet.unref();

  try {
    // 0. Vider Sentry avant tout le reste : sur le chemin `uncaughtException`,
    //    l'erreur qui provoque cet arrêt est encore dans le tampon d'envoi.
    //    Sortir sans la vider reviendrait à perdre exactement l'événement pour
    //    lequel on a installé le rapport d'erreurs.
    await viderSentry();

    // 1. Les ordonnanceurs d'abord : un job qui démarrerait après la fermeture
    //    du pool écrirait sur une connexion morte.
    stopMeetingScheduler();
    stopBillingSweep();
    stopTrialSweep();
    stopJobWorker();
    stopTripStaleSweeper();
    stopAccountLifecycleSchedulers();

    // 2. Les sockets ensuite. `server.close()` seul ne suffirait pas : il
    //    attend la fin des connexions en cours, or une socket Socket.IO ne se
    //    termine jamais d'elle-même — on atteindrait le couperet à chaque
    //    redéploiement. `io.close()` déconnecte les clients puis ferme le
    //    serveur HTTP sous-jacent.
    await new Promise((resoudre) => io.close(resoudre));

    // 3. Les dépendances en dernier, quand plus personne ne peut les solliciter.
    await pool.end();
    await Promise.all(clientsRedis.map((c) => c.quit().catch(() => {})));
  } catch (e) {
    console.error('[Arrêt] erreur pendant la fermeture:', e.message);
  }

  process.exit(code);
}

// SIGINT est ce que pm2 envoie au redémarrage ; SIGTERM ce qu'envoient systemd,
// Docker et `pm2 stop`. Les deux méritent le même soin : jusqu'ici, chaque
// déploiement coupait net les requêtes et les sockets en vol.
process.on('SIGINT', () => arretPropre(0, 'SIGINT'));
process.on('SIGTERM', () => arretPropre(0, 'SIGTERM'));

module.exports = { app, server, io };