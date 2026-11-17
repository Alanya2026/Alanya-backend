const jwt  = require('jsonwebtoken');
const pool = require('../../config/db');
const pendingCalls = require('../state/pendingCalls');
const callState = require('../state/callState');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { registerUserSocket, deviceRoom, normalizeDeviceId } = require('../../utils/userSocketRegistry');

const JWT_SECRET = process.env.JWT_SECRET || 'talky-secret-key-change-in-production';
const REPLAY_ENABLED = process.env.ENABLE_PENDING_CALL_REPLAY !== 'false';

const socketAuth = (io, socket, userSockets) => {

  socket.on('auth:login', async (data) => {
    try {
      const { token, deviceId, device_ID: deviceIdSnake } = data || {};
      if (!token) {
        return socket.emit('auth:error', { message: 'Token requis', code: 'TOKEN_REQUIRED' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          return socket.emit('auth:error', { message: 'Token expiré', code: 'TOKEN_EXPIRED' });
        }
        return socket.emit('auth:error', { message: 'Token invalide', code: 'TOKEN_INVALID' });
      }

      if (decoded.type !== 'access') {
        return socket.emit('auth:error', { message: 'Type de token invalide', code: 'TOKEN_INVALID' });
      }

      // Même garde que le middleware HTTP (migration 026) : sans elle, un
      // appareil révoqué verrait toutes ses requêtes REST en 401 mais garderait
      // une socket authentifiée, donc les messages et les appels en temps réel,
      // jusqu'à l'expiration de son access token. Les tokens antérieurs à la
      // migration (sans appareilId) restent acceptés.
      const [rows] = await pool.execute(
        `SELECT u.alanyaID, u.alanyaPhone
         FROM users u
         LEFT JOIN appareils a ON a.id = ? AND a.alanyaID = u.alanyaID
         WHERE u.alanyaID = ? AND u.exclus = 0 AND (a.id IS NULL OR a.revoked_at IS NULL)`,
        [decoded.appareilId ?? null, decoded.alanyaID]
      );

      if (rows.length === 0) {
        return socket.emit('auth:error', { message: 'Utilisateur introuvable, banni ou appareil déconnecté', code: 'AUTH_REJECTED' });
      }

      const alanyaID = rows[0].alanyaID;
      const rawDevice = deviceId ?? deviceIdSnake;
      // Canonique : même id que ensureStableDeviceId() / user_push_devices.deviceId.
      socket.deviceId = normalizeDeviceId(rawDevice);
      // Clé de la déconnexion forcée à la révocation : `socket.deviceId` est
      // l'UUID applicatif du client, pas l'identifiant matériel de
      // `appareils.device_id` — seul `appareilId` désigne la même ligne des
      // deux côtés.
      socket.appareilId = decoded.appareilId ?? null;
      // Doublé dans `socket.data.*` : c'est le seul sous-objet que l'adapter
      // Redis sérialise vers un RemoteSocket distant (intégration Redis
      // phase 1) — nécessaire pour que userSocketRegistry.js lise ces
      // valeurs cross-instance via fetchSockets(). La propriété à plat reste
      // pour le code non migré qui la lit en local sur ce même socket.
      socket.data.deviceId = socket.deviceId;
      socket.data.appareilId = socket.appareilId;
      await _registerSocket(socket, alanyaID, userSockets, io);
      console.log(`[Socket] Authentifié: User ${alanyaID} (socket ${socket.id})`);

    } catch (error) {
      console.error('[Socket auth:login]', error.message);
      // Ce catch enveloppe un `pool.execute` vers un MySQL distant : un pool
      // saturé, un hoquet réseau, un timeout, et l'on arrive ici. Le code dit au
      // client que l'échec est PASSAGER — sans lui, il restait connecté mais
      // jamais authentifié, sans aucune voie de retour, jusqu'au redémarrage de
      // l'application.
      socket.emit('auth:error', { message: 'Erreur d\'authentification', code: 'AUTH_INTERNAL' });
    }
  });
};

async function _registerSocket(socket, alanyaID, userSockets, io) {
  socket.alanyaID      = alanyaID;
  socket.authenticated = true;
  // Une socket authentifiée n'est PAS en ligne tant qu'elle ne l'a pas déclaré
  // via `presence:online` : l'app peut se (re)connecter en arrière-plan, par
  // exemple réveillée par une push d'appel.
  socket.isForeground  = false;
  socket.data.isForeground = false; // doublé dans socket.data.* — voir plus haut

  registerUserSocket(userSockets, alanyaID, socket.id);
  socket.join(`user_${alanyaID}`);
  const dRoom = deviceRoom(alanyaID, socket.deviceId);
  if (dRoom) socket.join(dRoom);
  // Room par ligne de `appareils`, en plus de celle par identifiant matériel.
  //
  // Les enveloppes du chiffrement sont adressées par `appareil_id` : c'est la
  // clé primaire de `appareils`, celle que porte le JWT, et celle que suit la
  // révocation. Sans cette room, chaque envoi chiffré devrait traduire N
  // `appareil_id` en N `device_id` pour savoir à qui émettre — une requête
  // supplémentaire sur le chemin critique de l'accusé, pour une information
  // que la socket connaît déjà d'elle-même.
  //
  // `deviceRoom` reste en service : elle sert les appels et le média, qui
  // raisonnent sur l'appareil physique et non sur la session enrôlée.
  if (socket.appareilId != null) socket.join(`appareil_${socket.appareilId}`);
  socket.emit('auth:verified', { success: true, alanyaID });

  // Reconnexion pendant un appel : ne PAS annuler la grâce disconnect tant que
  // le client n'a pas confirmé (call_resume_ack). Sinon un auth:login idle
  // ressuscite un in_call fantôme et bloque les nouveaux appels (CALLER_BUSY).
  const activeCall = await callState.getEntry(alanyaID);
  const callKeyActif = activeCall?.callId != null ? String(activeCall.callId) : null;
  if (
    activeCall?.status === 'in_call' &&
    callKeyActif &&
    (await callDeviceOwnership.isOwnerSocket(callKeyActif, alanyaID, socket.id))
  ) {
    // Ré-authentification sur la socket même qui tient l'appel (jeton
    // rafraîchi juste après le décrochage, typiquement) : rien n'a été coupé,
    // il n'y a rien à reprendre. Proposer une reprise ici armait un minuteur
    // d'accusé qui, perdu dans une course, raccrochait un appel sain.
    console.log(`[Socket auth] ré-auth sur la socket de l'appel ${callKeyActif} — pas de reprise`);
  } else if (activeCall?.status === 'in_call') {
    const { offerCallResume } = require('./calls');
    await offerCallResume(io, socket, userSockets, alanyaID);
  } else {
    await callState.cancelDisconnectGrace(alanyaID);
  }

  // Rejeu d'un appel entrant en attente : si l'utilisateur vient d'être réveillé
  // par un push FCM (app fermée), l'event `incoming_call` initial a été perdu.
  // On le lui rejoue maintenant que son socket est authentifié, avec l'offre WebRTC.
  if (!REPLAY_ENABLED) {
    await pendingCalls.clear(alanyaID);
    console.log(`[PhantomCallFix] pending:replay-disabled target=${alanyaID}`);
    return;
  }

  const pending = await pendingCalls.getReplayable(alanyaID);
  if (pending) {
    // Garde autoritaire : ne rejouer que si l'appel est TOUJOURS en sonnerie pour
    // ce callId côté callState. Sinon (refusé / terminé / timeout, ou tout état
    // désynchronisé du buffer) on purge et on ne rejoue pas un écran fantôme.
    const entry = await callState.getEntry(alanyaID);
    const stillRinging =
      !!entry &&
      entry.status === 'ringing' &&
      (pending.callId == null || String(entry.callId) === String(pending.callId));

    if (!stillRinging) {
      console.log(
        `[PhantomCallFix] pending:stale-skip target=${alanyaID} status=${entry?.status ?? 'idle'} callId=${pending.callId ?? 'none'}`,
      );
      await pendingCalls.clear(alanyaID);
    } else {
      console.log(`[Socket] !! Rejeu incoming_call à User ${alanyaID} (appel en attente)`);
      socket.emit('incoming_call', pending);
      const delivery = await pendingCalls.markDelivered(alanyaID, 'auth-replay');
      if (delivery) {
        console.log(
          `[PhantomCallFix] pending:replay target=${alanyaID} callId=${delivery.callId ?? 'none'} attempts=${delivery.attempts}`,
        );
      }
      await pendingCalls.clear(alanyaID);
    }
  } else {
    console.log(`[PhantomCallFix] pending:skip-replay target=${alanyaID}`);
  }
}

module.exports = socketAuth;