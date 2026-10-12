const { parseMentionsColumn, isMentioned } = require('../utils/mentions');
const admin = require('../config/firebase');
const { messagePreview } = require('../utils/messagePreview');
const { getConnectedDeviceIds } = require('../utils/userSocketRegistry');
const {
  logQueued,
  logSkipped,
  logSent,
  logFailed,
  logTokenStale,
  hashForLog,
} = require('../notifications/notificationLogger');
const {
  buildMessagePayload,
  buildTripPayload,
} = require('../notifications/notificationContract');
const { getMessagePushOptions } = require('../notifications/notificationPolicy');
const { DEVICE_REGISTRY_V2, ANDROID_NATIVE_V2, IOS_RICH_NSE, IOS_VOIP_V2 } = require('../notifications/notificationFlags');
const { personnaliserNomContact } = require('../notifications/notificationContactName');
const { resolvePushTargets, resolveCallPushTargets } = require('../notifications/pushDeviceRegistry');
const { sendVoipPush, clearVoipToken, isConfigured: isVoipConfigured } = require('../notifications/apnsVoipProvider');
const { evaluateMessagePush, evaluateTypePush } = require('../notifications/notificationFilter');
const {
  loadUserNotificationPrefsMany,
  loadConversationMuteMany,
} = require('../notifications/notificationPrefs');
const { loadUserDndScheduleMany } = require('./dndScheduleService');
const { civilDayKey, FALLBACK_TIMEZONE } = require('./voicemailScheduleService');
const { claimDailyNotice } = require('../socket/state/voicemailNotice');
const { loadUserPrivacyPrefs, contactsAmong } = require('./privacyPrefsService');
const { shouldUseAndroidNativeDataOnly } = require('../notifications/notificationAndroidNative');
const { shouldUseDeviceRegistry } = require('../notifications/notificationRouting');
const { resolveTripPush, isTripType, TRIP_TYPES } = require('../notifications/notificationTripRouting');

/**
 * Push silencieuse : le destinataire a coupé ses notifications ou mis la
 * conversation en sourdine. On envoie quand même le `data` pour que son
 * terminal puisse accuser réception, mais sans alerte, son ni badge.
 */
const isSilentPush = (data) => String(data?.silent ?? '') === '1';

const _buildApnsConfig = (data) => {
  const type = data.type;
  const showAlert =
    !isSilentPush(data) &&
    (type === 'message' ||
      type === 'meeting_invite' ||
      type === 'meeting_reminder' ||
      type === 'status_view' ||
      type === 'voicemail_active' ||
      // Sans cette ligne, une alerte de trajet partait en push de fond sur
      // iOS : aucun affichage, et une délivrance à la discrétion du système.
      isTripType(type));

  const aps = { 'content-available': 1 };
  if (showAlert && (data.title || data.body)) {
    aps.alert = {
      title: data.title || 'Alanya',
      body: data.body || '',
    };
    if (data.soundEnabled !== '0') {
      aps.sound = 'default';
    }
  }

  if (type === 'message' && data.conversationId) {
    aps['thread-id'] = `conv_${data.conversationId}`;
    if (data.isGroup === '1' && data.groupName) {
      aps['summary-arg'] = data.groupName;
    }
    aps.category = 'ALANYA_MESSAGE';
    if (IOS_RICH_NSE && data.senderAvatar) {
      aps['mutable-content'] = 1;
    }
  }

  if (!isSilentPush(data) && data.unreadTotal != null && data.unreadTotal !== '') {
    const badge = parseInt(String(data.unreadTotal), 10);
    if (Number.isFinite(badge) && badge >= 0) {
      aps.badge = badge;
    }
  }

  return {
    headers: {
      'apns-priority': showAlert ? '10' : '5',
      'apns-push-type': showAlert ? 'alert' : 'background',
    },
    payload: { aps },
  };
};

// Types affichés à l'utilisateur : bloc `notification` Android pour que le
// système les affiche même app tuée. Les appels restent data-only pour
// déclencher CallKit via le handler Dart.
// Trajets : la décision d'acheminement vit dans `notificationTripRouting`, un
// module pur et testé. Hors de VISIBLE_TYPES, une alerte partait en push de
// fond sur iOS (rien affiché) et en priorité normale avec 24 h de TTL sur
// Android (retardable par Doze) — deux défauts qu'aucune lecture ne révélait.
const VISIBLE_TYPES = [
  'message', 'meeting_invite', 'meeting_reminder', 'status_view',
  'voicemail_active',
  ...TRIP_TYPES,
];

const CALL_TYPES = ['call', 'group_call', 'call_ended'];
// Aligné sur NO_ANSWER_MS (45 s, calls.js) : un push d'appel délivré après le
// timeout serveur ferait sonner un appel déjà classé « sans réponse ».
//
// `call_ended` en fait partie, et ce n'était pas le cas : le push qui ARRÊTE la
// sonnerie partait en priorité normale avec 24 h de validité, quand celui qui la
// démarre part en priorité haute avec 45 s. Sur un appareil en veille, Android
// pouvait donc retarder indéfiniment l'ordre d'arrêt — le téléphone continuait
// de sonner après que l'appelant a raccroché — et livrer des heures plus tard un
// ordre devenu absurde.
const CALL_TTL_MS = 45_000;

