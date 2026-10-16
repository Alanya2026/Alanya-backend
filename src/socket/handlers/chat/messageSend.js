const pool = require('../../../config/db');
const { resolveSendPolicy } = require('../../../utils/messageSendPolicy');
const {
  sanitizeMentions,
  serializeMentionsColumn,
} = require('../../../utils/mentions');
const { resolveLastMessagePreview } = require('../../../utils/mediaAlbum');
const { resolveReplyTarget } = require('../../../utils/resolveReplyToID');
const {
  getCachedParticipants,
  setCachedParticipants,
} = require('../../../utils/conversationParticipantsCache');
const { messageInsertSql, messageInsertParams, insertMessageThumb } = require('../../../utils/messageInsert');
const {
  normaliseChiffre,
  ecritChiffre,
  EnveloppeInvalide,
} = require('../../../utils/messageEnvelopes');
const {
  chargeMesAppareils,
  planRoutage,
  emetEnveloppes,
} = require('./envelopeRouting');
const { peutPublier } = require('../../../services/e2eeSettingsService');
const { getSenderIdentity } = require('../../../utils/senderIdentityCache');
const { buildSentPayload } = require('../../../utils/sentMessagePayload');
const { MEDIA_THUMB_SELECT } = require('../../../utils/messageThumbSql');
const { checkOutgoing, OUTGOING_DENIED } = require('../../../services/billing/outgoingGate');
const {
  resolveStickerFields,
  sanitizeReplyContent,
  StickerMessageError,
  toSocketError,
} = require('../../../utils/stickerMessage');
const { normalizeMessageType } = require('../../../utils/messageType');
const {
  resolveSafeboxShareFields,
  SafeboxShareMessageError,
  sanitizeShareReply,
  toSocketError: toShareSocketError,
} = require('../../../utils/safeboxShareMessage');

// `mt.thumb` rejoint APRÈS m.* et réencodé en base64 : mysql2 retourne un
// objet JS où la dernière colonne du même nom l'emporte, donc `mediaThumb`
// prend la valeur de message_thumb sans qu'il soit nécessaire d'énumérer les
// colonnes de `message` une par une. Contrat JSON inchangé côté client
// (audit scalabilité 06/08/2026 §2.2, migration 060).
const MSG_SELECT = `
  SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
         u.account_type AS sender_account_type,
         u.verification_status AS sender_verification_status,
         p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
         ${MEDIA_THUMB_SELECT}
  FROM message m
  JOIN users u ON m.senderID = u.alanyaID
  LEFT JOIN pays p ON u.idPays = p.idPays
  LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
`;

/** Normalise la ligne DB pour le client (clientId camelCase + msgID). */
function toClientMsg(row, clientId) {
  if (!row) return null;
  const id = clientId || row.clientID || row.clientId || null;
  return {
    ...row,
    msgID: row.msgID,
    clientId: id,
    clientID: id,
  };
}

async function loadMessageById(msgID) {
  const [rows] = await pool.execute(`${MSG_SELECT} WHERE m.msgID = ?`, [msgID]);
  return rows[0] || null;
}

async function loadMessageByClientId(senderID, clientId) {
  const [rows] = await pool.execute(
    `${MSG_SELECT} WHERE m.senderID = ? AND m.clientID = ? LIMIT 1`,
    [senderID, clientId],
  );
  return rows[0] || null;
}

/** Nom expéditeur + infos groupe en une seule requête (hors chemin critique). */
async function loadNotifyContext(conversationID, senderID) {
  // Les deux colonnes d'avatar viennent de la même ligne que le nom et le
  // groupe : c'est déjà un CROSS JOIN users × conversation, donc les ajouter ne
  // coûte aucun aller-retour supplémentaire.
  const [rows] = await pool.execute(
    `SELECT u.nom AS senderName, u.avatar_url AS senderAvatar,
            c.isGroup, c.GroupName AS groupName, c.groupPhoto AS groupAvatar
     FROM users u
     CROSS JOIN conversation c
     WHERE u.alanyaID = ? AND c.conversID = ?
     LIMIT 1`,
    [senderID, conversationID],
  );
  const row = rows[0] || {};
  return {
    senderName: row.senderName ?? 'Talky',
    senderAvatar: row.senderAvatar ?? '',
    isGroup: !!row.isGroup,
    groupName: row.groupName ?? '',
    groupAvatar: row.groupAvatar ?? '',
  };
}

