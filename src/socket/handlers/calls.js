const pool = require('../../config/db');
const {
  notifyIncomingCall,
  notifyGroupCall,
  notifyCallEnded,
  notifyVoicemailActive,
} = require('../../services/notificationService');
const {
  shouldInterceptCall,
  shouldFallBackToVoicemail,
  noAnswerDelayMs,
  isNoAnswerEnabled,
} = require('../../services/voicemailScheduleService');
const { maxParticipants, maxInvitees } = require('../../constants/participantLimits');
const { isBlockedEitherWay } = require('../../utils/blockUtils');
const { isOfficialAccount } = require('../../utils/officialAccountGuard');
const { checkOutgoing, OUTGOING_DENIED } = require('../../services/billing/outgoingGate');
const { getClientIp, parseCallMode } = require('../../utils/clientIp');
const { buildDirectConversationLookup } = require('../../utils/directConversation');
const pendingCalls = require('../state/pendingCalls');
const callState = require('../state/callState');
const callSessions = require('../state/callSessions');
const groupRooms = require('../state/groupRooms');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { runGroupLeaveCascade } = require('../../services/groupRoomWorkers');
const pendingIce = require('../state/pendingIce');
const { canFallBackToLastCall } = require('../rejectFallback');
const {
  emitToUser,
  emitToDevice,
  emitToUserExceptDevice,
  isUserOnline,
  getConnectedDeviceIds,
  normalizeDeviceId,
} = require('../../utils/userSocketRegistry');

// ─────────────────────────────────────────────────────────────────────────────
// CONTRAT D'EVENTS — appels 1-à-1
//
// Client → Serveur :
//   call_user     { targetUserId, callerId, callerName, callerPhoto, isVideo, offer }
//   answer_call   { callerId, callId, answer }
//   reject_call   { callerId, callId? }
//   end_call      { targetUserId, mode? }
//   ice_candidate { targetUserId, candidate }
//   call_resume_ack    { callId }  — client confirme reprise après call_resume
//   call_resume_reject { callId, reason? } — client idle sans session locale
//   call_video_upgrade_offer { targetUserId, callId, transitionId, offer }
//   call_video_upgrade_answer { targetUserId, callId, transitionId, answer }
//   call_video_upgrade_commit { targetUserId, callId, transitionId }
//
// Serveur → Client :
//   incoming_call { callId, callerId, callerName, callerPhoto, isVideo, offer }
//   call_ringing  { callId, targetId, isVideo }  — à l'APPELANT seul, dès que la
//                 ligne sonne. C'est là qu'il apprend l'identifiant de l'appel :
//                 il n'en avait aucun avant `call_answered`, et tout état
//                 terminal reçu pendant la sonnerie — un refus, au premier chef
//                 — était jeté de son côté faute de correspondance.
//   call_answered { answer, callId? }
//   call_rejected { callId? }
//   call_ended    { callId?, reason?, claimedByAnotherDevice? }
//   call_error    { code, callId? }  — CALL_ANSWERED_ELSEWHERE, DEVICE_ID_REQUIRED…
//   call_failed   { reason, code? }                     — erreur (hors-ligne, données invalides…)
//                 code CALL_SELF : la cible est l'appelant lui-même.
//                 code CALL_ID_UNAVAILABLE : pas d'appel sans callId serveur.
//   call_busy     { callId, targetId, reason:'busy' }   — cible déjà ringing / in_call
//   call_voicemail{ callId, targetId, reason:'voicemail', isVideo, conversationID,
//                   didRing, greetingUrl, greetingSeconds }
//                 — à l'APPELANT seul. Le répondeur du destinataire prend
//                 l'appel. Quatre chemins y mènent : créneau de silence et
//                 ligne occupée (avant toute sonnerie, EN LIEU ET PLACE de
//                 call_ringing ou call_busy), délai sans réponse écoulé et
//                 refus explicite (après la sonnerie, en lieu et place de
//                 call_no_answer ou call_rejected).
//                 `didRing` distingue les deux familles : la feuille de
//                 l'appelant dit « n'a pas répondu » ou « est indisponible ».
//                 `greetingUrl` est l'annonce du destinataire, à télécharger et
//                 à jouer ; le nom du fichier change à chaque enregistrement,
//                 ce qui tient lieu d'empreinte pour le cache client.
//                 Pas de texte d'annonce dans le payload : le client le compose
//                 depuis ses propres traductions.
//   call_resume   { callId, peerId, status, isVideo, role, answer? }
//
// Ownership média : callDeviceOwnership (par callId/sessionId/roomId + userId → device).
// Rooms signaling : user_<alanyaID>_device_<normalizedDeviceId> (jamais device_<id> global).
//   call_no_answer{ callId, targetId, reason:'no_answer' } — timeout serveur sans réponse
//   ice_candidate { candidate }
//
// État autoritaire par userId (callState) : idle | ringing | in_call.
//  - call_user  : cible occupée → call_busy (pas d'incoming_call ni FCM) ; répondeur
//                 actif → call_voicemail (rien n'est armé, AUCUN FCM : c'est ce qui
//                 garantit que le téléphone ne sonne pas) ; sinon les deux
//                 participants passent « ringing » + timer no-answer (45 s).
//  - answer_call: les deux participants passent « in_call ».
//  - reject/end/timeout/disconnect : les deux repassent « idle ».
//  - auth:login in_call : call_resume + timeout ack (8 s) ; grâce disconnect conservée
//    jusqu'à call_resume_ack (ou call_rejoin implicite). Reject/timeout → endActiveCall.
//  - Tous les états terminaux émettent le FCM call_ended (avec callId) nécessaire pour
//    couper la sonnerie/CallKit du destinataire réveillé en arrière-plan.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CONTRAT D'EVENTS — « Ajouter à l'appel » / transfert (3 participants max)
//
// Client → Serveur :
//   call_add_participant { targetUserId, mode?: 'join'|'transfer' }
//   call_add_cancel      { }
//   call_conf_join       { }
//   call_conf_reject     { }
//   call_conf_ready      { sessionId, peerId }  — participant restant ↔ C connected
//   end_call             { … }  — « je pars » si session
//
// Serveur → Client :
//   call_add_pending  { sessionId, callId, invitee, byUserId, mode }
//   call_conf_invite  { sessionId, callId, roomId, sessionKind, mode, from, peers, isVideo }
//   call_conf_joined  { sessionId, user, mode? }
//   call_conf_peers   { sessionId, peers, mode? }
//   call_conf_failed  { sessionId, userId, reason, mode? }
//   call_conf_left    { sessionId, userId, remaining, reason? }
//   call_transfer_armed { sessionId, leaveInMs }     — initiateur seulement
//   call_transfer_done  { sessionId, transferredUserId, remainingParticipantIds, reason }
//   call_add_rejected { code }
//                 code TARGET_VOICEMAIL : le répondeur de l'invité est actif.
//                 Refusé AVANT toute pose d'invitation — aucun enregistrement
//                 n'est proposé, on est en pleine communication.
//
// mode absent → join. Timer 10 s après call_conf_ready uniquement (serveur).
// ─────────────────────────────────────────────────────────────────────────────

// Délai serveur avant de déclarer un appel « sans réponse » (marge > sonnerie CallKit 30 s).
const NO_ANSWER_MS = 45 * 1000;

/**
 * Les valeurs de `callHistory.status`.
 *
 * Elles étaient écrites en chiffres nus un peu partout. Deux conventions ont
 * cohabité pour « manqué » — le schéma déclare 0, le timeout serveur écrit 3 —
 * et c'est exactement le genre de chose qu'un nombre isolé dans une requête ne
 * dit pas. Miroir de `call_history_rules.dart` côté application.
 */
const CALL_STATUS = Object.freeze({
  INITIATED: 0,
  ANSWERED: 1,
  REJECTED: 2,
  NO_ANSWER: 3,
  /** Renvoyé au répondeur SANS avoir sonné : créneau de silence, ou ligne occupée. */
  VOICEMAIL_SILENT: 4,
  /** A sonné, puis répondeur : délai sans réponse écoulé, ou refus explicite. */
  VOICEMAIL_AFTER_RING: 5,
});

// Refus de `callSessions.addPending`, dans le vocabulaire de `call_add_rejected`.
const REFUS_DE_GREFFE = {
  PENDING: 'ADD_ALREADY_USED',
  FULL: 'ADD_ALREADY_USED',
  TARGET_BUSY: 'TARGET_BUSY',
  SESSION_GONE: 'NOT_IN_CALL',
  INVALID: 'TARGET_ALREADY_IN_CALL',
  LOCKED: 'INTERNAL',
};
const {
  TRANSFER_READY_TIMEOUT_MS,
  TRANSFER_AUTO_LEAVE_MS,
} = callSessions;


function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// Récupère (ou crée) la conversation 1-à-1 entre deux utilisateurs.
// Renvoie null si les deux identifiants sont identiques : un appel ne peut pas
// être dirigé vers soi-même, et créer une conv « à soi » ici la ferait passer
// pour une conversation d'appel.
async function getOrCreateDirectConversation(userA, userB) {
  if (Number(userA) === Number(userB)) return null;

  const lookup = buildDirectConversationLookup({ meId: userA, peerId: userB });
  const [existing] = await pool.execute(lookup.sql, lookup.params);
  if (existing.length > 0) return existing[0].conversID;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'INSERT INTO conversation (isGroup, lastMessageAt) VALUES (0, NOW())'
    );
    const conversID = result.insertId;
    for (const id of [userA, userB]) {
      await conn.execute(
        'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
        [conversID, id]
      );
    }
    await conn.commit();
    return conversID;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Appelée dès qu'un appel atteint un état terminal (terminé / refusé).
// Met à jour l'aperçu de la conversation (lastMessage...) et notifie
// LES DEUX participants (contrairement aux events existants qui ne
// notifient que le correspondant) avec les données finales de l'appel.
async function finalizeCallAndNotify(io, userSockets, callID) {
  if (!callID) return;
  try {
    const [rows] = await pool.execute(
      `SELECT c.*,
              u1.nom as caller_nom, u1.pseudo as caller_pseudo, u1.avatar_url as caller_avatar,
              u2.nom as receiver_nom, u2.pseudo as receiver_pseudo, u2.avatar_url as receiver_avatar
       FROM callHistory c
       JOIN users u1 ON c.idCaller   = u1.alanyaID
       JOIN users u2 ON c.idReceiver = u2.alanyaID
       WHERE c.IDcall = ?`,
      [callID]
    );
    if (!rows.length) return;
    const call = rows[0];
    const { idCaller, idReceiver } = call;

    const conversID = await getOrCreateDirectConversation(idCaller, idReceiver);

    // conversID null (auto-appel) : pas d'aperçu à mettre à jour, mais on
    // notifie quand même le journal d'appels.
    if (conversID != null) {
      const isVideo = call.type === 1;

      // ⚠ Ces valeurs étaient 5 et 6, annotées « réservés ». Elles ne l'étaient
      // pas : **5 = localisation** et **6 = message système**. Un appel vocal
      // terminé marquait donc la conversation comme portant une position, et un
      // appel vidéo comme portant un événement de groupe — deux types dont le
      // client sait qu'ils contiennent du JSON, et qu'il essaie de décoder.
      //
      // 20 et 21 : hors de portée des types de messages (0 à 9), pour qu'aucune
      // extension future du fil ne vienne les reprendre. Miroir de
      // `lib/core/utils/call_log_preview.dart` côté Talky.
      const lastMessageType = isVideo ? 21 : 20;

      // Chaîne de repli, en français. Le client la remplace par sa propre
      // traduction à partir du type : il n'a pas besoin de ce texte, seulement
      // d'un aperçu correct pour les surfaces qui ne savent pas le reconstruire.
      const preview = isVideo ? '📹 Appel vidéo' : '📞 Appel vocal';

      await pool.execute(
        `UPDATE conversation
         SET lastMessage = ?, lastMessageAt = NOW(),
             lastMessageSenderID = ?, lastMessageType = ?
         WHERE conversID = ?`,
        [preview, idCaller, lastMessageType, conversID]
      );
    }

    const payload = { conversationID: conversID, call };
    for (const uid of [idCaller, idReceiver]) {
      emitToUser(io, uid, 'call_log_updated', payload);
    }
  } catch (err) {
    console.warn('[finalizeCallAndNotify]', err.message);
  }
}

/**
 * Envoie un appel au répondeur du destinataire.
 *
 * Quatre chemins y mènent, et ils n'ont en commun que leur issue :
 *   1. un créneau de silence est actif      → `call_user`, statut 4
 *   2. la ligne du destinataire est occupée → `call_user`, statut 4
 *   3. personne n'a décroché à temps        → `onNoAnswer`, statut 5
 *   4. le destinataire a refusé             → `processRejectCall`, statut 5
 *
 * L'axe des deux statuts est « le téléphone a-t-il sonné ? ». Le 4 dit non — le
 * destinataire était indisponible par choix, il n'y avait rien à rater, et les
 * statistiques l'excluent du taux de réussite. Le 5 dit oui — il avait une
 * chance de prendre l'appel.
 *
 * @param {object|null} socket socket de l'APPELANT si on l'a sous la main
 *   (chemin `call_user`). Sinon on émet à toutes ses sockets : les autres
 *   appareils ignorent l'événement, leur statut d'appel ne l'autorise pas.
 * @param {number|null} callID ligne d'historique existante (chemins 3 et 4) ou
 *   `null` s'il faut la créer (chemins 1 et 2).
 * @returns {Promise<number|null>} l'identifiant de l'appel, ou `null` si
 *   l'historique n'a pas pu être écrit.
 */
async function basculerVersRepondeur({
  io,
  userSockets,
  socket = null,
  callerID,
  targetID,
  isVideo = false,
  status,
  callID = null,
  ip = null,
  callerName = '',
  schedule = null,
  activeUntil = null,
}) {
  let voicemailCallID = callID;

  if (voicemailCallID == null) {
    try {
      // Inséré directement au bon statut, jamais 0 puis UPDATE : entre les deux
      // écritures, un crash laisserait une ligne « appel manqué » parfaitement
      // crédible dans les deux journaux — alors que le téléphone n'a jamais
      // sonné.
      const [result] = await pool.execute(
        `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, ip)
         VALUES (?, ?, ?, ?, NOW(), ?)`,
        [callerID, targetID, isVideo ? 1 : 0, status, ip],
      );
      voicemailCallID = result.insertId;
    } catch (dbErr) {
      console.warn('[Répondeur] insert échoué:', dbErr.message);
    }
  } else {
    try {
      await pool.execute('UPDATE callHistory SET status = ? WHERE IDcall = ?', [
        status,
        voicemailCallID,
      ]);
    } catch (dbErr) {
      console.warn('[Répondeur] update échoué:', dbErr.message);
    }
  }

  // La conversation est résolue ici et transmise à l'appelant : sans elle, son
  // app devrait faire un aller-retour `createConversation` avant de pouvoir
  // ouvrir le micro.
  let conversID = null;
  try {
    conversID = await getOrCreateDirectConversation(callerID, targetID);
  } catch (convErr) {
    console.warn('[Répondeur] conversation échouée:', convErr.message);
  }

  const payload = {
    callId: voicemailCallID != null ? String(voicemailCallID) : null,
    targetId: String(targetID),
    reason: 'voicemail',
    isVideo: !!isVideo,
    conversationID: conversID,
    // Dit à l'appelant s'il a laissé sonner ou non : sa feuille annonce
    // « n'a pas répondu » ou « est indisponible », ce n'est pas la même chose.
    didRing: status === CALL_STATUS.VOICEMAIL_AFTER_RING,
    // L'annonce enregistrée par le destinataire, s'il en a une.
    //
    // Une URL, pas les octets : le client la télécharge PENDANT qu'il démonte
    // déjà l'appel — plusieurs centaines de millisecondes de CallKit à rendre
    // et de connexion pair-à-pair à fermer — donc sans rien allonger. Et son
    // cache la sert instantanément dès le deuxième appel vers la même personne.
    //
    // Le nom du fichier porte un suffixe aléatoire : c'est lui qui fait office
    // d'empreinte, puisque le cache client indexe par nom et n'invalide rien.
    greetingUrl: schedule?.greeting_url ?? null,
    greetingSeconds:
      schedule?.greeting_seconds == null ? null : Number(schedule.greeting_seconds),
  };

  if (socket) {
    // À la socket seule, comme `call_ringing` : les autres appareils de
    // l'appelant n'ont pas cet appel.
    socket.emit('call_voicemail', payload);
  } else {
    emitToUser(io, callerID, 'call_voicemail', payload);
  }

  // Fait apparaître l'entrée « Répondeur » en direct dans le journal des DEUX
  // parties. Sans lui, le destinataire ne découvrirait l'appel qu'au prochain
  // rechargement complet.
  if (voicemailCallID != null) {
    finalizeCallAndNotify(io, userSockets, voicemailCallID)
      .catch((err) => console.warn('[Répondeur] finalize:', err.message));
  }

  notifyVoicemailActive(targetID, callerName, {
    callerID,
    activeUntil,
    timeZone: schedule?.resolvedTimezone,
  }).catch((err) => console.warn('[Répondeur] notify:', err.message));

  return voicemailCallID;
}