const sendDataOnlyNotification = async (fcmToken, data = {}, meta = {}) => {
  if (!fcmToken || fcmToken === 'INDEFINI') return;

  try {
    if (!admin.apps.length) {
      console.warn('[FCM] Firebase non initialisé — notification ignorée');
      return;
    }

    const platform = String(meta.platform || 'unknown').toLowerCase();
    const androidNativeDataOnly = shouldUseAndroidNativeDataOnly(
      { ANDROID_NATIVE_V2 },
      platform,
      data.type,
    );

    const silent = isSilentPush(data);
    const isVisible = VISIBLE_TYPES.includes(data.type);
    const isCall = CALL_TYPES.includes(data.type);
    const isMeeting =
      data.type === 'meeting_invite' || data.type === 'meeting_reminder';

    // Messages / meetings / statut : data + notification système (filet app tuée).
    // Appels : data-only (CallKit via handler Dart).
    // Android native v2 : data-only → MessagingStyle Kotlin.
    const message = {
      token: fcmToken,
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: {
        priority: isCall || isVisible ? 'high' : 'normal',
        // `meta.ttlMs` permet à l'appelant d'imposer une validité plus courte —
        // c'est le cas d'un destinataire dont le répondeur bascule à 27 s au
        // lieu de 45 : un push délivré après la bascule ferait sonner un appel
        // qui n'existe plus. Absent, on garde CALL_TTL_MS.
        ttl: isCall
          ? (Number.isFinite(meta.ttlMs) && meta.ttlMs > 0 ? meta.ttlMs : CALL_TTL_MS)
          : (resolveTripPush(data.type)?.ttlMs ?? 86400000),
      },
      apns: _buildApnsConfig(data),
    };

    // Priorité haute conservée pour les push silencieuses : elles portent
    // l'accusé de remise, qui doit partir sans attendre la sortie de Doze.
    if (!silent && isVisible && (data.title || data.body) && !androidNativeDataOnly) {
      message.notification = {
        title: data.title || 'Alanya',
        body: data.body || '',
      };
      // Tag distinct obligatoire : sans tag, FCM réutilise l'id 0 et chaque
      // notif écrase la précédente dans le tiroir Android.
      let tag;
      if (data.tripId) {
        // Un trajet occupe UNE ligne dans le tiroir, quel que soit le nombre
        // d'étapes. Sans ce tag, le propriétaire empilerait quatre
        // notifications pour un même trajet — pré-avis, échéance, deux
        // relances — et devrait deviner laquelle est encore d'actualité. La
        // plus récente remplace la précédente, exactement comme la carte de
        // conversation est réécrite sur place.
        tag = `trip_${data.tripId}`;
      } else if (data.conversationId) {
        tag = `conv_${data.conversationId}`;
      } else if (data.meetingId) {
        tag = `meeting_${data.type}_${data.meetingId}`;
      } else {
        tag = `${data.type || 'notif'}_${Date.now()}`;
      }
      // Le canal décide de tout sur Android : c'est lui qui porte l'importance,
      // le son, et surtout l'autorisation de passer outre « Ne pas déranger ».
      // Poster une alerte de sûreté sur `talky_messages` la rendrait
      // silencieuse chez quiconque a activé le mode silencieux — c'est-à-dire
      // la nuit, précisément quand elle compte.
      const trajet = resolveTripPush(data.type);

      message.android.notification = {
        channelId: trajet
          ? trajet.channelId
          : (isMeeting ? 'talky_meetings' : 'talky_messages'),
        icon: 'ic_stat_notification',
        color: trajet ? trajet.color : '#114B86',
        sound: 'default',
        tag,
      };
    }

    // Sous test, on ne sort pas de la machine. Deux raisons, et la seconde
    // n'est pas une commodité : les suites qui passent par un handler d'appel
    // — callResumeAck, callSessionLeave… — déclenchaient de vrais push vers de
    // vrais appareils, et le SDK Firebase gardait ses connexions HTTP/2
    // ouvertes, ce qui empêchait le processus de rendre la main. C'est la
    // véritable cause de l'entrée C6 de l'audit, que l'on croyait due à des
    // minuteries restées armées.
    const messageId = process.env.NODE_ENV === 'test'
      ? `test-${Date.now()}`
      : await admin.messaging().send(message);
    logSent({
      type: data.type,
      eventId: data.eventId,
      msgID: data.msgID,
      conversationId: data.conversationId,
      providerMessageId: messageId,
      mode: silent
        ? 'silent_delivery_ack'
        : androidNativeDataOnly
          ? 'android_native_data_only'
          : 'fcm_notification_block',
      platform,
    });
  } catch (error) {
    const code = error?.code || error?.errorInfo?.code || '';
    // `mismatched-credential` / SenderId mismatch : token émis par un autre
    // projet Firebase (ex. installation antérieure au renommage du paquet
    // Android). Aussi définitif qu'un token désenregistré → même purge.
    const staleToken =
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/mismatched-credential' ||
      error.message?.includes('Requested entity was not found') ||
      error.message?.includes('SenderId mismatch');
    if (staleToken) {
      logTokenStale({
        type: data.type,
        eventId: data.eventId,
        msgID: data.msgID,
        conversationId: data.conversationId,
        reason: code || 'stale_token',
      });
      try {
        const pool = require('../config/db');
        // Les deux couches : `resolveCallPushTargets` lit user_push_devices en
        // priorité — un token mort qui n'y serait pas purgé resterait ciblé à
        // chaque appel, en échec silencieux, sans jamais retomber sur le legacy.
        await pool.execute(
          'UPDATE users SET fcm_token = "INDEFINI" WHERE fcm_token = ?',
          [fcmToken],
        );
        await pool.execute(
          'UPDATE user_push_devices SET fcmToken = "INDEFINI" WHERE fcmToken = ?',
          [fcmToken],
        );
      } catch (cleanupErr) {
        console.warn('[FCM] Token cleanup failed:', cleanupErr.message);
      }
    }
    // Un push d'appel raté = destinataire qui ne sonne pas : contrairement aux
    // messages (rattrapés à la reconnexion), c'est une perte fonctionnelle
    // immédiate → visible en console avec le code d'erreur exact.
    if (CALL_TYPES.includes(data.type) || data.type === 'call_ended') {
      console.error(
        `[FCM][CALL] échec envoi type=${data.type} callId=${data.callId || '?'} code=${code || 'n/a'}: ${error.message}`,
      );
    }
    // Ne pas faire crasher le serveur pour une notif ratée
    logFailed({
      type: data.type,
      eventId: data.eventId,
      msgID: data.msgID,
      conversationId: data.conversationId,
      reason: code ? `${code}: ${error.message}` : error.message,
    });
  }
};

