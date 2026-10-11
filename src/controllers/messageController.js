const pool = require('../config/db');
const { fail } = require('../utils/apiError');
const { peutPublier } = require('../services/e2eeSettingsService');
const { deleteMediaFile } = require('../utils/mediaFile');
const { notifyNewMessage } = require('../services/notificationService');
const { evaluateDirectMessageSend } = require('../utils/blockUtils');
const { assertCanSendToConversation } = require('../utils/groupSendPolicy');
const { sanitizeMentions, serializeMentionsColumn } = require('../utils/mentions');
const { markConversationDeliveredBy } = require('../utils/deliveryReceiptUtils');
const { resolveLastMessagePreview } = require('../utils/mediaAlbum');
const { resolveReplyTarget } = require('../utils/resolveReplyToID');
const { HISTORY_CUTOFF_SQL } = require('../utils/messageHistoryFilter');
const { enregistrerSuppressions, lireSuppressions } = require('../utils/messageTombstone');
const { appliquerStatutLecteur } = require('../utils/groupReceipts');
const { messageInsertSql, messageInsertParams, insertMessageThumb } = require('../utils/messageInsert');
const {
  attacheChiffre,
  normaliseChiffre,
  ecritChiffre,
  EnveloppeInvalide,
} = require('../utils/messageEnvelopes');
const {
  chargeMesAppareils,
  planRoutage,
  emetEnveloppes,
} = require('../socket/handlers/chat/envelopeRouting');
const { MEDIA_THUMB_SELECT } = require('../utils/messageThumbSql');
const { copyForForward } = require('../services/mediaStorage');
const { resolveStickerFields, estSticker, sanitizeReplyContent, champsDeTransfert } = require('../utils/stickerMessage');
const { normalizeMessageType } = require('../utils/messageType');

// Même origine que celle composée à l'upload : une URL de transfert doit être
// indiscernable d'une URL d'upload, sans quoi le client la traiterait comme
// un hôte différent (cache, épinglage de certificat).
const MEDIA_BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const {
  decider: deciderSuppression,
  chargerContextes: chargerContextesSuppression,
  contexteDe: contexteSuppression,
  SuppressionRefusee,
} = require('../utils/messageDeletion');

const MESSAGE_EDIT_WINDOW_MINUTES = 30;
const MAX_BATCH_DELETE = 50;
const MAX_BATCH_FORWARD_SOURCES = 20;
const MAX_BATCH_FORWARD_TARGETS = 20;

const _execute = (conn, sql, params) =>
  conn ? conn.execute(sql, params) : pool.execute(sql, params);