// Déclenché par le timer NO_ANSWER_MS : l'appel est resté « ringing » sans réponse.
// Nettoie l'état des deux participants, prévient l'appelant (call_no_answer) et
// coupe la sonnerie du destinataire (FCM call_ended).
async function onNoAnswer(io, userSockets, callID, callerID, targetID) {
  const entry = await callState.getEntry(targetID);
  // Le timer peut avoir été neutralisé entre-temps (réponse/refus/nouvel appel).
  if (!entry || entry.status !== 'ringing' || String(entry.callId) !== String(callID)) {
    return;
  }

  console.log(`[Socket call_user] ⏰ Pas de réponse: callId=${callID} caller=${callerID} target=${targetID}`);

  await pendingCalls.clear(targetID);
  await callState.clear(targetID);
  await callState.clear(callerID);

  // Répondeur ou « sans réponse » : la décision se prend ICI, à l'échéance, et
  // pas au moment d'armer le minuteur.
  //
  // Ce n'est pas un choix de style. Côté Redis, l'échéance devient une ligne de
  // `job_queue` et le rappel de fonction passé à `scheduleNoAnswer` est jeté en
  // route : le worker reconstruit l'action en appelant `onNoAnswer` en dur. Le
  // seul paramètre qui traverse est le DÉLAI. La variante d'action doit donc se
  // décider de ce côté-ci.
  //
  // Bénéfice inattendu : c'est correct même si le destinataire a basculé son
  // réglage pendant que son téléphone sonnait.
  const { fallback, schedule } = await shouldFallBackToVoicemail(targetID).catch((err) => {
    console.warn('[Socket call_user] no-answer: répondeur illisible:', err.message);
    return { fallback: false, schedule: null };
  });

  if (fallback) {
    console.log(`[Socket call_user] 📼 Répondeur après sonnerie: callId=${callID}`);
    // Pas de socket sous la main : l'appelant est joint par son compte. Ses
    // autres appareils ignoreront l'événement, leur statut ne l'autorise pas.
    await basculerVersRepondeur({
      io,
      userSockets,
      callerID,
      targetID,
      isVideo: !!entry.isVideo,
      status: CALL_STATUS.VOICEMAIL_AFTER_RING,
      callID,
      schedule,
    });
  } else {
    if (callID) {
      try {
        await pool.execute('UPDATE callHistory SET status = ? WHERE IDcall = ?', [
          CALL_STATUS.NO_ANSWER,
          callID,
        ]);
      } catch (dbErr) {
        console.warn('[Socket call_user] no-answer DB update failed:', dbErr.message);
      }
      finalizeCallAndNotify(io, userSockets, callID)
        .catch((err) => console.warn('[Socket call_user] no-answer finalize error:', err.message));
    }

    emitToUser(io, callerID, 'call_no_answer', {
      callId:   callID != null ? String(callID) : null,
      targetId: String(targetID),
      reason:   'no_answer',
    });
  }

  // Ce qui suit vaut dans les DEUX cas : le destinataire doit cesser de sonner,
  // qu'on renvoie l'appelant au répondeur ou qu'on classe l'appel sans réponse.

  // Coupe de façon DÉTERMINISTE la sonnerie/l'écran entrant d'une cible au premier
  // plan (socket ouvert) : le FCM ci-dessous ne couvre que l'arrière-plan et peut
  // être retardé/perdu sous Doze. call_ended est traité quel que soit le statut.
  emitToUser(io, targetID, 'call_ended', {
    callId: callID != null ? String(callID) : null,
    reason: 'no_answer',
  });

  // Coupe la sonnerie/CallKit du destinataire s'il a été réveillé en arrière-plan.
  notifyCallEnded(targetID, callerID, 'Appel manqué', callID, { reason: 'no_answer' })
    .catch((err) => console.warn('[Socket call_user] no-answer notifyCallEnded error:', err.message));

  if (callID != null) await callDeviceOwnership.release(String(callID));
}

/**
 * Déconnexion d'un participant d'appel de groupe : on ne l'annonce plus, on
 * arme une grâce.
 *
 * Il y a deux modes de panne, et un seul demande une grâce.
 *
 * Le mode dominant est que le participant est DÉJÀ REVENU quand cette fonction
 * s'exécute : Socket.IO ne constate la chute qu'au bout de son ping (25 s
 * d'intervalle, 20 s de patience), alors que le client se reconnecte et rejoue
 * `join_group_call` en deux secondes. Annoncer un départ à ce moment-là — ce
 * que faisait cette fonction — expulsait quelqu'un de présent. La garde de
 * socket périmée ci-dessous suffit à ce cas, et c'est le plus fréquent.
 *
 * Le mode minoritaire est la chute constatée avant le retour. C'est celui que la
 * grâce couvre : la place est tenue quinze secondes, et l'annonce n'est faite
 * qu'à l'échéance, par le worker, si personne n'est revenu.
 */
async function armGroupRoomGraceOnDisconnect(io, socket) {
  const rId = socket.currentGroupRoom;
  socket.currentGroupRoom = null;
  if (!rId) return;
  const userID = socket.alanyaID;
  // Sans identité, il n'y a personne à faire partir. L'annonce vivait hors de
  // cette garde et diffusait `userId: "null"`.
  if (userID == null) return;

  try {
    const roomKey = String(rId);

    // Une socket plus récente du même compte tient déjà la place : cette
    // déconnexion est celle d'un fantôme. `tryClaim` réécrit `activeSocketId` à
    // chaque revendication, y compris quand l'appareil était déjà propriétaire —
    // c'est ce qui rend la comparaison fiable.
    //
    // Comparer les sockets et non les appareils : un retour sur le MÊME
    // téléphone garde le même identifiant d'appareil, et une garde par appareil
    // armerait donc une grâce sur quelqu'un qui vient de revenir — le rejoin
    // étant passé avant, plus rien ne l'annulerait.
    const entry = await callDeviceOwnership.getEntry(roomKey, userID);
    if (entry?.activeSocketId && entry.activeSocketId !== socket.id) {
      console.log(
        `[Socket disconnect] socket périmée ignorée user=${userID} room=${rId}`,
      );
      return;
    }

    // Échec ouvert : entrée absente ou sans socket, on arme quand même. Ne rien
    // faire laisserait le participant au roster jusqu'à l'expiration des clés.
    //
    // La place dans le salon est tenue, mais l'appareil est libéré tout de
    // suite : c'est ce qui permet de revenir depuis un AUTRE téléphone.
    await callDeviceOwnership.forget(roomKey, userID);
    const jeton = await groupRooms.armGrace(
      rId, userID, () => runGroupLeaveCascade(io, rId, userID),
    );
    if (jeton == null) {
      // Salon disparu ou participant déjà sorti : il n'y a rien à quitter.
      return;
    }
    console.log(
      `[Socket disconnect] Grâce groupe armée user=${userID} room=${rId} jeton=${jeton}`,
    );
  } catch (e) {
    console.warn('[Socket disconnect] group room grace failed:', e.message);
  }
}

/**
 * Clôt l'entrée callHistory d'un appel et rafraîchit l'aperçu de conversation.
 * Mutualisé entre la fin d'appel 1-à-1 et la fin d'une session à trois.
 */
async function closeCallHistory(io, userSockets, callID) {
  if (!callID) return;
  try {
    // status 3 = manqué / coupé sans réponse propre. La durée n'existe que si
    // l'appel a été décroché, et c'est `status = 1` qui l'atteste — pas
    // `start_time`, dont la valeur dépend de l'état du schéma (voir la
    // migration 075).
    //
    // L'ordre des deux assignations compte : MySQL les évalue de gauche à
    // droite en voyant les valeurs déjà écrites, donc le CASE ci-dessous lit
    // le statut NEUF. Un appel jamais décroché vient de passer 0 → 3 : il
    // tombe dans le ELSE et repart à zéro. C'est le comportement voulu.
    //
    // Le plafond de 86 400 s (24 h) est un garde-fou, pas une règle métier :
    // une poignée de lignes ont été soldées très longtemps après coup — la
    // plus extrême 23 jours après son décrochage — parce qu'un état d'appel
    // périmé a fini par être nettoyé. Deux cas en quatre mois ne justifient
    // pas d'en chercher le mécanisme, mais rien ne justifie non plus qu'une
    // telle valeur atteigne le journal ou les cumuls de l'admin.
    await pool.execute(
      `UPDATE callHistory
       SET status = CASE WHEN status = 0 THEN 3 ELSE status END,
           duree = CASE WHEN status = 1
                        THEN LEAST(GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW())), 86400)
                        ELSE 0 END
       WHERE IDcall = ?`,
      [callID],
    );
  } catch (dbErr) {
    console.warn('[Socket closeCallHistory] DB update failed:', dbErr.message);
  }
  finalizeCallAndNotify(io, userSockets, callID)
    .catch((err) => console.warn('[Socket closeCallHistory] finalize error:', err.message));
}

/**
 * Départs que l'utilisateur a lui-même provoqués.
 *
 * Son application sait déjà qu'elle s'en va : la prévenir serait au mieux
 * redondant, au pire un `call_ended` en retard qui raccrocherait l'appel
 * suivant. Tout le reste est un retrait décidé par le serveur, et doit lui être
 * annoncé.
 *
 * `transfer` en fait partie : `call_transfer_done` le couvre déjà côté socket,
 * et un `call_ended` s'y doublerait.
 */
const DEPARTS_VOULUS = new Set(['hangup', 'transfer']);

/**
 * Retire [userID] de sa session à trois, si tant est qu'il en ait une.
 *
 * C'est le cœur de « raccrocher = partir » : tant qu'il reste deux personnes,
 * l'appel continue sans celui qui s'en va, et les deux restants se retrouvent
 * face à face. Ce n'est qu'en tombant à une seule personne que l'appel se
 * termine réellement.
 *
 * Le cas de l'invité qui raccroche alors qu'il sonnait encore est traité comme
 * un refus : les deux présents retrouvent leur appel 1-à-1 et leur droit d'ajout.
 *
 * @returns {Promise<boolean>} true si le départ a été absorbé par la session —
 *          l'appelant ne doit alors PAS dérouler la fin d'appel 1-à-1.
 */
async function leaveCallSession(io, userSockets, userID, reason = 'leave') {
  const session = await callSessions.getByUser(userID);
  if (!session) return false;

  const { sessionId, originCallId, mode } = session;
  const pendingInvitee = session.pending?.userId ?? null;
  // Lu avant tout solde : en mémoire, `session` est l'objet vivant, et son
  // invitation aura disparu au moment de couper le téléphone de l'invité.
  const pendingInviteId = session.pending?.inviteId || sessionId;
  const wasPending = callSessions.isPending(session, userID);
  const transferMeta = session.transfer
    ? {
        initiatorId: session.transfer.initiatorId,
        targetId: session.transfer.targetId,
        state: session.transfer.state,
      }
    : null;

  // Participant présent qui part alors qu'un invité sonne encore :
  // après son départ il ne resterait plus 2 présents → annuler l'invitation
  // AVANT removeParticipant, pour ne jamais laisser participants=[A] + pending=C.
  if (!wasPending && pendingInvitee != null) {
    const presentCount = callSessions.participantIds(session).length;
    if (presentCount <= 2) {
      await failInvite(io, sessionId, reason === 'disconnect' ? 'offline' : 'caller_left');
    }
    // Une session où quelqu'un est déjà entré porte l'appel — propriété
    // d'appareil, historique — et survit au solde : le départ normal, plus
    // bas, termine l'appel du dernier présent. Sinon elle vient d'être
    // détruite, et on termine le départ comme un hangup 1-à-1.
    if (presentCount <= 2 && !(session.joins > 0)) {
      await callState.cancelDisconnectGrace(userID);
      const entry = await callState.getEntry(userID);
      const peerID = entry?.peerId != null ? toInt(entry.peerId) : null;
      const callID = entry?.callId ?? originCallId ?? null;
      await callState.clear(userID);
      await pendingCalls.clear(userID);

      if (peerID != null) {
        await callState.cancelDisconnectGrace(peerID);
        await callState.clear(peerID);
        await pendingCalls.clear(peerID);
        emitToUser(io, peerID, 'call_ended', {
          callId: callID != null ? String(callID) : null,
        });
        notifyCallEnded(peerID, userID, 'Correspondant', callID)
          .catch((err) => console.warn('[Socket leaveCallSession] FCM error:', err.message));
        await closeCallHistory(io, userSockets, callID);
      }
      return true;
    }
  }

  // Auto-transfert : marquer completed AVANT remove pour ne pas confondre avec cancel.
  if (reason === 'transfer' && session.transfer) {
    await callSessions.completeTransfer(sessionId);
  }

  const { remaining, hadPendingInvitee } = await callSessions.removeParticipant(sessionId, userID);

  console.log(
    `[Socket] leaveCallSession user=${userID} session=${sessionId} ` +
    `pending=${wasPending} restants=[${remaining}] reason=${reason}`,
  );

  await callState.cancelDisconnectGrace(userID);
  await pendingCalls.clear(userID);

  // Ownership de session : `release` n'était appelé que sur le chemin 1-à-1 et
  // dans `failInvite`. Une session qui se termine normalement laissait donc son
  // entrée `active` derrière elle — et rejoindre depuis un autre appareil était
  // refusé définitivement. Un départ ne libère que le partant ; si la session
  // n'a pas survécu au départ, la clé entière s'en va.
  await callDeviceOwnership.forget(sessionId, userID);
  if (!(await callSessions.get(sessionId))) {
    await callDeviceOwnership.release(sessionId);
  }

  // Si destroy a emporté un pending (ex. départ → <2 présents), couper CallKit C.
  if (!wasPending && hadPendingInvitee != null && !(await callSessions.get(sessionId))) {
    await callState.clear(hadPendingInvitee);
    await pendingCalls.clear(hadPendingInvitee);
    emitToUser(io, hadPendingInvitee, 'call_ended', { callId: sessionId, inviteId: pendingInviteId });
    notifyCallEnded(hadPendingInvitee, userID, 'Correspondant', pendingInviteId)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM pending error:', err.message));
  }

  // L'invité s'en va avant d'être entré : simple échec d'invitation.
  if (wasPending) {
    await callState.clear(userID);
    const failReason = reason === 'disconnect'
      ? 'offline'
      : (reason === 'media_not_ready' ? 'media_not_ready' : 'declined');
    // Session où quelqu'un était déjà entré : elle continue sans l'invité, et
    // l'app doit la garder.
    const keepSession = !!(await callSessions.get(sessionId));
    for (const uid of remaining) {
      emitToUser(io, uid, 'call_conf_failed', {
        sessionId,
        userId: String(userID),
        reason: failReason,
        mode: mode || 'join',
        keepSession,
      });
    }
    return true;
  }

  await callState.clear(userID);

  try {
    await closeSessionHistoryFor(sessionId, userID);
  } catch (err) {
    console.warn('[Socket leaveCallSession] historique:', err.message);
  }

  // Transfert : notifier l'initiateur si départ manuel pendant armed.
  if (
    transferMeta &&
    transferMeta.state === 'armed' &&
    Number(userID) === Number(transferMeta.initiatorId) &&
    reason !== 'transfer'
  ) {
    emitToUser(io, userID, 'call_transfer_done', {
      sessionId,
      transferredUserId: String(userID),
      remainingParticipantIds: remaining.map(String),
      reason: 'manual',
    });
  }

  // Entré par une invitation, le partant a présenté l'appel à CallKit sous
  // l'identifiant de celle-ci : c'est lui que ses notifications de fin visent.
  const presentationDuPartant = presentationIdOf(session, userID) ?? sessionId;

  // Le partant n'était prévenu que pour `media_not_ready`. Pour toute autre
  // raison décidée par le serveur — grâce de déconnexion expirée, reprise
  // refusée, accusé de reprise manqué — il ne recevait RIEN : ni socket, ni
  // FCM. Seuls les restants étaient avertis, plus bas. Son écran d'appel
  // restait donc ouvert sur une conférence dont il venait d'être retiré, et il
  // n'avait aucun moyen de l'apprendre.
  const retraitDecideParLeServeur = !DEPARTS_VOULUS.has(reason);
  if (retraitDecideParLeServeur) {
    emitToUser(io, userID, 'call_ended', { callId: sessionId, reason });
    notifyCallEnded(userID, remaining[0] ?? null, 'Correspondant', presentationDuPartant)
      .catch((err) => console.warn(`[Socket leaveCallSession] FCM partant (${reason}):`, err.message));
  }

  // Auto-transfert : FCM pour couper CallKit si l'app de l'initiateur est en BG/kill.
  // Pas de call_ended socket ici : call_transfer_done suffit en foreground, et un
  // call_ended socket risquait d'être mal interprété / doublé avec le leave.
  if (reason === 'transfer') {
    notifyCallEnded(userID, remaining[0] ?? null, 'Correspondant', presentationDuPartant)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM transfer:', err.message));
  }

  if (remaining.length >= 2) {
    const [first, second] = remaining;
    await callState.setPeer(first, second);
    await callState.setPeer(second, first);

    const leftPayload = {
      sessionId,
      userId: String(userID),
      remaining: remaining.map(String),
      mode: mode || 'join',
    };
    if (reason === 'media_not_ready') leftPayload.reason = 'media_not_ready';
    if (reason === 'transfer') leftPayload.reason = 'transfer';

    // Le partant reçoit le sien, et c'est ce qui lui apprend son retrait : son
    // app y reconnaît son propre identifiant et termine l'appel. Le `call_ended`
    // envoyé plus haut ne suffit pas — pendant une conférence encore peuplée,
    // l'app l'ignore délibérément, par garde contre les `call_ended` parasites,
    // et le partant a justement encore ses liens ouverts.
    const destinataires = retraitDecideParLeServeur
      ? [...remaining, userID]
      : remaining;
    for (const uid of destinataires) {
      emitToUser(io, uid, 'call_conf_left', leftPayload);
    }
    return true;
  }

  if (remaining.length === 1) {
    const last = remaining[0];
    const lastEntry = await callState.getEntry(last);
    const lastCallId = lastEntry?.callId ?? originCallId ?? null;

    await callState.cancelDisconnectGrace(last);
    await callState.clear(last);
    await pendingCalls.clear(last);

    emitToUser(io, last, 'call_ended', {
      callId: lastCallId != null ? String(lastCallId) : null,
    });
    notifyCallEnded(last, userID, 'Correspondant', presentationIdOf(session, last) ?? lastCallId)
      .catch((err) => console.warn('[Socket leaveCallSession] FCM error:', err.message));

    try {
      await closeSessionHistoryFor(sessionId, last);
    } catch (err) {
      console.warn('[Socket leaveCallSession] historique last:', err.message);
    }
    try {
      await closeCallHistory(io, userSockets, lastCallId);
    } catch (err) {
      console.warn('[Socket leaveCallSession] closeCallHistory:', err.message);
    }
  }

  return true;
}

