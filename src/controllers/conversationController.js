const pool = require('../config/db');
const { materializeForUser } = require('../services/broadcastService');
const { markConversationReadBy } = require('../utils/readReceiptUtils');
const { getBlockPair, maskPresenceIfBlocked } = require('../utils/blockUtils');
const { attachParticipantsBatch } = require('../utils/conversationParticipantsBatch');
const { postSystemMessage, loadUserNames } = require('../utils/systemMessage');
const { ensureGroupOwner } = require('../utils/groupOwnership');
const {
  invalidateConversationParticipants,
} = require('../utils/conversationParticipantsCache');
const {
  SELF_CHAT_MARKER,
  buildDirectConversationLookup,
  isSelfChatRow,
  dedupeDirectConversations,
} = require('../utils/directConversation');
const { masquerDernierMessageEfface } = require('../utils/messageHistoryFilter');
const { evaluateJoinAckMessage } = require('../utils/groupJoinAck');
const { canAddUser } = require('../services/privacyPrefsService');
const { releasePublicFiles, groupPhotosOf } = require('../utils/mediaFile');
const MAX_BATCH_CONVERSATIONS = 50;

/** Champs par-utilisateur jointés sur cp — inclut consentement / historique (028). */
const CP_VIEWER_FIELDS = `cp.unreadCount, cp.isPinned, cp.isArchived,
              cp.role AS myRole, cp.mutedUntil, cp.muteForever, cp.mentionsOnly,
              cp.pendingJoinMsgID AS myPendingJoinMsgID,
              cp.historyCutoffAt AS myHistoryCutoffAt`;

const asFlag = (v) => (v === 1 || v === true || v === '1' ? 1 : 0);

// Nettoyer les URL d'avatar pour éviter les valeurs indésirables et les problèmes de sécurité
const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

// Attacher les participants (avec user info) à une conversation
async function attachParticipants(conversationRow, viewerId = null) {
  if (!conversationRow) return conversationRow;
  const [parts] = await pool.execute(
    `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url,
            u.alanyaPhone, up.is_online AS is_online, up.last_seen AS last_seen,
            u.account_type, u.verification_status, u.verified_until,
            cp.role, cp.joinedAt
     FROM conv_participants cp
     JOIN users u ON cp.alanyaID = u.alanyaID
     LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
     WHERE cp.conversID = ?`,
    [conversationRow.conversID]
  );

  const participants = [];
  for (const p of parts) {
    const masked = await maskPresenceIfBlocked(
      viewerId, p.alanyaID, p.is_online, p.last_seen,
    );
    participants.push({
      alanyaID:    p.alanyaID,
      nom:         p.nom,
      pseudo:      p.pseudo,
      avatar_url:  sanitizeUrl(p.avatar_url),
      alanyaPhone: p.alanyaPhone,
      is_online:   masked.is_online,
      last_seen:   masked.last_seen,
      role:        Number(p.role) || 0,
      joinedAt:    p.joinedAt,
      // Le socle était lu par la requête mais jamais renvoyé : l'en-tête de
      // conversation, rafraîchi par ce chemin, perdait le badge du pair.
      // Mêmes clés que la liste (conversationParticipantsBatch.js).
      account_type:        Number(p.account_type) || 0,
      verification_status: Number(p.verification_status) || 0,
      verified_until:      p.verified_until ?? null,
    });

    // Pas de blockStatus sur une conversation avec soi-même : il n'y a pas de
    // pair à bloquer. La clé reste donc absente du payload.
    if (viewerId != null && !conversationRow.isGroup && !isSelfChatRow(conversationRow)
        && Number(p.alanyaID) !== Number(viewerId)) {
      const pair = await getBlockPair(viewerId, p.alanyaID);
      conversationRow.blockStatus = {
        isBlocked: pair.iBlockedThem,
        blockedByThem: pair.theyBlockedMe,
      };
    }
  }
  conversationRow.participants = participants;

  return conversationRow;
}


// Attacher les participants à plusieurs conversations (≤ 3 requêtes SQL).
async function attachParticipantsMany(rows, viewerId = null) {
  return attachParticipantsBatch(pool, rows, viewerId, sanitizeUrl);
}

/**
 * Diffuse les métadonnées d'une conversation à tous ses membres.
 *
 * La charge OMET délibérément les champs par-utilisateur — `unreadCount`,
 * `isPinned`, `isArchived`, `lastMessage*` — pour deux raisons :
 *
 * - ils diffèrent d'un membre à l'autre, et une émission unique ne peut pas
 *   porter la valeur de chacun ;
 * - le client écrit un companion PARTIEL à la réception. Si la trame les
 *   portait, une trame tardive réécrirait un `unreadCount` périmé et ferait
 *   réapparaître un badge fantôme sur une conversation déjà lue.
 *
 * `updatedAt` accompagne la charge : le client s'en sert comme garde
 * anti-réordonnancement (il ignore une trame plus ancienne que son état local).
 */
async function emitConversationUpdated(io, conversID) {
  if (!io) return;
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM conversation WHERE conversID = ?',
      [conversID],
    );
    if (rows.length === 0) return;

    const enriched = await attachParticipants(rows[0], null);
    const payload = { ...enriched };
    delete payload.unreadCount;
    delete payload.isPinned;
    delete payload.isArchived;
    delete payload.lastMessage;
    delete payload.lastMessageAt;
    delete payload.lastMessageSenderID;
    delete payload.lastMessageType;
    delete payload.lastMessageStatus;

    const [members] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ?',
      [conversID],
    );
    for (const m of members) {
      io.to(`user_${Number(m.alanyaID)}`).emit('conversation:updated', payload);
    }
  } catch (error) {
    console.error('[Conversation] emitConversationUpdated:', error.message);
  }
}

// `scoreDirectConversation` et `dedupeDirectConversations` vivent désormais dans
// utils/directConversation.js, avec la résolution des conversations 1-1.

// Matérialisations de diffusions en vol, par utilisateur : évite d'empiler des
// transactions (FOR UPDATE sur `users`) quand un client rafraîchit en rafale.
const _materializingUsers = new Set();
const _triggerMaterialize = (alanyaID, localeHint) => {
  if (_materializingUsers.has(alanyaID)) return;
  _materializingUsers.add(alanyaID);
  setImmediate(() => {
    materializeForUser(alanyaID, { locale: localeHint })
      .catch((e) => console.error('[broadcast] materializeForUser échoué:', e.message))
      .finally(() => _materializingUsers.delete(alanyaID));
  });
};

