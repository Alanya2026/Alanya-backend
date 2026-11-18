const crypto = require('crypto');

/** @typedef {'message'|'message_read_sync'|'call'|'group_call'|'call_ended'|'meeting_invite'|'meeting_reminder'|'status_view'|'qr_contact_scanned'} NotificationType */

const SCHEMA_VERSION = '2';

const NOTIFICATION_TYPES = Object.freeze([
  'message',
  'message_read_sync',
  'call',
  'group_call',
  'call_ended',
  'meeting_invite',
  'meeting_reminder',
  'status_view',
  'qr_contact_scanned',
  'broadcast',
  // Trajets de confiance. `trip_alert` et `trip_sos` sont les deux seuls types
  // de toute l'application qui passent outre « Ne pas déranger » : une alerte de
  // sûreté qu'un réglage de silence peut étouffer n'est pas une alerte.
  'trip_alert',
  'trip_sos',
  'trip_closed',
  // Rappels au PROPRIÉTAIRE seul, avant que le cercle ne soit sollicité. Ils ne
  // contournent pas « Ne pas déranger » : ce ne sont pas des alertes, ce sont
  // les chances qu'on lui laisse d'éviter d'en déclencher une.
  'trip_eta_soon',
  'trip_due',
  'trip_reminder',
  // Abonnement Alanya Plus. Aucun ne passe outre « Ne pas déranger ».
  'billing_reminder',
  'billing_expired',
  'billing_purge_warning',
  'payment_succeeded',
  'payment_failed',
  // Vérification d'identité : décision sur le dossier.
  'verification_update',
  // Répondeur : « votre répondeur vient de prendre un appel ». Plafonné à un
  // par jour (socket/state/voicemailNotice.js) — ce n'est pas un avis d'appel
  // manqué, c'est un rappel que l'interrupteur est resté armé.
  'voicemail_active',
  // Lien d'invitation de groupe avec approbation (migration 116).
  'group_join_request',
  'group_join_approved',
]);

/**
 * Génère un eventId unique pour tracer un envoi de notification.
 * @returns {string}
 */
const generateEventId = () => `notif_${crypto.randomUUID()}`;

/**
 * Convertit un objet payload en map FCM data (toutes les valeurs en string).
 * @param {Record<string, unknown>} data
 * @returns {Record<string, string>}
 */
const stringifyData = (data = {}) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  );

/**
 * @param {unknown} value
 * @returns {string}
 */
const asString = (value) => (value == null ? '' : String(value));

/** Valeurs sentinelle stockées en base à la place d'une URL absente. */
const AVATAR_PLACEHOLDERS = Object.freeze([
  'non defini',
  'indefini',
  'undefined',
  'null',
]);

/** Ancien hôte du backend, encore présent dans les lignes `avatar_url` d'époque. */
const LEGACY_MEDIA_HOST = /^https?:\/\/158\.220\.107\.211/;
const MEDIA_HOST = 'https://www.alanya237.com';

/**
 * Rend une URL d'avatar utilisable par un client natif, ou la chaîne vide.
 *
 * Portage serveur de `normalizeAvatarUrl` (backend_url.dart) : le client Flutter
 * assainit déjà ce qu'il lit de l'API, mais Kotlin et le Service Extension iOS
 * consomment le payload push directement — sans équivalent de ce nettoyage, ils
 * héritaient de deux pièges bien réels de la colonne `users.avatar_url` :
 *
 * 1. Les sentinelles littérales (« NON DEFINI »…). Non filtrées, elles rendent
 *    `data.senderAvatar` truthy : `_buildApnsConfig` posait alors
 *    `mutable-content: 1` et Android lançait un téléchargement, pour une URL qui
 *    n'en est pas une.
 * 2. L'ancien hôte `158.220.107.211`, laissé par les lignes antérieures à la
 *    migration de domaine — injoignable en HTTPS valide aujourd'hui.
 *
 * `http://` est rejeté plutôt que réécrit : Android l'accepterait
 * (`usesCleartextTraffic="true"`), iOS non (ATS). Une URL qui ne marche que sur
 * une plateforme est un défaut plus coûteux qu'une photo absente sur les deux.
 *
 * @param {unknown} raw
 * @returns {string} URL https, ou '' si rien d'exploitable
 */