async function loadParticipantsExcept(conversationID, senderID) {
  const cached = getCachedParticipants(conversationID, senderID);
  if (cached) return cached;
  const [participants] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
    [conversationID, senderID],
  );
  setCachedParticipants(conversationID, senderID, participants);
  return participants;
}

function emitSendFailed(socket, {
  clientId, code, message, feature,
}) {
  socket.emit('message:send_failed', {
    clientId: clientId || null,
    code,
    message,
    // Seulement pour SUBSCRIPTION_REQUIRED : le panneau de l'offre dit pourquoi.
    ...(feature ? { feature } : {}),
  });
}

/**
 * Insère le message, et son corps chiffré avec lui quand il y en a un.
 *
 * ── Pourquoi une transaction dès qu'il y a du chiffré ──
 *
 * Entre l'INSERT dans `message` et l'écriture de `message_e2ee`, une coupure
 * laisserait une ligne annoncée chiffrée (`enc_version = 1`) sans corps. Elle
 * serait servie à tous les destinataires, illisible pour chacun, et
 * définitivement : le clair n'existe plus que sur le téléphone de l'émetteur,
 * qui a déjà reçu son accusé et n'a donc plus rien à rejouer.
 *
 * Le chemin en clair garde son `pool.execute` nu. Rien de ce qui le suit n'en
 * dépend, c'est lui qui porte tout le trafic d'aujourd'hui, et lui faire
 * payer une transaction allongerait le chemin critique de l'accusé pour une
 * garantie dont il n'a pas l'usage.
 */