// Récupère la liste des conversations de l'utilisateur connecté, avec les infos des participants et les métadonnées de la conversation
const getConversations = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const localeHint = req.query.locale || req.headers['accept-language'];
    // Hors du chemin de la réponse : après une diffusion, des milliers de
    // clients ouvrent l'app en même temps — chacun ouvrait ici une transaction
    // sur un pool partagé avant de recevoir sa liste. Les conversations
    // matérialisées arrivent au rafraîchissement suivant / via socket.
    _triggerMaterialize(alanyaID, localeHint);
    // LIMIT en dur (pas un curseur) : le client traite cette réponse comme la
    // liste complète et fait autorité (deleteConversationsNotIn supprime en
    // local tout ce qui n'y figure pas) — une vraie pagination casserait ce
    // merge. Ce plafond ne protège que contre une requête non bornée (audit
    // scalabilité 06/08/2026 §3.3) ; 500 est très généreux au regard du volume
    // actuel (113 conversations sur toute la plateforme au 07/08/2026).
    const [rows] = await pool.execute(
      `SELECT c.*, ${CP_VIEWER_FIELDS},
              COALESCE(c.message_count, 0) AS messageCount
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
       WHERE cp.alanyaID = ?
       ORDER BY cp.isPinned DESC, c.lastMessageAt DESC, c.conversID DESC
       LIMIT 500`,
      [alanyaID]
    );
    const enriched = await attachParticipantsMany(rows.map(masquerDernierMessageEfface), alanyaID);
    res.json(dedupeDirectConversations(enriched, alanyaID));
  } catch (error) {
    throw error;
  }
};

// Récupère une conversation spécifique par son ID, avec les infos des participants et les métadonnées
const getConversationById = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT c.*, ${CP_VIEWER_FIELDS}
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
       WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [id, alanyaID]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found', code: 'CONVERSATION_NOT_FOUND' });
    }
    const enriched = await attachParticipants(masquerDernierMessageEfface(rows[0]), alanyaID);
    res.json(enriched);
  } catch (error) {
    throw error;
  }
};

// Créer une nouvelle conversation privée entre l'utilisateur connecté et un autre participant, ou un groupe si plusieurs participants sont fournis
const createConversation = async (req, res) => {
  let conn = null;
  try {
    const alanyaID = Number(req.user.alanyaID);
    const peerID = parseInt(req.body.participantID, 10);

    if (!Number.isInteger(peerID) || peerID <= 0) {
      return res.status(400).json({ error: 'participantID invalide', code: 'INVALID_PARTICIPANT_ID' });
    }

    // Conversation « avec soi-même » : un seul participant, marquée par
    // GroupName. Voir utils/directConversation.js.
    const isSelf = peerID === alanyaID;

    if (!isSelf) {
      const allowed = await canAddUser(alanyaID, peerID);
      if (!allowed) {
        return res.status(403).json({
          error: 'Cet utilisateur n\'accepte pas d\'être ajouté aux conversations',
          code: 'ADD_ME_POLICY_DENIED',
        });
      }
    }

    const lookup = buildDirectConversationLookup({ meId: alanyaID, peerId: peerID });
    const [existing] = await pool.execute(lookup.sql, lookup.params);

    if (existing.length > 0) {
      const enriched = await attachParticipants(existing[0], alanyaID);
      return res.json(enriched);
    }

    // Transaction : sans elle, l'échec du second INSERT laissait une
    // conversation orpheline (aucun rollback) que la recherche ci-dessus
    // retrouvait ensuite comme si elle était valide.
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [result] = await conn.execute(
      'INSERT INTO conversation (isGroup, GroupName, lastMessageAt) VALUES (0, ?, NOW())',
      [isSelf ? SELF_CHAT_MARKER : null]
    );
    const conversID = result.insertId;

    // `uq_conv_user (conversID, alanyaID)` interdit deux lignes identiques :
    // une conversation avec soi-même n'a donc qu'un seul participant.
    const participantIds = isSelf ? [alanyaID] : [alanyaID, peerID];
    for (const id of participantIds) {
      await conn.execute(
        'INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)',
        [conversID, id]
      );
    }

    await conn.commit();

    const [rows] = await pool.execute(
      `SELECT c.*, ${CP_VIEWER_FIELDS} FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [conversID, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);

    // Notifier l'autre participant en temps réel. Émission vers la room
    // `user_<id>` (rejointe à l'auth) plutôt qu'un socket-id précis : robuste
    // aux reconnexions / multi-onglets où le socket-id mémorisé est périmé.
    // Pour un self-chat, `peerID` vaut ma propre room : les autres appareils du
    // compte reçoivent la conversation sans traitement particulier.
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${peerID}`).emit('conversation:created', enriched);
    }

    res.json(enriched);
  } catch (error) {
    if (conn) await conn.rollback();
    throw error;
  } finally {
    if (conn) conn.release();
  }
};