/**
 * Retraits provoqués par l'expiration d'une grâce de déconnexion.
 *
 * Volontairement limité à ces deux-là. `resume_ack_timeout` et
 * `resume_owner_missing` sont armés APRÈS le retour de l'utilisateur, qui est
 * donc en ligne par construction : les soumettre à la même garde les viderait
 * de leur sens, puisqu'ils existent précisément pour retirer quelqu'un de
 * revenu mais incapable de reprendre son appel.
 */
const RAISONS_DE_GRACE = new Set([
  'disconnect_grace_expired',
  'ringing_disconnect_grace_expired',
]);

/**
 * L'appareil qui tient cet appel a-t-il de nouveau une socket vivante ?
 *
 * Socket.IO ne constate la mort d'une socket qu'au terme de son ping — 25 s
 * d'intervalle, 20 s de patience, et `server.js` garde ces valeurs par défaut.
 * L'application, elle, recrée la sienne en deux secondes. Le `disconnect` de
 * l'ancienne arrive donc couramment APRÈS le retour, et arme une grâce sur
 * quelqu'un de présent ; à l'échéance, il était retiré de son propre appel sans
 * avoir rien fait, et sans que rien ne le lui dise.
 *
 * On compare les APPAREILS, pas les sockets. Le chemin de reprise ne revendique
 * jamais la propriété — `offerCallResume` se contente de lire
 * `getActiveDeviceId` —, donc `activeSocketId` reste sur la socket morte et une
 * comparaison de sockets, comme celle des salons de groupe, ne verrait jamais
 * le retour.
 *
 * Et on ne se contente pas de « le compte est en ligne » : un appel dont le
 * téléphone est parti ne doit pas survivre parce qu'une tablette est connectée.
 */
async function appareilDAppelRevenu(io, userID) {
  const entry = await callState.getEntry(userID);
  const callKey = entry?.callId != null ? String(entry.callId) : null;
  if (!callKey) return false;

  const proprietaire = await callDeviceOwnership.getActiveDeviceId(callKey, userID);
  if (!proprietaire) return false;

  const connectes = await getConnectedDeviceIds(io, userID);
  return connectes.has(proprietaire);
}

/**
 * Termine l'appel 1-à-1 actif d'un utilisateur (disconnect / kill app).
 * Nettoie callState + pendingCalls, prévient le pair (socket + FCM call_ended).
 * @returns {Promise<boolean>} true si un appel a été terminé.
 */
async function endActiveCallForUser(io, userSockets, userID, reason = 'disconnect') {
  // Une grâce de déconnexion qui expire alors que l'appareil est revenu ne doit
  // rien emporter. C'est ici qu'on l'arrête, et pas ailleurs : cette fonction
  // est l'entonnoir commun aux DEUX exécutions de la grâce — le job Redis
  // (`callStateWorkers`) et le `setTimeout` du repli mémoire. Une garde posée
  // dans le handler `disconnect` n'en couvrirait qu'une.
  if (RAISONS_DE_GRACE.has(reason) && (await appareilDAppelRevenu(io, userID))) {
    await callState.cancelDisconnectGrace(userID);
    console.log(
      `[Socket] grâce ignorée : l'appareil est revenu user=${userID} reason=${reason}`,
    );
    return false;
  }

  // Session à trois : le départ n'emporte pas l'appel des autres.
  if (await leaveCallSession(io, userSockets, userID, reason)) {
    return true;
  }

  await callState.cancelDisconnectGrace(userID);
  const entry = await callState.getEntry(userID);
  if (!entry || (entry.status !== 'ringing' && entry.status !== 'in_call')) {
    return false;
  }

  const peerID = entry.peerId != null ? toInt(entry.peerId) : null;
  const callID = entry.callId != null ? entry.callId : null;
  const callIdStr = callID != null ? String(callID) : null;

  console.log(
    `[Socket] endActiveCallForUser user=${userID} peer=${peerID} callId=${callIdStr ?? 'none'} reason=${reason}`,
  );

  await pendingCalls.clear(userID);
  if (peerID) await pendingCalls.clear(peerID);
  await callState.cancelDisconnectGrace(userID);
  if (peerID) await callState.cancelDisconnectGrace(peerID);
  await callState.clear(userID);
  if (peerID) await callState.clear(peerID);

  await closeCallHistory(io, userSockets, callID);

  if (peerID) {
    emitToUser(io, peerID, 'call_ended', { callId: callIdStr });
    notifyCallEnded(peerID, userID, 'Correspondant', callID)
      .catch((err) => console.warn('[Socket endActiveCallForUser] FCM error:', err.message));
  }

  return true;
}

// Récupère un état « occupé » fantôme : l'utilisateur est marqué ringing/in_call
// mais n'a PLUS AUCUN socket connecté et aucune reconnexion en grâce → son appel
// précédent n'a jamais été nettoyé (kill multi-socket, socket fantôme, crash sans
// end_call…). On le purge des deux côtés pour ne pas renvoyer un faux call_busy.
// Session à trois résiduelle : le participant n'a plus aucune socket et aucune
// reconnexion en grâce — son client a terminé sans prévenir (crash, kill, bug).
// Sans ce nettoyage, la session le maintiendrait « occupé » et confisquerait le
// droit d'ajout de l'appel indéfiniment.
async function reclaimStaleSession(io, userID) {
  const session = await callSessions.getByUser(userID);
  if (!session) return false;
  if (await isUserOnline(io, userID)) return false;
  if (await callState.hasDisconnectGrace(userID)) return false;

  console.log(
    `[callSessions] reclaimStaleSession user=${userID} session=${session.sessionId} (hors-ligne, sans grâce)`,
  );
  await callSessions.removeParticipant(session.sessionId, userID);
  return true;
}

async function reclaimStaleBusy(io, userID) {
  await reclaimStaleSession(io, userID);
  const entry = await callState.getEntry(userID);
  if (!entry) return false;
  if (entry.status !== 'in_call' && entry.status !== 'ringing') return false;
  if (await isUserOnline(io, userID)) return false;   // en ligne : appel en arrière-plan légitime
  if (await callState.hasDisconnectGrace(userID)) return false; // grâce de reconnexion déjà armée
  const peerID = entry.peerId != null ? toInt(entry.peerId) : null;
  console.log(
    `[callState] reclaimStaleBusy user=${userID} status=${entry.status} (offline, sans grâce)`,
  );
  await callState.clear(userID);
  await pendingCalls.clear(userID);
  if (peerID) {
    const peerEntry = await callState.getEntry(peerID);
    if (peerEntry && String(peerEntry.peerId) === String(userID)) {
      await callState.clear(peerID);
      await pendingCalls.clear(peerID);
    }
  }
  return true;
}

const callUser = (io, socket, userSockets) => {
  socket.on('call_user', async (data) => {
    try {
      if (!socket.authenticated) {
        console.warn('[Socket call_user] ** Tentative non authentifiée');
        return;
      }

      const { targetUserId, callerId, callerName, callerPhoto, isVideo, offer } = data;
      const targetID = toInt(targetUserId);
      const callerID = socket.alanyaID;
      const callerDeviceId = normalizeDeviceId(socket.deviceId);

      // Identité appelant = socket uniquement (jamais le payload client).
      if (callerId != null && toInt(callerId) != null && toInt(callerId) !== callerID) {
        console.warn(
          `[Socket call_user] ⛔ callerId spoof refusé payload=${callerId} socket=${callerID}`,
        );
        socket.emit('call_failed', {
          reason: 'Identité invalide',
          code: 'CALLER_ID_MISMATCH',
        });
        return;
      }

      console.log(`[Socket call_user] 📞 Appel: ${callerID} → ${targetID} (${isVideo ? 'vidéo' : 'audio'})`);

      if (!callerDeviceId) {
        socket.emit('call_failed', {
          reason: 'Identifiant appareil requis',
          code: 'DEVICE_ID_REQUIRED',
        });
        return;
      }

      if (!targetID || !offer) {
        console.warn('[Socket call_user] ** Données invalides', { targetID, offerExists: !!offer });
        socket.emit('call_failed', { reason: 'Données d\'appel invalides' });
        return;
      }

      // Essai fini et aucun abonnement : le compte reçoit, il n'appelle pas.
      // Avant tout état d'appel : rien à défaire, aucune sonnerie posée.
      if (!(await checkOutgoing(callerID)).allowed) {
        socket.emit('call_failed', {
          reason: OUTGOING_DENIED.message,
          code: OUTGOING_DENIED.code,
          feature: OUTGOING_DENIED.feature,
        });
        return;
      }

      // Auto-appel : à refuser avant isBlockedEitherWay, qui renvoie false pour
      // une paire identique et laisserait passer l'appel.
      if (targetID === callerID) {
        console.warn(`[Socket call_user] ** Auto-appel refusé: user=${callerID}`);
        socket.emit('call_failed', { reason: 'Appel impossible', code: 'CALL_SELF' });
        return;
      }

      // Le compte officiel diffuse, il ne décroche pas. Sans ce garde, l'appel
      // partirait vers un compte que personne n'ouvrira jamais.
      if (await isOfficialAccount(targetID)) {
        socket.emit('call_failed', {
          reason: 'Ce compte ne reçoit pas d\'appels',
          code: 'OFFICIAL_NOT_CALLABLE',
        });
        return;
      }

      if (await isBlockedEitherWay(callerID, targetID)) {
        socket.emit('call_failed', { reason: 'Appel impossible', code: 'CALL_BLOCKED' });
        return;
      }

      // État autoritaire : cible déjà en sonnerie avec quelqu'un d'autre ou en communication.
      const existingPair = await callState.findExistingRingingPair(callerID, targetID);
      if (existingPair) {
        console.log(
          `[Socket call_user] 🔁 Paire déjà en sonnerie callId=${existingPair.callId ?? 'none'} caller=${callerID} target=${targetID}`,
        );
        const pending = await pendingCalls.get(targetID);
        if (pending && (await isUserOnline(io, targetID))) {
          emitToUser(io, targetID, 'incoming_call', pending);
        }
        // Glare : l'appelant est aussi la cible de l'autre sonnerie → lui renvoyer l'entrant.
        const pendingForCaller = await pendingCalls.get(callerID);
        if (pendingForCaller && (await isUserOnline(io, callerID))) {
          emitToUser(io, callerID, 'incoming_call', pendingForCaller);
        }
        return;
      }

      // Purge un éventuel « occupé » fantôme (appel précédent jamais nettoyé)
      // avant d'évaluer la disponibilité réelle des deux participants.
      await reclaimStaleBusy(io, targetID);
      await reclaimStaleBusy(io, callerID);

      if (await callState.isBusyForNewCall(callerID, targetID, pendingCalls)) {
        console.log(`[Socket call_user] ⛔ Appelant occupé: caller=${callerID} (${await callState.get(callerID)})`);
        socket.emit('call_failed', {
          reason: 'Un appel est déjà en cours de votre côté',
          code: 'CALLER_BUSY',
        });
        return;
      }

      // ── RÉPONDEUR ────────────────────────────────────────────────────────
      //
      // Placement : APRÈS `CALLER_BUSY`, AVANT `TARGET_BUSY`.
      //
      // Après `CALLER_BUSY`, parce que cette garde-là protège l'APPELANT : la
      // court-circuiter laisserait quelqu'un déjà en communication ouvrir une
      // seconde branche sortante dans sa machine à états. Avant `TARGET_BUSY`,
      // parce que c'est précisément la garde que le répondeur remplace — le
      // destinataire n'est pas « occupé », il est injoignable par choix, et
      // l'appelant ne doit pas recevoir `call_busy` mais l'invitation à laisser
      // un message.
      //
      // Ce qui suit ne fait RIEN d'autre que ce qui est écrit. Pas de
      // `callState.setRinging`, pas de `callDeviceOwnership`, pas de
      // `scheduleNoAnswer`, pas de `pendingCalls.set`, pas d'`incoming_call`,
      // et surtout pas de `notifyIncomingCall` : c'est l'absence de ce dernier
      // appel qui garantit qu'aucun FCM ne part, donc qu'aucun CallKit ne
      // s'ouvre, donc que le téléphone ne sonne pas. C'est la promesse même de
      // la fonctionnalité, et `voicemailIntercept.test.js` la vérifie ligne à
      // ligne.
      const verdictRepondeur = await shouldInterceptCall(targetID, callerID).catch((err) => {
        // Une planification illisible ne doit jamais faire échouer un appel :
        // le défaut penche toujours du côté « le téléphone sonne ».
        console.warn('[Socket call_user] répondeur: évaluation impossible:', err.message);
        return { intercept: false };
      });

      if (verdictRepondeur.intercept) {
        console.log(`[Socket call_user] 📼 Répondeur: ${callerID} → ${targetID}`);
        await basculerVersRepondeur({
          io,
          userSockets,
          socket,
          callerID,
          targetID,
          isVideo,
          status: CALL_STATUS.VOICEMAIL_SILENT,
          ip: getClientIp(socket),
          callerName,
          schedule: verdictRepondeur.schedule,
          activeUntil: verdictRepondeur.activeUntil,
        });
        return;
      }

      if (await callState.isBusyForNewCall(targetID, callerID, pendingCalls)) {
        console.log(`[Socket call_user] ⛔ Cible occupée: target=${targetID} (${await callState.get(targetID)})`);

        // Ligne occupée et filet armé : le répondeur plutôt que « occupé ».
        //
        // Statut 4 et non 5 : le téléphone n'a pas sonné — il était déjà pris.
        // Le destinataire n'a rien raté, l'appel n'avait aucune chance
        // d'aboutir, et le taux de réussite des appels ne doit pas s'en
        // alourdir.
        //
        // Le créneau est celui que `shouldInterceptCall` vient de charger, une
        // quinzaine de lignes plus haut : aucune requête de plus sur un chemin
        // que chaque appel entrant traverse.
        if (isNoAnswerEnabled(verdictRepondeur.schedule)) {
          console.log(`[Socket call_user] 📼 Répondeur (ligne occupée): ${callerID} → ${targetID}`);
          await basculerVersRepondeur({
            io,
            userSockets,
            socket,
            callerID,
            targetID,
            isVideo,
            status: CALL_STATUS.VOICEMAIL_SILENT,
            ip: getClientIp(socket),
            callerName,
            schedule: verdictRepondeur.schedule,
          });
          return;
        }

        socket.emit('call_busy', {
          callId:   null,
          targetId: String(targetID),
          reason:   'busy',
        });
        return;
      }

      let callID = null;
      try {
        const callerIp = getClientIp(socket);
        // `start_time` n'est plus renseignée ici : c'est l'heure de DÉCROCHAGE,
        // écrite par answer_call. La remplir dès l'ouverture faisait partir le
        // chronomètre à la sonnerie. L'heure d'initiation est dans created_at.
        //
        // Tant que la migration 075 n'est pas appliquée, la colonne est encore
        // `NOT NULL DEFAULT CURRENT_TIMESTAMP` en base et sera donc remplie
        // malgré cette omission — sans conséquence : les calculs de durée ne
        // s'appuient plus sur elle mais sur `status = 1`.
        const [result] = await pool.execute(
          `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, ip)
           VALUES (?, ?, ?, 0, NOW(), ?)`,
          [callerID, targetID, isVideo ? 1 : 0, callerIp]
        );
        callID = result.insertId;
        socket.currentCallID = callID;
        socket.currentCallTarget = targetID;
      } catch (dbErr) {
        console.warn('[Socket call_user] DB insert failed:', dbErr.message);
      }

      if (!callID) {
        socket.emit('call_failed', {
          reason: 'Impossible de démarrer l\'appel',
          code: 'CALL_ID_UNAVAILABLE',
        });
        return;
      }

      const callKey = String(callID);
      await callDeviceOwnership.setCalling(callKey, callerID, {
        activeDeviceId: callerDeviceId,
        activeSocketId: socket.id,
      });
      await callDeviceOwnership.ring(callKey, targetID);

      // Marque les deux participants « ringing » AVANT d'émettre incoming_call
      // et d'armer le timeout (séparément : un handle setTimeout ne se
      // sérialise pas vers job_queue).
      //
      // L'ordre compte, et pas qu'un peu. L'appelant commence à rassembler ses
      // candidats ICE dès qu'il a posé sa description locale, donc avant même
      // que `call_user` ne soit traité ici : ses premiers candidats arrivaient
      // pendant que ce handler tournait encore, et le relais les jetait sans
      // un mot faute d'entrée callState — c'est-à-dire avant même d'atteindre
      // le tampon de sonnerie. Poser l'état d'abord ferme cette fenêtre.
      //
      // Côté destinataire, c'est la même inversion : une réponse très rapide
      // (auto-réponse depuis une notification) pouvait arriver avant que
      // `ringing` ne soit posé et recevoir CALL_NOT_RINGING.
      await callState.setRinging(targetID, { callId: callID, peerId: callerID, isVideo: !!isVideo });
      await callState.setRinging(callerID, { callId: callID, peerId: targetID, isVideo: !!isVideo });

      // Le destinataire qui a armé le filet bascule plus tôt : 27 s au lieu de
      // 45. Le créneau a déjà été chargé quelques lignes plus haut par
      // `shouldInterceptCall` — on le réutilise plutôt que de rouvrir la base
      // sur un chemin traversé par chaque appel.
      const delaiSansReponse = noAnswerDelayMs(verdictRepondeur.schedule, NO_ANSWER_MS);
      await callState.scheduleNoAnswer(
        targetID,
        () => onNoAnswer(io, userSockets, callID, callerID, targetID),
        delaiSansReponse,
      );

      // L'appelant apprend l'identifiant de son appel AVANT le décrochage.
      //
      // Il ne le recevait jusqu'ici que dans `call_answered` : pendant toute la
      // sonnerie, il ne connaissait que l'horodatage qu'il s'était fabriqué pour
      // ouvrir sa session CallKit. Ses gardes de callId — celles qui empêchent
      // un événement en retard de raccrocher l'appel suivant — comparaient donc
      // le `2169` du serveur à un horodatage, et jetaient le refus du
      // destinataire. La sonnerie de retour continuait jusqu'au filet des
      // 45 secondes, qui annonçait « pas de réponse » sur un appel refusé.
      //
      // À la socket seule, pas au compte : les autres appareils de l'appelant
      // n'ont pas cet appel.
      socket.emit('call_ringing', {
        callId:   callKey,
        targetId: String(targetID),
        isVideo:  !!isVideo,
      });

      const incomingPayload = {
        callId:      callKey,
        callerId:    String(callerID),
        callerName:  callerName  || '',
        callerPhoto: callerPhoto || null,
        isVideo:     isVideo     || false,
        offer,
      };

      // Bufferise l'appel : si le destinataire est hors-ligne (app fermée), il sera
      // réveillé par FCM puis l'event `incoming_call` lui sera rejoué à sa reconnexion.
      await pendingCalls.set(targetID, incomingPayload);
      console.log(`[PhantomCallFix] pending:set target=${targetID} callId=${incomingPayload.callId ?? 'none'}`);

      if (await isUserOnline(io, targetID)) {
        console.log(`[Socket call_user] !! Envoi incoming_call à user_${targetID}`);
        emitToUser(io, targetID, 'incoming_call', incomingPayload);
        const delivery = await pendingCalls.markDelivered(targetID, 'socket-live');
        if (delivery) {
          console.log(
            `[PhantomCallFix] pending:delivered-live target=${targetID} callId=${delivery.callId ?? 'none'} attempts=${delivery.attempts}`,
          );
        }
      } else {
        console.warn(`[Socket call_user] ** Utilisateur ${targetID} non trouvé en socket — fallback FCM + rejeu à la reconnexion`);
      }

      // Le push d'appel ne doit pas survivre au délai qui le classe.
      //
      // Sa durée de validité était calée en dur sur les 45 secondes, « pour
      // qu'un push délivré après le timeout ne fasse pas sonner un appel déjà
      // classé ». Pour un destinataire qui bascule à 27 s, 45 s est devenu trop
      // long : un push délivré à 40 s ferait sonner un téléphone dont l'appel
      // est parti au répondeur treize secondes plus tôt. On passe donc le même
      // délai aux deux. (`call_ended` garde le sien : c'est l'ordre d'ARRÊT, il
      // doit survivre — voir le commentaire de CALL_TTL_MS.)
      notifyIncomingCall(targetID, callerID, callerName, callerPhoto, isVideo, callID, null, {
        ttlMs: delaiSansReponse,
      }).catch((err) => console.warn('[Socket call_user] FCM error:', err.message));
    } catch (error) {
      console.error('[Socket call_user]', error.message);
      socket.emit('call_failed', { reason: error.message });
    }
  });
};