const sendToUser = async (alanyaID, rawData = {}, options = {}) => {
  // Nom personnalisé du destinataire pour l'expéditeur — un seul endroit.
  const data = await personnaliserNomContact(alanyaID, rawData);
  if (shouldUseDeviceRegistry(DEVICE_REGISTRY_V2, data)) {
    return sendToUserDevices(alanyaID, data, options);
  }
  return sendToUserLegacy(alanyaID, data, options);
};

const sendToUserLegacy = async (alanyaID, data = {}, options = {}) => {
  try {
    const { io = null, skipIfDeviceOnline = false, excludeDeviceId = null } = options;
    const connectedDevices =
      skipIfDeviceOnline && io ? await getConnectedDeviceIds(io, alanyaID) : new Set();

    const pool = require('../config/db');
    const [rows] = await pool.execute(
      'SELECT fcm_token, device_ID FROM users WHERE alanyaID = ? AND fcm_token != "INDEFINI"',
      [alanyaID],
    );
    if (rows.length === 0) {
      console.warn(`[FCM] Pas de token pour alanyaID=${alanyaID}`);
      return;
    }

    const { fcm_token: fcmToken, device_ID: deviceId } = rows[0];

    // Le repli legacy ne connaît qu'un jeton — celui du compte. S'il désigne
    // l'appareil qu'on voulait précisément épargner, ne rien envoyer : un
    // `call_ended` porte le callId exact de l'appel en cours, et l'appareil qui
    // vient de décrocher raccrocherait de lui-même.
    if (excludeDeviceId) {
      // Require local, comme `sendCallEndedToUser` plus bas : le module n'est
      // pas importé en tête de fichier, et cette fonction-ci n'est pas dans sa
      // portée.
      const { normalizeDeviceId } = require('../utils/deviceId');
      const legacyDid = normalizeDeviceId(deviceId);
      if (legacyDid && legacyDid === excludeDeviceId) {
        console.warn(
          `[FCM] legacy: appareil exclu, envoi annulé user=${alanyaID}`,
        );
        return;
      }
    }

    if (skipIfDeviceOnline) {
      if (
        deviceId &&
        deviceId !== 'INDEFINI' &&
        connectedDevices.has(String(deviceId))
      ) {
        logSkipped({
          type: data.type,
          eventId: data.eventId,
          msgID: data.msgID,
          conversationId: data.conversationId,
          userId: alanyaID,
          reason: 'device_socket_online',
        });
        return;
      }
      if (
        (!deviceId || deviceId === 'INDEFINI') &&
        connectedDevices.size > 0
      ) {
        logSkipped({
          type: data.type,
          eventId: data.eventId,
          msgID: data.msgID,
          conversationId: data.conversationId,
          userId: alanyaID,
          reason: 'any_socket_online',
        });
        return;
      }
    }

    logQueued({
      type: data.type,
      eventId: data.eventId,
      msgID: data.msgID,
      conversationId: data.conversationId,
      userId: alanyaID,
      deviceId,
    });

    await sendDataOnlyNotification(fcmToken, data, { platform: 'unknown' });
  } catch (error) {
    console.error('[FCM] sendToUser error:', error.message);
  }
};

/**
 * Qui, parmi les destinataires, a le droit de voir la photo de l'expéditeur ?
 *
 * La photo en jeu est celle d'UN seul utilisateur — l'expéditeur — donc son
 * réglage se lit une fois, hors de la boucle de fan-out. Le cas courant
 * ('everyone', la valeur par défaut) et le cas 'nobody' se tranchent sans
 * aucune requête supplémentaire ; seul 'contacts' en coûte une, batchée pour
 * toute la liste. Appeler `canViewProfileField` par destinataire aurait rendu
 * le fan-out linéaire en requêtes, ce que le chargement groupé plus bas a
 * justement supprimé.
 *
 * @param {number} senderID
 * @param {Array<number>} recipientIds
 * @returns {Promise<(recipientId: number) => boolean>}
 */
const resolveAvatarVisibility = async (senderID, recipientIds) => {
  let level = 'everyone';
  try {
    const prefs = await loadUserPrivacyPrefs(senderID);
    level = prefs.profilePhotoVisibility || 'everyone';
  } catch (e) {
    // Une préférence illisible ne doit pas priver tout un groupe de sa
    // notification : on retombe sur le comportement d'avant ce filtre.
    console.warn('[FCM] profilePhotoVisibility illisible:', e.message);
    return () => true;
  }

  if (level === 'everyone') return () => true;
  if (level === 'nobody') return () => false;

  const contacts = await contactsAmong(senderID, recipientIds);
  return (recipientId) => contacts.has(Number(recipientId));
};

const MAX_PUSH_CONCURRENCY = 5;

// Nombre de destinataires traités en parallèle par notifyNewMessage : borne le
// pic de connexions DB / d'appels FCM tout en supprimant la latence cumulée
// d'un fan-out strictement séquentiel.
const FANOUT_CONCURRENCY = Number(process.env.PUSH_FANOUT_CONCURRENCY || 10);

/**
 * Envoie à tous les appareils enregistrés (skip foreground+conv active récent).
 */
