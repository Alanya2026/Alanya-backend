/**
 * Payload `message:sent` / `message:received` construit en mémoire.
 *
 * Reproduit à l'identique ce que rendait `toClientMsg(loadMessageById(msgID))`,
 * c'est-à-dire une ligne `MSG_SELECT` (`m.*` + identité de l'expéditeur + la
 * vignette rejointe depuis `message_thumb`). Tout est connu de l'appelant au
 * moment de l'INSERT : les colonnes viennent de ce qu'il vient d'écrire, le
 * `msgID` de `insertId`, le `sendAt` du paramètre qu'il a lui-même fourni, et
 * l'identité de l'expéditeur d'un cache 60 s.
 *
 * Relire la ligne coûtait un `SELECT` à trois jointures — un aller-retour
 * complet vers une base qui n'est pas colocalisée avec le backend — juste pour
 * réapprendre des valeurs déjà en main, et ce avant de pouvoir acquitter.
 *
 * Les dates sont des objets `Date`, comme mysql2 les rend : socket.io les
 * sérialise en ISO 8601, donc le contrat JSON vu par le client est inchangé.
 *
 * Réservé aux messages qui viennent d'être insérés : les colonnes d'évolution
 * (accusés, édition, épinglage, réactions, vue) y valent forcément leur défaut.
 * Sur un rejeu (`ON DUPLICATE KEY`), la ligne existante peut déjà les porter —
 * l'appelant doit alors la relire.
 */

/** Normalise une entrée date (string ISO, Date, null) en `Date` ou `null`. */
function _date(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function _int(v, fallback = null) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Objet tel que mysql2 rend une colonne JSON : parsé, ou `null`. */
function _json(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

function buildSentPayload({
  msgID,
  senderID,
  conversationID,
  clientId,
  sendAt,
  clickSentAt,
  content,
  type,
  mediaUrl,
  mediaName,
  mediaDuration,
  mediaSize,
  mediaPageCount,
  mediaThumb,
  replyToID,
  replyToContent,
  isStatusReply,
  isForwarded,
  isViewOnce,
  mentions,
  senderIdentity,
  encVersion,
  isSensitive = false,
  mediaProtection = null,
}) {
  const id = clientId || null;
  return {
    msgID: _int(msgID, 0),
    senderID: _int(senderID, 0),
    conversationID: _int(conversationID, 0),
    // Les deux graphies : le client accepte l'une ou l'autre, la ligne DB
    // porte `clientID` et `toClientMsg` exposait historiquement les deux.
    clientID: id,
    clientId: id,

    content: content ?? null,
    type: _int(type, 0),
    // `enc_version` (migration 092) : la graphie de la colonne, puisque
    // `MSG_SELECT` fait `m.*` et que le client lit la même clé qu'il reçoive
    // ce payload construit en mémoire ou une ligne relue. Deux graphies
    // auraient donné un message annoncé chiffré sur un chemin et en clair sur
    // l'autre, pour la même ligne.
    enc_version: encVersion === 1 ? 1 : 0,
    status: 1,
    sendAt: _date(sendAt) ?? new Date(),
    clickSentAt: _date(clickSentAt),

    // Accusés : un message qui vient de naître n'est ni livré ni lu.
    deliveredAt: null,
    readAt: null,

    mediaUrl: mediaUrl ?? null,
    mediaName: mediaName ?? null,
    mediaDuration: _int(mediaDuration),
    mediaSize: _int(mediaSize),
    mediaPageCount: _int(mediaPageCount),
    // Même forme que `MEDIA_THUMB_SELECT` en lecture : du base64 d'un seul
    // tenant, sans les sauts de ligne que `TO_BASE64` ajoute et que le client
    // ne sait pas décoder. C'est exactement ce qu'on a reçu du client.
    mediaThumb: mediaThumb ?? null,

    replyToID: _int(replyToID),
    replyToContent: replyToContent ?? null,
    isStatusReply: _int(isStatusReply, 0),
    isForwarded: isForwarded ? 1 : 0,
    isViewOnce: isViewOnce ? 1 : 0,
    // Document sensible (migration 110). `mediaProtection` sous la forme
    // qu'une colonne JSON prend dans mysql2 : l'objet, pas sa chaîne — le
    // client reçoit la même chose qu'à la relecture de la ligne.
    isSensitive: isSensitive ? 1 : 0,
    mediaProtection: _json(mediaProtection),

    // Colonnes d'évolution, à leur valeur de création.
    isDeleted: 0,
    deletedForID: null,
    isEdited: 0,
    editedAt: null,
    isPinned: 0,
    pinnedAt: null,
    pinnedBy: null,
    has_reactions: 0,
    reactions: null,
    viewedAt: null,

    // Déjà normalisées par `sanitizeMentions` : tableau d'ids, marqueur
    // « all », ou null. Même forme qu'une colonne JSON rendue par mysql2.
    mentions: mentions ?? null,

    sender_nom: senderIdentity?.sender_nom ?? null,
    sender_pseudo: senderIdentity?.sender_pseudo ?? null,
    sender_avatar: senderIdentity?.sender_avatar ?? null,
    sender_account_type: _int(senderIdentity?.sender_account_type, 0),
    sender_verification_status: _int(senderIdentity?.sender_verification_status, 0),
    messageTz: senderIdentity?.messageTz ?? null,
    messageTzOffset: senderIdentity?.messageTzOffset ?? null,
  };
}

module.exports = { buildSentPayload };