const answerCall = (io, socket, userSockets) => {
  // L'accusé, pour la même raison que sur `end_call` : sans lui, l'émetteur ne
  // peut pas distinguer un socket vivant d'un socket zombie — TCP mort, mais
  // Socket.IO ne le constate qu'au bout de son ping. La réponse WebRTC partait
  // alors dans le vide et n'était JAMAIS rejouée, contrairement au raccrochage
  // qui a reçu file et accusé. L'appelé affichait « en cours » avec son
  // chronomètre, l'appelant restait sur « connexion », et aucun média ne
  // passait.
  socket.on('answer_call', async (data, ack) => {
    const repondre = typeof ack === 'function' ? ack : () => {};
    let repondu = false;
    const solder = (r) => {
      if (repondu) return;
      repondu = true;
      repondre(r);
    };
    try {
      if (!socket.authenticated) {
        console.warn('[Socket answer_call] ** Non authentifié');
        solder({ ok: false, reason: 'unauthenticated' });
        return;
      }
      const { callerId, answer, callId: rawCallId } = data || {};

      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      const deviceId   = normalizeDeviceId(socket.deviceId);
      if (!callerID || !answer) {
        console.warn('[Socket answer_call] ** Données invalides', { callerID, answerExists: !!answer });
        solder({ ok: false, reason: 'invalid_data' });
        return;
      }
      if (!deviceId) {
        socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
        solder({ ok: false, reason: 'DEVICE_ID_REQUIRED' });
        return;
      }

      const callId = toInt(rawCallId);
      if (!callId) {
        socket.emit('call_error', { code: 'CALL_ID_REQUIRED' });
        solder({ ok: false, reason: 'CALL_ID_REQUIRED' });
        return;
      }
      const callKey = String(callId);

      const receiverEntry = await callState.getEntry(receiverID);
      const callerEntry = await callState.getEntry(callerID);
      const pairOk =
        receiverEntry &&
        receiverEntry.status === 'ringing' &&
        String(receiverEntry.peerId) === String(callerID) &&
        String(receiverEntry.callId) === callKey &&
        callerEntry &&
        callerEntry.status === 'ringing' &&
        String(callerEntry.peerId) === String(receiverID) &&
        String(callerEntry.callId) === callKey;

      if (!pairOk) {
        // L'appel ne sonne plus : annulé, refusé ailleurs, ou démonté chez le
        // destinataire pendant qu'il répondait. Le `finally` accusait « ok »
        // pour cette sortie-là aussi : le client en concluait que son
        // décrochage avait abouti, se déclarait connecté et affichait un appel
        // en cours avec personne en face.
        socket.emit('call_error', {
          code: 'CALL_NOT_RINGING',
          callId: callKey,
        });
        solder({ ok: false, reason: 'CALL_NOT_RINGING' });
        return;
      }

      const claim = await callDeviceOwnership.tryClaim(
        callKey,
        receiverID,
        deviceId,
        socket.id,
      );
      if (!claim.ok) {
        const code = claim.reason === 'DEVICE_ID_REQUIRED'
          ? 'DEVICE_ID_REQUIRED'
          : (claim.reason === 'NO_SESSION' ? 'CALL_INVALID_STATE' : 'CALL_ANSWERED_ELSEWHERE');
        socket.emit('call_error', { code, callId: callKey });
        solder({ ok: false, reason: code });
        return;
      }

      console.log(`[Socket answer_call] 📞 Réponse: Receiver ${receiverID} device=${deviceId} → Caller ${callerID} callId=${callKey}`);

      await pendingCalls.clear(receiverID);

      const isVideo = !!callerEntry?.isVideo;
      await callState.setInCall(receiverID, { callId, peerId: callerID, isVideo });
      await callState.setInCall(callerID, { callId, peerId: receiverID, lastAnswer: answer, isVideo });

      socket.currentCallID = callId;
      socket.currentCallTarget = callerID;

      const elsewherePayload = {
        callId: callKey,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      };
      await emitToUserExceptDevice(
        io,
        receiverID,
        deviceId,
        'call_ended',
        elsewherePayload,
      );
      notifyCallEnded(receiverID, callerID, 'Appel répondu sur un autre appareil', callId, {
        excludeDeviceId: deviceId,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      }).catch((err) => console.warn('[Socket answer_call] FCM siblings:', err.message));

      try {
        const [result] = await pool.execute(
          `UPDATE callHistory
           SET start_time = NOW(), status = 1
           WHERE IDcall = ?`,
          [callId],
        );
        console.log(`[Socket answer_call] !! DB updated: ${result.affectedRows} row(s)`);
      } catch (dbErr) {
        console.warn('[Socket answer_call] DB update failed:', dbErr.message);
      }

      // Les candidats que l'appelant a émis pendant la sonnerie n'avaient
      // aucun appareil où aller : le destinataire n'en avait pas encore. Sans
      // ce rejeu il n'en reçoit jamais aucun — pas une seule paire à tester, et
      // une allocation TURN sans permission, donc sourde aux tests de
      // connectivité. L'appel restait muet jusqu'à l'ICE restart de l'appelant,
      // une vingtaine de secondes plus tard.
      const bufferedIce = await pendingIce.drain(callKey, receiverID);
      if (bufferedIce.length) {
        console.log(
          `[Socket answer_call] 🧊 ${bufferedIce.length} candidat(s) ICE de la sonnerie rejoué(s) → ${receiverID} device=${deviceId}`,
        );
        for (const item of bufferedIce) {
          emitToDevice(io, receiverID, deviceId, 'ice_candidate', item);
        }
      }

      const callerDeviceId = await callDeviceOwnership.getActiveDeviceId(callKey, callerID);
      const answeredPayload = {
        answer,
        callId: callKey,
      };
      if (!callerDeviceId) {
        // L'état est posé, mais l'appelant n'a plus d'appareil où recevoir la
        // réponse : elle ne lui parviendra jamais. Le dire plutôt que d'accuser
        // « ok » — le destinataire affichait sinon un appel établi que personne
        // ne rejoindra.
        console.warn(`[Socket answer_call] ** pas de device caller actif — pas de fan-out call_answered`);
        solder({ ok: false, reason: 'caller_device_missing' });
        return;
      }
      console.log(`[Socket answer_call] !! Envoi call_answered → deviceRoom(${callerID}, ${callerDeviceId})`);
      emitToDevice(io, callerID, callerDeviceId, 'call_answered', answeredPayload);
    } catch (error) {
      console.error('[Socket answer_call]', error.message);
      solder({ ok: false, reason: 'error' });
    } finally {
      // Seul le chemin nominal arrive ici sans avoir soldé : la réponse a été
      // relayée à l'appelant. Chaque sortie d'échec solde désormais elle-même —
      // un « ok » sur un appel qui ne sonne plus faisait croire au client que
      // son décrochage avait abouti.
      solder({ ok: true });
    }
  });
};

const rejectCall = (io, socket, userSockets) => {
  socket.on('reject_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { callerId, callId } = data || {};
      const callerID   = toInt(callerId);
      const receiverID = socket.alanyaID;
      if (!callerID) return;

      await processRejectCall({
        io,
        userSockets,
        callerID,
        receiverID,
        callIdHint: callId,
        rejectingDeviceId: normalizeDeviceId(socket.deviceId),
      });
    } catch (error) {
      console.error('[Socket reject_call]', error.message);
    }
  });
};

/**
 * Logique partagée socket + HTTP : refuse un appel entrant pour [receiverID].
 * Idempotent (double refus / course HTTP+socket → no-op sûr).
 */
async function processRejectCall({
  io,
  userSockets,
  callerID,
  receiverID,
  callIdHint = null,
  rejectingDeviceId = null,
}) {
  if (!callerID || !receiverID) {
    return { ok: false, reason: 'invalid_ids' };
  }

  // Un refus d'invitation en conférence arrive par ce chemin-ci.
  //
  // La couche native ne connaît que `POST /calls/reject` : elle n'a jamais su
  // qu'une conférence existait. Quand CallKit retire une invitation restée sans
  // réponse — à 40 s, avant le timer serveur de 45 s —, c'est donc un refus
  // 1-à-1 qu'elle poste, avec un identifiant de session (`conf_…`) que `toInt`
  // ne sait pas lire. Le garde anti-refus-tardif était sauté, et la suite
  // traitait ça comme le refus d'un appel simple : l'état serveur de l'inviteur
  // effacé, `call_rejected` émis vers lui, et son appel en cours avec un tiers
  // raccroché. Une invitation non répondue suffisait — pas un cas limite.
  //
  // On corrige ici plutôt que dans la couche native : le correctif vaut alors
  // pour les versions déjà installées, qui ne changeront pas.
  const inviteeSession = await callSessions.getByUser(receiverID);
  if (inviteeSession && callSessions.isPending(inviteeSession, receiverID)) {
    console.log(
      `[processRejectCall] ↪ refus routé vers la session ${inviteeSession.sessionId} `
      + `(invité=${receiverID}, hint=${callIdHint ?? 'none'})`,
    );
    await failInvite(io, inviteeSession.sessionId, 'declined', {
      decliningDeviceId: normalizeDeviceId(rejectingDeviceId),
    });
    return { ok: true, callId: inviteeSession.sessionId, conference: true };
  }

  const hintID = toInt(callIdHint);
  if (hintID) {
    const receiverEntry = await callState.getEntry(toInt(receiverID));
    const currentPairCallID =
      receiverEntry && String(receiverEntry.peerId) === String(callerID)
        ? toInt(receiverEntry.callId)
        : null;
    if (currentPairCallID && currentPairCallID !== hintID) {
      try {
        await pool.execute(
          'UPDATE callHistory SET status = 2 WHERE IDcall = ? AND status = 0',
          [hintID],
        );
      } catch (dbErr) {
        console.warn('[processRejectCall] stale DB update failed:', dbErr.message);
      }
      console.log(
        `[processRejectCall] refus tardif ignoré: hint=${hintID} ≠ courant=${currentPairCallID} (receiver=${receiverID})`,
      );
      return { ok: true, callId: hintID, stale: true };
    }
  }

  let rejectedCallID = toInt(callIdHint);
  if (!rejectedCallID) {
    rejectedCallID = (await callState.getEntry(receiverID))?.callId ?? null;
  }
  const callKey = rejectedCallID != null ? String(rejectedCallID) : null;
  if (callKey) {
    const owner = await callDeviceOwnership.getEntry(callKey, receiverID);
    if (owner?.state === 'active' && owner.activeDeviceId) {
      const rejDid = normalizeDeviceId(rejectingDeviceId);
      if (!rejDid || owner.activeDeviceId !== rejDid) {
        console.log(
          `[processRejectCall] refus ignoré (déjà claimé device=${owner.activeDeviceId})`,
        );
        return { ok: false, reason: 'already_answered', callId: rejectedCallID };
      }
    }
  }

  // Deuxième filet, indépendant du premier : ne solder l'appelant que si son
  // état correspond bien à ce refus-ci. Un refus tardif — a fortiori venu d'un
  // tiers dont la session a déjà été nettoyée — ne doit pas effacer l'appel
  // qu'il est en train de mener avec quelqu'un d'autre.
  const callerEntry = await callState.getEntry(callerID);
  const callerMatchesReject = !!callerEntry
    && String(callerEntry.peerId) === String(receiverID)
    && (callKey == null || String(callerEntry.callId) === callKey);

  await pendingCalls.clear(receiverID);
  await callState.clear(receiverID);
  if (callerMatchesReject) {
    await callState.clear(callerID);
  } else {
    console.log(
      `[processRejectCall] 🛡 état de l'appelant conservé: caller=${callerID} `
      + `pair=${callerEntry?.peerId ?? 'none'} attendu=${receiverID} `
      + `callId=${callerEntry?.callId ?? 'none'} refus=${callKey ?? 'none'}`,
    );
  }
  if (callKey) await callDeviceOwnership.release(callKey);

  try {
    // Le repli ne vaut que si le refus ne désigne PAS déjà autre chose qu'un
    // appel à deux — voir `canFallBackToLastCall`. Une invitation de groupe
    // refusée porte un `roomId`, et ce repli lui faisait réécrire le dernier
    // appel à deux entre les mêmes personnes.
    if (!rejectedCallID && canFallBackToLastCall(callIdHint)) {
      const [rows] = await pool.execute(
        `SELECT IDcall FROM callHistory
         WHERE idCaller = ? AND idReceiver = ?
         ORDER BY created_at DESC LIMIT 1`,
        [callerID, receiverID]
      );
      rejectedCallID = rows[0]?.IDcall ?? null;
    } else if (!rejectedCallID) {
      console.log(
        `[processRejectCall] repli refusé: hint=${callIdHint} ne désigne pas `
        + 'un appel à deux (salon de groupe ou session)',
      );
    }
    if (rejectedCallID) {
      await pool.execute('UPDATE callHistory SET status = ? WHERE IDcall = ?', [
        CALL_STATUS.REJECTED,
        rejectedCallID,
      ]);
    }
  } catch (dbErr) {
    console.warn('[processRejectCall] DB update failed:', dbErr.message);
  }

  const rejectedCallIdStr = rejectedCallID != null ? String(rejectedCallID) : null;

  /**
   * Les AUTRES appareils du destinataire doivent cesser de sonner.
   *
   * Extrait en fermeture parce que les deux issues — refus sec et bascule au
   * répondeur — en ont besoin à l'identique. Le refus vient d'un appareil ; les
   * autres n'ont rien vu et sonneraient jusqu'au bout sans cet avis.
   */
  const _prevenirAppareilsFreres = async () => {
    const siblingPayload = {
      callId: rejectedCallIdStr,
      reason: 'rejected_elsewhere',
      claimedByAnotherDevice: true,
    };
    if (rejectingDeviceId) {
      await emitToUserExceptDevice(io, receiverID, rejectingDeviceId, 'call_ended', siblingPayload);
      notifyCallEnded(receiverID, callerID, 'Appel refusé sur un autre appareil', rejectedCallID, {
        excludeDeviceId: rejectingDeviceId,
        reason: 'rejected_elsewhere',
        claimedByAnotherDevice: true,
      }).catch((err) => console.warn('[processRejectCall] FCM siblings:', err.message));
    } else {
      emitToUser(io, receiverID, 'call_ended', siblingPayload);
    }
  };

  // Refus explicite et filet armé : le répondeur plutôt qu'un refus sec.
  //
  // C'est le geste le plus courant pour dire « pas maintenant, laisse-moi un
  // message », et sur un téléphone ordinaire il mène au répondeur.
  //
  // Ce point d'insertion est le seul possible. Plus haut, deux sorties
  // anticipées l'auraient détourné : la branche CONFÉRENCE, où un refus
  // d'invitation à trois n'a rien à voir avec un appel entrant, et la garde de
  // refus TARDIF, qui solde un vieil appel déjà remplacé. Ici, et seulement
  // ici, le refus est celui d'un appel entrant que l'appelant mène encore.
  //
  // Statut 5 : le téléphone A sonné, le destinataire a vu l'appel et l'a
  // écarté. Il compte donc dans le taux de réussite, contrairement au 4.
  if (callerMatchesReject && rejectedCallID) {
    const { fallback, schedule } = await shouldFallBackToVoicemail(receiverID).catch((err) => {
      console.warn('[processRejectCall] répondeur illisible:', err.message);
      return { fallback: false, schedule: null };
    });

    if (fallback) {
      console.log(`[processRejectCall] 📼 Répondeur après refus: callId=${rejectedCallIdStr}`);
      await basculerVersRepondeur({
        io,
        userSockets,
        callerID,
        targetID: receiverID,
        status: CALL_STATUS.VOICEMAIL_AFTER_RING,
        callID: rejectedCallID,
        schedule,
      });
      // Les appareils frères du destinataire sont prévenus plus bas, comme
      // dans le cas ordinaire : leur sonnerie doit cesser quoi qu'il arrive.
      await _prevenirAppareilsFreres();
      console.log(`[processRejectCall] !! Refus receiver=${receiverID} → répondeur callId=${rejectedCallIdStr}`);
      return { ok: true, callId: rejectedCallID, voicemail: true };
    }
  }

  finalizeCallAndNotify(io, userSockets, rejectedCallID)
    .catch((err) => console.warn('[processRejectCall] finalizeCallAndNotify error:', err.message));

  // Même règle pour l'avis que pour l'état : on ne prévient l'appelant que si
  // ce refus concerne l'appel qu'il mène. Le client a désormais sa propre garde
  // (B4), mais elle ne doit pas être la seule.
  if (callerMatchesReject) {
    emitToUser(io, callerID, 'call_rejected', { callId: rejectedCallIdStr });

    notifyCallEnded(callerID, receiverID, 'Destinataire', rejectedCallID, {
      reason: 'rejected_elsewhere',
    }).catch((err) => console.warn('[processRejectCall] FCM notifyCallEnded error:', err.message));
  }

  await _prevenirAppareilsFreres();

  console.log(`[processRejectCall] !! Refus receiver=${receiverID} → caller=${callerID} callId=${rejectedCallIdStr}`);
  return { ok: true, callId: rejectedCallID };
}

