// Lien et QR code d'invitation de groupe — routes HTTP.
//
// Côté groupe (`/api/conversations/:id/…`, membre requis) :
//   GET  invite-link                      voir le lien (admin, ou membre si le
//                                         réglage `onlyAdminsCanShareLink` est coupé)
//   POST invite-link/reset                nouveau lien, l'ancien cesse de marcher (admin)
//   GET  join-requests                    demandes en attente (admin)
//   POST join-requests/:userId/approve    accepter (admin)
//   POST join-requests/:userId/reject     refuser (admin)
//   POST join-requests/approve-all        tout accepter (admin)
//
// Côté invité (`/api/groups/invite/:token`, connecté) :
//   GET    /            aperçu du groupe et situation de l'appelant
//   POST   /join        rejoindre, ou demander à rejoindre si l'approbation est active
//   DELETE /request     annuler ma demande
//
// Rien n'entre dans un groupe sans un appui explicite de la personne sur
// « Rejoindre » : l'aperçu ne modifie rien. Et comme c'est l'arrivant qui agit,
// la préférence « qui peut m'ajouter aux groupes » (canAddUser) ne s'applique
// pas, pas plus que la bannière « Rester / Quitter » des ajouts par un tiers.

const pool = require('../config/db');
const svc = require('../services/groupInviteService');
const { postSystemMessage, loadUserNames } = require('../utils/systemMessage');
const { invalidateConversationParticipants } = require('../utils/conversationParticipantsCache');
const { contactsAmong } = require('../services/privacyPrefsService');
const {
  notifyGroupJoinRequest, notifyGroupJoinApproved,
} = require('../services/notificationService');
const { loadEnrichedConversation, emitConversationUpdated } = require('./conversationController');

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const t = String(url).trim();
  if (_INVALID_URL_VALUES.includes(t)) return null;
  return t.startsWith('http') ? t : null;
};

const lienInvalide = (res) => res.status(404).json({
  error: 'Ce lien d\'invitation ne fonctionne plus',
  code: 'INVITE_LINK_INVALID',
});

/** Prévient les admins que la liste des demandes a changé (pastille, écran ouvert). */
async function signalerDemandes(io, conversID) {
  if (!io) return;
  try {
    const [admins, pendingCount] = await Promise.all([
      svc.adminsDuGroupe(conversID),
      svc.nombreEnAttente(conversID),
    ]);
    for (const id of admins) {
      io.to(`user_${id}`).emit('group:join_requests', { conversID, pendingCount });
    }
  } catch (e) {
    console.warn('[groupInvite] signalement des demandes échoué :', e.message);
  }
}

/**
 * Fait entrer `userId` dans le groupe. Idempotent : déjà membre → `added: false`.
 * `event` : `member_joined_link` (entrée directe, l'acteur est l'arrivant) ou
 * `join_approved` (l'acteur est l'admin qui accepte).
 */
async function admettre({ conversID, userId, actorId, event, io }) {
  const [conv] = await pool.execute(
    'SELECT hideHistoryForNewMembers FROM conversation WHERE conversID = ?',
    [conversID],
  );
  const hideHistory = !!conv[0]?.hideHistoryForNewMembers;

  const [ins] = await pool.execute(
    `INSERT IGNORE INTO conv_participants (conversID, alanyaID, historyCutoffAt)
     VALUES (?, ?, ${hideHistory ? 'NOW()' : 'NULL'})`,
    [conversID, userId],
  );
  const added = ins.affectedRows > 0;
  if (!added) return { added: false };

  await svc.oublierRetrait(conversID, [userId]);
  invalidateConversationParticipants(conversID);

  const pourArrivant = await loadEnrichedConversation(conversID, userId);
  if (io && pourArrivant) {
    io.to(`user_${userId}`).emit('conversation:created', pourArrivant);
  }
  await emitConversationUpdated(io, conversID);

  const cible = await loadUserNames([userId]);
  await postSystemMessage({
    conversationID: conversID,
    actorID: actorId,
    event,
    payload: { ids: cible.ids, names: cible.names },
    io,
  });

  return { added: true, conversation: pourArrivant };
}

// ── Côté groupe ────────────────────────────────────────────────────────────