const sendToUserDevices = async (alanyaID, data = {}, options = {}) => {
  try {
    const targets = await resolvePushTargets(alanyaID, data.conversationId);
    if (targets.length === 0) {
      console.warn(`[FCM] Pas de cible push pour alanyaID=${alanyaID}`);
      return;
    }

    for (let i = 0; i < targets.length; i += MAX_PUSH_CONCURRENCY) {
      const batch = targets.slice(i, i + MAX_PUSH_CONCURRENCY);
      await Promise.all(
        batch.map(async (target) => {
          logQueued({
            type: data.type,
            eventId: data.eventId,
            msgID: data.msgID,
            conversationId: data.conversationId,
            userId: alanyaID,
            deviceId: hashForLog(target.deviceId),
          });
          await sendDataOnlyNotification(target.fcmToken, data, {
            platform: target.platform,
          });
        }),
      );
    }
  } catch (error) {
    console.error('[FCM] sendToUserDevices error:', error.message);
    await sendToUserLegacy(alanyaID, data, options);
  }
};

/**
 * Appels : multi-appareil + VoIP APNs iOS si IOS_VOIP_V2 (sinon FCM data-only).
 */
const sendCallToUser = async (alanyaID, rawData = {}, options = {}) => {
  const data = await personnaliserNomContact(alanyaID, rawData);
  if (!DEVICE_REGISTRY_V2) {
    return sendToUserLegacy(alanyaID, data, {});
  }

  try {
    const targets = await resolveCallPushTargets(alanyaID);
    if (targets.length === 0) {
      console.warn(`[PushCall] Pas de cible pour alanyaID=${alanyaID}`);
      return sendToUserLegacy(alanyaID, data, {});
    }

    for (const target of targets) {
      logQueued({
        type: data.type,
        userId: alanyaID,
        deviceId: hashForLog(target.deviceId),
      });

      const platform = String(target.platform || 'unknown').toLowerCase();
      const voipToken = String(target.voipToken || '').trim();
      let sentViaVoip = false;

      if (
        IOS_VOIP_V2 &&
        platform === 'ios' &&
        voipToken &&
        isVoipConfigured()
      ) {
        const result = await sendVoipPush(voipToken, data, {
          deviceId: target.deviceId,
        });
        if (result.ok) {
          sentViaVoip = true;
        } else if (result.reason === 'stale_token') {
          await clearVoipToken(alanyaID, target.deviceId);
        }
      }

      if (!sentViaVoip && target.fcmToken && target.fcmToken !== 'INDEFINI') {
        await sendDataOnlyNotification(target.fcmToken, data, {
          platform,
          ttlMs: options.ttlMs,
        });
      }
    }
  } catch (error) {
    console.error('[PushCall] sendCallToUser error:', error.message);
    await sendToUserLegacy(alanyaID, data, {});
  }
};

/**
 * Fin d'appel : FCM data-only + VoIP dismiss iOS.
 * @param {object} [options]
 * @param {string} [options.excludeDeviceId] — ne pas pousser vers cet appareil (gagnant claim).
 */
const sendCallEndedToUser = async (alanyaID, rawData = {}, options = {}) => {
  const data = await personnaliserNomContact(alanyaID, rawData);
  const { normalizeDeviceId } = require('../utils/deviceId');
  const excludeDeviceId = normalizeDeviceId(options.excludeDeviceId);

  if (!DEVICE_REGISTRY_V2) {
    if (excludeDeviceId) {
      console.warn(
        '[PushCall] excludeDeviceId ignored on legacy path user=',
        alanyaID,
      );
    }
    return sendToUserLegacy(alanyaID, data, {});
  }

  try {
    const targets = await resolveCallPushTargets(alanyaID);
    if (targets.length === 0) {
      return sendToUserLegacy(alanyaID, data, { excludeDeviceId });
    }

    // La décision de « qui reçoit » vit dans `callEndedTargets`, avec son test.
    const { filterCallEndedTargets } = require('../notifications/callEndedTargets');
    const retenues = filterCallEndedTargets(targets, excludeDeviceId);
    if (retenues.length < targets.length) {
      console.warn(
        `[PushCall] call_ended: ${targets.length - retenues.length} cible(s) `
        + `écartée(s) user=${alanyaID}`,
      );
    }

    for (const target of retenues) {
      if (options.excludeDeviceId && !excludeDeviceId) {
        console.warn(
          `[PushCall] excludeDeviceId missing/ambiguous user=${alanyaID}`,
        );
      }

      logQueued({
        type: data.type,
        userId: alanyaID,
        deviceId: hashForLog(target.deviceId),
      });

      const platform = String(target.platform || 'unknown').toLowerCase();
      const voipToken = String(target.voipToken || '').trim();

      if (
        IOS_VOIP_V2 &&
        platform === 'ios' &&
        voipToken &&
        isVoipConfigured()
      ) {
        await sendVoipPush(
          voipToken,
          { ...data, type: 'call_ended' },
          { deviceId: target.deviceId },
        );
      }

      if (target.fcmToken && target.fcmToken !== 'INDEFINI') {
        await sendDataOnlyNotification(target.fcmToken, data, { platform });
      }
    }
  } catch (error) {
    console.error('[PushCall] sendCallEndedToUser error:', error.message);
    // L'exclusion voyage jusque dans le repli : une panne SQL ne doit pas
    // pousser `call_ended` vers l'appareil qui vient de décrocher.
    await sendToUserLegacy(alanyaID, data, { excludeDeviceId });
  }
};

/** True si le destinataire a au moins un socket dans la room user_{id}. */
const isUserSocketConnected = (io, alanyaID) => {
  if (!io?.sockets?.adapter?.rooms) return false;
  const room = io.sockets.adapter.rooms.get(`user_${alanyaID}`);
  return !!(room && room.size > 0);
};

/**
 * Push message à tous les participants (FCM toujours envoyé — Phase 1.1).
 * Le client supprime localement si la conversation est visible au premier plan.
 * @param {import('socket.io').Server|null} [io] — conservé pour compatibilité API, non utilisé pour skip.
 */