const iceCandidate = (io, socket, userSockets) => {
  socket.on('ice_candidate', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, candidate } = data;
      const targetID = toInt(targetUserId);
      if (!targetID || !candidate) return;

      const selfId = socket.alanyaID;
      const deviceId = normalizeDeviceId(socket.deviceId);
      const selfEntry = await callState.getEntry(selfId);
      const callKey = selfEntry?.callId != null ? String(selfEntry.callId) : null;
      if (!callKey || !deviceId || !(await callDeviceOwnership.isOwnerDevice(callKey, selfId, deviceId))) {
        return;
      }
      // Signal média = preuve de session locale (clients sans call_resume_ack).
      if (await callState.hasResumeAckTimer(selfId)) {
        await callState.confirmResume(selfId);
      }
      const relayPayload = {
        candidate,
        ...(data?.generation != null ? { generation: data.generation } : {}),
        ...(data?.callId != null ? { callId: data.callId } : {}),
      };

      const targetDeviceId = await callDeviceOwnership.getActiveDeviceId(callKey, targetID);
      if (!targetDeviceId) {
        // Le destinataire sonne encore : il n'a pas d'appareil actif avant
        // d'avoir décroché. Jeter le candidat le laissait sans un seul
        // candidat distant pour tout l'appel — l'appelant ne les réémet
        // jamais. On les garde et answer_call les rejoue.
        const targetEntry = await callDeviceOwnership.getEntry(callKey, targetID);
        if (targetEntry && targetEntry.state === 'ringing') {
          const kept = await pendingIce.push(callKey, targetID, relayPayload);
          if (!kept) {
            console.warn(
              `[Socket ice_candidate] tampon plein callId=${callKey} target=${targetID}`,
            );
          }
          return;
        }
        console.warn(`[Socket ice_candidate] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDeviceId, 'ice_candidate', relayPayload);
    } catch (error) {
      console.error('[Socket ice_candidate]', error.message);
    }
  });
};

const endCall = (io, socket, userSockets) => {
  // L'accusé n'est pas un confort : c'est la seule preuve que le raccrochage a
  // été traité. Sans lui, l'émetteur ne peut pas distinguer un socket vivant
  // d'un socket zombie — TCP mort, mais Socket.IO ne le constate qu'au bout de
  // son ping (25 s d'intervalle, 20 s de patience). Le paquet part dans le
  // vide, personne ne prévient le pair, et celui-ci reste sur « Reconnexion… »
  // jusqu'à son propre délai. C'est le cas d'autant plus probable que l'appel
  // a duré : plus de temps pour que la connexion meure sans le dire.
  socket.on('end_call', async (data, ack) => {
    const repondre = typeof ack === 'function' ? ack : () => {};
    try {
      // Un refus explicite, pas un silence : l'émetteur remet alors le
      // raccrochage en file et reconstruit son socket.
      if (!socket.authenticated) {
        repondre({ ok: false, reason: 'unauthenticated' });
        return;
      }
      const { targetUserId, mode: rawMode } = data;
      const targetID = toInt(targetUserId);
      const callerID = socket.alanyaID;
      const mode = parseCallMode(rawMode);

      // Session à trois : raccrocher ne fait que retirer celui qui appuie.
      // L'appel des autres continue — d'où la sortie anticipée, avant toute
      // clôture d'historique ou notification de fin.
      if (await leaveCallSession(io, userSockets, callerID, 'hangup')) {
        socket.currentCallID     = null;
        socket.currentCallTarget = null;
        repondre({ ok: true, handled: 'left_session' });
        return;
      }

      // Déjà hors appel (ex. 2ᵉ end_call CallKit après leaveCallSession) :
      // ne pas retomber en teardown 1-à-1 vers targetUserId — sinon on envoie
      // call_ended à l'inviteur alors que les deux restants continuent.
      const selfStillActive = await callState.getEntry(callerID);
      if (
        !selfStillActive ||
        (selfStillActive.status !== 'ringing' && selfStillActive.status !== 'in_call')
      ) {
        socket.currentCallID     = null;
        socket.currentCallTarget = null;
        repondre({ ok: true, handled: 'already_idle' });
        return;
      }

      // Préférer le callId d'état (fiable) avant clear — évite un FCM call_ended
      // sans callId qui ne pourrait pas bloquer un FCM `call` tardif.
      const selfEntry = selfStillActive;
      const peerEntry = targetID ? await callState.getEntry(targetID) : null;
      let endedCallID =
        (selfEntry?.callId != null ? selfEntry.callId : null) ??
        (peerEntry?.callId != null ? peerEntry.callId : null) ??
        socket.currentCallID ??
        null;

      // Appel terminé/annulé : ne pas le rejouer au destinataire.
      if (targetID) await pendingCalls.clear(targetID);
      await pendingCalls.clear(callerID);

      // État autoritaire : les deux participants repassent « idle ».
      await callState.clear(callerID);
      if (targetID) await callState.clear(targetID);
      if (endedCallID != null) await callDeviceOwnership.release(String(endedCallID));

      if (callerID && endedCallID == null) {
        try {
          const [rows] = await pool.execute(
            `SELECT IDcall FROM callHistory
             WHERE (idCaller = ? OR idReceiver = ?)
               AND (idCaller = ? OR idReceiver = ?)
             ORDER BY created_at DESC LIMIT 1`,
            [callerID, callerID, targetID || callerID, targetID || callerID]
          );
          endedCallID = rows[0]?.IDcall ?? null;
        } catch (dbErr) {
          console.warn('[Socket end_call] DB lookup failed:', dbErr.message);
        }
      }

      if (endedCallID) {
        try {
          // Le cas courant ici est l'annulation pendant la sonnerie : l'appel
          // n'a jamais été décroché, il n'a donc pas de durée. `status = 1` est
          // le seul témoin d'un décrochage — c'est answer_call qui l'écrit.
          //
          // Le statut, lui, restait à 0 À VIE. `callState.clear()` juste
          // au-dessus annule le job `call_no_answer`, donc onNoAnswer — seul
          // écrivain de `status = 3` — ne s'exécutera jamais, et cet UPDATE ne
          // touchait que la durée. La ligne n'était alors ni « manquée », ni
          // « refusée », ni « terminée » : elle restait « en cours », affichée
          // en vert comme un appel abouti et absente du badge d'appels manqués.
          // On applique la règle que closeCallHistory tient déjà pour la
          // déconnexion — raccrocher et perdre le réseau doivent classer
          // l'appel de la même façon.
          //
          // L'ordre des deux assignations est ici indifférent : un `status = 1`
          // est inchangé dans les deux lectures, et un `status = 0` donne
          // `duree = 0` que le CASE voie 0 ou 3.
          await pool.execute(
            `UPDATE callHistory
             SET duree = CASE WHEN status = 1
                              THEN LEAST(GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW())), 86400)
                              ELSE 0 END,
                 status = CASE WHEN status = 0 THEN 3 ELSE status END,
                 mode = COALESCE(?, mode)
             WHERE IDcall = ?`,
            [mode, endedCallID]
          );
        } catch (dbErr) {
          console.warn('[Socket end_call] DB update failed:', dbErr.message);
        }
      }

      // Met à jour la conversation + notifie les deux côtés (discussions + logs d'appel).
      finalizeCallAndNotify(io, userSockets, endedCallID)
        .catch((err) => console.warn('[Socket end_call] finalizeCallAndNotify error:', err.message));

      if (targetID) {
        const endedCallIdStr = endedCallID != null ? String(endedCallID) : null;
        emitToUser(io, targetID, 'call_ended', {
          callId: endedCallIdStr,
          reason: 'caller_ended',
        });

        // Envoyer FCM au receiver pour arrêter la sonnerie (cas où receiver est en background)
        notifyCallEnded(targetID, callerID, 'L\'appelant', endedCallID, {
          reason: 'caller_ended',
        })
          .catch((err) => console.warn('[Socket end_call] FCM notifyCallEnded error:', err.message));
      }

      socket.currentCallID     = null;
      socket.currentCallTarget = null;
      repondre({ ok: true, handled: 'ended' });
    } catch (error) {
      console.error('[Socket end_call]', error.message);
      repondre({ ok: false, reason: 'error' });
    }
  });
};

//  AJOUT D'UN PARTICIPANT — « Ajouter à l'appel » (transfert assisté)

/** Fiches d'affichage (nom, photo) d'un lot d'utilisateurs, indexées par id. */
async function fetchUserCards(userIds = []) {
  const ids = [...new Set(userIds.map(toInt).filter((v) => v != null))];
  if (!ids.length) return new Map();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.execute(
      `SELECT alanyaID, nom, pseudo, avatar_url FROM users WHERE alanyaID IN (${placeholders})`,
      ids,
    );
    return new Map(rows.map((r) => [
      r.alanyaID,
      {
        id: String(r.alanyaID),
        name: (r.nom || '').trim() || r.pseudo || '',
        photo: r.avatar_url || null,
      },
    ]));
  } catch (dbErr) {
    console.warn('[Socket call_add] fetchUserCards failed:', dbErr.message);
    return new Map();
  }
}

/**
 * Ouvre les lignes d'historique de l'invité, une par paire réellement connectée.
 *
 * callHistory reste binaire : l'appel à trois s'y écrit comme un faisceau de
 * paires reliées par un même sessionID. L'appel d'origine est rattaché à la
 * session au passage, pour que le journal puisse regrouper les trois lignes.
 */
async function openSessionHistory(session, inviteeID) {
  const { sessionId, originCallId, isVideo } = session;
  const present = callSessions.participantIds(session).filter((id) => id !== inviteeID);
  try {
    if (originCallId) {
      await pool.execute('UPDATE callHistory SET sessionID = ? WHERE IDcall = ?', [
        sessionId,
        originCallId,
      ]);
    }
    for (const uid of present) {
      // status 1 = décroché : l'invité est effectivement entré.
      await pool.execute(
        `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, start_time, sessionID)
         VALUES (?, ?, ?, 1, NOW(), NOW(), ?)`,
        [uid, inviteeID, isVideo ? 1 : 0, sessionId],
      );
    }
  } catch (dbErr) {
    console.warn('[Socket call_add] openSessionHistory failed:', dbErr.message);
  }
}

/**
 * Clôt les lignes de session d'un participant qui s'en va.
 *
 * Seules les siennes : les deux autres continuent de parler et leur propre ligne
 * doit rester ouverte jusqu'à ce qu'ils raccrochent à leur tour.
 */
async function closeSessionHistoryFor(sessionId, userID) {
  if (!sessionId || !userID) return;
  try {
    await pool.execute(
      `UPDATE callHistory
       SET duree = CASE WHEN status = 1
                        THEN LEAST(GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW())), 86400)
                        ELSE 0 END
       WHERE sessionID = ? AND (idCaller = ? OR idReceiver = ?) AND duree = 0`,
      [sessionId, userID, userID],
    );
  } catch (dbErr) {
    console.warn('[Socket call_add] closeSessionHistoryFor failed:', dbErr.message);
  }
}

async function failInvite(io, sessionId, reason, { decliningDeviceId = null } = {}) {
  const session = await callSessions.get(sessionId);
  if (!session?.pending) return;

  const inviteeID = session.pending.userId;
  const inviteId = session.pending.inviteId || sessionId;
  const present = callSessions.participantIds(session);
  const mode = session.mode || 'join';

  // En Redis, `session` est une copie : l'invité a pu entrer depuis. Il est
  // alors participant, et rien ne doit plus toucher à son état ni à la
  // propriété d'appareil d'une session désormais à trois.
  const solde = await callSessions.abortPending(sessionId);
  if (!solde) {
    console.log(`[Socket call_add] invitation déjà soldée ou promue session=${sessionId} raison=${reason}`);
    return;
  }

  console.log(`[Socket call_add] ✖ invitation soldée session=${sessionId} invité=${inviteeID} raison=${reason}`);

  await callState.clear(inviteeID);
  await pendingCalls.clear(inviteeID);
  // Une session où quelqu'un était déjà entré continue : la propriété
  // d'appareil de ses présents est ce qui autorise le relais média entre eux.
  if (solde.destroyed) await callDeviceOwnership.release(sessionId);
  else await callDeviceOwnership.forget(sessionId, inviteeID);

  for (const uid of present) {
    emitToUser(io, uid, 'call_conf_failed', {
      sessionId,
      userId: String(inviteeID),
      reason,
      mode,
      keepSession: !solde.destroyed,
    });
  }

  // Toujours stopper les appareils de C (y compris declined) — ExceptDevice si connu.
  // Son téléphone connaît l'invitation sous `inviteId` : la fin doit viser celui-là.
  const endedPayload = {
    callId: sessionId,
    inviteId,
    reason: reason === 'declined' ? 'rejected_elsewhere' : 'cancelled',
    claimedByAnotherDevice: reason === 'declined',
  };
  if (decliningDeviceId) {
    await emitToUserExceptDevice(io, inviteeID, decliningDeviceId, 'call_ended', endedPayload);
    notifyCallEnded(inviteeID, present[0] ?? null, 'Correspondant', inviteId, {
      excludeDeviceId: decliningDeviceId,
      reason: endedPayload.reason,
      claimedByAnotherDevice: !!endedPayload.claimedByAnotherDevice,
    }).catch((err) => console.warn('[Socket call_add] FCM call_ended error:', err.message));
  } else {
    emitToUser(io, inviteeID, 'call_ended', endedPayload);
    notifyCallEnded(inviteeID, present[0] ?? null, 'Correspondant', inviteId, {
      reason: endedPayload.reason,
    }).catch((err) => console.warn('[Socket call_add] FCM call_ended error:', err.message));
  }
}

/**
 * Identifiant sous lequel [userId] a vu arriver cet appel, s'il y est entré
 * par une invitation : c'est celui que son CallKit connaît, donc celui que les
 * notifications de fin doivent viser. null pour les participants d'origine,
 * dont l'appel porte son propre identifiant.
 */
function presentationIdOf(session, userId) {
  return session?.participants?.get(Number(userId))?.inviteId ?? null;
}

/**
 * Timeout média : C n'a jamais eu de lien WebRTC ready → retirer C, garder A/B.
 */
async function onTransferMediaNotReady(io, userSockets, sessionId) {
  const session = await callSessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) return;
  if (session.transfer.state !== 'joined') return;

  const targetId = session.transfer.targetId;
  console.log(`[Socket transfer] ⏱ media_not_ready session=${sessionId} target=${targetId}`);
  await callSessions.cancelTransfer(sessionId, 'media_not_ready');
  await leaveCallSession(io, userSockets, targetId, 'media_not_ready');
}

/**
 * Auto-leave de l'initiateur après 10 s si canCompleteTransfer.
 */
async function onTransferAutoLeave(io, userSockets, sessionId) {
  const session = await callSessions.get(sessionId);
  if (!session || session.mode !== 'transfer' || !session.transfer) return;
  if (session.transfer.state !== 'armed') return;

  if (!callSessions.canCompleteTransfer(session)) {
    console.log(`[Socket transfer] ⛔ auto-leave annulé (canCompleteTransfer=false) session=${sessionId}`);
    await callSessions.cancelTransfer(sessionId, 'incomplete');
    return;
  }

  const initiatorId = session.transfer.initiatorId;
  const remainingBefore = callSessions.participantIds(session)
    .filter((id) => id !== initiatorId);

  console.log(`[Socket transfer] ⏱ auto-leave initiator=${initiatorId} session=${sessionId}`);
  await leaveCallSession(io, userSockets, initiatorId, 'transfer');

  emitToUser(io, initiatorId, 'call_transfer_done', {
    sessionId,
    transferredUserId: String(initiatorId),
    remainingParticipantIds: remainingBefore.map(String),
    reason: 'automatic',
  });
}

const addParticipant = (io, socket, userSockets) => {
  socket.on('call_add_participant', async (data) => {
    try {
      if (!socket.authenticated) return;

      const { targetUserId, callerName, callerPhoto, mode: rawMode } = data || {};
      const inviteeID   = toInt(targetUserId);
      const requesterID = socket.alanyaID;
      const mode = callSessions.normalizeMode(rawMode);

      const reject = (code) => socket.emit('call_add_rejected', { code });

      if (!inviteeID || !requesterID) return reject('INVALID');
      if (inviteeID === requesterID) return reject('TARGET_SELF');
      // Inviter quelqu'un, c'est émettre : refusé sans abonnement, même au milieu
      // d'un appel que le compte a reçu.
      if (!(await checkOutgoing(requesterID)).allowed) return reject(OUTGOING_DENIED.code);

      const entry = await callState.getEntry(requesterID);
      if (!entry || entry.status !== 'in_call' || entry.peerId == null) {
        return reject('NOT_IN_CALL');
      }
      const peerID = toInt(entry.peerId);
      if (!peerID) return reject('NOT_IN_CALL');
      if (peerID === inviteeID) return reject('TARGET_ALREADY_IN_CALL');

      await reclaimStaleBusy(io, inviteeID);
      if (await callState.isBusyForNewCall(inviteeID, requesterID, pendingCalls)) {
        console.log(`[Socket call_add] ⛔ invité occupé: ${inviteeID} (${await callState.get(inviteeID)})`);
        return reject('TARGET_BUSY');
      }

      // Blocage vérifié avant de poser quoi que ce soit : l'autre présent ne
      // voit jamais passer une invitation vouée au refus, et aucune sonnerie
      // n'est à défaire.
      const [blockedByRequester, blockedByPeer] = await Promise.all([
        isBlockedEitherWay(requesterID, inviteeID),
        isBlockedEitherWay(peerID, inviteeID),
      ]);
      if (blockedByRequester || blockedByPeer) {
        console.log(`[Socket call_add] ⛔ blocage: invité=${inviteeID}`);
        return reject('TARGET_BLOCKED');
      }

      // Répondeur de l'invité : au même endroit et pour la même raison que le
      // blocage ci-dessus — AVANT que quoi que ce soit ne soit posé.
      //
      // `failInvite` ne pouvait pas servir ici : il exige un `pending` déjà
      // enregistré, donc il n'intervient qu'une fois l'invité mis en sonnerie.
      // Or c'est précisément la sonnerie que le répondeur interdit. Le contrôle
      // doit donc être en amont, et il l'est.
      //
      // Aucun enregistrement n'est proposé : on est en pleine communication à
      // deux, il n'y a pas d'appelant disponible pour laisser un message.
      const repondeurInvite = await shouldInterceptCall(inviteeID, requesterID).catch((err) => {
        console.warn('[Socket call_add] répondeur: évaluation impossible:', err.message);
        return { intercept: false };
      });
      if (repondeurInvite.intercept) {
        console.log(`[Socket call_add] 📼 répondeur actif: invité=${inviteeID}`);
        return reject('TARGET_VOICEMAIL');
      }

      // Retombés à deux dans une session, on y greffe l'invitation : le relais
      // média, la propriété d'appareil et l'historique y sont déjà rangés.
      // Sinon, c'est la première invitation de l'appel : on ouvre la session.
      let session;
      const existante = await callSessions.getByUser(requesterID);
      if (existante) {
        if (!callSessions.participantIds(existante).includes(peerID)) return reject('NOT_IN_CALL');
        const greffe = await callSessions.addPending(existante.sessionId, {
          inviteeId: inviteeID,
          byUserId: requesterID,
          mode,
        });
        if (greffe.refus) {
          console.log(`[Socket call_add] ⛔ greffe refusée (${greffe.refus}): demandeur=${requesterID}`);
          return reject(REFUS_DE_GREFFE[greffe.refus] || 'INTERNAL');
        }
        session = greffe.session;
      } else {
        session = await callSessions.openWithPending({
          originCallId: entry.callId ?? null,
          isVideo: !!entry.isVideo,
          participants: [requesterID, peerID],
          inviteeId: inviteeID,
          byUserId: requesterID,
          mode,
        });
        if (!session) {
          console.log(`[Socket call_add] ⛔ invitation déjà en vol: demandeur=${requesterID}`);
          return reject('ADD_ALREADY_USED');
        }
      }
      const { sessionId } = session;
      const inviteId = session.pending?.inviteId || sessionId;

      // Ownership session : A/B depuis l'appel d'origine, C en ringing. Une
      // session greffée connaît déjà l'appareil actif de ses présents : ne pas
      // l'écraser par celui, peut-être périmé, de l'appel d'origine.
      await callDeviceOwnership.ring(sessionId, inviteeID);
      if (entry.callId != null) {
        for (const uid of [requesterID, peerID]) {
          if (await callDeviceOwnership.getActiveDeviceId(sessionId, uid)) continue;
          const prev = await callDeviceOwnership.getEntry(String(entry.callId), uid);
          if (prev?.activeDeviceId) {
            await callDeviceOwnership.setActive(sessionId, uid, {
              activeDeviceId: prev.activeDeviceId,
              activeSocketId: prev.activeSocketId,
            });
          }
        }
      }

      await callState.setRinging(inviteeID, {
        callId: sessionId,
        peerId: requesterID,
        isVideo: !!entry.isVideo,
      });

      await callSessions.armPendingTimer(sessionId, NO_ANSWER_MS, () => {
        failInvite(io, sessionId, 'no_answer').catch((err) =>
          console.warn('[Socket call_add] failInvite no_answer:', err.message),
        );
      });

      const cards = await fetchUserCards([requesterID, peerID, inviteeID]);
      const fallback = (uid) => ({ id: String(uid), name: '', photo: null });
      const inviteeCard   = cards.get(inviteeID)   ?? fallback(inviteeID);
      const requesterCard = cards.get(requesterID) ?? fallback(requesterID);
      const peerCard      = cards.get(peerID)      ?? fallback(peerID);

      if (callerName) requesterCard.name = callerName;
      if (callerPhoto) requesterCard.photo = callerPhoto;

      console.log(
        `[Socket call_add] ➕ ${requesterID} ajoute ${inviteeID} mode=${mode} ` +
        `à l'appel avec ${peerID} (session=${sessionId})`,
      );

      for (const uid of [requesterID, peerID]) {
        emitToUser(io, uid, 'call_add_pending', {
          sessionId,
          callId: session.originCallId,
          invitee: inviteeCard,
          byUserId: String(requesterID),
          mode,
        });
      }

      emitToUser(io, inviteeID, 'call_conf_invite', {
        sessionId,
        inviteId,
        callId: session.originCallId,
        roomId: sessionId,
        sessionKind: 'conference',
        mode,
        from: requesterCard,
        peers: [requesterCard, peerCard],
        isVideo: !!entry.isVideo,
      });

      notifyIncomingCall(
        inviteeID,
        requesterID,
        requesterCard.name,
        requesterCard.photo,
        !!entry.isVideo,
        // L'invitation, pas la session : c'est cet identifiant que le
        // téléphone présente et marque terminé. La session voyage à côté.
        inviteId,
        {
          roomId: sessionId,
          sessionId,
          sessionKind: 'conference',
          mode,
        },
      ).catch((err) => console.warn('[Socket call_add] FCM invite error:', err.message));
    } catch (error) {
      console.error('[Socket call_add_participant]', error.message);
      socket.emit('call_add_rejected', { code: 'INTERNAL' });
    }
  });
};