async function insereMessage(params, chiffre) {
  if (!chiffre) {
    const [r] = await pool.execute(messageInsertSql(null), params);
    return { msgID: r.insertId, isNewInsert: r.affectedRows === 1 };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.execute(messageInsertSql(chiffre), params);
    const msgID = r.insertId;
    await ecritChiffre(conn, msgID, chiffre);
    await conn.commit();
    return { msgID, isNewInsert: r.affectedRows === 1 };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Une enveloppe adressée à un appareil que `appareils` ne connaît plus.
 *
 * Le cas réel : l'appareil a été révoqué entre le moment où l'émetteur a
 * récupéré la liste des cibles et celui où il envoie. La clé étrangère de
 * `message_envelope` le refuse, et c'est bien ainsi — une enveloppe orpheline
 * ne serait jamais remise à personne.
 *
 * On le distingue d'une vraie erreur serveur pour que le client rafraîchisse
 * sa liste d'appareils et rejoue, au lieu de retenter à l'identique.
 */
function estAppareilInconnu(error) {
  return error && (
    error.code === 'ER_NO_REFERENCED_ROW_2'
    || error.code === 'ER_NO_REFERENCED_ROW'
  );
}

function logMsgPath(clientId, stage, t0) {
  const ms = t0 != null ? Date.now() - t0 : 0;
  console.log(`[MsgPath] clientId=${clientId} stage=${stage} ms_since_received=${ms}`);
}

const joinConversation = (io, socket) => {
  socket.on('join_conversation', async (data) => {
    try {
      // La room `conversation_<id>` reçoit message:updated, message:deleted,
      // message:reaction, message:pinned, message:viewed et le typing. Sans ces
      // deux gardes, n'importe quelle socket — même non authentifiée — pouvait
      // la rejoindre et écouter la vie d'une conversation dont elle n'est pas.
      if (!socket.authenticated) {
        return socket.emit('error', {
          message: 'Unauthenticated',
          code: 'UNAUTHENTICATED',
        });
      }

      const conversationID = parseInt(data?.conversationID, 10);
      if (!conversationID || conversationID < 1) return;

      const [rows] = await pool.execute(
        'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
        [conversationID, socket.alanyaID],
      );
      if (rows.length === 0) {
        return socket.emit('error', {
          message: 'Conversation introuvable ou non autorisée',
          code: 'NOT_A_MEMBER',
        });
      }

      socket.join(`conversation_${conversationID}`);
      socket.emit('joined_conversation', { conversationID });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });
};

const messageSend = (io, socket) => {
  socket.on('message:send', async (data) => {
    let clientId = null;
    // L'accusé part désormais avant les écritures d'aperçu et de non-lus. Si
    // l'une d'elles échoue, le message est bel et bien enregistré et confirmé :
    // envoyer un `send_failed` après coup ferait basculer en rouge une bulle
    // déjà passée au ✓, et le client la rejouerait pour rien.
    let acked = false;
    const t0 = Date.now();
    try {
      if (!socket.authenticated) {
        emitSendFailed(socket, {
          clientId: data?.clientId,
          code: 'UNAUTHENTICATED',
          message: 'Unauthenticated',
        });
        return socket.emit('error', {
          message: 'Unauthenticated',
          code: 'UNAUTHENTICATED',
        });
      }

      // `let` pour `content`, `mediaUrl` et `mediaName` : un sticker (type 10)
      // les voit réécrits par le serveur plus bas.
      let {
        conversationID, content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb,
        mediaSize, mediaPageCount,
        replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
        clickSentAt, mentions, mentionsAll = false,
      } = data;
      clientId = typeof data.clientId === 'string' ? data.clientId.trim() : '';
      const senderID = socket.alanyaID;
      logMsgPath(clientId || '?', 'received', t0);

      if (!clientId || clientId.length > 64) {
        emitSendFailed(socket, {
          clientId: clientId || null,
          code: 'MISSING_CLIENT_ID',
          message: 'clientId required (max 64 chars)',
        });
        return;
      }

      // `type` normalisé AVANT tout contrôle sticker : MySQL arrondit un
      // `10.4` à 10 à l'INSERT, ce qui créerait un type 10 sans résolution
      // serveur. Un non-entier est refusé pour TOUS les types (messageType).
      const typeNormalise = normalizeMessageType(type);
      if (typeNormalise === null) {
        emitSendFailed(socket, {
          clientId,
          code: 'INVALID_PAYLOAD',
          message: 'type de message invalide',
        });
        return;
      }
      type = typeNormalise;

      // Partie chiffrée, s'il y en a une. Validée AVANT l'INSERT et non
      // réparée après : un message chiffré mal formé est perdu sans recours —
      // l'émetteur a son accusé, le clair n'existe plus que chez lui, et le
      // serveur n'a aucune clé pour rattraper quoi que ce soit.
      let chiffre;
      try {
        chiffre = normaliseChiffre(data, socket.appareilId);
      } catch (e) {
        if (!(e instanceof EnveloppeInvalide)) throw e;
        emitSendFailed(socket, { clientId, code: e.code, message: e.message });
        return;
      }
      // Interrupteur fermé, ou compte hors cohorte : un corps chiffré n'a rien
      // à faire ici. Refusé AVANT l'INSERT, pour la même raison qu'un corps
      // mal formé.
      if (chiffre && !(await peutPublier(senderID))) {
        emitSendFailed(socket, {
          clientId,
          code: 'E2EE_INACTIF',
          message: 'Chiffrement de bout en bout non disponible pour ce compte',
        });
        return;
      }

      // Un message chiffré n'a ni `content` ni, forcément, de `mediaUrl` :
      // son texte est dans le corps scellé. Sans ce troisième terme, tout
      // envoi chiffré serait refusé comme payload vide.
      if (!conversationID || (!content && !mediaUrl && !chiffre)) {
        emitSendFailed(socket, {
          clientId,
          code: 'INVALID_PAYLOAD',
          message: 'conversationID and (content, mediaUrl or body) required',
        });
        return;
      }

      // Essai fini et aucun abonnement : le compte ne fait que recevoir. Avant
      // toute lecture de la conversation — c'est le refus le moins cher, et
      // `clientId` permet au téléphone de marquer CETTE bulle, sans rejeu.
      const outgoing = await checkOutgoing(senderID);
      if (!outgoing.allowed) {
        emitSendFailed(socket, {
          clientId,
          code: OUTGOING_DENIED.code,
          message: OUTGOING_DENIED.message,
          feature: OUTGOING_DENIED.feature,
        });
        return socket.emit('error', {
          message: OUTGOING_DENIED.message,
          code: OUTGOING_DENIED.code,
          feature: OUTGOING_DENIED.feature,
        });
      }

      // Appartenance, mode annonce, compte officiel et blocages en une passe :
      // 2 requêtes au lieu de 4 (1 seule pour un groupe). Voir
      // `utils/messageSendPolicy` — verdicts et codes strictement identiques à
      // l'enchaînement `assertCanSendToConversation` + `evaluateDirectMessageSend`
      // qu'elle remplace ici, ces deux-là restant en service ailleurs.
      const sendPolicy = await resolveSendPolicy(conversationID, senderID);
      logMsgPath(clientId, 'policy_checked', t0);
      if (!sendPolicy.ok) {
        emitSendFailed(socket, {
          clientId,
          code: sendPolicy.code,
          message: sendPolicy.message,
        });
        return socket.emit('error', {
          message: sendPolicy.message,
          code: sendPolicy.code,
        });
      }
      const { silentDrop } = sendPolicy;

      // Sticker : le serveur relit le `sid` en base et réécrit `content`,
      // `mediaUrl` et `mediaName` — ceux du client sont ignorés. Même fonction
      // que le chemin HTTP (`messageController`). Corps chiffré : ni lu ni
      // touché, il est scellé.
      try {
        const sticker = await resolveStickerFields({
          type, content, senderID, chiffre,
        });
        if (sticker) ({ content, mediaUrl, mediaName } = sticker);
      } catch (e) {
        if (!(e instanceof StickerMessageError)) throw e;
        const refus = toSocketError(e);
        emitSendFailed(socket, { clientId, ...refus });
        return socket.emit('error', refus);
      }

      // Fichier du coffre (type 11) : même principe que le sticker. Le partage
      // est relu en base ; il doit être à l'expéditeur et à cette discussion.
      try {
        const partage = await resolveSafeboxShareFields({
          type, content, senderID, conversationID, chiffre,
        });
        if (partage) ({ content, mediaUrl, mediaName } = partage);
      } catch (e) {
        if (!(e instanceof SafeboxShareMessageError)) throw e;
        const refus = toShareSocketError(e);
        emitSendFailed(socket, { clientId, ...refus });
        return socket.emit('error', refus);
      }

      // Ces quatre lectures sont indépendantes les unes des autres : les lancer
      // ensemble met leur coût en parallèle au lieu de l'additionner. Les deux
      // dernières passent par un cache 60 s et ne coûtent donc rien la plupart
      // du temps ; les deux premières ne touchent la base que s'il y a
      // effectivement une citation ou une mention.
      const [replyTarget, mentionsValue, senderIdentity, participants] =
        await Promise.all([
          resolveReplyTarget(conversationID, replyToID),
          // Écrites DANS l'INSERT et pas en UPDATE séparé : l'idempotence devient
          // gratuite, un rejeu du même clientID ne peut ni les dupliquer ni les
          // perdre. L'intersection avec les participants se fait côté serveur.
          sanitizeMentions(
            conversationID, senderID, mentions, { all: mentionsAll === true },
          ),
          getSenderIdentity(senderID),
          silentDrop
            ? Promise.resolve([])
            : loadParticipantsExcept(conversationID, senderID),
        ]);
      const resolvedReplyToID = replyTarget.id;
      // Citation d'un sticker : libellé neutre, jamais le JSON (même règle que
      // le chemin HTTP, via `sanitizeReplyContent`).
      const resolvedReplyToContent =
        (replyToContent != null && String(replyToContent).trim() !== '')
          ? sanitizeShareReply(sanitizeReplyContent(replyToContent, replyTarget.type), replyTarget.type)
          : null;

      // Date d'envoi décidée ici et non par `NOW()` : c'est ce qui permet
      // d'acquitter sans relire la ligne (voir utils/messageInsert).
      const sendAt = new Date();

      // Idempotence via unique (senderID, clientID) : insertId = nouveau ou existant.
      const insertParams = messageInsertParams({
        senderID,
        conversationID,
        clientId,
        content,
        type,
        sendAt,
        clickSentAt,
        mediaUrl,
        mediaName,
        mediaDuration,
        mediaSize,
        mediaPageCount,
        replyToID: resolvedReplyToID,
        replyToContent: resolvedReplyToContent,
        isStatusReply,
        isForwarded,
        isViewOnce,
        mentionsSerialized: serializeMentionsColumn(mentionsValue),
      });

      let msgID;
      let isNewInsert;
      try {
        ({ msgID, isNewInsert } = await insereMessage(insertParams, chiffre));
      } catch (e) {
        if (!estAppareilInconnu(e)) throw e;
        emitSendFailed(socket, {
          clientId,
          code: 'E2EE_ENVELOPPE_APPAREIL_INCONNU',
          message: 'Un appareil destinataire n\'existe plus : rafraîchir la liste et rejouer',
        });
        return;
      }
      logMsgPath(clientId, 'insert_done', t0);

      // Replay / course : message déjà présent → ack seulement, pas de double
      // unread. La ligne existante peut déjà porter des accusés, une édition ou
      // un épinglage, donc ici on la relit vraiment — chemin rare, et seule
      // cette relecture dit la vérité. La vignette est écrite avant, pour que
      // la relecture la ramène.
      if (!isNewInsert) {
        await insertMessageThumb(pool, msgID, mediaThumb);
        const existing = await loadMessageById(msgID) || await loadMessageByClientId(senderID, clientId);
        if (existing) {
          const payload = toClientMsg(existing, clientId);
          socket.emit('message:sent', payload);
          // Rejeu d'un message chiffré : on n'émet QUE vers la socket
          // émettrice. Le payload relu ne porte aucune enveloppe, et en
          // diffuser un aux autres appareils leur afficherait un message
          // illisible alors qu'ils ont très probablement déjà reçu le leur au
          // premier essai — un rejeu signifie que c'est l'accusé qui s'est
          // perdu, pas forcément la livraison. Ce qui manque encore à un
          // appareil lui arrive par le delta de synchronisation, qui sert les
          // enveloppes.
          if (!chiffre) {
            socket.to(`user_${senderID}`).emit('message:sent', payload);
          }
          logMsgPath(clientId, 'sender_ack_emit', t0);
          return;
        }
        emitSendFailed(socket, {
          clientId,
          code: 'INSERT_LOST',
          message: 'Duplicate key but message not found',
        });
        return;
      }

      // Payload identique à celui que rendait la relecture `MSG_SELECT`, mais
      // construit en mémoire : plus rien ne sépare l'INSERT de l'accusé.
      const payload = buildSentPayload({
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
        replyToID: resolvedReplyToID,
        replyToContent: resolvedReplyToContent,
        isStatusReply,
        isForwarded,
        isViewOnce,
        mentions: mentionsValue,
        senderIdentity,
        encVersion: chiffre ? 1 : 0,
      });

      // Accusé expéditeur en premier : c'est lui qui fait passer la bulle de
      // l'horloge au ✓. Tout ce qui suit est hors du chemin critique.
      //
      // La socket émettrice reçoit le payload NU, même pour un message
      // chiffré : elle détient le clair, lui renvoyer le corps scellé la
      // ferait déchiffrer ce qu'elle vient d'écrire.
      socket.emit('message:sent', payload);
      acked = true;
      logMsgPath(clientId, 'sender_ack_emit', t0);

      if (chiffre) {
        // Une émission par appareil : le corps est commun mais la clé de
        // contenu est scellée séparément pour chacun. Voir `envelopeRouting`.
        //
        // Les autres appareils de l'expéditeur sont dans le même plan que les
        // destinataires : ils reçoivent `message:sent` au lieu de
        // `message:received`, mais par le même chemin. C'est ce qui remplace
        // le `socket.to('user_<moi>')` du chemin en clair.
        if (!silentDrop) {
          const mesAppareils = await chargeMesAppareils(senderID);
          const plan = planRoutage({
            enveloppes: chiffre.enveloppes,
            mesAppareils,
            monAppareilId: socket.appareilId,
          });
          emetEnveloppes(io, { payload, chiffre, plan });
          logMsgPath(clientId, 'recipient_emit', t0);
        }
      } else {
        socket.to(`user_${senderID}`).emit('message:sent', payload);

        if (!silentDrop && participants.length > 0) {
          // Forme tableau : une seule émission, le payload n'est encodé qu'une fois
          // (la boucle unitaire le sérialisait N fois sur l'event loop).
          io.to(participants.map((p) => `user_${p.alanyaID}`))
            .emit('message:received', payload);
          logMsgPath(clientId, 'recipient_emit', t0);
        }
      }

      // Vignette : le destinataire l'a déjà reçue dans le payload, l'écriture
      // ne sert qu'aux relectures ultérieures (historique, sync).
      await insertMessageThumb(pool, msgID, mediaThumb);

      if (!silentDrop) {
        // Aperçu de conversation et non-lus : après les émissions. Le client
        // recalcule son propre aperçu depuis le message reçu, il n'attend pas
        // ces deux écritures pour afficher quoi que ce soit.
        await pool.execute(
          `UPDATE conversation
           SET lastMessage = ?, lastMessageAt = NOW(),
               lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1
           WHERE conversID = ?`,
          [
            // Un message chiffré n'a pas d'aperçu calculable ici : le serveur
            // n'a ni le texte ni le nom du fichier. L'aperçu stocké n'est
            // qu'une amorce pour la liste de conversations — le client la
            // remplace dès qu'il a déchiffré, et c'est lui qui la localise.
            resolveLastMessagePreview({
              content, mediaName, type, isViewOnce, isEncrypted: !!chiffre,
            }),
            senderID, type, conversationID,
          ],
        );

        await pool.execute(
          'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
          [conversationID, senderID],
        );

        // Prep FCM hors chemin critique.
        setImmediate(() => {
          loadNotifyContext(conversationID, senderID)
            .then((ctx) => {
              const notifyFields = {
                content,
                mediaName,
                type,
                isViewOnce,
                // Le corps de la push ne peut plus être calculé ici. Sur
                // Android, le chemin data-only laisse le client composer la
                // notification après déchiffrement ; partout ailleurs, c'est
                // un libellé neutre qui s'affiche — jamais un extrait.
                isEncrypted: !!chiffre,
                isGroup: ctx.isGroup,
                groupName: ctx.groupName,
                senderAvatar: ctx.senderAvatar,
                groupAvatar: ctx.groupAvatar,
                msgID,
                clientId,
                // La liste déjà normalisée : le fan-out n'a aucune requête à
                // refaire pour savoir qui est mentionné.
                mentions: mentionsValue,
              };
              const { notifyNewMessage } = require('../../../services/notificationService');
              return notifyNewMessage(
                conversationID,
                senderID,
                ctx.senderName,
                notifyFields,
                io,
              );
            })
            .catch((e) => console.warn('[FCM notification]', e.message));
        });
      }
    } catch (error) {
      console.error('[Socket message:send]', error.message);
      // Après l'accusé, l'échec ne concerne plus l'envoi lui-même (aperçu de
      // conversation, compteur de non-lus) : on le journalise sans démentir un
      // ✓ déjà affiché. Le rattrapage périodique corrigera l'aperçu.
      if (acked) return;
      emitSendFailed(socket, {
        clientId,
        code: 'SERVER_ERROR',
        message: error.message,
      });
      socket.emit('error', { message: error.message });
    }
  });
};

module.exports = { joinConversation, messageSend, emitSendFailed };