const sanitizeAvatarUrl = (raw) => {
  const value = asString(raw).trim();
  if (!value) return '';
  if (AVATAR_PLACEHOLDERS.includes(value.toLowerCase())) return '';

  const rewritten = value.replace(LEGACY_MEDIA_HOST, MEDIA_HOST);
  return rewritten.startsWith('https://') ? rewritten : '';
};

/**
 * Construit le payload v2 pour une notification message.
 * Rétrocompatible : les champs legacy (title, body, callerId) sont conservés.
 *
 * @param {object} input
 * @param {number|string} input.msgID
 * @param {number|string} input.conversationId
 * @param {number|string} input.senderId
 * @param {string} input.senderName
 * @param {string} [input.senderAvatar]
 * @param {string} input.body
 * @param {number|string} [input.msgType]
 * @param {boolean} [input.isGroup]
 * @param {string} [input.groupName]
 * @param {string} [input.groupAvatar]
 * @param {string} [input.clientId]
 * @param {string|Date} [input.sentAt]
 * @param {number|string} [input.unreadTotal]
 * @param {string} [input.eventId]
 * @param {boolean} [input.isEncrypted] corps non calculable par le serveur
 * @returns {Record<string, string>}
 */
const buildMessagePayload = (input = {}) => {
  const eventId = input.eventId || generateEventId();
  const isGroup = input.isGroup === true || input.isGroup === 1 || input.isGroup === '1';
  const isEncrypted = input.isEncrypted === true || input.isEncrypted === 1
    || input.isEncrypted === '1';
  const groupName = asString(input.groupName);
  const senderName = asString(input.senderName);
  const body = asString(input.body);
  const sentAt =
    input.sentAt instanceof Date
      ? input.sentAt.toISOString()
      : asString(input.sentAt) || new Date().toISOString();

  const title = isGroup && groupName ? groupName : senderName;

  return stringifyData({
    schemaVersion: SCHEMA_VERSION,
    eventId,
    type: 'message',
    msgID: input.msgID,
    clientId: input.clientId ?? '',
    conversationId: input.conversationId,
    senderId: input.senderId,
    senderName,
    // Assaini ici, et pas chez les appelants : c'est le point de passage unique
    // des trois consommateurs (MessageNotificationHelper, NSE iOS, Flutter).
    senderAvatar: sanitizeAvatarUrl(input.senderAvatar),
    title,
    body: isGroup && senderName ? `${senderName}: ${body}` : body,
    msgType: input.msgType ?? 0,
    isGroup: isGroup ? '1' : '0',
    groupName,
    groupAvatar: sanitizeAvatarUrl(input.groupAvatar),
    sentAt,
    unreadTotal: input.unreadTotal ?? '',
    // `enc` dit aux trois consommateurs (MessageNotificationHelper,
    // NSE iOS, Flutter) que `body` est un libellé neutre et non le message :
    // le serveur n'a pas le texte. Sans ce drapeau, chacun afficherait
    // « Message chiffré » en croyant afficher le message, et personne ne
    // saurait qu'il faut le remplacer après déchiffrement.
    enc: isEncrypted ? '1' : '0',
    // Legacy aliases consumed by le client actuel
    callerId: input.senderId,
  });
};

/**
 * Payload silencieux pour synchroniser la lecture sur les autres appareils.
 * @param {object} input
 * @param {number|string} input.conversationId
 * @param {number|string} [input.msgID]
 * @param {string} [input.eventId]
 * @returns {Record<string, string>}
 */