const getMessages = async (req, res) => {
  try {
    const { id } = req.params; // conversationID
    const alanyaID = req.user.alanyaID;
    const { limit = 50, before, after } = req.query;

    // Membership d'abord : un JOIN seul renverrait [] pour un non-membre, ce
    // qui confirmerait l'existence de la conversation. 404 comme avant.
    const [membership] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [id, alanyaID],
    );
    if (membership.length === 0) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    // Jointure cp : filtre historyCutoffAt (migration 028). Sans elle, un
    // nouvel arrivant avec historique masqué récupérerait tout le fil.
    // mediaThumb rejointe depuis message_thumb, réencodée en base64 : même
    // contrat JSON qu'avant, la vignette n'est simplement plus stockée dans
    // la ligne `message` (audit scalabilité 06/08/2026 §2.2, migration 060).
    let query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar,
             p.timeZone   AS messageTz,
             p.decalageHoraire AS messageTzOffset,
             (m.viewedAt IS NOT NULL) AS viewedByMe,
             cp.lastReadMsgID AS _lastReadMsgID,
             ${MEDIA_THUMB_SELECT}
      FROM message m
      JOIN conv_participants cp
        ON cp.conversID = m.conversationID AND cp.alanyaID = ?
      JOIN users u ON m.senderID = u.alanyaID
      LEFT JOIN pays p ON u.idPays = p.idPays
      LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
      WHERE m.conversationID = ?
        AND m.isDeleted = 0
        AND (m.deletedForID IS NULL OR m.deletedForID != ?)
        AND ${HISTORY_CUTOFF_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM blocked b
          WHERE b.alanyaID = ?
            AND b.idCallerBlock = m.senderID
            AND m.senderID != ?
            AND m.sendAt >= b.dateBlock
        )
    `;
    const params = [alanyaID, id, alanyaID, alanyaID, alanyaID];

    if (before) {
      query += ' AND m.msgID < ?';
      params.push(parseInt(before));
    }
    if (after) {
      query += ' AND m.msgID > ?';
      params.push(parseInt(after));
    }

    query += ' ORDER BY m.sendAt DESC LIMIT ?';
    params.push(parseInt(limit) || 50);

    const [rows] = await pool.query(query, params);

    // Groupe : statut des messages reçus vu par CE lecteur, pas le statut global
    // (« lu » dès le premier lecteur) — sinon son compteur de non-lus tombe à
    // zéro (groupe 3GI 2029, bug A6 ; migration 096).
    const [[convRow]] = await pool.execute(
      'SELECT isGroup FROM conversation WHERE conversID = ?',
      [id],
    );
    appliquerStatutLecteur(rows, alanyaID, { isGroup: Number(convRow?.isGroup) === 1 });

    // Média vue unique déjà consulté par cet utilisateur → on n'expose plus l'URL.
    // Expose aussi clientId (camelCase) pour le match optimiste côté app.
    for (const r of rows) {
      if (r.isViewOnce && r.viewedByMe > 0 && r.senderID !== alanyaID) {
        r.mediaUrl = null;
      }
      if (r.clientID != null && r.clientId == null) {
        r.clientId = r.clientID;
      }
    }

    // Corps et enveloppe des messages chiffrés, pour CET appareil seulement.
    // Aucune requête si la page n'en contient aucun.
    await attacheChiffre(pool, rows, req.user.appareilId);

    // Lecture / accusés : uniquement via message:read ou POST /:id/read
    // (markConversationReadBy), pour notifier lastMessageStatus correctement.

    res.json(rows.reverse());
  } catch (error) {
    throw error;
  }
};

/**
 * Ack à l'expéditeur seul. Extrait pour être réutilisé au rejeu, où l'on ne doit
 * ni rediffuser aux autres participants ni renvoyer de push.
 */
const _emitSenderAck = (req, senderID, msg) => {
  const io = req.app.get('io');
  if (!io || !senderID) return;
  const clientId = msg.clientID ?? msg.clientId ?? null;
  io.to(`user_${senderID}`).emit('message:sent', {
    ...msg,
    clientId,
    clientID: clientId,
    msgID: msg.msgID,
  });
};

const _deliverMessage = async (req, conversationID, senderID, msg, fields, silentDrop) => {
  if (silentDrop) return;

  const {
    content, mediaName, type, isViewOnce, mentions, isEncrypted, chiffre,
  } = fields;
  const io = req.app.get('io');
  if (io) {
    if (chiffre) {
      // Une émission par appareil : le corps est commun mais la clé de
      // contenu est scellée séparément pour chacun. Même routage que le
      // chemin socket (voir `socket/handlers/chat/envelopeRouting`), et pour
      // la même raison — diffuser toutes les enveloppes à tout le monde
      // dirait à chacun combien d'appareils ont ses correspondants.
      //
      // `monAppareilId` est null ici : la requête est HTTP, il n'y a pas de
      // socket émettrice à écarter. L'appareil qui a posté reçoit donc son
      // enveloppe comme les autres — il ne l'ouvrira pas, puisqu'il détient
      // le clair, mais `normaliseChiffre` l'a de toute façon interdite.
      const mesAppareils = await chargeMesAppareils(senderID);
      const plan = planRoutage({
        enveloppes: chiffre.enveloppes, mesAppareils, monAppareilId: null,
      });
      emetEnveloppes(io, { payload: msg, chiffre, plan });
    } else {
      const [participants] = await pool.execute(
        'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND alanyaID != ?',
        [conversationID, senderID]
      );
      if (participants.length > 0) {
        // Forme tableau : une seule émission, encodage unique du payload.
        io.to(participants.map((p) => `user_${p.alanyaID}`))
          .emit('message:received', msg);
      }
      _emitSenderAck(req, senderID, msg);
    }
  }

  // Fan-out FCM hors du cycle de la réponse HTTP (le chemin socket fait déjà
  // pareil via setImmediate) : le client ne doit pas attendre N envois push
  // avant de recevoir son 200, et la connexion pool est libérée tout de suite.
  setImmediate(async () => {
    try {
      const [sender] = await pool.execute(
        'SELECT nom, avatar_url FROM users WHERE alanyaID = ?', [senderID]
      );
      const senderName = sender[0]?.nom ?? 'Talky';

      const [convRows] = await pool.execute(
        'SELECT isGroup, GroupName, groupPhoto FROM conversation WHERE conversID = ?',
        [conversationID]
      );
      const conv = convRows[0] ?? {};
      await notifyNewMessage(conversationID, senderID, senderName, {
        content,
        mediaName,
        type,
        isViewOnce,
        // Le corps de la push ne peut pas être calculé ici : libellé neutre,
        // et le client le remplace après déchiffrement.
        isEncrypted: !!isEncrypted,
        isGroup: !!conv.isGroup,
        groupName: conv.GroupName ?? '',
        senderAvatar: sender[0]?.avatar_url ?? '',
        groupAvatar: conv.groupPhoto ?? '',
        mentions,
        // Sans eux, `stringifyData` les retirait du payload (clés undefined) : la
        // push d'une réponse rapide partait sans msgID, et la déduplication client
        // retombait sur `eventId`, régénéré à chaque envoi — donc inopérante. Le
        // chemin socket les transmet depuis toujours.
        msgID: msg.msgID,
        clientId: msg.clientID ?? msg.clientId ?? null,
      }, io);
    } catch (e) {
      console.error('[FCM] fan-out HTTP échoué:', e.message);
    }
  });
};

const _persistMessage = async (conn, conversationID, senderID, fields) => {
  // `let` pour `content`, `mediaUrl` et `mediaName` : un sticker (type 10) les
  // voit réécrits par le serveur plus bas.
  let {
    content, type = 0, mediaUrl, mediaName, mediaDuration, mediaThumb,
    mediaSize, mediaPageCount,
    replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
    clickSentAt, clientId, mentions, mentionsAll = false,
    chiffre = null,
  } = fields;

  // `type` normalisé AVANT tout contrôle sticker : MySQL arrondit un `10.4` à
  // 10 à l'INSERT, ce qui créerait un type 10 sans résolution serveur. Un
  // non-entier est refusé pour TOUS les types (messageType). Le `throw` porte
  // `status`/`code` : le `catch` de `sendMessage` le rend tel quel, et un lot
  // de transfert l'abandonne en cours de transaction.
  const typeNormalise = normalizeMessageType(type);
  if (typeNormalise === null) {
    const err = new Error('type de message invalide');
    err.status = 400;
    err.code = 'INVALID_PAYLOAD';
    throw err;
  }
  type = typeNormalise;

  if (clientId) {
    const [existing] = await _execute(conn,
      `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
              p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
              ${MEDIA_THUMB_SELECT}
       FROM message m
       JOIN users u ON m.senderID = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
       WHERE m.senderID = ? AND m.clientID = ? AND m.isDeleted = 0
       LIMIT 1`,
      [senderID, clientId],
    );
    if (existing.length > 0) {
      return {
        msg: existing[0],
        silentDrop: false,
        // Le message existe déjà : l'appelant ne doit PAS rediffuser. Voir
        // `_persistAndDeliverMessage`.
        replayed: true,
        // Rejeu : on relit les mentions déjà persistées plutôt que de refaire
        // confiance au payload, qui peut avoir changé entre deux tentatives.
        fields: {
          content, mediaName, type, isViewOnce,
          // Le drapeau vient de la LIGNE, pas du payload rejoué : c'est elle
          // qui dit si le message a été écrit chiffré, et le payload d'un
          // rejeu peut avoir changé entre deux tentatives.
          isEncrypted: Number(existing[0].enc_version) === 1,
          chiffre: null,
          mentions: existing[0].mentions,
        },
      };
    }
  }

  // Appartenance + mode annonce. Placé APRÈS le court-circuit d'idempotence
  // ci-dessus : un message déjà persisté doit rester rejouable même si le mode
  // annonce a été activé entre-temps, sinon un retry légitime échouerait.
  const sendPolicy = await assertCanSendToConversation(conversationID, senderID);
  if (!sendPolicy.ok) {
    const err = new Error(sendPolicy.message);
    err.status = sendPolicy.code === 'CONVERSATION_NOT_FOUND' ? 404 : 403;
    err.code = sendPolicy.code;
    throw err;
  }

  const blockEval = await evaluateDirectMessageSend(conversationID, senderID);
  if (blockEval.isDirect && blockEval.action === 'reject') {
    const err = new Error('Cannot message blocked user');
    err.status = 403;
    err.code = blockEval.code || 'BLOCKED_BY_SENDER';
    throw err;
  }

  const silentDrop = blockEval.isDirect && blockEval.action === 'silent';

  // Sticker : même fonction que `message:send` (socket). Le serveur relit le
  // `sid` en base ; `content`, `mediaUrl` et `mediaName` du client sont
  // ignorés. Une `StickerMessageError` porte `status`, `code` et `feature` :
  // les `catch` des appelants la rendent telle quelle.
  const sticker = await resolveStickerFields({
    type, content, senderID, chiffre,
  });
  if (sticker) ({ content, mediaUrl, mediaName } = sticker);

  const { id: resolvedReplyToID, type: replyToType } = await resolveReplyTarget(conversationID, replyToID);
  // Citation d'un sticker : libellé neutre, jamais le JSON (voir stickerMessage).
  const resolvedReplyToContent = resolvedReplyToID != null
    ? sanitizeReplyContent(replyToContent ?? null, replyToType)
    : null;

  const mentionsValue = await sanitizeMentions(
    conversationID, senderID, mentions, { all: mentionsAll === true },
  );

  const [result] = await _execute(
    conn,
    messageInsertSql(chiffre),
    messageInsertParams({
      senderID,
      conversationID,
      clientId,
      content,
      type,
      // Explicite comme sur le chemin socket : `sendAt` n'est plus `NOW()`,
      // c'est l'appelant qui décide (voir utils/messageInsert).
      sendAt: new Date(),
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
    }),
  );

  const msgID = result.insertId;
  // Course : un second POST (rejeu natif / Flutter) a pu gagner l'INSERT.
  // affectedRows === 1 → ligne nouvelle ; sinon c'est un rejeu, on ne
  // touche ni unread ni lastMessage.
  const isNewInsert = result.affectedRows === 1;

  // Corps chiffré et enveloppes, AVANT toute relecture et avant la réponse
  // HTTP. Sur ce chemin l'appelant fournit une connexion (`conn`) et la
  // transaction est tenue par `_persistAndDeliverMessage` : le message et son
  // corps sont donc commis ensemble, ou pas du tout. Une ligne annoncée
  // chiffrée sans corps serait illisible pour tous les destinataires, et
  // définitivement — le clair n'existe plus que sur le téléphone émetteur.
  if (chiffre) await ecritChiffre(conn ?? pool, msgID, chiffre);

  // Écriture séparée dans message_thumb (audit scalabilité 06/08/2026 §2.2,
  // migration 060) : idempotente, sûre à rejouer sur le chemin course.
  await insertMessageThumb(conn ?? pool, msgID, mediaThumb);

  if (!isNewInsert) {
    const [existingRows] = await _execute(
      conn,
      `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
              p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
              ${MEDIA_THUMB_SELECT}
       FROM message m
       JOIN users u ON m.senderID = u.alanyaID
       LEFT JOIN pays p ON u.idPays = p.idPays
       LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
       WHERE m.msgID = ?`,
      [msgID],
    );
    return {
      msg: existingRows[0],
      silentDrop: false,
      replayed: true,
      fields: {
        content,
        mediaName,
        type,
        isViewOnce,
        isEncrypted: !!chiffre,
        chiffre,
        mentions: existingRows[0]?.mentions ?? mentionsValue,
      },
    };
  }

  if (!silentDrop) {
    await _execute(conn,
      `UPDATE conversation
       SET lastMessage = ?, lastMessageAt = NOW(),
           lastMessageSenderID = ?, lastMessageType = ?, lastMessageStatus = 1,
           message_count = message_count + 1
       WHERE conversID = ?`,
      [
        // Chiffré : le serveur n'a ni le texte ni le nom du fichier. L'aperçu
        // stocké n'est qu'une amorce — le client le remplace et le localise
        // dès qu'il a déchiffré.
        resolveLastMessagePreview({
          content, mediaName, type, isViewOnce, isEncrypted: !!chiffre,
        }),
        senderID, type, conversationID,
      ]
    );

    await _execute(conn,
      'UPDATE conv_participants SET unreadCount = unreadCount + 1 WHERE conversID = ? AND alanyaID != ?',
      [conversationID, senderID]
    );
  }

  const [rows] = await _execute(conn,
    `SELECT m.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar,
            p.timeZone AS messageTz, p.decalageHoraire AS messageTzOffset,
            ${MEDIA_THUMB_SELECT}
     FROM message m
     JOIN users u ON m.senderID = u.alanyaID
     LEFT JOIN pays p ON u.idPays = p.idPays
     LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
     WHERE m.msgID = ?`,
    [msgID]
  );

  return {
    msg: rows[0],
    silentDrop,
    replayed: false,
    fields: {
      content, mediaName, type, isViewOnce,
      isEncrypted: !!chiffre, chiffre,
      mentions: mentionsValue,
    },
  };
};

const _persistAndDeliverMessage = async (req, conversationID, senderID, fields, { conn = null, skipDelivery = false } = {}) => {
  const { msg, silentDrop, replayed, fields: deliveryFields } =
    await _persistMessage(conn, conversationID, senderID, fields);
  if (!skipDelivery) {
    if (replayed) {
      // Rejeu d'un `clientId` déjà persisté. Rediffuser enverrait un second
      // `message:received` ET une seconde push : le destinataire verrait deux
      // fois le même message. Seul l'ack expéditeur est rejoué, pour que le
      // client qui retente puisse réconcilier sa ligne locale.
      //
      // Même comportement que le chemin socket, qui sort immédiatement dans ce
      // cas (src/socket/handlers/chat/messageSend.js).
      _emitSenderAck(req, senderID, msg);
    } else {
      await _deliverMessage(req, conversationID, senderID, msg, deliveryFields, silentDrop);
    }
  }
  return { msg, silentDrop, replayed, deliveryFields };
};

// `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
// `async`, donc l'erreur remontait en unhandled rejection et tuait le process
// sous Node 24, sans jamais atteindre `errorHandler`. C'est le chemin de la
// réponse rapide depuis la notification, app fermée.
const sendMessage = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      content, type = 0, mediaUrl, mediaName, mediaDuration,
      mediaSize, mediaPageCount,
      replyToID, replyToContent, isStatusReply = 0, isForwarded = 0, isViewOnce = 0,
      clickSentAt, clientId,
    } = req.body;
    const senderID = req.user.alanyaID;

    // Partie chiffrée, s'il y en a une. Validée AVANT l'INSERT, comme sur le
    // chemin socket : un message chiffré mal formé est perdu sans recours.
    let chiffre;
    try {
      chiffre = normaliseChiffre(req.body, req.user.appareilId);
    } catch (e) {
      if (!(e instanceof EnveloppeInvalide)) throw e;
      // `fail` et non un `res.json` direct : il fait passer la prose par
      // `scrubMessage`. Ce message-ci est écrit à la main et sans danger,
      // mais la garde de couverture ne peut pas le savoir — et c'est bien
      // qu'elle ne le sache pas : c'est ce qui a arrêté les fuites de
      // messages de driver.
      return fail(res, 400, e.code, e.message);
    }
    // Même garde que `message:send` : interrupteur fermé ou compte hors
    // cohorte, un corps chiffré est refusé avant toute écriture.
    if (chiffre && !(await peutPublier(senderID))) {
      return fail(res, 404, 'E2EE_INACTIF', 'Chiffrement de bout en bout non disponible pour ce compte');
    }

    // Un message chiffré n'a ni `content` ni forcément de `mediaUrl` : son
    // texte est dans le corps scellé.
    if (!content && !mediaUrl && !chiffre) {
      return res.status(400).json({ error: 'content, mediaUrl ou body requis', code: 'CONTENT_REQUIRED' });
    }

    const { msg } = await _persistAndDeliverMessage(req, id, senderID, {
      content, type, mediaUrl, mediaName, mediaDuration,
      mediaSize, mediaPageCount,
      replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce,
      clickSentAt, clientId, chiffre,
    });

    res.json(msg);
  } catch (error) {
    // `error.status` et non `=== 403` : la politique d'envoi renvoie aussi un
    // 404 (conversation inexistante), qui finirait sinon en 500.
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.feature ? { feature: error.feature } : {}),
      });
    }
    next(error);
  }
};

const updateMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body;
    const senderID = req.user.alanyaID;

    if (!content) {
      return res.status(400).json({ error: 'content requis', code: 'CONTENT_REQUIRED' });
    }

    // Être l'auteur ne suffit pas : il faut être ENCORE membre. Sans ça, un
    // exclu gardait 30 minutes pour réécrire le contenu de ses messages restés
    // dans le fil du groupe — modification rediffusée aux membres restants — et
    // un temps illimité pour les supprimer pour tout le monde. C'était aussi un
    // contournement du mode annonce : interdit d'envoyer, mais libre de
    // remplacer le texte d'un message antérieur au verrou.
    const [existing] = await pool.execute(
      `SELECT m.* FROM message m
         JOIN conv_participants cp
           ON cp.conversID = m.conversationID AND cp.alanyaID = m.senderID
        WHERE m.msgID = ? AND m.senderID = ? AND m.isDeleted = 0`,
      [id, senderID]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou non autorisé', code: 'MESSAGE_NOT_FOUND' });
    }

    // Modifier un message chiffré n'est pas écrire dans `content` : il
    // faudrait rechiffrer le corps et resceller la clé pour chaque appareil,
    // puis router `message:updated` appareil par appareil — alors qu'il part
    // aujourd'hui vers la room `conversation_<id>`, commune à tous.
    //
    // Refuser est le seul comportement sûr en attendant. Écrire le nouveau
    // texte dans `content` « en passant » déposerait le clair sur le serveur
    // pour un message que l'auteur croit chiffré : exactement ce que le
    // chiffrement de bout en bout promet d'empêcher. Et le client, voyant
    // `enc_version = 1`, continuerait de déchiffrer l'ancien corps : la
    // modification serait invisible pour tout le monde sauf la base.
    if (Number(existing[0].enc_version) === 1) {
      return res.status(409).json({
        error: 'La modification d\'un message chiffré n\'est pas encore prise en charge',
        code: 'E2EE_EDITION_NON_PRISE_EN_CHARGE',
      });
    }

    // Modifier un sticker n'a pas de sens : son `content` est un JSON que le
    // serveur a canonisé à l'envoi, et son `mediaUrl` est recalculée depuis la
    // base. Une édition remplacerait tout par du texte arbitraire affiché en
    // JSON brut chez les destinataires — exactement ce que « ne jamais
    // exposer le content d'un sticker » interdit. Le retrait (DELETE) n'est
    // pas concerné : seul le remplacement du texte est refusé.
    if (estSticker(existing[0].type)) {
      return res.status(409).json({
        error: 'La modification d\'un sticker n\'est pas prise en charge',
        code: 'STICKER_EDIT_FORBIDDEN',
      });
    }

    const sentAt = new Date(existing[0].sendAt);
    const ageMinutes = (Date.now() - sentAt.getTime()) / 60000;
    if (ageMinutes > MESSAGE_EDIT_WINDOW_MINUTES) {
      return res.status(403).json({
        error: `La modification n'est possible que dans les ${MESSAGE_EDIT_WINDOW_MINUTES} minutes suivant l'envoi`, code: 'EDIT_WINDOW_EXPIRED',
      });
    }

    await pool.execute(
      'UPDATE message SET content = ?, isEdited = 1, editedAt = NOW() WHERE msgID = ?',
      [content, id]
    );

    const [rows] = await pool.execute(
      `SELECT m.*, ${MEDIA_THUMB_SELECT}
       FROM message m
       LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
       WHERE m.msgID = ?`,
      [id],
    );
    const updated = rows[0];

    const io = req.app.get('io');
    if (io && updated) {
      io.to(`conversation_${updated.conversationID}`).emit('message:updated', updated);
    }

    res.json(updated);
  } catch (error) {
    throw error;
  }
};