const createGroup = async (req, res, next) => {
  try {
    const {
      participantIDs,
      groupName,
      groupPhoto,
      description,
      onlyAdminsCanSend,
      onlyAdminsCanEditInfo,
      hideHistoryForNewMembers,
      onlyAdminsCanAddMembers,
    } = req.body;
    const alanyaID = req.user.alanyaID;

    if (!participantIDs || !Array.isArray(participantIDs) || participantIDs.length === 0) {
      return res.status(400).json({ error: 'participantIDs required as array', code: 'PARTICIPANT_IDS_REQUIRED' });
    }

    const cleanDescription =
      typeof description === 'string' && description.trim() !== ''
        ? description.trim().slice(0, 512)
        : null;

    const sendFlag = onlyAdminsCanSend !== undefined ? asFlag(onlyAdminsCanSend) : 0;
    const editFlag = onlyAdminsCanEditInfo !== undefined ? asFlag(onlyAdminsCanEditInfo) : 0;
    // Défaut OFF : les membres initiaux voient tout l'historique (cutoff NULL).
    const historyFlag = hideHistoryForNewMembers !== undefined
      ? asFlag(hideHistoryForNewMembers)
      : 0;
    // Défaut OFF : tout le monde peut ajouter des membres.
    const addMembersFlag = onlyAdminsCanAddMembers !== undefined
      ? asFlag(onlyAdminsCanAddMembers)
      : 0;

    const demandes = [...new Set(participantIDs
      .map((p) => parseInt(p, 10))
      .filter((p) => Number.isInteger(p) && p > 0 && p <= 2147483647
                     && p !== Number(alanyaID)))];
    let membres = [];
    if (demandes.length > 0) {
      const ph = demandes.map(() => '?').join(',');
      const [validRows] = await pool.execute(
        `SELECT alanyaID FROM users WHERE alanyaID IN (${ph}) AND exclus = 0`,
        demandes,
      );
      const valides = new Set(validRows.map((r) => Number(r.alanyaID)));
      membres = demandes.filter((p) => valides.has(p));
    }

    for (const pid of membres) {
      if (!(await canAddUser(alanyaID, pid))) {
        return res.status(403).json({
          error: 'Un ou plusieurs participants n\'acceptent pas d\'être ajoutés aux groupes',
          code: 'ADD_ME_POLICY_DENIED',
        });
      }
    }

    const [result] = await pool.execute(
      `INSERT INTO conversation
         (isGroup, GroupName, groupPhoto, description, createdBy, lastMessageAt,
          onlyAdminsCanSend, onlyAdminsCanEditInfo, hideHistoryForNewMembers,
          onlyAdminsCanAddMembers)
       VALUES (1, ?, ?, ?, ?, NOW(), ?, ?, ?, ?)`,
      [
        groupName || 'Groupe',
        groupPhoto || null,
        cleanDescription,
        alanyaID,
        sendFlag,
        editFlag,
        historyFlag,
        addMembersFlag,
      ]
    );
    const conversID = result.insertId;

    // Le créateur est propriétaire (role = 2). Il reste inséré en premier :
    // le backfill de la 024 s'appuie sur MIN(cp.id) pour retrouver le
    // propriétaire des groupes antérieurs. Pas de pendingJoin / cutoff.
    await pool.execute(
      'INSERT INTO conv_participants (conversID, alanyaID, role) VALUES (?, ?, 2)',
      [conversID, alanyaID]
    );

    for (const pid of membres) {
      // Invités à la création : même règle d'historique que addParticipants.
      // Le créateur reste sans cutoff (INSERT séparé ci-dessus).
      await pool.execute(
        `INSERT INTO conv_participants (conversID, alanyaID, role, historyCutoffAt)
         VALUES (?, ?, 0, ${historyFlag ? 'NOW()' : 'NULL'})`,
        [conversID, pid],
      );
    }

    const [rows] = await pool.execute(
      `SELECT c.*, ${CP_VIEWER_FIELDS} FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [conversID, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);

    // Notifier tous les membres du groupe en temps réel (room `user_<id>`,
    // robuste aux reconnexions vs socket-id mémorisé périmé).
    const io = req.app.get('io');
    if (io) {
      for (const pid of membres) {
        io.to(`user_${pid}`).emit('conversation:created', enriched);
      }
    }

    // Première ligne du fil. Émise après `conversation:created` : les clients
    // doivent connaître la conversation avant d'en recevoir un message.
    await postSystemMessage({
      conversationID: conversID,
      actorID: alanyaID,
      event: 'group_created',
      payload: { value: groupName || 'Groupe' },
      io,
    });

    // Invités à la création : même bannière Rester/Quitter qu'un addParticipants.
    if (membres.length > 0) {
      const targets = await loadUserNames(membres);
      const sysMsg = await postSystemMessage({
        conversationID: conversID,
        actorID: alanyaID,
        event: 'member_added',
        payload: { ids: targets.ids, names: targets.names },
        io,
      });
      await setPendingJoinAndNotify(conversID, membres, sysMsg?.msgID, io);
    }

    res.json(enriched);
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

// PUT /conversations/:id — flags PAR UTILISATEUR uniquement (épinglage,
// archivage), stockés dans conv_participants. Sous `requireParticipant`.
//
// Cette route acceptait aussi GroupName / groupPhoto, et les écrivait SANS
// aucune vérification d'appartenance : n'importe quel compte authentifié
// pouvait renommer ou rephotographier n'importe quel groupe du système. Les
// infos de groupe sont désormais sur PATCH /:id/group, qui porte sa propre
// règle d'autorisation. Aucun client n'envoyait ces champs par ici.
const updateConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isPinned, isArchived, GroupName, groupPhoto } = req.body;
    const alanyaID = req.user.alanyaID;

    if (GroupName !== undefined || groupPhoto !== undefined) {
      return res.status(400).json({
        error: 'Utiliser PATCH /conversations/:id/group pour les infos du groupe',
        code: 'USE_GROUP_ENDPOINT',
      });
    }

    if (typeof isPinned === 'number') {
      await pool.execute('UPDATE conv_participants SET isPinned = ? WHERE conversID = ? AND alanyaID = ?', [isPinned, id, alanyaID]);
    }
    if (typeof isArchived === 'number') {
      await pool.execute('UPDATE conv_participants SET isArchived = ? WHERE conversID = ? AND alanyaID = ?', [isArchived, id, alanyaID]);
    }

    const [rows] = await pool.execute(
      `SELECT c.*, ${CP_VIEWER_FIELDS} FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [id, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);
    res.json(enriched);
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

const deleteConversation = async (req, res, next) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    // Lus AVANT le DELETE : après, le partant n'est plus destinataire et on ne
    // saurait plus s'il s'agissait d'un groupe.
    const [avant] = await pool.execute(
      `SELECT cp.alanyaID, c.isGroup
         FROM conv_participants cp
         JOIN conversation c ON c.conversID = cp.conversID
        WHERE cp.conversID = ?`,
      [id],
    );
    const isGroup = avant.length > 0 && !!avant[0].isGroup;
    const membresAvant = avant.map((r) => Number(r.alanyaID));

    await pool.execute('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [id, alanyaID]);
    invalidateConversationParticipants(Number(id));
    {
      const ioLeave = req.app.get('io');
      if (ioLeave) {
        ioLeave.in(`user_${alanyaID}`).socketsLeave(`conversation_${id}`);
      }
    }

    const [remaining] = await pool.execute('SELECT * FROM conv_participants WHERE conversID = ?', [id]);

    if (remaining.length === 0) {
      const photo = await groupPhotosOf(pool, id);
      await pool.execute('DELETE FROM message WHERE conversationID = ?', [id]);
      await pool.execute('DELETE FROM conversation WHERE conversID = ?', [id]);
      releasePublicFiles(photo);
    } else if (isGroup) {
      const io = req.app.get('io');

      // « Supprimer la conversation » sur un groupe EST un départ : les autres
      // membres doivent le voir, exactement comme via /leave. Sans ça,
      // l'utilisateur disparaissait de la liste des membres sans un mot, et le
      // fil ne gardait aucune trace.
      await postSystemMessage({
        conversationID: Number(id),
        actorID: alanyaID,
        event: 'member_left',
        io,
        notifyExtra: [alanyaID],
      });

      // Cette route retirait l'appelant sans regarder son rôle : un propriétaire
      // qui « supprime » un groupe de sa liste le laissait vivant et SANS
      // propriétaire, donc définitivement ingérable (403 GROUP_OWNER_REQUIRED
      // pour tout le monde). Le garant rétablit la succession.
      await ensureGroupOwner(Number(id), { departingID: alanyaID, io });

      if (io) {
        const payload = {
          conversID: Number(id),
          alanyaID: Number(alanyaID),
          removedBy: Number(alanyaID),
          reason: 'left',
        };
        for (const memberId of membresAvant) {
          io.to(`user_${memberId}`).emit('group:participant:removed', payload);
        }
        await emitConversationUpdated(io, Number(id));
      }
    }

    res.json({ message: 'Conversation deleted' });
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

// Sous `requireParticipant` : `req.membership` garantit que l'appelant est
// membre, et que `:id` est un entier valide.
//
// `next(error)` et non `throw` : Express 4 ne capture pas le rejet d'un handler
// `async`, donc un `throw` ici remonte en unhandled rejection et, sous Node 24,
// tue le process. Ce chemin est celui de l'action « Lu » de la notification,
// app fermée : une erreur SQL transitoire suffirait à faire tomber le serveur.
const markAsRead = async (req, res, next) => {
  try {
    const alanyaID = req.user.alanyaID;

    await markConversationReadBy({
      conversationID: req.membership.conversID,
      readerID: alanyaID,
      io: req.app.get('io'),
    });

    res.json({ message: 'Marked as read' });
  } catch (error) {
    next(error);
  }
};

// POST /conversations/:id/participants — ajoute des participants à un groupe.
// L'appelant doit déjà être membre. Idempotent : ignore les IDs déjà présents.
const addParticipants = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { participantIDs } = req.body;
    const alanyaID = req.user.alanyaID;

    if (!participantIDs || !Array.isArray(participantIDs) || participantIDs.length === 0) {
      return res.status(400).json({ error: 'participantIDs required as array', code: 'PARTICIPANT_IDS_REQUIRED' });
    }

    // Verrou dédié (découplé de onlyAdminsCanEditInfo) : un membre peut
    // inviter sans pouvoir renommer le groupe, et inversement.
    if (req.membership.onlyAdminsCanAddMembers && req.membership.role < 1) {
      return res.status(403).json({
        error: 'Seuls les administrateurs peuvent ajouter des participants',
        code: 'GROUP_ADD_MEMBERS_LOCKED',
      });
    }

    // Vérifier que la conv est bien un groupe et lire le réglage historique.
    const [convRows] = await pool.execute(
      `SELECT c.isGroup, c.hideHistoryForNewMembers FROM conversation c
       JOIN conv_participants cp ON cp.conversID = c.conversID AND cp.alanyaID = ?
       WHERE c.conversID = ?`,
      [alanyaID, id]
    );
    if (convRows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée', code: 'CONVERSATION_NOT_FOUND' });
    }
    if (!convRows[0].isGroup) {
      return res.status(400).json({ error: 'Pas un groupe', code: 'NOT_A_GROUP' });
    }

    // Override optionnel (tests) ; l'app n'expose pas le paramètre — le défaut
    // vient du réglage groupe, défini dans les paramètres de la fiche.
    const hideHistory = req.body.hideHistory !== undefined
      ? asFlag(req.body.hideHistory) === 1
      : !!convRows[0].hideHistoryForNewMembers;

    // IDs déjà présents → on les filtre pour ne pas violer la PK.
    const [existing] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ?',
      [id]
    );
    const existingIds = new Set(existing.map((r) => Number(r.alanyaID)));

    const demandes = participantIDs
      .map((p) => parseInt(p, 10))
      .filter((p) => Number.isInteger(p) && p > 0 && p <= 2147483647
                     && !existingIds.has(p));

    // Filtrer sur les comptes qui EXISTENT réellement. Sans ça, un id inconnu
    // — ou dépassant la borne d'un INT — violait fk_cp_user, et l'erreur
    // remontait jusqu'à tuer le process (Express 4 ne capture pas le rejet
    // d'un handler async). Une requête d'un membre ordinaire suffisait.
    const toAdd = demandes.length === 0 ? [] : await (async () => {
      const ph = demandes.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT alanyaID FROM users WHERE alanyaID IN (${ph}) AND exclus = 0`,
        demandes,
      );
      const valides = new Set(rows.map((r) => Number(r.alanyaID)));
      return demandes.filter((p) => valides.has(p));
    })();

    for (const pid of toAdd) {
      if (!(await canAddUser(alanyaID, pid))) {
        return res.status(403).json({
          error: 'Un ou plusieurs participants n\'acceptent pas d\'être ajoutés aux groupes',
          code: 'ADD_ME_POLICY_DENIED',
        });
      }
    }

    for (const pid of toAdd) {
      // historyCutoffAt = NOW() si masquage actif : getMessages n'expose que
      // sendAt >= cutoff (le member_added de cet ajout reste visible).
      await pool.execute(
        `INSERT INTO conv_participants (conversID, alanyaID, historyCutoffAt)
         VALUES (?, ?, ${hideHistory ? 'NOW()' : 'NULL'})`,
        [id, pid]
      );
    }

    // Conv enrichie pour la réponse + diffusion temps réel à tous les membres
    // (existants + nouveaux). Les clients upsertent et voient la liste des
    // participants mise à jour.
    const [rows] = await pool.execute(
      `SELECT c.*, ${CP_VIEWER_FIELDS}
       FROM conversation c JOIN conv_participants cp ON c.conversID = cp.conversID
       WHERE c.conversID = ? AND cp.alanyaID = ?`,
      [id, alanyaID]
    );
    const enriched = await attachParticipants(rows[0], alanyaID);

    const io = req.app.get('io');
    if (io) {
      const allMemberIds = [...existingIds, ...toAdd];
      for (const pid of allMemberIds) {
        io.to(`user_${parseInt(pid)}`).emit('conversation:created', enriched);
      }
    }

    // Trace dans le fil — seulement si quelqu'un a réellement été ajouté :
    // `addParticipants` est idempotent, et un rejeu ne doit pas empiler des
    // « X a ajouté » vides. Émis APRÈS la réponse socket pour ne pas retarder
    // l'affichage de la conversation chez les nouveaux membres.
    if (toAdd.length > 0) {
      const targets = await loadUserNames(toAdd);
      const sysMsg = await postSystemMessage({
        conversationID: Number(id),
        actorID: alanyaID,
        event: 'member_added',
        payload: { ids: targets.ids, names: targets.names },
        io,
      });

      // Bannière « Rester / Quitter » : pendingJoinMsgID = msg système.
      await setPendingJoinAndNotify(Number(id), toAdd, sysMsg?.msgID, io);
    }

    res.json(enriched);
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

/**
 * Pose pendingJoinMsgID sur les nouveaux membres et diffuse conversation:updated
 * personnalisé (myPendingJoinMsgID, myRole, cutoff…).
 *
 * Émis APRÈS conversation:created qui portait encore la vue de l'acteur.
 */
async function setPendingJoinAndNotify(conversID, memberIds, msgID, io) {
  if (msgID == null || !Array.isArray(memberIds) || memberIds.length === 0) {
    return;
  }
  const ids = memberIds
    .map((p) => parseInt(p, 10))
    .filter((p) => Number.isInteger(p) && p > 0);
  if (ids.length === 0) return;

  const ph = ids.map(() => '?').join(',');
  await pool.execute(
    `UPDATE conv_participants
        SET pendingJoinMsgID = ?
      WHERE conversID = ? AND alanyaID IN (${ph})`,
    [msgID, conversID, ...ids],
  );

  if (!io) return;
  for (const pid of ids) {
    const forNew = await loadEnrichedConversation(conversID, pid);
    if (!forNew) continue;
    const payload = { ...forNew };
    delete payload.unreadCount;
    delete payload.isPinned;
    delete payload.isArchived;
    delete payload.lastMessage;
    delete payload.lastMessageAt;
    delete payload.lastMessageSenderID;
    delete payload.lastMessageType;
    delete payload.lastMessageStatus;
    io.to(`user_${pid}`).emit('conversation:updated', payload);
  }
}

/** Conversation enrichie telle que la renvoie GET /:id (rôle inclus). */
async function loadEnrichedConversation(conversID, alanyaID) {
  const [rows] = await pool.execute(
    `SELECT c.*, ${CP_VIEWER_FIELDS}
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
      WHERE c.conversID = ? AND cp.alanyaID = ?`,
    [conversID, alanyaID],
  );
  if (rows.length === 0) return null;
  return attachParticipants(masquerDernierMessageEfface(rows[0]), alanyaID);
}

// PATCH /conversations/:id/group — nom, photo, description.
//
// Route dédiée plutôt que PUT /:id : cette dernière porte une sémantique PAR
// UTILISATEUR (épinglage, archivage) avec une règle d'autorisation différente.
// Les avoir mélangées est exactement ce qui avait laissé n'importe quel compte
// renommer n'importe quel groupe.
const updateGroupInfo = async (req, res, next) => {
  try {
    const conversID = req.membership.conversID;
    const alanyaID = req.user.alanyaID;
    const { GroupName, groupPhoto, description } = req.body;

    if (req.membership.onlyAdminsCanEditInfo && req.membership.role < 1) {
      return res.status(403).json({
        error: 'Seuls les administrateurs peuvent modifier les infos du groupe',
        code: 'GROUP_INFO_LOCKED',
      });
    }

    const updates = [];
    const values = [];
    const events = [];

    if (GroupName !== undefined) {
      const name = String(GroupName).trim();
      if (name === '' || name.length > 255) {
        return res.status(400).json({ error: 'Nom de groupe invalide (1 à 255 caractères)', code: 'INVALID_GROUP' });
      }
      updates.push('GroupName = ?');
      values.push(name);
      events.push({ event: 'group_renamed', payload: { value: name } });
    }

    if (groupPhoto !== undefined) {
      const photo = groupPhoto === null ? null : String(groupPhoto).trim() || null;
      updates.push('groupPhoto = ?');
      values.push(photo);
      events.push({ event: 'group_photo_changed', payload: {} });
    }

    if (description !== undefined) {
      const desc = description === null ? null : String(description).trim().slice(0, 512) || null;
      updates.push('description = ?');
      values.push(desc);
      events.push({
        event: 'group_description_changed',
        payload: { value: desc || '' },
      });
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Aucun champ à modifier', code: 'NO_FIELDS_TO_UPDATE' });
    }

    const anciennePhoto = groupPhoto !== undefined ? await groupPhotosOf(pool, conversID) : [];

    values.push(conversID);
    await pool.execute(
      `UPDATE conversation SET ${updates.join(', ')} WHERE conversID = ?`,
      values,
    );
    // Photo remplacée ou retirée : l'ancienne n'est plus désignée.
    releasePublicFiles(anciennePhoto);

    const io = req.app.get('io');

    // Un message système PAR CHAMP réellement modifié : « X a renommé le
    // groupe » et « X a changé la photo » sont deux informations distinctes.
    for (const e of events) {
      await postSystemMessage({
        conversationID: conversID,
        actorID: alanyaID,
        event: e.event,
        payload: e.payload,
        io,
      });
    }

    // Relu APRÈS les messages système : ceux-ci réécrivent la ligne
    // (updatedAt, lastMessage*), donc une lecture antérieure renverrait au
    // client un corps périmé d'un cran par rapport à la trame socket — et sa
    // garde d'ordonnancement rejetterait ensuite la trame.
    const enriched = await loadEnrichedConversation(conversID, alanyaID);
    await emitConversationUpdated(io, conversID);

    res.json(enriched);
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

// PATCH /conversations/:id/settings — verrous de permission + historique.
// Toujours réservé aux admins, contrairement à /group qui est déverrouillable.
const updateGroupSettings = async (req, res, next) => {
  try {
    const conversID = req.membership.conversID;
    const alanyaID = req.user.alanyaID;
    const {
      onlyAdminsCanSend,
      onlyAdminsCanEditInfo,
      hideHistoryForNewMembers,
      onlyAdminsCanAddMembers,
    } = req.body;

    const updates = [];
    const values = [];
    const events = [];

    if (onlyAdminsCanSend !== undefined) {
      const next = asFlag(onlyAdminsCanSend);
      // On ne poste une trace que si la valeur CHANGE : un rejeu à l'identique
      // ne doit pas empiler des messages système.
      if (next !== (req.membership.onlyAdminsCanSend ? 1 : 0)) {
        updates.push('onlyAdminsCanSend = ?');
        values.push(next);
        events.push({ lock: 'send', on: next });
      }
    }

    if (onlyAdminsCanEditInfo !== undefined) {
      const next = asFlag(onlyAdminsCanEditInfo);
      if (next !== (req.membership.onlyAdminsCanEditInfo ? 1 : 0)) {
        updates.push('onlyAdminsCanEditInfo = ?');
        values.push(next);
        events.push({ lock: 'edit', on: next });
      }
    }

    if (hideHistoryForNewMembers !== undefined) {
      const next = asFlag(hideHistoryForNewMembers);
      if (next !== (req.membership.hideHistoryForNewMembers ? 1 : 0)) {
        updates.push('hideHistoryForNewMembers = ?');
        values.push(next);
        events.push({ lock: 'history', on: next });
      }
    }

    if (onlyAdminsCanAddMembers !== undefined) {
      const next = asFlag(onlyAdminsCanAddMembers);
      if (next !== (req.membership.onlyAdminsCanAddMembers ? 1 : 0)) {
        updates.push('onlyAdminsCanAddMembers = ?');
        values.push(next);
        events.push({ lock: 'add', on: next });
      }
    }

    if (updates.length > 0) {
      values.push(conversID);
      await pool.execute(
        `UPDATE conversation SET ${updates.join(', ')} WHERE conversID = ?`,
        values,
      );
    }

    const io = req.app.get('io');

    for (const e of events) {
      await postSystemMessage({
        conversationID: conversID,
        actorID: alanyaID,
        event: 'settings_changed',
        payload: { lock: e.lock, on: e.on },
        io,
      });
    }

    // Relu après, même raison que dans updateGroupInfo.
    const enriched = await loadEnrichedConversation(conversID, alanyaID);
    if (events.length > 0) await emitConversationUpdated(io, conversID);

    res.json(enriched);
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

// POST /conversations/:id/ack-join — le nouvel ajouté choisit « Rester ».
// Sync multi-appareil : pendingJoinMsgID est serveur, pas local-only.
const ackGroupJoin = async (req, res, next) => {
  try {
    const conversID = req.membership.conversID;
    const alanyaID = req.user.alanyaID;
    const bodyMsgID = req.body?.msgID != null ? parseInt(req.body.msgID, 10) : null;

    const [rows] = await pool.execute(
      `SELECT pendingJoinMsgID FROM conv_participants
        WHERE conversID = ? AND alanyaID = ?`,
      [conversID, alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée', code: 'CONVERSATION_NOT_FOUND' });
    }

    const pending = rows[0].pendingJoinMsgID != null
      ? Number(rows[0].pendingJoinMsgID)
      : null;

    // Idempotent : déjà ack → 200 avec l'état courant.
    if (pending == null) {
      const enriched = await loadEnrichedConversation(conversID, alanyaID);
      return res.json(enriched);
    }

    if (bodyMsgID != null && Number.isInteger(bodyMsgID) && bodyMsgID !== pending) {
      return res.status(400).json({
        error: 'msgID ne correspond pas au consentement en attente',
        code: 'JOIN_ACK_MISMATCH',
      });
    }

    // Vérifie que le message est bien un member_added où je figure dans ids.
    const [msgRows] = await pool.execute(
      `SELECT content, type FROM message WHERE msgID = ? AND conversationID = ?`,
      [pending, conversID],
    );
    const verdict = msgRows.length === 0
      ? 'missing'
      : evaluateJoinAckMessage({
          type: msgRows[0].type,
          content: msgRows[0].content,
          viewerId: alanyaID,
        });
    if (verdict === 'invalid') {
      return res.status(400).json({
        error: 'Consentement invalide pour cet utilisateur',
        code: 'JOIN_ACK_INVALID',
      });
    }
    // missing (message disparu / type inattendu) ou ok : clear pour ne pas
    // bloquer la bannière indéfiniment.
    await pool.execute(
      `UPDATE conv_participants SET pendingJoinMsgID = NULL
        WHERE conversID = ? AND alanyaID = ?`,
      [conversID, alanyaID],
    );

    const enriched = await loadEnrichedConversation(conversID, alanyaID);
    const io = req.app.get('io');
    // Personnalisé : seuls les appareils de CET utilisateur doivent retirer
    // la bannière. Les autres membres n'ont jamais de pendingJoinMsgID.
    if (io && enriched) {
      const payload = { ...enriched };
      delete payload.unreadCount;
      delete payload.isPinned;
      delete payload.isArchived;
      delete payload.lastMessage;
      delete payload.lastMessageAt;
      delete payload.lastMessageSenderID;
      delete payload.lastMessageType;
      delete payload.lastMessageStatus;
      io.to(`user_${alanyaID}`).emit('conversation:updated', payload);
    }

    res.json(enriched);
  } catch (error) {
    next(error);
  }
};

// DELETE /conversations/:id/participants/:userId — retirer un membre.
const removeParticipant = async (req, res, next) => {
  try {
    const conversID = req.membership.conversID;
    const alanyaID = req.user.alanyaID;
    const targetId = parseInt(req.params.userId, 10);

    if (!Number.isInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Identifiant de membre invalide', code: 'INVALID_MEMBER' });
    }
    if (targetId === Number(alanyaID)) {
      return res.status(400).json({
        error: 'Utiliser /leave pour quitter le groupe',
        code: 'USE_LEAVE_ENDPOINT',
      });
    }

    const [targetRows] = await pool.execute(
      'SELECT role FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversID, targetId],
    );

    // Membre déjà parti : 200 et non 404. Un double-tap sur « Retirer » ne doit
    // pas afficher d'erreur alors que le résultat voulu est atteint.
    if (targetRows.length === 0) {
      return res.json({ conversID, removed: targetId, alreadyGone: true });
    }

    const targetRole = Number(targetRows[0].role) || 0;

    if (targetRole === 2) {
      return res.status(403).json({
        error: 'Le propriétaire du groupe ne peut pas être retiré',
        code: 'CANNOT_REMOVE_OWNER',
      });
    }
    // Rôle supérieur OU ÉGAL : un admin ne retire pas un autre admin.
    if (targetRole >= req.membership.role) {
      return res.status(403).json({
        error: 'Vous ne pouvez pas retirer ce membre',
        code: 'INSUFFICIENT_ROLE',
      });
    }

    // Noms lus AVANT le DELETE, et snapshot des membres à prévenir : l'exclu
    // ne sera plus dans conv_participants juste après.
    const names = await loadUserNames([targetId]);
    const [before] = await pool.execute(
      'SELECT alanyaID FROM conv_participants WHERE conversID = ?',
      [conversID],
    );
    const membersBefore = before.map((r) => Number(r.alanyaID));

    await pool.execute(
      'DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversID, targetId],
    );

    // Le fan-out temps réel lit un cache de participants à TTL 60 s, dont la
    // fonction d'invalidation existait sans être appelée nulle part : l'exclu
    // continuait de recevoir les `message:received` complets — contenu et
    // média — pendant jusqu'à une minute.
    invalidateConversationParticipants(conversID);

    // Et le sortir de la room : la garde d'entrée de `join_conversation` est
    // correcte, mais rien ne révoquait une adhésion déjà accordée. Tant que sa
    // socket vivait, il recevait indéfiniment message:updated, les réactions,
    // les épinglages et le typing du groupe.
    const io0 = req.app.get('io');
    if (io0) io0.in(`user_${targetId}`).socketsLeave(`conversation_${conversID}`);

    const io = req.app.get('io');

    await postSystemMessage({
      conversationID: conversID,
      actorID: alanyaID,
      event: 'member_removed',
      payload: { ids: names.ids, names: names.names },
      io,
      notifyExtra: [targetId],
    });

    if (io) {
      const payload = {
        conversID,
        alanyaID: targetId,
        removedBy: Number(alanyaID),
        reason: 'kicked',
      };
      for (const memberId of membersBefore) {
        io.to(`user_${memberId}`).emit('group:participant:removed', payload);
      }
      await emitConversationUpdated(io, conversID);
    }

    res.json({ conversID, removed: targetId });
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

// PATCH /conversations/:id/participants/:userId/role — promouvoir / rétrograder.
// Propriétaire uniquement : un admin ne crée pas d'admin.
const setParticipantRole = async (req, res, next) => {
  try {
    const conversID = req.membership.conversID;
    const alanyaID = req.user.alanyaID;
    const targetId = parseInt(req.params.userId, 10);
    const role = parseInt(req.body?.role, 10);

    if (!Number.isInteger(targetId) || targetId < 1) {
      return res.status(400).json({ error: 'Identifiant de membre invalide', code: 'INVALID_MEMBER' });
    }
    // 2 exclu : le transfert de propriété n'est pas au périmètre, et la
    // succession automatique du départ suffit à garantir un propriétaire.
    if (role !== 0 && role !== 1) {
      return res.status(400).json({ error: 'role doit valoir 0 ou 1', code: 'INVALID_ROLE' });
    }
    if (targetId === Number(alanyaID)) {
      return res.status(400).json({
        error: 'Vous ne pouvez pas changer votre propre rôle',
        code: 'CANNOT_CHANGE_OWN_ROLE',
      });
    }

    const [targetRows] = await pool.execute(
      'SELECT role FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
      [conversID, targetId],
    );
    if (targetRows.length === 0) {
      return res.status(404).json({ error: 'Membre introuvable dans ce groupe', code: 'GROUP_NOT_FOUND' });
    }

    const currentRole = Number(targetRows[0].role) || 0;
    const roleUnchanged = currentRole === role;

    if (!roleUnchanged) {
      await pool.execute(
        'UPDATE conv_participants SET role = ? WHERE conversID = ? AND alanyaID = ?',
        [role, conversID, targetId],
      );
    }

    const io = req.app.get('io');

    // Rôle déjà en place : 200 sans message système. Le résultat voulu est
    // atteint, et empiler « X a nommé Y administrateur » serait faux.
    if (!roleUnchanged) {
      const names = await loadUserNames([targetId]);
      await postSystemMessage({
        conversationID: conversID,
        actorID: alanyaID,
        event: 'role_changed',
        payload: { ids: names.ids, names: names.names, role },
        io,
      });
      await emitConversationUpdated(io, conversID);
    }

    const enriched = await loadEnrichedConversation(conversID, alanyaID);
    res.json(enriched);
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

const leaveGroup = async (req, res, next) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    // Lu AVANT le DELETE : après, on ne saurait plus si l'appelant était
    // propriétaire, ni qui reste pour lui succéder.
    const [before] = await pool.execute(
      `SELECT cp.alanyaID, cp.role, cp.joinedAt, cp.id, c.isGroup
         FROM conv_participants cp
         JOIN conversation c ON c.conversID = cp.conversID
        WHERE cp.conversID = ?
        ORDER BY cp.role DESC, cp.joinedAt ASC, cp.id ASC`,
      [id],
    );
    const me = before.find((r) => Number(r.alanyaID) === Number(alanyaID));
    if (!me) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée', code: 'CONVERSATION_NOT_FOUND' });
    }
    const isGroup = !!me.isGroup;
    const membersBefore = before.map((r) => Number(r.alanyaID));

    await pool.execute('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [id, alanyaID]);
    invalidateConversationParticipants(Number(id));
    {
      const ioLeave = req.app.get('io');
      if (ioLeave) {
        ioLeave.in(`user_${alanyaID}`).socketsLeave(`conversation_${id}`);
      }
    }

    const [remaining] = await pool.execute('SELECT * FROM conv_participants WHERE conversID = ?', [id]);

    if (remaining.length === 0) {
      const photo = await groupPhotosOf(pool, id);
      await pool.execute('DELETE FROM message WHERE conversationID = ?', [id]);
      await pool.execute('DELETE FROM conversation WHERE conversID = ?', [id]);
      releasePublicFiles(photo);
      return res.json({ message: 'Left group' });
    }

    const io = req.app.get('io');

    if (isGroup) {
      await postSystemMessage({
        conversationID: Number(id),
        actorID: alanyaID,
        event: 'member_left',
        io,
        // Le partant n'est plus dans conv_participants : sans ce rappel, son
        // propre appareil n'afficherait jamais la trace de son départ.
        notifyExtra: [alanyaID],
      });

      // Succession, déléguée au garant partagé — les trois autres chemins de
      // sortie l'appellent aussi. Il constate l'absence de propriétaire plutôt
      // que de la prédire, donc l'appel est sûr même si l'appelant n'était pas
      // propriétaire.
      await ensureGroupOwner(Number(id), { departingID: alanyaID, io });

      if (io) {
        const payload = {
          conversID: Number(id),
          alanyaID: Number(alanyaID),
          removedBy: Number(alanyaID),
          reason: 'left',
        };
        // Diffusé au snapshot PRIS AVANT le DELETE : le partant doit être
        // prévenu, or il ne fait plus partie des destinataires courants.
        for (const memberId of membersBefore) {
          io.to(`user_${memberId}`).emit('group:participant:removed', payload);
        }
        await emitConversationUpdated(io, Number(id));
      }
    }

    res.json({ message: 'Left group' });
  } catch (error) {
    // `next` et non `throw` : Express 4 ne capture pas le rejet d'un handler
    // `async`. L'erreur remontait en unhandled rejection et tuait le PROCESS
    // sans jamais atteindre `errorHandler` — une seule requête suffisait.
    next(error);
  }
};

const _normalizeConversationIDs = (raw) => {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const ids = [...new Set(raw.map((id) => parseInt(id, 10)).filter((id) => id > 0))];
  return ids.length === raw.length ? ids : [];
};

const batchUpdateConversations = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { conversationIDs, isPinned, isArchived } = req.body;
    const alanyaID = req.user.alanyaID;
    const ids = _normalizeConversationIDs(conversationIDs);

    if (ids.length === 0) {
      return res.status(400).json({ error: 'conversationIDs invalides ou dupliqués', code: 'INVALID_CONVERSATION_IDS' });
    }
    if (ids.length > MAX_BATCH_CONVERSATIONS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_CONVERSATIONS} conversations`, code: 'LIMIT_REACHED' });
    }

    const hasPinned = typeof isPinned === 'number' || typeof isPinned === 'boolean';
    const hasArchived = typeof isArchived === 'number' || typeof isArchived === 'boolean';
    if (!hasPinned && !hasArchived) {
      return res.status(400).json({ error: 'Aucune mise à jour fournie (isPinned/isArchived)', code: 'NO_FIELDS_TO_UPDATE' });
    }

    const placeholders = ids.map(() => '?').join(',');
    await conn.beginTransaction();

    const [members] = await conn.execute(
      `SELECT conversID FROM conv_participants
       WHERE alanyaID = ? AND conversID IN (${placeholders})`,
      [alanyaID, ...ids]
    );
    if (members.length !== ids.length) {
      await conn.rollback();
      return res.status(403).json({ error: 'Non autorisé pour une ou plusieurs conversations', code: 'FORBIDDEN' });
    }

    if (hasPinned) {
      const pinned = isPinned === true || isPinned === 1 ? 1 : 0;
      await conn.execute(
        `UPDATE conv_participants
         SET isPinned = ?
         WHERE alanyaID = ? AND conversID IN (${placeholders})`,
        [pinned, alanyaID, ...ids]
      );
    }
    if (hasArchived) {
      const archived = isArchived === true || isArchived === 1 ? 1 : 0;
      await conn.execute(
        `UPDATE conv_participants
         SET isArchived = ?
         WHERE alanyaID = ? AND conversID IN (${placeholders})`,
        [archived, alanyaID, ...ids]
      );
    }

    await conn.commit();
    res.json({ updated: ids.length });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const batchDeleteConversations = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { conversationIDs } = req.body;
    const alanyaID = req.user.alanyaID;
    const ids = _normalizeConversationIDs(conversationIDs);

    if (ids.length === 0) {
      return res.status(400).json({ error: 'conversationIDs invalides ou dupliqués', code: 'INVALID_CONVERSATION_IDS' });
    }
    if (ids.length > MAX_BATCH_CONVERSATIONS) {
      return res.status(400).json({ error: `Maximum ${MAX_BATCH_CONVERSATIONS} conversations`, code: 'LIMIT_REACHED' });
    }

    const placeholders = ids.map(() => '?').join(',');
    await conn.beginTransaction();

    const [members] = await conn.execute(
      `SELECT conversID FROM conv_participants
       WHERE alanyaID = ? AND conversID IN (${placeholders})`,
      [alanyaID, ...ids]
    );
    if (members.length !== ids.length) {
      await conn.rollback();
      return res.status(403).json({ error: 'Non autorisé pour une ou plusieurs conversations', code: 'FORBIDDEN' });
    }

    await conn.execute(
      `DELETE FROM conv_participants
       WHERE alanyaID = ? AND conversID IN (${placeholders})`,
      [alanyaID, ...ids]
    );

    const [orphans] = await conn.execute(
      `SELECT c.conversID
       FROM conversation c
       LEFT JOIN conv_participants cp ON cp.conversID = c.conversID
       WHERE c.conversID IN (${placeholders})
       GROUP BY c.conversID
       HAVING COUNT(cp.alanyaID) = 0`,
      ids
    );
    const orphanIDs = orphans.map((r) => Number(r.conversID)).filter((id) => id > 0);
    // Lues dans la transaction, supprimées après le commit : un retour
    // arrière ne doit pas laisser des groupes privés de leur photo.
    const photosOrphelines = await groupPhotosOf(conn, orphanIDs);
    if (orphanIDs.length > 0) {
      const orphanPlaceholders = orphanIDs.map(() => '?').join(',');
      await conn.execute(
        `DELETE FROM message WHERE conversationID IN (${orphanPlaceholders})`,
        orphanIDs
      );
      await conn.execute(
        `DELETE FROM conversation WHERE conversID IN (${orphanPlaceholders})`,
        orphanIDs
      );
    }

    await conn.commit();
    releasePublicFiles(photosOrphelines);

    // Même trou que deleteConversation, en lot : la suppression ne regarde pas
    // le rôle, donc un propriétaire pouvait laisser derrière lui un groupe sans
    // aucun role=2. APRÈS le commit — le garant lit l'état réel via le pool, et
    // son échec ne doit pas annuler une suppression déjà validée.
    const io = req.app.get('io');
    const survivants = ids.filter((id) => !orphanIDs.includes(id));
    for (const convID of survivants) {
      await ensureGroupOwner(convID, { departingID: alanyaID, io });
    }

    res.json({ deleted: ids.length });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
};

const updateConversationMute = async (req, res) => {
  try {
    const { id } = req.params;
    const { unmute, muteForever, mutedUntil, mentionsOnly } = req.body;
    const alanyaID = req.user.alanyaID;

    const [member] = await pool.execute(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [id, alanyaID],
    );
    if (member.length === 0) {
      return res.status(404).json({ error: 'Conversation introuvable', code: 'CONVERSATION_NOT_FOUND' });
    }

    if (unmute === true || unmute === 1 || unmute === '1') {
      await pool.execute(
        'UPDATE conv_participants SET mutedUntil = NULL, muteForever = 0 WHERE conversID = ? AND alanyaID = ?',
        [id, alanyaID],
      );
    } else if (muteForever === true || muteForever === 1 || muteForever === '1') {
      await pool.execute(
        'UPDATE conv_participants SET muteForever = 1, mutedUntil = NULL WHERE conversID = ? AND alanyaID = ?',
        [id, alanyaID],
      );
    } else if (mutedUntil) {
      const until = new Date(mutedUntil);
      if (Number.isNaN(until.getTime())) {
        return res.status(400).json({ error: 'mutedUntil invalide', code: 'INVALID_MUTED_UNTIL' });
      }
      await pool.execute(
        'UPDATE conv_participants SET mutedUntil = ?, muteForever = 0 WHERE conversID = ? AND alanyaID = ?',
        [until, id, alanyaID],
      );
    } else {
      return res.status(400).json({ error: 'unmute, muteForever ou mutedUntil requis', code: 'UNMUTE_REQUIRED' });
    }

    if (mentionsOnly !== undefined) {
      const mo = mentionsOnly === true || mentionsOnly === 1 || mentionsOnly === '1' ? 1 : 0;
      try {
        await pool.execute(
          'UPDATE conv_participants SET mentionsOnly = ? WHERE conversID = ? AND alanyaID = ?',
          [mo, id, alanyaID],
        );
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }

    let mute = { mutedUntil: null, muteForever: 0, mentionsOnly: 0 };
    try {
      const [rows] = await pool.execute(
        'SELECT mutedUntil, muteForever, mentionsOnly FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
        [id, alanyaID],
      );
      mute = rows[0] || mute;
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }

    res.json({
      conversID: Number(id),
      mutedUntil: mute.mutedUntil,
      muteForever: mute.muteForever ? 1 : 0,
      mentionsOnly: mute.mentionsOnly ? 1 : 0,
    });
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      return res.status(503).json({ error: 'Migration mute non appliquée', code: 'INTERNAL' });
    }
    throw error;
  }
};

module.exports = {
  getConversations,
  getConversationById,
  createConversation,
  createGroup,
  updateConversation,
  deleteConversation,
  markAsRead,
  leaveGroup,
  addParticipants,
  batchUpdateConversations,
  batchDeleteConversations,
  updateConversationMute,
  updateGroupInfo,
  updateGroupSettings,
  ackGroupJoin,
  removeParticipant,
  setParticipantRole,
};