const cancelAddParticipant = (io, socket, userSockets) => {
  socket.on('call_add_cancel', async () => {
    try {
      if (!socket.authenticated) return;
      const session = await callSessions.getByUser(socket.alanyaID);
      if (!session?.pending) return;
      // L'invitation appartient à celui qui l'a lancée : lui seul l'annule.
      if (session.pending.byUserId !== socket.alanyaID) return;
      await failInvite(io, session.sessionId, 'cancelled');
    } catch (error) {
      console.error('[Socket call_add_cancel]', error.message);
    }
  });
};

const confReject = (io, socket, userSockets) => {
  socket.on('call_conf_reject', async () => {
    try {
      if (!socket.authenticated) return;
      const session = await callSessions.getByUser(socket.alanyaID);
      if (!session || !callSessions.isPending(session, socket.alanyaID)) return;
      await failInvite(io, session.sessionId, 'declined', {
        decliningDeviceId: normalizeDeviceId(socket.deviceId),
      });
    } catch (error) {
      console.error('[Socket call_conf_reject]', error.message);
    }
  });
};

const confJoin = (io, socket, userSockets) => {
  socket.on('call_conf_join', async () => {
    try {
      if (!socket.authenticated) return;
      const inviteeID = socket.alanyaID;
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!deviceId) {
        socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
        return;
      }

      const session = await callSessions.getByUser(inviteeID);
      if (!session || !callSessions.isPending(session, inviteeID)) {
        // Sortir en silence laissait l'invité sur un écran qui tourne, sans
        // moyen de distinguer un refus d'une lenteur réseau. Les autres sorties
        // de ce handler émettent toutes un call_error : celle-ci aussi.
        console.log(
          `[Socket call_conf_join] ⛔ aucune invitation en attente user=${inviteeID}`,
        );
        socket.emit('call_error', {
          code: 'CALL_INVITE_NOT_PENDING',
          callId: session ? session.sessionId : null,
        });
        return;
      }

      const { sessionId } = session;
      if (session.pending.acceptedByDeviceId) {
        socket.emit('call_error', {
          code: 'CALL_ALREADY_JOINED_ON_OTHER_DEVICE',
          callId: sessionId,
        });
        return;
      }

      if (!(await callDeviceOwnership.getEntry(sessionId, inviteeID))) {
        await callDeviceOwnership.ring(sessionId, inviteeID);
      }
      const claim = await callDeviceOwnership.tryClaim(
        sessionId,
        inviteeID,
        deviceId,
        socket.id,
      );
      if (!claim.ok) {
        socket.emit('call_error', {
          code: claim.reason === 'CALL_ANSWERED_ELSEWHERE'
            ? 'CALL_ALREADY_JOINED_ON_OTHER_DEVICE'
            : 'CALL_INVALID_STATE',
          callId: sessionId,
        });
        return;
      }

      // L'écriture partait dans une copie jetable en mode Redis : la garde
      // anti-double-join relisait toujours null. Elle est maintenant persistée,
      // et refuse si un autre appareil a déjà accepté.
      const noted = await callSessions.markPendingAccepted(sessionId, {
        deviceId,
        socketId: socket.id,
      });
      if (!noted) {
        socket.emit('call_error', {
          code: 'CALL_ALREADY_JOINED_ON_OTHER_DEVICE',
          callId: sessionId,
        });
        return;
      }

      const mode = session.mode || 'join';
      const present = callSessions.participantIds(session);
      // Lu avant la promotion, qui efface l'invitation.
      const inviteId = session.pending.inviteId || sessionId;
      const promoted = await callSessions.promotePending(sessionId);
      if (!promoted) {
        // Invitation soldée entre l'acceptation et ici (délai, annulation) :
        // la réclamation posée plus haut resterait « active » et gênerait une
        // réinvitation de cet utilisateur dans la même session.
        await callDeviceOwnership.forget(sessionId, inviteeID);
        return;
      }

      // Ownership A/B : reprise depuis originCallId si pas encore migrés à l'invite.
      if (session.originCallId) {
        for (const uid of present) {
          if (await callDeviceOwnership.getActiveDeviceId(sessionId, uid)) continue;
          const prev = await callDeviceOwnership.getEntry(String(session.originCallId), uid);
          if (prev?.activeDeviceId) {
            await callDeviceOwnership.setActive(sessionId, uid, {
              activeDeviceId: prev.activeDeviceId,
              activeSocketId: prev.activeSocketId,
            });
          }
        }
      }

      await pendingCalls.clear(inviteeID);
      await callState.setInCall(inviteeID, {
        callId: sessionId,
        peerId: present[0] ?? null,
        isVideo: session.isVideo,
      });
      socket.currentCallID = sessionId;

      console.log(`[Socket call_add] ✔ ${inviteeID} device=${deviceId} rejoint session=${sessionId} mode=${mode}`);

      const elsewherePayload = {
        callId: sessionId,
        inviteId,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      };
      await emitToUserExceptDevice(io, inviteeID, deviceId, 'call_ended', elsewherePayload);
      notifyCallEnded(inviteeID, present[0] ?? null, 'Appel répondu sur un autre appareil', inviteId, {
        excludeDeviceId: deviceId,
        reason: 'answered_elsewhere',
        claimedByAnotherDevice: true,
      }).catch((err) => console.warn('[Socket call_conf_join] FCM siblings:', err.message));

      if (mode === 'transfer') {
        await callSessions.markTransferJoined(sessionId, TRANSFER_READY_TIMEOUT_MS, () => {
          onTransferMediaNotReady(io, userSockets, sessionId)
            .catch((err) => console.warn('[Socket transfer] media_not_ready error:', err.message));
        });
      }

      openSessionHistory(promoted, inviteeID)
        .catch((err) => console.warn('[Socket call_conf_join] historique:', err.message));

      const cards = await fetchUserCards([...present, inviteeID]);
      const fallback = (uid) => ({ id: String(uid), name: '', photo: null });
      const inviteeCard = cards.get(inviteeID) ?? fallback(inviteeID);

      for (const uid of present) {
        const activeDid = await callDeviceOwnership.getActiveDeviceId(sessionId, uid);
        const payload = { sessionId, user: inviteeCard, mode };
        if (!activeDid) {
          console.warn(`[Socket call_conf_join] pas de device actif user=${uid} — drop conf_joined`);
          continue;
        }
        emitToDevice(io, uid, activeDid, 'call_conf_joined', payload);
      }

      emitToDevice(io, inviteeID, deviceId, 'call_conf_peers', {
        sessionId,
        isVideo: session.isVideo,
        mode,
        peers: present.map((uid) => cards.get(uid) ?? fallback(uid)),
      });
    } catch (error) {
      console.error('[Socket call_conf_join]', error.message);
    }
  });
};

const confReady = (io, socket, userSockets) => {
  socket.on('call_conf_ready', async (data) => {
    try {
      if (!socket.authenticated) return;
      const reporterID = socket.alanyaID;
      const sessionId = data?.sessionId?.toString();
      const peerId = toInt(data?.peerId);
      if (!sessionId || !peerId) return;

      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!deviceId || !(await callDeviceOwnership.isOwnerDevice(sessionId, reporterID, deviceId))) {
        console.log(
          `[Socket call_conf_ready] ignored reporter=${reporterID} reason=not_owner_device`,
        );
        return;
      }

      const result = await callSessions.registerTransferReady({
        sessionId,
        reporterId: reporterID,
        peerId,
        leaveTimerMs: TRANSFER_AUTO_LEAVE_MS,
        onLeave: () => {
          onTransferAutoLeave(io, userSockets, sessionId)
            .catch((err) => console.warn('[Socket transfer] auto-leave error:', err.message));
        },
      });

      if (!result.ok) {
        console.log(`[Socket call_conf_ready] ignored reporter=${reporterID} reason=${result.reason}`);
        return;
      }

      if (result.armed) {
        const initiatorId = result.session.transfer.initiatorId;
        console.log(
          `[Socket call_conf_ready] ✔ armed session=${sessionId} ` +
          `reporter=${reporterID} peer=${peerId} → leave ${initiatorId} in ${TRANSFER_AUTO_LEAVE_MS}ms`,
        );
        const initDid = await callDeviceOwnership.getActiveDeviceId(sessionId, initiatorId);
        const armedPayload = {
          sessionId,
          leaveInMs: TRANSFER_AUTO_LEAVE_MS,
        };
        if (initDid) {
          emitToDevice(io, initiatorId, initDid, 'call_transfer_armed', armedPayload);
        } else {
          console.warn(
            `[Socket call_conf_ready] pas de device initiateur=${initiatorId} — drop transfer_armed`,
          );
        }
      }
    } catch (error) {
      console.error('[Socket call_conf_ready]', error.message);
    }
  });
};

//  APPELS DE GROUPE

const createGroupCall = (io, socket, userSockets) => {
  socket.on('create_group_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId, callerId, callerName, callerPhoto, isVideo, targetUserIds } = data;
      if (!roomId || !Array.isArray(targetUserIds)) return;
      if (!groupRooms.isValidRoomId(String(roomId))) {
        return socket.emit('call_error', { code: 'INVALID_ROOM_ID' });
      }

      const callerID = socket.alanyaID;
      const videoCall = !!isVideo;
      const callerDeviceId = normalizeDeviceId(socket.deviceId);
      if (!callerDeviceId) {
        return socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
      }
      if (callerId != null && toInt(callerId) != null && toInt(callerId) !== callerID) {
        console.warn(`[Socket create_group_call] callerId spoof payload=${callerId} socket=${callerID}`);
        return socket.emit('call_error', { code: 'CALLER_ID_MISMATCH' });
      }
      // Essai fini et aucun abonnement : on rejoint un appel de groupe sur
      // invitation (join_group_call), on n'en lance pas.
      if (!(await checkOutgoing(callerID)).allowed) {
        return socket.emit('call_error', {
          code: OUTGOING_DENIED.code,
          feature: OUTGOING_DENIED.feature,
        });
      }
      const inviteLimit = maxInvitees(videoCall);
      const uniqueTargets = [...new Set(
        targetUserIds.map(toInt).filter((id) => id && id !== callerID),
      )];

      if (uniqueTargets.length > inviteLimit) {
        return socket.emit('error', {
          message: `Maximum ${maxParticipants(videoCall)} participants en ${videoCall ? 'vidéo' : 'audio'} (vous inclus)`,
          code: 'GROUP_CALL_TOO_MANY',
        });
      }

      await groupRooms.create(roomId, {
        isVideo: videoCall,
        ownerID: callerID,
        ownerInfo: { userName: callerName || '', userPhoto: callerPhoto || null },
      });

      socket.join(`group_${roomId}`);
      socket.currentGroupRoom = roomId;
      await callDeviceOwnership.setActive(String(roomId), callerID, {
        activeDeviceId: callerDeviceId,
        activeSocketId: socket.id,
      });
      // L'organisateur est engagé : sans cette inscription il restait invisible
      // à `isBusyForNewCall`, et un appel à deux lui arrivait par-dessus.
      await callState.setInGroup(callerID, roomId);

      const fcmTargets = [];
      for (const targetID of uniqueTargets) {
        // Le chemin 1-à-1 protège sa cible depuis toujours — `call_user`
        // refuse et émet `call_busy` quand elle est déjà en communication. Le
        // groupe ne consultait rien : l'invitation partait chez tout le monde,
        // et arrivait en plein écran, sonnerie comprise, par-dessus une
        // conversation en cours. `isApplicationForeground` rend faux dès que le
        // verrou d'écran est posé, c'est-à-dire l'état normal d'un appel audio.
        //
        // On n'invite pas quelqu'un qui parle déjà.
        if (await callState.isBusyForNewCall(targetID, callerID, pendingCalls)) {
          console.log(
            `[create_group_call] invité ${targetID} occupé — non sonné`,
          );
          continue;
        }
        await callDeviceOwnership.ring(String(roomId), targetID);
        fcmTargets.push(targetID);
        if (await isUserOnline(io, targetID)) {
          emitToUser(io, targetID, 'group_call_invite', {
            callerId:    String(callerID),
            callerName:  callerName  || '',
            callerPhoto: callerPhoto || null,
            isVideo:     videoCall,
            roomId,
          });
        }
      }

      // FCM en parallèle pour les destinataires hors-ligne / app fermée
      notifyGroupCall(fcmTargets, callerID, callerName, callerPhoto, videoCall, roomId)
        .catch((err) => console.warn('[Socket create_group_call] FCM error:', err.message));
    } catch (error) {
      console.error('[Socket create_group_call]', error.message);
    }
  });
};