const buildMessageReadSyncPayload = (input = {}) =>
  stringifyData({
    schemaVersion: SCHEMA_VERSION,
    eventId: input.eventId || generateEventId(),
    type: 'message_read_sync',
    conversationId: input.conversationId,
    msgID: input.msgID ?? '',
    // Badge : _buildApnsConfig le transforme en aps.badge, donc les autres
    // appareils iOS du lecteur se remettent à jour sans ouvrir l'app.
    unreadTotal: input.unreadTotal,
  });

/**
 * Normalise un payload entrant (legacy ou v2) sans lever d'exception.
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {Record<string, string>}
 */
const normalizeIncomingPayload = (raw = {}) => {
  const safe = raw && typeof raw === 'object' ? raw : {};
  const type = asString(safe.type) || 'message';
  const normalized = stringifyData({ ...safe, type });

  if (!normalized.schemaVersion) {
    normalized.schemaVersion = '1';
  }
  if (!normalized.eventId && normalized.msgID) {
    normalized.eventId = `legacy_msg_${normalized.msgID}`;
  }
  return normalized;
};

/**
 * @param {Record<string, string>} data
 * @returns {boolean}
 */
const isV2Payload = (data) => asString(data?.schemaVersion) === SCHEMA_VERSION;


/**
 * Charge utile d'une alerte de trajet.
 *
 * Data-only et haute priorité, comme les appels : le client doit pouvoir rendre
 * un plein écran plutôt qu'une bannière, et le faire même application fermée.
 *
 * TTL court — deux minutes. Une alerte de sûreté affichée trois heures après
 * coup est du bruit, et surtout elle décrédibilise les suivantes.
 */
const buildTripPayload = (input = {}) => {
  const {
    type = 'trip_alert',
    tripId,
    state,
    ownerId,
    ownerName = '',
    lastLat = null,
    lastLng = null,
    lastAt = null,
    eventId = null,
    title = '',
    body = '',
  } = input;

  return stringifyData({
    schemaVersion: '2',
    type,
    eventId: eventId || `${type}_${tripId}_${Date.now()}`,
    tripId,
    state,
    ownerId,
    ownerName,
    lastLat,
    lastLng,
    lastAt,

    // ⚠ `title` et `body` ne sont PAS décoratifs : sans eux, la notification
    // n'existe pas.
    //
    // Ces envois sont data-only (`sendDataOnlyNotification`), donc c'est le
    // client qui compose et affiche la notification locale — et il commence par
    // `if (title.isEmpty && body.isEmpty) return;` (push_service.dart). Une
    // charge utile sans ces deux champs produisait donc une alerte de sûreté
    // parfaitement silencieuse : elle ne vivait que dans le socket, c'est-à-dire
    // uniquement si l'application du destinataire était déjà ouverte. L'inverse
    // exact de la règle du volet — une alerte ne transite jamais par la seule
    // room.
    //
    // Le texte est composé côté serveur, comme pour les messages
    // (`buildMessagePayload`) : quand l'application est tuée, personne côté
    // client n'est là pour traduire.
    title,
    body,

    deeplink: `alanya://trips/${tripId}`,
  });
};

/**
 * Charge utile des notifications de l'abonnement : relance, échéance, purge,
 * paiement. Même règle que les trajets — `title` et `body` composés côté
 * serveur, faute de quoi le client, application tuée, n'afficherait rien —,
 * et un lien vers « Mon abonnement ».
 */
const buildBillingPayload = ({
  type, title = '', body = '', eventId = null, deeplink = 'alanya://subscription',
} = {}) =>
  stringifyData({
    schemaVersion: SCHEMA_VERSION,
    type,
    eventId: eventId || generateEventId(),
    title,
    body,
    deeplink,
  });

module.exports = {
  SCHEMA_VERSION,
  NOTIFICATION_TYPES,
  buildTripPayload,
  buildBillingPayload,
  generateEventId,
  stringifyData,
  sanitizeAvatarUrl,
  buildMessagePayload,
  buildMessageReadSyncPayload,
  normalizeIncomingPayload,
  isV2Payload,
};