const getInviteLink = async (req, res, next) => {
  try {
    const { conversID, role } = req.membership;
    const reglages = await svc.lireReglages(conversID);
    if (!reglages) {
      return res.status(404).json({ error: 'Conversation introuvable ou non autorisée', code: 'CONVERSATION_NOT_FOUND' });
    }
    if (reglages.onlyAdminsCanShareLink && role < 1) {
      return res.status(403).json({
        error: 'Seuls les administrateurs peuvent partager le lien',
        code: 'GROUP_INVITE_LINK_ADMIN_ONLY',
      });
    }
    const token = await svc.obtenirJeton(conversID, req.user.alanyaID);
    res.json({ token, url: svc.inviteUrl(token), ...reglages });
  } catch (error) {
    next(error);
  }
};

const resetInviteLink = async (req, res, next) => {
  try {
    const { conversID } = req.membership;
    const token = await svc.reinitialiserJeton(conversID, req.user.alanyaID);
    await postSystemMessage({
      conversationID: conversID,
      actorID: req.user.alanyaID,
      event: 'invite_link_reset',
      io: req.app.get('io'),
    });
    const reglages = await svc.lireReglages(conversID);
    res.json({ token, url: svc.inviteUrl(token), ...reglages });
  } catch (error) {
    next(error);
  }
};

const listJoinRequests = async (req, res, next) => {
  try {
    const { conversID } = req.membership;
    const rows = await svc.demandesEnAttente(conversID);
    const ids = rows.map((r) => Number(r.alanyaID));
    // « Dans vos contacts » : l'admin qui regarde a-t-il enregistré la personne ?
    const contacts = ids.length > 0
      ? await contactsAmong(req.user.alanyaID, ids)
      : new Set();
    res.json({
      requests: rows.map((r) => ({
        alanyaID: Number(r.alanyaID),
        nom: r.nom,
        pseudo: r.pseudo,
        avatar_url: sanitizeUrl(r.avatar_url),
        requestedAt: r.createdAt,
        isContact: contacts.has(Number(r.alanyaID)),
      })),
    });
  } catch (error) {
    next(error);
  }
};

/** Accepte une demande. Renvoie le code d'erreur, ou null si tout va bien. */
async function accepterUne(conversID, userId, adminId, io) {
  const [{ n }] = (await pool.execute(
    'SELECT COUNT(*) AS n FROM conv_participants WHERE conversID = ?',
    [conversID],
  ))[0];
  if (Number(n) >= svc.maxMembres()) return 'GROUP_FULL';

  const tranche = await svc.trancherDemande(conversID, userId, true, adminId);
  if (!tranche) return 'JOIN_REQUEST_NOT_FOUND';

  await admettre({ conversID, userId, actorId: adminId, event: 'join_approved', io });

  if (io) io.to(`user_${userId}`).emit('group:join_decided', { conversID, approved: true });
  const [g] = await pool.execute('SELECT GroupName FROM conversation WHERE conversID = ?', [conversID]);
  notifyGroupJoinApproved(userId, { conversID, name: g[0]?.GroupName || '' })
    .catch((e) => console.warn('[groupInvite] push d\'acceptation :', e.message));
  return null;
}

const ERREURS_DECISION = {
  GROUP_FULL: [409, 'Le groupe est complet'],
  JOIN_REQUEST_NOT_FOUND: [404, 'Cette demande a déjà été traitée'],
};

const decideJoinRequest = (approve) => async (req, res, next) => {
  try {
    const { conversID } = req.membership;
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isInteger(userId) || userId < 1) {
      return res.status(400).json({ error: 'Identifiant invalide', code: 'INVALID_MEMBER' });
    }
    const io = req.app.get('io');

    let code = null;
    if (approve) {
      code = await accepterUne(conversID, userId, req.user.alanyaID, io);
    } else {
      const ok = await svc.trancherDemande(conversID, userId, false, req.user.alanyaID);
      if (!ok) code = 'JOIN_REQUEST_NOT_FOUND';
      else if (io) io.to(`user_${userId}`).emit('group:join_decided', { conversID, approved: false });
    }
    await signalerDemandes(io, conversID);

    if (code) {
      const [status, error] = ERREURS_DECISION[code];
      return res.status(status).json({ error, code });
    }
    res.json({ conversID, alanyaID: userId, approved: approve });
  } catch (error) {
    next(error);
  }
};