const notifyNewMessage = async (conversationID, senderID, senderName, fields = {}, io = null) => {
  void io;
  try {
    const {
      content,
      mediaName,
      type = 0,
      isViewOnce = false,
      isGroup = false,
      groupName = '',
      msgID,
      clientId,
      senderAvatar,
      groupAvatar,
      unreadTotal,
      mentions,
      isEncrypted = false,
    } = fields;

    // Parsé UNE FOIS hors de la boucle : la colonne arrive avec la ligne
    // message que l'appelant a déjà chargée, donc zéro requête ici.
    const mentionList = parseMentionsColumn(mentions);

    // Pour un message chiffré, `content` et `mediaName` n'existent pas ici :
    // ils sont dans le corps scellé. `messagePreview` rend alors un libellé
    // neutre. Le corps réel est composé par le client après déchiffrement —
    // c'est la raison d'être du chemin data-only d'Android.
    const body = messagePreview({
      content,
      mediaName,
      type,
      isViewOnce,
      isEncrypted,
      maxLen: 100,
    });

    const pool = require('../config/db');
    const [participants] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
    if (participants.length === 0) return;
    const pushOptions = getMessagePushOptions();
    const recipientIds = participants.map((p) => Number(p.alanyaID));

    // Lectures en batch : la boucle unitaire exécutait ~4 requêtes séquentielles
    // PAR destinataire (unread, prefs, DND, mute) — soit ~800 requêtes pour un
    // groupe de 200. Ici : 4 requêtes au total, quel que soit l'effectif.
    const [
      unreadRows,
      prefsMap,
      dndMap,
      muteMap,
      canSeeAvatar,
    ] = await Promise.all([
      pool
        .query(
          'SELECT alanyaID, COALESCE(SUM(unreadCount), 0) AS total FROM conv_participants WHERE alanyaID IN (?) GROUP BY alanyaID',
          [recipientIds],
        )
        .then(([rows]) => rows),
      loadUserNotificationPrefsMany(recipientIds),
      loadUserDndScheduleMany(recipientIds),
      loadConversationMuteMany(conversationID, recipientIds),
      resolveAvatarVisibility(senderID, recipientIds),
    ]);
    const unreadMap = new Map(
      unreadRows.map((r) => [Number(r.alanyaID), Number(r.total) || 0]),
    );

    const notifyOne = async (recipientId) => {
      let payload = buildMessagePayload({
        msgID,
        clientId,
        conversationId: conversationID,
        senderId: senderID,
        senderName,
        senderAvatar,
        body,
        msgType: type,
        isGroup,
        groupName,
        groupAvatar,
        unreadTotal: unreadMap.get(recipientId) ?? 0,
        isEncrypted,
      });

      const mentioned = isMentioned(mentionList, recipientId, senderID);
      payload = { ...payload, mentioned: mentioned ? '1' : '0' };

      const decision = await evaluateMessagePush(recipientId, conversationID, payload, {
        isGroup,
        isMentioned: mentioned,
        avatarAllowed: canSeeAvatar(recipientId),
        preloaded: {
          prefs: prefsMap.get(recipientId),
          dnd: dndMap.get(recipientId),
          mute: muteMap.get(recipientId),
        },
      });
      if (!decision.allowed) {
        logSkipped({
          type: 'message',
          eventId: payload.eventId,
          msgID: payload.msgID,
          conversationId: String(conversationID),
          userId: recipientId,
          reason: decision.reason,
        });
        return;
      }
      payload = decision.payload;

      await sendToUser(recipientId, payload, pushOptions);
    };

    // Envois par vagues bornées : plus de latence cumulée séquentielle
    // (200 allers-retours FCM en série ≈ 40 s), sans pour autant noyer le
    // pool DB ni l'API FCM.
    for (let i = 0; i < recipientIds.length; i += FANOUT_CONCURRENCY) {
      const wave = recipientIds.slice(i, i + FANOUT_CONCURRENCY);
      await Promise.all(
        wave.map((id) =>
          notifyOne(id).catch((e) =>
            console.error(`[FCM] notifyNewMessage destinataire=${id}:`, e.message),
          ),
        ),
      );
    }
  } catch (error) {
    console.error('[FCM] notifyNewMessage error:', error.message);
  }
};

/**
 * Construit le data payload FCM/CallKit d'un appel entrant.
 * Extras optionnels pour les invitations conférence / transfert.
 * Exposé pour les tests de contrat (sans I/O réseau).
 */
const buildIncomingCallPayload = (
  callerID,
  callerName,
  callerPhoto,
  isVideo,
  callId,
  extras = null,
) => {
  const payload = {
    type:       'call',
    title:      callerName || 'Appel entrant',
    body:       `${callerName || 'Quelqu\'un'} vous appelle`,
    callerId:   String(callerID),
    callerName: String(callerName ?? ''),
    photo:      String(callerPhoto ?? ''),
    isVideo:    String(isVideo ?? false),
    callId:     String(callId ?? ''),
  };
  if (extras && typeof extras === 'object') {
    if (extras.roomId != null && extras.roomId !== '') {
      payload.roomId = String(extras.roomId);
    }
    if (extras.sessionId != null && extras.sessionId !== '') {
      payload.sessionId = String(extras.sessionId);
    }
    if (extras.sessionKind != null && extras.sessionKind !== '') {
      payload.sessionKind = String(extras.sessionKind);
    }
    if (extras.mode != null && extras.mode !== '') {
      payload.mode = String(extras.mode);
    }
  }
  return payload;
};

/**
 * Push d'appel entrant (1-à-1 ou invitation conférence).
 *
 * Pour une conférence / transfert, passer extras :
 *   { roomId, sessionId, sessionKind: 'conference', mode: 'join'|'transfer' }
 * Les appels 1-à-1 n'envoient pas ces champs (rétrocompat).
 */
const notifyIncomingCall = async (
  idReceiver,
  callerID,
  callerName,
  callerPhoto,
  isVideo,
  callId,
  extras = null,
  options = {},
) => {
  await sendCallToUser(
    idReceiver,
    buildIncomingCallPayload(callerID, callerName, callerPhoto, isVideo, callId, extras),
    // `options.ttlMs` : validité du push, quand elle doit être plus courte que
    // les 45 s par défaut — répondeur qui bascule à 27 s.
    options,
  );
};