const joinGroupCall = (io, socket, userSockets) => {
  socket.on('join_group_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId, userId, userName, userPhoto } = data;
      if (!roomId) return;
      // L'identifiant vient du client et alimente l'espace de clés Redis ainsi
      // que la clé de déduplication des jobs, un VARCHAR(128).
      if (!groupRooms.isValidRoomId(String(roomId))) {
        return socket.emit('call_error', { code: 'INVALID_ROOM_ID' });
      }

      const userID = socket.alanyaID;
      if (userId != null && toInt(userId) != null && toInt(userId) !== userID) {
        console.warn(`[Socket join_group_call] userId spoof payload=${userId} socket=${userID}`);
        return socket.emit('call_error', { code: 'USER_ID_MISMATCH' });
      }
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!deviceId) {
        return socket.emit('call_error', { code: 'DEVICE_ID_REQUIRED' });
      }

      const roomKey = String(roomId);
      // Inviteé sans entrée ownership (join tardif) : ring serveur puis claim.
      if (!(await callDeviceOwnership.getEntry(roomKey, userID))) {
        await callDeviceOwnership.ring(roomKey, userID);
      }
      const claim = await callDeviceOwnership.tryClaim(roomKey, userID, deviceId, socket.id);
      if (!claim.ok) {
        return socket.emit('call_error', {
          code: claim.reason === 'CALL_ANSWERED_ELSEWHERE'
            ? 'CALL_ANSWERED_ELSEWHERE'
            : 'CALL_INVALID_STATE',
          callId: roomKey,
        });
      }

      // Contrôle de capacité ET ajout en une seule opération : séparés, N
      // arrivées simultanées liraient toutes « il reste une place » avant
      // qu'aucune n'ait écrit, et le salon déborderait sa limite.
      const entree = await groupRooms.join(roomId, userID, {
        userName: userName || '', userPhoto: userPhoto || null,
      });
      if (!entree.ok) {
        // Le salon a été terminé pendant qu'on essayait d'entrer : sans la
        // pierre tombale, `join` l'aurait ressuscité en audio et sans
        // organisateur.
        if (entree.code === 'ROOM_ENDED') {
          return socket.emit('group_call_ended', { roomId: roomKey });
        }
        return socket.emit('error', {
          message: `Cet appel ${entree.isVideo ? 'vidéo' : 'audio'} est complet (${entree.limite} participants max)`,
          code: 'GROUP_CALL_FULL',
        });
      }
      const room = entree.room;

      socket.join(`group_${roomId}`);
      socket.currentGroupRoom = roomId;
      // Engagé : voir `callState.statusOccupies`. Sans pair et sous un statut
      // distinct, donc invisible aux chemins 1-à-1.
      await callState.setInGroup(userID, roomId);

      if (!claim.alreadyOwner) {
        await emitToUserExceptDevice(io, userID, deviceId, 'call_ended', {
          callId: roomKey,
          reason: 'answered_elsewhere',
          claimedByAnotherDevice: true,
        });
        notifyCallEnded(userID, null, 'Appel répondu sur un autre appareil', roomKey, {
          excludeDeviceId: deviceId,
          reason: 'answered_elsewhere',
          claimedByAnotherDevice: true,
        }).catch(() => {});
      }

      // `participants` n'était déclaré nulle part : la ligne levait une
      // ReferenceError que le catch en fin de handler avalait en une ligne de
      // log. Tout ce qui précède avait réussi — l'arrivant était bien dans la
      // salle, et les autres prévenus — mais lui ne recevait jamais la liste
      // de ceux qui s'y trouvaient déjà. Son roster se limitait donc à
      // lui-même et à celui qui l'avait invité : les états micro et caméra des
      // autres lui arrivaient bien, mais tombaient dans le `containsKey` du
      // client, et leurs tuiles restaient absentes de la grille.
      //
      // Sa liste part AVANT l'annonce aux autres : c'est elle qui déclenche,
      // côté arrivant, la réaffirmation de ses propres états média. L'ordre
      // inverse faisait courir les deux gestes l'un contre l'autre.
      const participantIds = Array.from(room.participants.keys()).map(String);
      socket.emit('group_participants', {
        roomId, participants: participantIds, resumed: !!entree.reprise,
      });

      socket.to(`group_${roomId}`).emit('group_user_joined', {
        roomId,
        userId:    String(userID),
        userName:  userName  || '',
        userPhoto: userPhoto || null,
        // Additif : dit aux autres que c'est un retour de coupure, pas une
        // arrivée. Aucun client ne le lit encore.
        resumed:   !!entree.reprise,
      });
    } catch (error) {
      console.error('[Socket join_group_call]', error.message);
    }
  });
};

const leaveGroupCall = (io, socket, userSockets) => {
  socket.on('leave_group_call', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { roomId } = data || {};
      // Le repli sur `currentGroupRoom` doit précéder le retrait : sans
      // `roomId` dans le payload, rien n'était purgé du salon alors que le
      // départ était bel et bien annoncé — un participant fantôme y restait.
      const rId = roomId || socket.currentGroupRoom;
      if (rId && socket.alanyaID) {
        await groupRooms.leave(rId, socket.alanyaID);
      }

      if (rId) {
        // Sans cette libération, l'entrée restait `active` sur l'appareil qui
        // vient de partir : rejoindre la même salle depuis un autre appareil
        // renvoyait CALL_ANSWERED_ELSEWHERE, définitivement.
        if (socket.alanyaID != null) {
          await callDeviceOwnership.forget(String(rId), socket.alanyaID);
          // `clearGroup` et non `clear` : un appel à deux commencé entre-temps
          // ne doit pas partir avec le départ du salon.
          await callState.clearGroup(socket.alanyaID);
        }
        socket.to(`group_${rId}`).emit('group_user_left', {
          roomId: rId,
          userId: String(socket.alanyaID),
        });
        socket.leave(`group_${rId}`);

        // Le salon s'est-il vidé ? Alors les invités qui sonnent encore
        // sonnent pour un appel que plus personne ne mène.
        try {
          const restant = await groupRooms.get(rId);
          if (!restant || !restant.participants || restant.participants.size === 0) {
            await notifierFinAuxInvitesEnSonnerie(rId, socket.alanyaID);
          }
        } catch (err) {
          console.warn('[Socket leave_group_call] fin de salon:', err.message);
        }
      }

      socket.currentGroupRoom = null;
    } catch (error) {
      console.error('[Socket leave_group_call]', error.message);
    }
  });
};

/**
 * Prévient par push les invités qui sonnent encore pour un appel de groupe.
 *
 * `end_group_call` et le départ du dernier participant ne diffusaient qu'à la
 * salle socket `group_<id>`. Or un invité dont l'application est fermée n'y est
 * jamais entré : il n'a été joint que par `notifyGroupCall`. Rien ne retirait
 * donc son entrée CallKit, et son téléphone sonnait les quarante secondes
 * complètes — écran de verrouillage compris — pour un appel que tout le monde
 * avait déjà quitté. À l'expiration, l'entrée retirée déclenchait en plus un
 * refus vers le serveur.
 *
 * Le 1-à-1 et la conférence poussent bien un `call_ended` dans ce cas ; le
 * groupe était le seul à ne pas le faire.
 */
async function notifierFinAuxInvitesEnSonnerie(roomId, ownerID) {
  const rId = String(roomId);
  let enSonnerie = [];
  try {
    enSonnerie = await callDeviceOwnership.listUsers(rId, 'ringing');
  } catch (err) {
    console.warn('[groupe] listUsers échoué:', err.message);
    return;
  }
  if (!enSonnerie.length) return;
  console.log(
    `[groupe] fin de ${rId} → ${enSonnerie.length} invité(s) encore en sonnerie`,
  );
  await Promise.allSettled(
    enSonnerie.map((inviteID) =>
      notifyCallEnded(inviteID, ownerID, 'Appel de groupe', rId, {
        reason: 'group_ended',
      }).catch((err) =>
        console.warn(`[groupe] call_ended vers ${inviteID}:`, err.message)),
    ),
  );
}

const endGroupCall = (io, socket, userSockets) => {
  socket.on('end_group_call', async (data) => {
    try {
      // Terminer l'appel pour TOUT le monde est réservé à l'organisateur
      // (ou, si la room n'a pas d'organisateur connu, à un participant).
      // Sans ces gardes, n'importe quelle socket — même non authentifiée —
      // pouvait tuer un appel de groupe en devinant son roomId.
      if (!socket.authenticated) return;
      const { roomId } = data || {};
      const rId = roomId || socket.currentGroupRoom;
      if (!rId) return;

      const room = await groupRooms.get(rId);
      if (room) {
        const isOwner =
          room.ownerID != null && Number(room.ownerID) === Number(socket.alanyaID);
        const isParticipant = !!room.participants?.has(Number(socket.alanyaID));
        if (!isOwner && !(room.ownerID == null && isParticipant)) return;
      }

      await groupRooms.destroy(rId);
      // Avant de libérer la propriété : c'est elle qui sait qui sonne encore,
      // et qui participe.
      await notifierFinAuxInvitesEnSonnerie(rId, socket.alanyaID);
      try {
        const engages = await callDeviceOwnership.listUsers(String(rId));
        await Promise.allSettled(engages.map((uid) => callState.clearGroup(uid)));
      } catch (err) {
        console.warn('[Socket end_group_call] libération callState:', err.message);
      }
      // La salle n'existe plus : plus personne n'a d'appareil à y posséder.
      await callDeviceOwnership.release(String(rId));
      // Le payload portait `{}` : le client ne pouvait pas distinguer la fin de
      // SA salle de celle d'une précédente (voir B5, côté client).
      io.to(`group_${rId}`).emit('group_call_ended', { roomId: String(rId) });

      // io.sockets.adapter.rooms/sockets ne voient que CE process : capturer
      // les membres locaux avant socketsLeave() (cross-instance, ci-dessous),
      // qui aura déjà vidé la room ici une fois appelé.
      const localSids = io.sockets.adapter.rooms.get(`group_${rId}`);

      // Cross-instance : propage le départ de la room via l'adapter Redis à
      // toute socket membre, quelle que soit l'instance qui l'héberge — sans
      // ça, un participant connecté à une AUTRE instance que celle traitant
      // end_group_call continuerait de recevoir les diffusions de cette room.
      io.in(`group_${rId}`).socketsLeave(`group_${rId}`);

      // currentGroupRoom est une propriété brute lue uniquement en local
      // (jamais via fetchSockets()) : la réinitialiser ne vaut donc que pour
      // les sockets de CE process — une RemoteSocket ne peut pas être mutée
      // à distance.
      if (localSids) {
        for (const sid of localSids) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.currentGroupRoom = null;
        }
      }
    } catch (error) {
      console.error('[Socket end_group_call]', error.message);
    }
  });
};

const groupOffer = (io, socket, userSockets) => {
  socket.on('group_offer', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, offer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !offer) return;
      const rId = roomId != null ? String(roomId) : (socket.currentGroupRoom != null ? String(socket.currentGroupRoom) : null);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!rId || !deviceId || !(await callDeviceOwnership.isOwnerDevice(rId, socket.alanyaID, deviceId))) {
        return;
      }
      // Signal média = preuve de session locale, comme pour ice_candidate.
      // Sans cela, un participant de session à trois qui reprend uniquement par
      // le maillage se faisait solder par resume_ack_timeout.
      if (await callState.hasResumeAckTimer(socket.alanyaID)) {
        await callState.confirmResume(socket.alanyaID);
      }
      const targetDid = await callDeviceOwnership.getActiveDeviceId(rId, targetID);
      if (!targetDid) {
        console.warn(`[Socket group_offer] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDid, 'group_offer', {
        fromUserId: String(socket.alanyaID),
        offer,
        roomId: rId,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      });
    } catch (error) {
      console.error('[Socket group_offer]', error.message);
    }
  });
};

const groupAnswer = (io, socket, userSockets) => {
  socket.on('group_answer', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, answer, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !answer) return;
      const rId = roomId != null ? String(roomId) : (socket.currentGroupRoom != null ? String(socket.currentGroupRoom) : null);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!rId || !deviceId || !(await callDeviceOwnership.isOwnerDevice(rId, socket.alanyaID, deviceId))) {
        return;
      }
      // Signal média = preuve de session locale, comme pour ice_candidate.
      if (await callState.hasResumeAckTimer(socket.alanyaID)) {
        await callState.confirmResume(socket.alanyaID);
      }
      const targetDid = await callDeviceOwnership.getActiveDeviceId(rId, targetID);
      if (!targetDid) {
        console.warn(`[Socket group_answer] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDid, 'group_answer', {
        fromUserId: String(socket.alanyaID),
        answer,
        roomId: rId,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      });
    } catch (error) {
      console.error('[Socket group_answer]', error.message);
    }
  });
};

const groupIceCandidate = (io, socket, userSockets) => {
  socket.on('group_ice_candidate', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, candidate, roomId } = data;
      const targetID = toInt(toUserId);
      if (!targetID || !candidate) return;
      const rId = roomId != null ? String(roomId) : (socket.currentGroupRoom != null ? String(socket.currentGroupRoom) : null);
      const deviceId = normalizeDeviceId(socket.deviceId);
      if (!rId || !deviceId || !(await callDeviceOwnership.isOwnerDevice(rId, socket.alanyaID, deviceId))) {
        return;
      }
      // Signal média = preuve de session locale, comme pour ice_candidate.
      if (await callState.hasResumeAckTimer(socket.alanyaID)) {
        await callState.confirmResume(socket.alanyaID);
      }
      const targetDid = await callDeviceOwnership.getActiveDeviceId(rId, targetID);
      if (!targetDid) {
        console.warn(`[Socket group_ice_candidate] pas de device cible user=${targetID} — drop`);
        return;
      }
      emitToDevice(io, targetID, targetDid, 'group_ice_candidate', {
        fromUserId: String(socket.alanyaID),
        candidate,
        roomId: rId,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      });
    } catch (error) {
      console.error('[Socket group_ice_candidate]', error.message);
    }
  });
};

//  ÉTAT MICRO (MUTE) 

// Appel 1-à-1 : relaie l'état micro vers le destinataire.
// Le userId est estampillé côté serveur (socket.alanyaID) : source fiable,
// impossible à usurper par le payload client.
const callMuteState = (io, socket, userSockets) => {
  socket.on('call:mute_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, isMuted } = data || {};
      const targetID = toInt(toUserId);
      if (!targetID) return;

      emitToUser(io, targetID, 'call:mute_state', {
        userId:  String(socket.alanyaID),
        isMuted: !!isMuted,
      });
    } catch (error) {
      console.error('[Socket call:mute_state]', error.message);
    }
  });
};

// Appel de groupe : diffuse l'état micro à tous les autres participants.
// Les groupes classiques sont dans la room Socket.IO `group_<roomId>`. Une
// conférence créée par « Ajouter un participant » utilise au contraire une
// callSession et un routage média par appareil ; ses participants ne rejoignent
// pas cette room. On relaie donc cette session vers les seuls appareils owners,
// sans changer le chemin historique des groupes classiques.
const groupMuteState = (io, socket, userSockets) => {
  socket.on('group:mute_state', async (data) => {
    try {
      if (!socket.authenticated) return;
      const rId = (data && data.roomId) || socket.currentGroupRoom;
      if (!rId) return;

      const payload = {
        roomId: String(rId),
        userId: String(socket.alanyaID),
        isMuted: !!(data && data.isMuted),
      };

      const session = await callSessions.getByUser(socket.alanyaID);
      if (session && String(session.sessionId) === String(rId)) {
        for (const participantId of callSessions.participantIds(session)) {
          if (Number(participantId) === Number(socket.alanyaID)) continue;
          const deviceId = await callDeviceOwnership.getActiveDeviceId(
            session.sessionId,
            participantId,
          );
          if (deviceId) {
            emitToDevice(io, participantId, deviceId, 'group:mute_state', payload);
          }
        }
        return;
      }

      socket.to(`group_${rId}`).emit('group:mute_state', payload);
    } catch (error) {
      console.error('[Socket group:mute_state]', error.message);
    }
  });
};