/**
 * Suppression POUR TOUS, unitaire ou par lot : une seule règle (voir
 * `utils/messageDeletion` : fenêtre de 72 h, expéditeur ou administrateur de
 * groupe), une seule transaction, tout ou rien — un seul refus annule le lot.
 *
 * Le compteur `message_count` ne baisse que des messages RÉELLEMENT supprimés
 * par cet appel : redemander la suppression d'un message déjà supprimé n'enlève
 * plus rien (le chemin par lot décrémentait avant pour chaque ligne trouvée).
 *
 * @returns {Promise<Array<{msgID:number, conversationID:number, parAdmin:boolean}>>}
 * @throws {SuppressionRefusee} 404 MESSAGE_NOT_FOUND, 403 FORBIDDEN, 403 DELETE_WINDOW_EXPIRED
 */
const supprimerPourTous = async (acteurID, ids, { maintenant = Date.now() } = {}) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const marques = ids.map(() => '?').join(',');
    const [lignes] = await conn.execute(
      `SELECT msgID, senderID, conversationID, sendAt, type, isDeleted
         FROM message WHERE msgID IN (${marques}) FOR UPDATE`,
      ids,
    );
    const parId = new Map(lignes.map((l) => [Number(l.msgID), l]));
    if (parId.size !== ids.length) {
      throw new SuppressionRefusee(404, 'MESSAGE_NOT_FOUND', 'Un ou plusieurs messages introuvables');
    }
    const contextes = await chargerContextesSuppression(conn, acteurID, lignes);

    const resultats = [];
    for (const id of ids) {
      const l = parId.get(id);
      const d = deciderSuppression({
        acteurID, message: l, contexte: contexteSuppression(contextes, l), maintenant,
      });
      if (!d.ok) throw new SuppressionRefusee(d.status, d.code, d.message);
      resultats.push({
        msgID: id, conversationID: Number(l.conversationID), parAdmin: d.parAdmin, dejaSupprime: d.dejaSupprime,
      });
    }

    const aSupprimer = resultats.filter((r) => !r.dejaSupprime);
    if (aSupprimer.length > 0) {
      await conn.execute(
        `UPDATE message SET isDeleted = 1, deletedForID = NULL
          WHERE msgID IN (${aSupprimer.map(() => '?').join(',')}) AND isDeleted = 0`,
        aSupprimer.map((r) => r.msgID),
      );
      await enregistrerSuppressions(conn, acteurID, aSupprimer);
      const parConversation = new Map();
      for (const r of aSupprimer) {
        parConversation.set(r.conversationID, (parConversation.get(r.conversationID) || 0) + 1);
      }
      for (const [conversationID, n] of parConversation) {
        await conn.execute(
          'UPDATE conversation SET message_count = GREATEST(0, message_count - ?) WHERE conversID = ?',
          [n, conversationID],
        );
      }
    }
    await conn.commit();
    return resultats;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

/** Traduit un refus de suppression en réponse HTTP ; toute autre erreur remonte. */
const repondreSuppression = (res, error) => {
  if (error instanceof SuppressionRefusee) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  throw error;
};

const deleteMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { all } = req.query;
    const senderID = req.user.alanyaID;

    // Pour TOUS : expéditeur dans les 72 h, ou administrateur de groupe (même règle
    // que le lot). « Pour moi » reste ci-dessous, inchangé.
    if (all === 'true') {
      const msgID = parseInt(id, 10);
      if (!(msgID > 0)) {
        return res.status(404).json({ error: 'Message introuvable ou non autorisé', code: 'MESSAGE_NOT_FOUND' });
      }
      let resultats;
      try {
        resultats = await supprimerPourTous(senderID, [msgID]);
      } catch (e) {
        return repondreSuppression(res, e);
      }
      const r = resultats[0];
      const io = req.app.get('io');
      if (io) {
        io.to(`conversation_${r.conversationID}`).emit('message:deleted', {
          msgID,
          conversationID: r.conversationID,
          all: true,
          deletedForID: null,
          deletedBy: senderID,
          byAdmin: r.parAdmin,
        });
      }
      return res.json({ message: 'Message supprimé', all: true });
    }

    const [existing] = await pool.execute(
      'SELECT * FROM message WHERE msgID = ? AND senderID = ?',
      [id, senderID]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable ou non autorisé', code: 'MESSAGE_NOT_FOUND' });
    }

    await pool.execute(
      'UPDATE message SET deletedForID = ? WHERE msgID = ?',
      [senderID, id]
    );

    const io = req.app.get('io');
    if (io && existing[0]) {
      io.to(`conversation_${existing[0].conversationID}`).emit('message:deleted', {
        msgID: parseInt(id),
        conversationID: existing[0].conversationID,
        all: false,
        deletedForID: senderID,
      });
    }

    res.json({ message: 'Message supprimé', all: false });
  } catch (error) {
    throw error;
  }
};

/// Parse la colonne JSON `message.reactions` (tableau [{ userID, emoji, reactedAt }]).
const _parseReactionsColumn = (raw) => {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const _upsertUserReaction = (reactions, userID, emoji) => {
  const uid = Number(userID);
  const now = new Date().toISOString();
  const next = reactions.filter((r) => Number(r.userID) !== uid);
  next.push({ userID: uid, emoji, reactedAt: now });
  return next;
};

const _removeUserReaction = (reactions, userID) => {
  const uid = Number(userID);
  return reactions.filter((r) => Number(r.userID) !== uid);
};

const _serializeReactionsColumn = (reactions) =>
  reactions.length > 0 ? JSON.stringify(reactions) : null;

/// Vérifie que [msgID] existe (non supprimé) et que [alanyaID] participe à la
/// conversation. Retourne conversationID ou null + code HTTP d'erreur.
const _messageReactionContext = async (msgID, alanyaID) => {
  const [existing] = await pool.execute(
    'SELECT conversationID FROM message WHERE msgID = ? AND isDeleted = 0',
    [msgID],
  );
  if (existing.length === 0) {
    return { error: { status: 404, body: { error: 'Message introuvable' } } };
  }
  const conversationID = existing[0].conversationID;

  const [member] = await pool.execute(
    'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
    [conversationID, alanyaID],
  );
  if (member.length === 0) {
    return { error: { status: 403, body: { error: 'Non autorisé' } } };
  }

  return { conversationID };
};

const _emitMessageReaction = (req, payload) => {
  const io = req.app.get('io');
  if (io) {
    io.to(`conversation_${payload.conversationID}`).emit('message:reaction', payload);
  }
};

/// Pose/remplace ma réaction sur un message. Diffuse `message:reaction`.
const setReaction = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const emoji = (req.body.emoji ?? '').toString().trim();
    if (!emoji) {
      return res.status(400).json({ error: 'emoji requis', code: 'EMOJI_REQUIRED' });
    }

    const ctx = await _messageReactionContext(id, alanyaID);
    if (ctx.error) {
      return res.status(ctx.error.status).json(ctx.error.body);
    }
    const { conversationID } = ctx;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT reactions FROM message WHERE msgID = ? AND isDeleted = 0 FOR UPDATE',
        [id],
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Message introuvable', code: 'MESSAGE_NOT_FOUND' });
      }
      const reactions = _upsertUserReaction(_parseReactionsColumn(rows[0].reactions), alanyaID, emoji);
      await conn.execute(
        'UPDATE message SET reactions = ? WHERE msgID = ?',
        [_serializeReactionsColumn(reactions), id],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    const payload = {
      msgID: parseInt(id, 10),
      conversationID,
      userID: alanyaID,
      emoji,
    };

    _emitMessageReaction(req, payload);
    res.json(payload);
  } catch (error) {
    throw error;
  }
};

/// Retire ma réaction sur un message. Diffuse `message:reaction` sans emoji.
const removeReaction = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const ctx = await _messageReactionContext(id, alanyaID);
    if (ctx.error) {
      return res.status(ctx.error.status).json(ctx.error.body);
    }
    const { conversationID } = ctx;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.execute(
        'SELECT reactions FROM message WHERE msgID = ? AND isDeleted = 0 FOR UPDATE',
        [id],
      );
      if (rows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Message introuvable', code: 'MESSAGE_NOT_FOUND' });
      }
      const reactions = _removeUserReaction(_parseReactionsColumn(rows[0].reactions), alanyaID);
      await conn.execute(
        'UPDATE message SET reactions = ? WHERE msgID = ?',
        [_serializeReactionsColumn(reactions), id],
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    const payload = {
      msgID: parseInt(id, 10),
      conversationID,
      userID: alanyaID,
    };

    _emitMessageReaction(req, payload);
    res.json(payload);
  } catch (error) {
    throw error;
  }
};

/// Hydratation initiale : toutes les réactions d'une conversation.
const getConversationReactions = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [id, alanyaID],
    );
    if (member.length === 0) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    // `has_reactions` (migration 059) est une colonne générée STORED et
    // indexée : remplace le filtre JSON_LENGTH(reactions) > 0, non sargable,
    // qui forçait un scan complet de l'historique à chaque ouverture d'écran
    // (audit scalabilité 06/08/2026 §5.1). LIMIT en dur comme plafond de
    // sécurité — cet endpoint reste, par conception, une hydratation
    // complète (pas de curseur, voir §3 du plan d'implémentation).
    const [rows] = await pool.execute(
      `SELECT msgID, reactions
       FROM message
       WHERE conversationID = ?
         AND isDeleted = 0
         AND has_reactions = 1
       LIMIT 5000`,
      [id],
    );

    const out = [];
    for (const row of rows) {
      for (const reaction of _parseReactionsColumn(row.reactions)) {
        const userID = Number(reaction.userID);
        const emoji = (reaction.emoji ?? '').toString();
        if (!userID || !emoji) continue;
        out.push({
          msgID: row.msgID,
          userID,
          emoji,
          reactedAt: reaction.reactedAt ?? null,
        });
      }
    }

    out.sort((a, b) => {
      const ta = a.reactedAt ? new Date(a.reactedAt).getTime() : 0;
      const tb = b.reactedAt ? new Date(b.reactedAt).getTime() : 0;
      return ta - tb;
    });

    res.json(out);
  } catch (error) {
    throw error;
  }
};

const pinMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const pinned =
      req.body.isPinned === 1 ||
      req.body.isPinned === true ||
      req.body.isPinned === '1';

    const [existing] = await pool.execute(
      'SELECT conversationID FROM message WHERE msgID = ? AND isDeleted = 0',
      [id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Message introuvable', code: 'MESSAGE_NOT_FOUND' });
    }
    const conversationID = existing[0].conversationID;

    // L'utilisateur doit être participant de la conversation pour (dés)épingler.
    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversationID, alanyaID]
    );
    if (member.length === 0) {
      return res.status(403).json({ error: 'Non autorisé', code: 'FORBIDDEN' });
    }

    if (pinned) {
      await pool.execute(
        'UPDATE message SET isPinned = 1, pinnedAt = NOW(), pinnedBy = ? WHERE msgID = ?',
        [alanyaID, id]
      );
    } else {
      await pool.execute(
        'UPDATE message SET isPinned = 0, pinnedAt = NULL, pinnedBy = NULL WHERE msgID = ?',
        [id]
      );
    }

    const payload = {
      msgID: parseInt(id),
      conversationID,
      isPinned: pinned ? 1 : 0,
      pinnedBy: pinned ? alanyaID : null,
    };

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationID}`).emit('message:pinned', payload);
    }

    res.json(payload);
  } catch (error) {
    throw error;
  }
};

const markMessageViewed = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    const [rows] = await pool.execute(
      'SELECT * FROM message WHERE msgID = ? AND isViewOnce = 1 AND isDeleted = 0',
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Média à vue unique introuvable', code: 'MEDIA_NOT_FOUND' });
    }
    const msg = rows[0];
    const conversationID = msg.conversationID;

    // L'expéditeur ne « consomme » pas sa propre vue unique.
    if (msg.senderID === alanyaID) {
      return res.json({ msgID: parseInt(id), viewed: false, self: true });
    }

    // L'utilisateur doit être participant.
    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversationID, alanyaID]
    );
    if (member.length === 0) {
      return res.status(403).json({ error: 'Non autorisé', code: 'FORBIDDEN' });
    }

    // Vue unique en 1-1 : un seul destinataire ⇒ dès qu'il a vu, on marque
    // consommé et on supprime physiquement le fichier.
    await pool.execute('UPDATE message SET viewedAt = NOW(), mediaUrl = NULL WHERE msgID = ?', [id]);
    deleteMediaFile(msg.mediaUrl);

    const io = req.app.get('io');
    if (io) {
      io.to(`conversation_${conversationID}`).emit('message:viewed', {
        msgID: parseInt(id),
        conversationID,
        viewerID: alanyaID,
      });
    }

    res.json({ msgID: parseInt(id), viewed: true });
  } catch (error) {
    throw error;
  }
};

const batchDeleteMessages = async (req, res) => {
  const conn = await pool.getConnection();
  // `supprimerPourTous` prend sa propre connexion : on rend la nôtre tout de
  // suite sur ce chemin, au lieu de tenir deux connexions par requête.
  let rendue = false;
  const rendre = () => { if (!rendue) { rendue = true; conn.release(); } };
  try {
    const { msgIDs, all } = req.body;
    const senderID = req.user.alanyaID;
    const forAll = all === true || all === 1 || all === '1' || all === 'true';

    if (!Array.isArray(msgIDs) || msgIDs.length === 0) {
      return res.status(400).json({ error: 'msgIDs requis (tableau non vide)', code: 'MSG_IDS_REQUIRED' });
    }
    if (msgIDs.length > MAX_BATCH_DELETE) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_DELETE} messages par requête`, code: 'LIMIT_REACHED' });
    }

    const ids = [...new Set(msgIDs.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    if (ids.length !== msgIDs.length) {
      return res.status(400).json({ error: 'msgIDs invalides ou dupliqués', code: 'INVALID_MSG_IDS' });
    }

    // Pour TOUS : la même règle que le chemin unitaire (72 h, expéditeur ou
    // administrateur de groupe), dans `supprimerPourTous`.
    if (forAll) {
      rendre();
      let resultats;
      try {
        resultats = await supprimerPourTous(senderID, ids);
      } catch (e) {
        return repondreSuppression(res, e);
      }
      const parConversation = new Map();
      for (const r of resultats) {
        if (!parConversation.has(r.conversationID)) parConversation.set(r.conversationID, []);
        parConversation.get(r.conversationID).push(r);
      }
      const io = req.app.get('io');
      if (io) {
        for (const [conversationID, rs] of parConversation) {
          io.to(`conversation_${conversationID}`).emit('messages:deleted', {
            conversationID,
            msgIDs: rs.map((r) => r.msgID),
            all: true,
            deletedForID: null,
            deletedBy: senderID,
            byAdminMsgIDs: rs.filter((r) => r.parAdmin).map((r) => r.msgID),
          });
        }
      }
      return res.json({ deleted: ids.length, all: true });
    }

    await conn.beginTransaction();

    const placeholders = ids.map(() => '?').join(',');
    const [existing] = await conn.execute(
      `SELECT msgID, conversationID, senderID FROM message WHERE msgID IN (${placeholders})`,
      ids
    );

    if (existing.length !== ids.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Un ou plusieurs messages introuvables', code: 'MESSAGE_NOT_FOUND' });
    }

    const unauthorized = existing.some((row) => row.senderID !== senderID);
    if (unauthorized) {
      await conn.rollback();
      return res.status(403).json({ error: 'Non autorisé pour un ou plusieurs messages', code: 'FORBIDDEN' });
    }

    await conn.execute(
      `UPDATE message SET deletedForID = ? WHERE msgID IN (${placeholders})`,
      [senderID, ...ids]
    );

    await conn.commit();

    const byConversation = new Map();
    for (const row of existing) {
      const convId = row.conversationID;
      if (!byConversation.has(convId)) byConversation.set(convId, []);
      byConversation.get(convId).push(row.msgID);
    }

    const io = req.app.get('io');
    if (io) {
      for (const [conversationID, convMsgIDs] of byConversation) {
        io.to(`conversation_${conversationID}`).emit('messages:deleted', {
          conversationID,
          msgIDs: convMsgIDs,
          all: forAll,
          deletedForID: forAll ? null : senderID,
        });
      }
    }

    res.json({ deleted: ids.length, all: forAll });
  } catch (error) {
    if (!rendue) await conn.rollback();
    throw error;
  } finally {
    rendre();
  }
};