const notifyGroupCall = async (targetUserIds = [], callerID, callerName, callerPhoto, isVideo, roomId) => {
  for (const uid of targetUserIds) {
    await sendCallToUser(uid, {
      type:       'group_call',
      title:      callerName || 'Appel de groupe',
      body:       `${callerName || 'Quelqu\'un'} démarre un appel de groupe`,
      callerId:   String(callerID),
      callerName: String(callerName ?? ''),
      photo:      String(callerPhoto ?? ''),
      isVideo:    String(isVideo ?? false),
      roomId:     String(roomId ?? ''),
    });
  }
};

const notifyStatusView = async (statusOwnerID, viewerName, viewerID = null) => {
  const decision = await evaluateTypePush(statusOwnerID, 'status_view');
  if (!decision.allowed) {
    logSkipped({
      type: 'status_view',
      userId: statusOwnerID,
      reason: decision.reason,
    });
    return;
  }
  await sendToUser(statusOwnerID, {
    type:  'status_view',
    title: 'Nouveau spectateur',
    body:  `${viewerName} a vu votre statut`,
    ...(viewerID ? { aboutUserId: viewerID, aboutName: viewerName } : {}),
  });
};

/**
 * Le répondeur vient d'intercepter un appel : on le rappelle à son
 * propriétaire, une fois par jour au plus.
 *
 * Ce n'est PAS un avis d'appel manqué. Le destinataire en est déjà informé
 * deux fois — l'entrée apparaît dans son journal (`call_log_updated`), et si
 * l'appelant laisse un vocal il reçoit la notification de message ordinaire.
 * Ce qu'il ne sait peut-être plus, en revanche, c'est que l'interrupteur est
 * resté armé. C'est cela qu'on lui dit, et c'est pourquoi le plafond
 * quotidien est dans la fonction elle-même : un appelant impossible à oublier.
 *
 * `sendToUser` et JAMAIS `sendCallToUser` : ce dernier est le canal VoIP qui
 * déclenche CallKit. L'emprunter ici rallumerait très exactement la sonnerie
 * que le répondeur vient d'éteindre.
 */
const notifyVoicemailActive = async (
  targetID,
  callerName,
  { activeUntil = null, timeZone = null, callerID = null } = {},
) => {
  // Les préférences d'abord, le quota ensuite — et pas l'inverse. Réserver la
  // journée puis se faire refouler par « Ne pas déranger » brûlerait le droit
  // à notifier : un appel intercepté à 2 h du matin consommerait le quota,
  // et l'appel de 9 h, lui parfaitement notifiable, resterait muet.
  const decision = await evaluateTypePush(targetID, 'voicemail_active');
  if (!decision.allowed) {
    logSkipped({ type: 'voicemail_active', userId: targetID, reason: decision.reason });
    return;
  }

  const jour = civilDayKey(new Date(), timeZone || FALLBACK_TIMEZONE);
  if (!(await claimDailyNotice(targetID, jour))) {
    logSkipped({ type: 'voicemail_active', userId: targetID, reason: 'deja_notifie_aujourdhui' });
    return;
  }

  const qui = (callerName || '').trim() || 'Quelqu\'un';
  // `activeUntil` est nul quand le créneau couvre la journée entière : on
  // n'invente pas d'heure de fin, on dit simplement qu'il tourne.
  let jusqua = '';
  if (activeUntil) {
    try {
      const heure = new Date(activeUntil).toLocaleTimeString('fr-FR', {
        timeZone: timeZone || FALLBACK_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
      });
      jusqua = ` Il reste actif jusqu'à ${heure}.`;
    } catch (_) {
      jusqua = '';
    }
  }

  await sendToUser(targetID, {
    type:  'voicemail_active',
    title: 'Votre répondeur a répondu',
    body:  `${qui} a essayé de vous appeler.${jusqua}`,
    ...(callerID ? { aboutUserId: callerID, aboutName: qui } : {}),
  });
};

/**
 * Le code QR éphémère du propriétaire vient d'être scanné : on l'invite à
 * ajouter le scanneur en retour. N'est envoyé que si aucun socket au premier
 * plan — sinon le dialogue in-app (événement `qr:contact_scanned`) suffit, et
 * la notification ferait doublon.
 */
const notifyQrContactScanned = async (ownerID, scanner, alreadyMutual) => {
  const scannerName = (scanner.nom || '').trim() || (scanner.pseudo || '').trim();
  await sendToUser(ownerID, {
    type:  'qr_contact_scanned',
    title: 'Nouveau contact',
    body:  `${scannerName || 'Quelqu\'un'} vous a ajouté avec votre code QR. Ajoutez-le en retour ?`,
    // L'identité voyage dans la data : au tap, l'app reconstruit l'invitation
    // « ajouter en retour » — l'événement socket émis au moment du scan est
    // perdu si l'app était fermée.
    byAlanyaID: String(scanner.alanyaID),
    byNom: scanner.nom || '',
    byPseudo: scanner.pseudo || '',
    byAvatar: scanner.avatar_url || '',
    alreadyMutual: alreadyMutual ? '1' : '0',
  });
};

const notifyMeetingInvite = async (participantId, organiserName, meetingTitle, meetingTime, meetingId, organiserId = null) => {
  await sendToUser(participantId, {
    ...(organiserId ? { aboutUserId: organiserId, aboutName: String(organiserName) } : {}),
    type:          'meeting_invite',
    title:         'Nouvelle réunion',
    body:          `${organiserName} vous invite à : ${meetingTitle}`,
    meetingTitle:  String(meetingTitle),
    organiserName: String(organiserName),
    meetingTime:   String(meetingTime),
    meetingId:     String(meetingId ?? ''),
  });
};