// Appel 1-à-1 : relaie l'état caméra vers le destinataire.
const callVideoState = (io, socket, userSockets) => {
  socket.on('call:video_state', (data) => {
    try {
      if (!socket.authenticated) return;
      const { toUserId, isVideoOn } = data || {};
      const targetID = toInt(toUserId);
      if (!targetID) return;

      emitToUser(io, targetID, 'call:video_state', {
        userId:    String(socket.alanyaID),
        isVideoOn: !!isVideoOn,
      });
    } catch (error) {
      console.error('[Socket call:video_state]', error.message);
    }
  });
};

// Appel de groupe : diffuse l'état caméra à tous les autres participants.
// Même double routage que `group:mute_state` ci-dessus : une conférence relaie
// vers les seuls appareils owners de la callSession, un groupe classique passe
// par la room Socket.IO. Sans la branche conférence, couper ou rallumer sa
// caméra à trois n'était jamais vu des autres — ils ne sont pas dans la room.
const groupVideoState = (io, socket, userSockets) => {
  socket.on('group:video_state', async (data) => {
    try {
      if (!socket.authenticated) return;
      const rId = (data && data.roomId) || socket.currentGroupRoom;
      if (!rId) return;

      const payload = {
        roomId:    rId,
        userId:    String(socket.alanyaID),
        isVideoOn: !!(data && data.isVideoOn),
      };

      const session = await callSessions.getByUser(socket.alanyaID);
      if (session && String(session.sessionId) === String(rId)) {
        for (const participantId of callSessions.participantIds(session)) {
          if (Number(participantId) === Number(socket.alanyaID)) continue;
          const deviceId = await callDeviceOwnership.getActiveDeviceId(
            session.sessionId,
            participantId,
          );
          if (deviceId) {
            emitToDevice(io, participantId, deviceId, 'group:video_state', payload);
          }
        }
        return;
      }

      socket.to(`group_${rId}`).emit('group:video_state', payload);
    } catch (error) {
      console.error('[Socket group:video_state]', error.message);
    }
  });
};

// Renégociation WebRTC après reconnexion (kill app en appel connecté).
/**
 * Émet call_resume UNIQUEMENT vers le device owner.
 * Auth ne doit plus appeler cancelDisconnectGrace pour un in_call.
 * Pas d'owner → pas d'emitToUser de secours ; timer RESUME_OWNER_MISSING dédié.
 */
async function offerCallResume(io, socket, userSockets, userID) {
  const entry = await callState.getEntry(userID);
  if (!entry || entry.status !== 'in_call') return false;

  const peerId = entry.peerId;
  const callKey = entry.callId != null ? String(entry.callId) : null;
  const ownerDeviceId = callKey
    ? await callDeviceOwnership.getActiveDeviceId(callKey, userID)
    : null;

  if (!ownerDeviceId) {
    console.log(
      `[Socket] call_resume skipped (no owner) user=${userID} callId=${callKey ?? 'none'}`,
    );
    await callState.scheduleResumeOwnerMissing(userID, async () => {
      try {
        console.log(
          `[Socket] resume_owner_missing timeout user=${userID} callId=${callKey ?? 'none'}`,
        );
        await endActiveCallForUser(io, userSockets, userID, 'resume_owner_missing');
        if (callKey) await callDeviceOwnership.release(callKey);
      } catch (e) {
        console.warn('[Socket] resume_owner_missing endActiveCallForUser failed:', e.message);
      }
    });
    return false;
  }

  const socketDid = normalizeDeviceId(socket.deviceId);
  if (!socketDid || socketDid !== ownerDeviceId) {
    console.log(
      `[Socket] call_resume skipped (non-owner socket) user=${userID} device=${socketDid ?? 'none'} owner=${ownerDeviceId}`,
    );
    return false;
  }

  const payload = {
    callId: entry.callId,
    peerId: peerId != null ? String(peerId) : null,
    status: 'in_call',
    isVideo: !!entry.isVideo,
    role: entry.lastAnswer != null ? 'caller' : 'callee',
    answer: entry.lastAnswer ?? null,
  };
  console.log(`[Socket] call_resume user=${userID} callId=${payload.callId ?? 'none'} device=${ownerDeviceId}`);
  emitToDevice(io, userID, ownerDeviceId, 'call_resume', payload);

  await callState.scheduleResumeAck(userID, async () => {
    try {
      console.log(
        `[Socket] call_resume_ack timeout user=${userID} callId=${callKey ?? 'none'}`,
      );
      await endActiveCallForUser(io, userSockets, userID, 'resume_ack_timeout');
      if (callKey) await callDeviceOwnership.release(callKey);
    } catch (e) {
      console.warn('[Socket] resume_ack_timeout endActiveCallForUser failed:', e.message);
    }
  });
  return true;
}

async function _settleResumeReject(io, userSockets, userID, callId, reason) {
  const entry = await callState.getEntry(userID);
  if (!entry || entry.status !== 'in_call') return false;
  if (callId != null && entry.callId != null && String(entry.callId) !== String(callId)) {
    return false;
  }
  const callKey = entry.callId != null ? String(entry.callId) : null;
  console.log(
    `[Socket] call_resume_reject user=${userID} callId=${callKey ?? 'none'} reason=${reason}`,
  );
  await endActiveCallForUser(io, userSockets, userID, reason);
  if (callKey) await callDeviceOwnership.release(callKey);
  return true;
}

const callResumeHandshake = (io, socket, userSockets) => {
  socket.on('call_resume_ack', async (data) => {
    try {
      if (!socket.authenticated) return;
      const userID = socket.alanyaID;
      const callId = data?.callId != null ? String(data.callId) : null;
      const entry = await callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call') return;
      if (callId != null && entry.callId != null && String(entry.callId) !== callId) {
        console.warn(
          `[Socket call_resume_ack] callId mismatch user=${userID} got=${callId} expected=${entry.callId}`,
        );
        return;
      }
      const callKey = entry.callId != null ? String(entry.callId) : null;
      const deviceId = normalizeDeviceId(socket.deviceId);
      // Seul le device owner peut confirmer la reprise.
      if (
        callKey &&
        (await callDeviceOwnership.getActiveDeviceId(callKey, userID)) &&
        (!deviceId || !(await callDeviceOwnership.isOwnerDevice(callKey, userID, deviceId)))
      ) {
        console.log(
          `[Socket] call_resume_ack ignored (non-owner) user=${userID} device=${deviceId ?? 'none'}`,
        );
        return;
      }
      await callState.confirmResume(userID);
      console.log(
        `[Socket] call_resume_ack user=${userID} callId=${entry.callId ?? 'none'}`,
      );
    } catch (error) {
      console.error('[Socket call_resume_ack]', error.message);
    }
  });

  socket.on('call_resume_reject', async (data) => {
    try {
      if (!socket.authenticated) return;
      const userID = socket.alanyaID;
      const callId = data?.callId != null ? String(data.callId) : null;
      const reason = data?.reason != null ? String(data.reason) : 'no_local_call_state';
      const entry = await callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call') return;
      const callKey = entry.callId != null ? String(entry.callId) : null;
      const deviceId = normalizeDeviceId(socket.deviceId);
      // Non-owner : ignore — ne jamais solder un appel actif sur le device owner.
      if (
        callKey &&
        (await callDeviceOwnership.getActiveDeviceId(callKey, userID)) &&
        (!deviceId || !(await callDeviceOwnership.isOwnerDevice(callKey, userID, deviceId)))
      ) {
        console.log(
          `[Socket] call_resume_reject ignored (non-owner) user=${userID} device=${deviceId ?? 'none'}`,
        );
        return;
      }
      await _settleResumeReject(
        io,
        userSockets,
        userID,
        callId,
        reason === 'no_local_call_state' ? 'resume_rejected' : `resume_rejected:${reason}`,
      );
    } catch (error) {
      console.error('[Socket call_resume_reject]', error.message);
    }
  });
};

const callRejoin = (io, socket, userSockets) => {
  socket.on('call_rejoin', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, offer } = data || {};
      const targetID = toInt(targetUserId);
      const userID = socket.alanyaID;
      if (!targetID || !offer) return;

      const entry = await callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call' || Number(entry.peerId) !== targetID) {
        socket.emit('call_failed', { reason: 'Aucun appel actif à reprendre', code: 'CALL_REJOIN_INVALID' });
        return;
      }

      const callKey = entry.callId != null ? String(entry.callId) : null;
      const sourceDeviceId = normalizeDeviceId(socket.deviceId);
      if (
        !callKey ||
        !sourceDeviceId ||
        !(await callDeviceOwnership.isOwnerDevice(callKey, userID, sourceDeviceId))
      ) {
        console.log(
          `[Socket call_rejoin] ignored (non-owner) user=${userID} device=${sourceDeviceId ?? 'none'}`,
        );
        return;
      }

      // Clients anciens : call_rejoin vaut confirmation de reprise.
      await callState.confirmResume(userID);

      const targetDeviceId = await callDeviceOwnership.getActiveDeviceId(callKey, targetID);
      if (!targetDeviceId) {
        console.warn(
          `[Socket call_rejoin] pas de device cible user=${targetID} callId=${callKey} — drop (pas emitToUser)`,
        );
        return;
      }

      const payload = {
        callId: entry.callId,
        peerId: String(userID),
        offer,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      };

      emitToDevice(io, targetID, targetDeviceId, 'call_rejoin_offer', payload);
    } catch (error) {
      console.error('[Socket call_rejoin]', error.message);
    }
  });

  socket.on('call_rejoin_answer', async (data) => {
    try {
      if (!socket.authenticated) return;
      const { targetUserId, answer } = data || {};
      const targetID = toInt(targetUserId);
      const userID = socket.alanyaID;
      if (!targetID || !answer) return;

      const entry = await callState.getEntry(userID);
      if (!entry || entry.status !== 'in_call' || Number(entry.peerId) !== targetID) {
        return;
      }

      const callKey = entry.callId != null ? String(entry.callId) : null;
      const sourceDeviceId = normalizeDeviceId(socket.deviceId);
      if (
        !callKey ||
        !sourceDeviceId ||
        !(await callDeviceOwnership.isOwnerDevice(callKey, userID, sourceDeviceId))
      ) {
        console.log(
          `[Socket call_rejoin_answer] ignored (non-owner) user=${userID} device=${sourceDeviceId ?? 'none'}`,
        );
        return;
      }

      await callState.confirmResume(userID);

      const targetDeviceId = await callDeviceOwnership.getActiveDeviceId(callKey, targetID);
      if (!targetDeviceId) {
        console.warn(
          `[Socket call_rejoin_answer] pas de device cible user=${targetID} callId=${callKey} — drop (pas emitToUser)`,
        );
        return;
      }

      const payload = {
        callId: entry.callId,
        peerId: String(userID),
        answer,
        ...(data?.generation != null ? { generation: data.generation } : {}),
      };
      emitToDevice(io, targetID, targetDeviceId, 'call_rejoin_answer', payload);
    } catch (error) {
      console.error('[Socket call_rejoin_answer]', error.message);
    }
  });
};

/**
 * Renégociation vidéo sur un appel audio actif.
 *
 * Ce canal est volontairement distinct de call_rejoin : une reprise ICE ne
 * doit pas changer le mode média ni accepter une offre provenant d'un appareil
 * secondaire. Les deux côtés doivent être propriétaires de leur appel actif.
 */
const callVideoUpgrade = (io, socket) => {
  const relay = (event, outgoingEvent, field) => {
    socket.on(event, async (data) => {
      try {
        if (!socket.authenticated) return;
        const targetID = toInt(data?.targetUserId);
        const callId = data?.callId != null ? String(data.callId) : '';
        const transitionId = data?.transitionId != null
          ? String(data.transitionId)
          : '';
        const description = data?.[field];
        if (
          !targetID ||
          !callId ||
          transitionId.length < 8 ||
          transitionId.length > 128 ||
          !description ||
          typeof description.sdp !== 'string' ||
          description.sdp.length > 2_000_000 ||
          (description.type !== 'offer' && description.type !== 'answer')
        ) return;

        const userID = socket.alanyaID;
        const entry = await callState.getEntry(userID);
        if (
          !entry ||
          entry.status !== 'in_call' ||
          String(entry.callId) !== callId ||
          Number(entry.peerId) !== targetID
        ) {
          socket.emit('call_failed', {
            reason: 'Aucun appel vidéo actif correspondant',
            code: 'CALL_VIDEO_UPGRADE_INVALID',
            callId,
          });
          return;
        }

        const sourceDeviceId = normalizeDeviceId(socket.deviceId);
        if (
          !sourceDeviceId ||
          !(await callDeviceOwnership.isOwnerDevice(callId, userID, sourceDeviceId))
        ) return;

        const targetDeviceId = await callDeviceOwnership.getActiveDeviceId(
          callId,
          targetID,
        );
        if (!targetDeviceId) return;

        emitToDevice(io, targetID, targetDeviceId, outgoingEvent, {
          callId,
          peerId: String(userID),
          transitionId,
          [field]: description,
        });
      } catch (error) {
        console.error(`[Socket ${event}]`, error.message);
      }
    });
  };

  relay('call_video_upgrade_offer', 'call_video_upgrade_offer', 'offer');
  relay('call_video_upgrade_answer', 'call_video_upgrade_answer', 'answer');

  socket.on('call_video_upgrade_commit', async (data, acknowledge) => {
    const reject = (code) => {
      if (typeof acknowledge === 'function') acknowledge({ ok: false, code });
    };
    try {
      if (!socket.authenticated) {
        reject('UNAUTHENTICATED');
        return;
      }
      const targetID = toInt(data?.targetUserId);
      const callId = data?.callId != null ? String(data.callId) : '';
      const transitionId = data?.transitionId != null
        ? String(data.transitionId)
        : '';
      if (
        !targetID ||
        !callId ||
        transitionId.length < 8 ||
        transitionId.length > 128
      ) {
        reject('INVALID_COMMIT');
        return;
      }

      const userID = socket.alanyaID;
      const entry = await callState.getEntry(userID);
      if (
        !entry ||
        entry.status !== 'in_call' ||
        String(entry.callId) !== callId ||
        Number(entry.peerId) !== targetID
      ) {
        reject('CALL_VIDEO_UPGRADE_INVALID');
        return;
      }
      const sourceDeviceId = normalizeDeviceId(socket.deviceId);
      if (
        !sourceDeviceId ||
        !(await callDeviceOwnership.isOwnerDevice(callId, userID, sourceDeviceId))
      ) {
        reject('CALL_VIDEO_UPGRADE_NOT_OWNER');
        return;
      }
      const targetDeviceId = await callDeviceOwnership.getActiveDeviceId(
        callId,
        targetID,
      );
      if (!targetDeviceId) {
        reject('CALL_VIDEO_UPGRADE_TARGET_OFFLINE');
        return;
      }
      const emitted = emitToDevice(io, targetID, targetDeviceId, 'call_video_upgrade_commit', {
        callId,
        peerId: String(userID),
        transitionId,
      });
      if (!emitted) {
        reject('CALL_VIDEO_UPGRADE_DELIVERY_FAILED');
        return;
      }
      if (typeof acknowledge === 'function') acknowledge({ ok: true });
    } catch (error) {
      console.error('[Socket call_video_upgrade_commit]', error.message);
      reject('CALL_VIDEO_UPGRADE_ERROR');
    }
  });

  const relayControl = (event, outgoingEvent) => {
    socket.on(event, async (data) => {
      try {
        if (!socket.authenticated) return;
        const targetID = toInt(data?.targetUserId);
        const callId = data?.callId != null ? String(data.callId) : '';
        const transitionId = data?.transitionId != null
          ? String(data.transitionId)
          : '';
        if (!targetID || !callId || transitionId.length < 8 || transitionId.length > 128) {
          return;
        }
        const userID = socket.alanyaID;
        const entry = await callState.getEntry(userID);
        if (
          !entry ||
          entry.status !== 'in_call' ||
          String(entry.callId) !== callId ||
          Number(entry.peerId) !== targetID
        ) return;
        const sourceDeviceId = normalizeDeviceId(socket.deviceId);
        if (
          !sourceDeviceId ||
          !(await callDeviceOwnership.isOwnerDevice(callId, userID, sourceDeviceId))
        ) return;
        const targetDeviceId = await callDeviceOwnership.getActiveDeviceId(
          callId,
          targetID,
        );
        if (!targetDeviceId) return;
        emitToDevice(io, targetID, targetDeviceId, outgoingEvent, {
          callId,
          peerId: String(userID),
          transitionId,
        });
      } catch (error) {
        console.error(`[Socket ${event}]`, error.message);
      }
    });
  };

  relayControl('call_video_upgrade_commit_ack', 'call_video_upgrade_commit_ack');
  relayControl('call_video_upgrade_ack_request', 'call_video_upgrade_ack_request');
  relayControl('call_video_upgrade_cancel', 'call_video_upgrade_cancel');
};

module.exports = {
  reclaimStaleBusy,
  offerCallResume,
  onNoAnswer,
  callUser,
  answerCall,
  rejectCall,
  processRejectCall,
  iceCandidate,
  endCall,
  endActiveCallForUser,
  leaveCallSession,
  failInvite,
  // Exportées pour les exécuteurs de délais (services/callSessionsWorkers.js) :
  // côté Redis, ces cascades sont déclenchées par la file de tâches, plus par
  // un setTimeout du process qui les a armées.
  onTransferMediaNotReady,
  onTransferAutoLeave,
  addParticipant,
  cancelAddParticipant,
  confJoin,
  confReject,
  confReady,
  createGroupCall,
  joinGroupCall,
  leaveGroupCall,
  endGroupCall,
  armGroupRoomGraceOnDisconnect,
  groupOffer,
  groupAnswer,
  groupIceCandidate,
  callMuteState,
  groupMuteState,
  callVideoState,
  groupVideoState,
  callResumeHandshake,
  callRejoin,
  callVideoUpgrade,
};