const batchForwardMessages = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { sourceMsgIDs, targetConversationIDs, caption } = req.body;
    const senderID = req.user.alanyaID;

    if (!Array.isArray(sourceMsgIDs) || sourceMsgIDs.length === 0) {
      return res.status(400).json({ error: 'sourceMsgIDs requis (tableau non vide)', code: 'SOURCE_MSG_IDS_REQUIRED' });
    }
    if (!Array.isArray(targetConversationIDs) || targetConversationIDs.length === 0) {
      return res.status(400).json({ error: 'targetConversationIDs requis (tableau non vide)', code: 'TARGET_CONVERSATION_IDS_REQUIRED' });
    }
    if (sourceMsgIDs.length > MAX_BATCH_FORWARD_SOURCES) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_FORWARD_SOURCES} messages source`, code: 'LIMIT_REACHED' });
    }
    if (targetConversationIDs.length > MAX_BATCH_FORWARD_TARGETS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_FORWARD_TARGETS} conversations cibles`, code: 'LIMIT_REACHED' });
    }

    const sourceIds = [...new Set(sourceMsgIDs.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    const targetIds = [...new Set(targetConversationIDs.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
    if (sourceIds.length !== sourceMsgIDs.length || targetIds.length !== targetConversationIDs.length) {
      return res.status(400).json({ error: 'IDs invalides ou dupliqués', code: 'INVALID_IDS' });
    }

    const sourcePlaceholders = sourceIds.map(() => '?').join(',');
    const [sources] = await pool.execute(
      `SELECT * FROM message WHERE msgID IN (${sourcePlaceholders}) ORDER BY FIELD(msgID, ${sourcePlaceholders})`,
      [...sourceIds, ...sourceIds]
    );

    if (sources.length !== sourceIds.length) {
      return res.status(404).json({ error: 'Un ou plusieurs messages source introuvables', code: 'MESSAGE_NOT_FOUND' });
    }

    const sourceConversationID = sources[0].conversationID;
    if (!sources.every((m) => m.conversationID === sourceConversationID)) {
      return res.status(400).json({ error: 'Tous les messages source doivent être dans la même conversation', code: 'INVALID_CONVERSATION' });
    }

    const [sourceMember] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [sourceConversationID, senderID]
    );
    if (sourceMember.length === 0) {
      return res.status(403).json({ error: 'Non autorisé à lire les messages source', code: 'FORBIDDEN' });
    }

    for (const m of sources) {
      if (m.isDeleted) {
        return res.status(400).json({ error: 'Message supprimé non transférable', code: 'INVALID_MESSAGE' });
      }
      if (m.isViewOnce) {
        return res.status(400).json({ error: 'Média à vue unique non transférable', code: 'INVALID_MEDIA' });
      }
      // Un sticker n'a pas besoin d'URL source : `mediaUrl` est recalculée.
      if (m.type !== 0 && m.type !== 5 && !estSticker(m.type) && !m.mediaUrl) {
        return res.status(400).json({ error: 'Média sans URL serveur non transférable via batch', code: 'INVALID_MEDIA' });
      }
    }

    for (const targetId of targetIds) {
      const [member] = await pool.execute(
        'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
        [targetId, senderID]
      );
      if (member.length === 0) {
        return res.status(403).json({ error: `Non autorisé pour la conversation ${targetId}`, code: 'CONVERSATION_FORBIDDEN' });
      }
    }

    await conn.beginTransaction();

    const pendingDelivery = [];
    const createdMessages = [];
    const trimmedCaption = typeof caption === 'string' ? caption.trim() : '';

    for (const targetId of targetIds) {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        // Un sticker se transfère seul, sans légende : son `content` est le
        // JSON canonique, que `_persistMessage` relit et réécrit.
        const { content, copie } = champsDeTransfert(source, i, trimmedCaption);

        // Le média transféré reçoit une adresse à LUI, par copie côté
        // Backblaze (CopyObject, aucun octet ne passe par le serveur). Sans ça,
        // deux messages partagent un seul fichier : la purge le supprime au
        // terme de la rétention du message d'origine, et le transfert —
        // parfois vieux de quelques heures — pointe dans le vide avec sa
        // `mediaUrl` intacte, ce qui affiche un média cassé chez le
        // destinataire. Chaque message garantit ainsi la rétention à son
        // propre média.
        //
        // En cas d'échec (fichier source déjà disparu, stockage injoignable),
        // on retombe sur l'URL d'origine : mieux vaut qu'un transfert refusé.
        // Un sticker se transfère PAR RÉFÉRENCE : l'asset est réutilisé, aucun
        // fichier n'est copié (contrat §5). Sa durée de vie n'est pas celle d'un
        // média de discussion.
        const cheminRelie = !copie
          ? null
          : await copyForForward(source.mediaUrl, { alanyaID: senderID });
        const mediaUrlTransfere = cheminRelie
          ? `${MEDIA_BASE_URL}/uploads/${cheminRelie}`
          : source.mediaUrl;

        const { msg, silentDrop, deliveryFields } = await _persistAndDeliverMessage(
          req,
          targetId,
          senderID,
          {
            content,
            type: source.type,
            mediaUrl: mediaUrlTransfere,
            mediaName: source.mediaName,
            mediaDuration: source.mediaDuration,
            mediaSize: source.mediaSize,
            mediaPageCount: source.mediaPageCount,
            isForwarded: 1,
          },
          { conn, skipDelivery: true }
        );

        createdMessages.push(msg);
        if (!silentDrop) {
          pendingDelivery.push({
            conversationID: targetId,
            msg,
            deliveryFields,
            silentDrop,
          });
        }
      }
    }

    await conn.commit();

    for (const item of pendingDelivery) {
      await _deliverMessage(
        req,
        item.conversationID,
        senderID,
        item.msg,
        item.deliveryFields,
        item.silentDrop
      );
    }

    res.json({ forwarded: createdMessages.length, messages: createdMessages });
  } catch (error) {
    await conn.rollback();
    if (error.status) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
        ...(error.feature ? { feature: error.feature } : {}),
      });
    }
    throw error;
  } finally {
    conn.release();
  }
};

/**
 * Sync delta globale multi-conversations basée sur un curseur PAR conversation.
 *
 * Le client envoie `cursors: [{c: conversID, m: dernierMsgIDLocal}, ...]` pour
 * les conversations qu'il connaît déjà (m > 0). Le serveur renvoie tous les
 * messages `msgID > curseur` de CES conversations, triés par msgID ASC et
 * plafonnés (`limit`). Le client réitère (en reconstruisant les curseurs depuis
 * son local) tant que `hasMore` est vrai → rattrapage garanti et sans trou,
 * indépendamment de la fiabilité du WebSocket.
 *
 * Curseur PAR conversation (et non global) : sinon, être à jour dans une conv
 * (msgID élevé) masquerait d'anciens messages manquants d'une autre conv.
 */
/**
 * POST /messages/deletions — rattrapage des suppressions POUR TOUS manquées hors
 * ligne. Corps : `{ after?: number, limit?: number }` ; sans `after`, renvoie
 * seulement la position courante (`cursor`) à mémoriser. Réponse :
 * `{ deletions: [{msgID, conversationID, deletedBy}], cursor, hasMore }`.
 */
const getDeletionsSince = async (req, res) => {
  const out = await lireSuppressions(pool, req.user.alanyaID, {
    apres: req.body?.after,
    limite: req.body?.limit,
  });
  res.json(out);
};