const notifyMeetingReminder = async (participantId, meetingTitle, organiserName, meetingId) => {
  await sendToUser(participantId, {
    type:          'meeting_reminder',
    title:         'Réunion dans moins de 10 minutes',
    body:          `${meetingTitle} démarre dans moins de 10 minutes`,
    meetingTitle:  String(meetingTitle),
    organiserName: String(organiserName),
    meetingId:     String(meetingId ?? ''),
  });
};

/**
 * @param {object} [options]
 * @param {string} [options.excludeDeviceId]
 * @param {string} [options.reason]
 * @param {boolean} [options.claimedByAnotherDevice]
 */
const notifyCallEnded = async (
  receiverId,
  callerId,
  callerName,
  callId = null,
  options = {},
) => {
  const payload = {
    type:       'call_ended',
    title:      'Appel terminé',
    body:       `${callerName || 'L\'appel'} a raccroché`,
    callerId:   String(callerId),
    callerName: String(callerName ?? ''),
    callId:     String(callId ?? ''),
  };
  if (options.reason) payload.reason = String(options.reason);
  if (options.claimedByAnotherDevice) {
    payload.claimedByAnotherDevice = 'true';
  }
  await sendCallEndedToUser(receiverId, payload, {
    excludeDeviceId: options.excludeDeviceId,
  });
};

/**
 * Sync silencieuse lecture → autres appareils du même utilisateur.
 * Data-only, sans bloc notification visible.
 */
const notifyMessageReadSync = async (alanyaID, conversationID, msgID = null) => {
  const { buildMessageReadSyncPayload } = require('../notifications/notificationContract');
  // Total non lu APRÈS la lecture : porté dans la push pour que le badge des
  // autres appareils iOS suive sans ouvrir l'app (aps.badge). Best-effort : la
  // sync de lecture part même si ce SELECT échoue.
  let unreadTotal;
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(
      'SELECT COALESCE(SUM(unreadCount), 0) AS total FROM conv_participants WHERE alanyaID = ?',
      [alanyaID],
    );
    unreadTotal = Number(rows[0]?.total ?? 0);
  } catch (e) {
    console.warn('[FCM message_read_sync] unreadTotal:', e.message);
  }
  const payload = buildMessageReadSyncPayload({
    conversationId: conversationID,
    msgID,
    unreadTotal,
  });
  await sendToUser(alanyaID, payload, getMessagePushOptions());
};


// ---------------------------------------------------------------------------
// Trajets de confiance — les textes
// ---------------------------------------------------------------------------

/**
 * Les libellés des notifications de trajet sont composés **ici, côté serveur**.
 *
 * Ce n'est pas le choix habituel de l'application, qui préfère laisser le client
 * traduire dans la langue du lecteur. Mais ces envois doivent atteindre un
 * téléphone dont l'application est fermée, voire tuée : c'est le système qui
 * affiche, et il n'y a personne pour traduire. La même contrainte s'applique
 * déjà aux messages (`buildMessagePayload`).
 *
 * Conséquence assumée : ces phrases sont en français. Les localiser demanderait
 * de connaître la langue de chaque destinataire côté serveur — un chantier
 * distinct, qui vaudrait pour tous les types de notification.
 */
const hhmm = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Heure à laquelle le cercle sera prévenu — la moitié du contrat annoncé au
 *  départ. Elle ne se devine pas, on l'écrit. */
const heureAlerte = (trip) => {
  if (!trip.eta_at) return null;
  const eta = new Date(trip.eta_at);
  if (Number.isNaN(eta.getTime())) return null;
  return hhmm(new Date(eta.getTime() + Number(trip.grace_minutes || 0) * 60_000));
};

/**
 * Alerte de trajet — le moment pour lequel toute la fonctionnalité existe.
 *
 * Trois écarts délibérés avec `notifyNewMessage` :
 *
 *  1. **Data-only et priorité haute**, comme un appel entrant : le client doit
 *     pouvoir rendre un plein écran, et le faire application fermée.
 *  2. **TTL de 120 s.** Une alerte de sûreté vieille de trois heures est du
 *     bruit — et elle décrédibilise les suivantes.
 *  3. **Aucun filtrage par les préférences ni par « Ne pas déranger ».** C'est
 *     le seul endroit de l'application où l'on s'autorise cela, et cela ne vaut
 *     que pour `trip_alert` et `trip_sos`. Une alerte qu'un réglage de silence
 *     peut étouffer n'est pas une alerte.
 */
const notifyTripAlert = async (trip, watcherIds, { io = null, isSos = false } = {}) => {
  if (!Array.isArray(watcherIds) || watcherIds.length === 0) return;

  let ownerName = '';
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(
      'SELECT nom, pseudo FROM users WHERE alanyaID = ?', [trip.owner_id],
    );
    ownerName = rows[0]?.nom || rows[0]?.pseudo || '';
  } catch { /* le nom est un confort, pas une condition */ }

  const type = isSos ? 'trip_sos' : 'trip_alert';
  const qui = ownerName || 'Un proche';
  const vu = trip.last_at ? hhmm(trip.last_at) : null;

  const data = buildTripPayload({
    type,
    tripId: Number(trip.id),
    state: trip.state,
    ownerId: Number(trip.owner_id),
    ownerName,
    lastLat: trip.last_lat == null ? null : Number(trip.last_lat),
    lastLng: trip.last_lng == null ? null : Number(trip.last_lng),
    lastAt: trip.last_at || null,
    // Le titre dit le FAIT, jamais une supposition : « n'a pas confirmé son
    // arrivée » et non « est en danger ». Le corps donne ce qui permet d'agir —
    // l'heure du dernier point, qui répond à « depuis quand ? ».
    title: isSos
      ? `${qui} a déclenché un SOS`
      : `${qui} n'a pas confirmé son arrivée`,
    body: vu
      ? `Dernière position à ${vu}`
      : 'Aucune position reçue',
  });

  await Promise.allSettled(watcherIds.map((id) =>
    sendToUser(Number(id), data, {
      io,
      // Surtout PAS `skipIfDeviceOnline` : un destinataire dont l'écran est
      // allumé sur une autre application ne verrait rien passer.
      skipIfDeviceOnline: false,
      android: { priority: 'high', ttl: 120_000 },
      apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' } },
    })));

  console.log(`[Trip] ${type} poussé à ${watcherIds.length} destinataire(s)`);
};