const approveAllJoinRequests = async (req, res, next) => {
  try {
    const { conversID } = req.membership;
    const io = req.app.get('io');
    const rows = await svc.demandesEnAttente(conversID);
    let approved = 0;
    let full = false;
    for (const r of rows) {
      const code = await accepterUne(conversID, Number(r.alanyaID), req.user.alanyaID, io);
      if (code === 'GROUP_FULL') { full = true; break; }
      if (!code) approved += 1;
    }
    await signalerDemandes(io, conversID);
    res.json({ conversID, approved, full });
  } catch (error) {
    next(error);
  }
};

// ── Côté invité ────────────────────────────────────────────────────────────

/** Aperçu public d'un groupe pour qui détient le lien (et rien de plus). */
const apercu = (groupe, state) => ({
  state,
  group: {
    // L'identifiant n'est donné qu'à un membre : c'est ce qui lui permet
    // d'ouvrir la discussion depuis l'aperçu.
    ...(state === 'already_member' ? { conversID: groupe.conversID } : {}),
    name: groupe.name,
    photo: sanitizeUrl(groupe.photo),
    description: groupe.description,
    memberCount: groupe.memberCount,
    hideHistory: groupe.hideHistory,
    approval: groupe.approval,
  },
});

/** Utilisé aussi par `POST /api/qr/resolve` quand le QR scanné est un lien de groupe. */
async function apercuPourJeton(token, userId) {
  const groupe = await svc.groupeParJeton(token);
  if (!groupe) return null;
  const state = await svc.situation(groupe.conversID, userId, groupe.memberCount);
  return apercu(groupe, state);
}

const previewInvite = async (req, res, next) => {
  try {
    const result = await apercuPourJeton(String(req.params.token || ''), req.user.alanyaID);
    if (!result) return lienInvalide(res);
    res.json(result);
  } catch (error) {
    next(error);
  }
};

const joinByInvite = async (req, res, next) => {
  try {
    const userId = Number(req.user.alanyaID);
    const groupe = await svc.groupeParJeton(String(req.params.token || ''));
    if (!groupe) return lienInvalide(res);

    const state = await svc.situation(groupe.conversID, userId, groupe.memberCount);
    const io = req.app.get('io');

    if (state === 'already_member') {
      const conversation = await loadEnrichedConversation(groupe.conversID, userId);
      return res.json({ state, conversation });
    }
    if (state === 'removed') {
      return res.status(403).json({
        error: 'Un administrateur vous a retiré de ce groupe',
        code: 'GROUP_REMOVED',
      });
    }
    if (state === 'pending') return res.json({ state });
    if (state === 'full') {
      return res.status(409).json({ error: 'Le groupe est complet', code: 'GROUP_FULL' });
    }

    if (groupe.approval) {
      await svc.creerDemande(groupe.conversID, userId);
      await signalerDemandes(io, groupe.conversID);
      const [me] = await pool.execute('SELECT nom, pseudo FROM users WHERE alanyaID = ?', [userId]);
      const admins = await svc.adminsDuGroupe(groupe.conversID);
      notifyGroupJoinRequest(admins, {
        conversID: groupe.conversID,
        name: groupe.name,
        requester: me[0] || {},
      }).catch((e) => console.warn('[groupInvite] push de demande :', e.message));
      return res.status(202).json({ state: 'pending' });
    }

    const { added, conversation } = await admettre({
      conversID: groupe.conversID,
      userId,
      actorId: userId,
      event: 'member_joined_link',
      io,
    });
    const conv = conversation || await loadEnrichedConversation(groupe.conversID, userId);
    res.json({ state: added ? 'joined' : 'already_member', conversation: conv });
  } catch (error) {
    next(error);
  }
};

const cancelJoinRequest = async (req, res, next) => {
  try {
    const groupe = await svc.groupeParJeton(String(req.params.token || ''));
    if (!groupe) return lienInvalide(res);
    const cancelled = await svc.annulerDemande(groupe.conversID, req.user.alanyaID);
    if (cancelled) await signalerDemandes(req.app.get('io'), groupe.conversID);
    res.json({ cancelled });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getInviteLink,
  resetInviteLink,
  listJoinRequests,
  approveJoinRequest: decideJoinRequest(true),
  rejectJoinRequest: decideJoinRequest(false),
  approveAllJoinRequests,
  previewInvite,
  joinByInvite,
  cancelJoinRequest,
  apercuPourJeton,
};