const getMessagesSince = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const rawCursors = Array.isArray(req.body?.cursors) ? req.body.cursors : [];
    const limit = Math.min(parseInt(req.body?.limit, 10) || 300, 500);

    // Normalise + déduplique (garde le plus petit curseur si doublon, pour ne
    // rien rater), en ne conservant que des entrées valides.
    const cursorByConv = new Map();
    for (const entry of rawCursors) {
      const c = parseInt(entry?.c, 10);
      const m = parseInt(entry?.m, 10);
      if (!Number.isInteger(c) || c <= 0) continue;
      const cur = Number.isInteger(m) && m > 0 ? m : 0;
      if (!cursorByConv.has(c) || cur < cursorByConv.get(c)) {
        cursorByConv.set(c, cur);
      }
    }

    if (cursorByConv.size === 0) {
      return res.json({ messages: [], hasMore: false });
    }

    // Plafond défensif : la clause OR ci-dessous a une branche par curseur, donc
    // par conversation. Sans borne, un client avec beaucoup de conversations
    // construirait une requête de taille arbitraire à chaque sync (audit
    // scalabilité 06/08/2026 §3.3). 100 est très généreux au regard du volume
    // actuel par utilisateur ; ce log signale s'il faut un jour faire itérer
    // le client sur plusieurs appels plutôt que tout envoyer d'un coup.
    const MAX_SYNC_CURSORS = 100;
    let cursorEntries = [...cursorByConv.entries()];
    if (cursorEntries.length > MAX_SYNC_CURSORS) {
      console.warn(
        `[getMessagesSince] ${cursorEntries.length} curseurs reçus, plafonné à ${MAX_SYNC_CURSORS} (alanyaID=${alanyaID})`,
      );
      cursorEntries = cursorEntries.slice(0, MAX_SYNC_CURSORS);
    }

    // Clauses OR (conversationID = ? AND msgID > ?) — bornées par participation.
    const orClauses = [];
    const orParams = [];
    for (const [c, m] of cursorEntries) {
      orClauses.push('(m.conversationID = ? AND m.msgID > ?)');
      orParams.push(c, m);
    }

    const query = `
      SELECT m.*,
             u.nom        AS sender_nom,
             u.pseudo     AS sender_pseudo,
             u.avatar_url AS sender_avatar,
             p.timeZone   AS messageTz,
             p.decalageHoraire AS messageTzOffset,
             (m.viewedAt IS NOT NULL) AS viewedByMe,
             c.isGroup AS _isGroup,
             cp.lastReadMsgID AS _lastReadMsgID,
             ${MEDIA_THUMB_SELECT}
      FROM message m
      JOIN conv_participants cp ON cp.conversID = m.conversationID AND cp.alanyaID = ?
      JOIN conversation c ON c.conversID = m.conversationID
      JOIN users u ON m.senderID = u.alanyaID
      LEFT JOIN pays p ON u.idPays = p.idPays
      LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
      WHERE m.isDeleted = 0
        AND (m.deletedForID IS NULL OR m.deletedForID != ?)
        AND ${HISTORY_CUTOFF_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM blocked b
          WHERE b.alanyaID = ?
            AND b.idCallerBlock = m.senderID
            AND m.senderID != ?
            AND m.sendAt >= b.dateBlock
        )
        AND (${orClauses.join(' OR ')})
      ORDER BY m.msgID ASC
      LIMIT ?
    `;
    const params = [alanyaID, alanyaID, alanyaID, alanyaID, ...orParams, limit + 1];
    const [rows] = await pool.query(query, params);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    // Groupe : statut vu par CE lecteur (voir getMessages, bug A6).
    appliquerStatutLecteur(page, alanyaID);

    for (const r of page) {
      if (r.isViewOnce && r.viewedByMe > 0 && r.senderID !== alanyaID) {
        r.mediaUrl = null;
      }
      if (r.clientID != null && r.clientId == null) {
        r.clientId = r.clientID;
      }
    }

    await attacheChiffre(pool, page, req.user.appareilId);

    res.json({ messages: page, hasMore });
  } catch (error) {
    throw error;
  }
};

/** Statut d'un message envoyé par clientId (rattrapage outbox HTTP). */
// `next(error)` : même raison que `sendMessage`. C'est la requête que le client
// utilise pour savoir si une réponse rapide était déjà passée avant de la
// rejouer — elle ne doit surtout pas pouvoir tuer le process.
const getMessageStatusByClientId = async (req, res, next) => {
  try {
    const clientId =
      typeof req.query.clientId === 'string' ? req.query.clientId.trim() : '';
    if (!clientId) {
      return res.status(400).json({ error: 'clientId required', code: 'CLIENT_ID_REQUIRED' });
    }

    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT msgID, status, conversationID, sendAt, clientID
       FROM message
       WHERE clientID = ? AND senderID = ? AND isDeleted = 0
       LIMIT 1`,
      [clientId, alanyaID],
    );

    if (rows.length === 0) {
      return res.json({ found: false });
    }

    const row = rows[0];
    res.json({
      found: true,
      msgID: row.msgID,
      status: row.status,
      conversationID: row.conversationID,
      sendAt: row.sendAt,
      clientId: row.clientID,
    });
  } catch (error) {
    next(error);
  }
};

/** Messages sortants encore au statut « envoyé » (status=1) pour réconciliation outbox. */
const getPendingOutgoingMessages = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT msgID, clientID, conversationID, content, type, sendAt, status
       FROM message
       WHERE senderID = ? AND status = 1 AND isDeleted = 0
       ORDER BY sendAt DESC
       LIMIT 50`,
      [alanyaID],
    );

    const messages = rows.map((row) => ({
      ...row,
      clientId: row.clientID,
    }));
    res.json({ messages });
  } catch (error) {
    throw error;
  }
};

/**
 * Accusé de REMISE émis par la couche push (app fermée : le terminal a reçu la
 * notification mais n'a pas de socket). Équivalent HTTP de `message:delivered`,
 * idempotent, sans effet si les messages sont déjà remis ou déjà lus.
 */
// `next(error)` : appelé à CHAQUE push reçue par la couche native. Une base sans
// la migration 023 renvoie ER_BAD_FIELD_ERROR sur `deliveredAt` — avec `throw`,
// c'était un crash du process à chaque notification, en boucle.
const markMessagesDelivered = async (req, res, next) => {
  try {
    const alanyaID = req.user.alanyaID;
    const conversationID = Number(
      req.body?.conversationId ?? req.body?.conversationID,
    );
    if (!conversationID) {
      return res.status(400).json({ error: 'conversationId required', code: 'CONVERSATION_ID_REQUIRED' });
    }

    const [membership] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [conversationID, alanyaID],
    );
    if (membership.length === 0) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }

    const result = await markConversationDeliveredBy({
      conversationID,
      recipientID: alanyaID,
      io: req.app.get('io'),
    });

    res.json({ ok: true, changed: result.changed });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMessages,
  getMessagesSince,
  getDeletionsSince,
  sendMessage,
  updateMessage,
  deleteMessage,
  batchDeleteMessages,
  batchForwardMessages,
  pinMessage,
  markMessageViewed,
  setReaction,
  removeReaction,
  getConversationReactions,
  getMessageStatusByClientId,
  getPendingOutgoingMessages,
  markMessagesDelivered,
};