/** Clôture — silencieuse, et c'est voulu : « bien arrivée » rassure, mais ne
 *  doit réveiller personne. */
const notifyTripClosed = async (trip, watcherIds, { io = null } = {}) => {
  if (!Array.isArray(watcherIds) || watcherIds.length === 0) return;

  // Une clôture rassure : elle mérite un texte, mais pas de réveiller personne.
  const confirme = trip.state === 'closed_confirmed';
  const fausseAlerte = trip.close_reason === 'false_alarm';

  const data = buildTripPayload({
    type: 'trip_closed',
    tripId: Number(trip.id),
    state: trip.state,
    ownerId: Number(trip.owner_id),
    title: 'Trajet de confiance',
    body: fausseAlerte
      ? 'Fausse alerte — tout va bien'
      : (confirme ? 'Arrivée confirmée' : 'Partage arrêté'),
  });
  await Promise.allSettled(watcherIds.map((id) =>
    sendToUser(Number(id), data, { io, android: { priority: 'normal' } })));
};

// ---------------------------------------------------------------------------
// Rappels au propriétaire — les chances qu'on lui laisse
// ---------------------------------------------------------------------------

/**
 * Prévient le PROPRIÉTAIRE, et lui seul, avant que son cercle ne soit sollicité.
 *
 * Ces trois notifications sont l'escalade elle-même. Sans elles, quelqu'un qui
 * range son téléphone, arrive chez lui et oublie de confirmer n'apprend
 * strictement rien à 21:45, rien à 21:48, rien à 21:52 — et à 21:55 ses cinq
 * proches sont réveillés. Le mécanisme conçu pour éviter exactement cela n'avait
 * jamais eu l'occasion de fonctionner : les jobs n'émettaient qu'un socket, que
 * le client n'écoutait pas, et `transition()` ne poussait que sur les états
 * d'alerte et les clôtures.
 *
 * Priorité normale et **aucun contournement de « Ne pas déranger »** : ce ne
 * sont pas des alertes. Le jour où un rappel réveille quelqu'un la nuit, le
 * cercle apprend que le rouge de l'application ne veut rien dire.
 */
const notifierProprietaire = async (trip, { io, type, title, body, ttlMs }) => {
  const data = buildTripPayload({
    type,
    tripId: Number(trip.id),
    state: trip.state,
    ownerId: Number(trip.owner_id),
    title,
    body,
  });
  await sendToUser(Number(trip.owner_id), data, {
    io,
    // Surtout pas `skipIfDeviceOnline` : « en ligne » ne veut pas dire « regarde
    // son écran ». C'est précisément la personne distraite qu'il faut atteindre.
    skipIfDeviceOnline: false,
    android: { priority: 'high', ...(ttlMs ? { ttl: ttlMs } : {}) },
    apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' } },
  });
};

/** T−5 min. Silencieux pour le cercle, informatif pour le porteur. */
const notifyTripEtaSoon = async (trip, { io = null } = {}) => {
  const eta = trip.eta_at ? hhmm(trip.eta_at) : null;
  await notifierProprietaire(trip, {
    io,
    type: 'trip_eta_soon',
    title: 'Votre arrivée approche',
    body: eta
      ? `Arrivée prévue à ${eta}. Pensez à confirmer.`
      : 'Pensez à confirmer votre arrivée.',
    // Périmé passé l'échéance : le rappel suivant prendra le relais.
    ttlMs: 10 * 60_000,
  });
};

/** T. L'échéance est atteinte, le cercle ne sait encore rien. */
const notifyTripDue = async (trip, { io = null } = {}) => {
  const alerte = heureAlerte(trip);
  await notifierProprietaire(trip, {
    io,
    type: 'trip_due',
    title: 'Confirmez votre arrivée',
    // Les deux heures du contrat, écrites et non déduites. C'est la seule chose
    // qui permette de décider en connaissance de cause depuis l'écran de
    // verrouillage.
    body: alerte
      ? `Sans réponse, vos proches seront prévenus à ${alerte}.`
      : 'Sans réponse, vos proches seront prévenus avec votre dernière position.',
    ttlMs: 15 * 60_000,
  });
};

/** T+3 et T+7. Même contenu, insistance assumée. */
const notifyTripReminder = async (trip, { io = null, offsetMin = 0 } = {}) => {
  const alerte = heureAlerte(trip);
  await notifierProprietaire(trip, {
    io,
    type: 'trip_reminder',
    title: 'Vos proches vont être prévenus',
    body: alerte
      ? `Confirmez votre arrivée avant ${alerte}.`
      : 'Confirmez votre arrivée.',
    ttlMs: Math.max(2, 10 - Number(offsetMin || 0)) * 60_000,
  });
};

module.exports = {
  notifyTripAlert,
  notifyTripClosed,
  notifyTripEtaSoon,
  notifyTripDue,
  notifyTripReminder,
  sendDataOnlyNotification,
  sendToUser,
  sendToUserDevices,
  sendCallToUser,
  sendCallEndedToUser,
  sendToUserLegacy,
  notifyNewMessage,
  notifyIncomingCall,
  buildIncomingCallPayload,
  notifyGroupCall,
  notifyStatusView,
  notifyVoicemailActive,
  notifyQrContactScanned,
  notifyMeetingInvite,
  notifyMeetingReminder,
  notifyCallEnded,
  notifyMessageReadSync,
};
