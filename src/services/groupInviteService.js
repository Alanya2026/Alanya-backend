// Lien et QR code d'invitation de groupe — accès base.
//
// Un groupe a au plus UN lien (table `conv_invite_link`), créé à la première
// demande et remplacé à la réinitialisation : l'ancien jeton cesse aussitôt de
// résoudre, y compris imprimé sur un QR.
//
// Le jeton vit hors de `conversation` : la fiche de groupe (`SELECT c.*`) est
// diffusée à tous les membres et l'aurait fait fuiter vers les membres simples.

const crypto = require('crypto');
const pool = require('../config/db');
const { QR_BASE_URL } = require('../utils/qrToken');

/** 12 octets → 16 caractères base64url : 96 bits, non énumérable. */
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;
const nouveauJeton = () => crypto.randomBytes(12).toString('base64url');
const estJetonValide = (token) => typeof token === 'string' && TOKEN_RE.test(token);

/** Adresse partagée et encodée dans le QR. */
const inviteUrl = (token) => `${QR_BASE_URL}/g/${token}`;

/**
 * Taille maximale d'un groupe pour une ARRIVÉE PAR LIEN (l'ajout direct par un
 * membre n'est pas borné ici, pour ne rien changer à l'existant).
 */
const maxMembres = () => {
  const n = Number(process.env.GROUP_MAX_MEMBERS);
  return Number.isInteger(n) && n > 0 ? n : 1024;
};

const STATUT = Object.freeze({ EN_ATTENTE: 0, ACCEPTEE: 1, REFUSEE: 2, ANNULEE: 3 });

/** Réglages du lien d'un groupe. */
async function lireReglages(conversID) {
  const [rows] = await pool.execute(
    'SELECT onlyAdminsCanShareLink, approveNewMembers FROM conversation WHERE conversID = ?',
    [conversID],
  );
  if (rows.length === 0) return null;
  return {
    onlyAdminsCanShareLink: !!rows[0].onlyAdminsCanShareLink,
    approveNewMembers: !!rows[0].approveNewMembers,
  };
}

/** Jeton du groupe, créé s'il n'existe pas encore. */
async function obtenirJeton(conversID, actorId) {
  const [rows] = await pool.execute(
    'SELECT token FROM conv_invite_link WHERE conversID = ?',
    [conversID],
  );
  if (rows.length > 0) return rows[0].token;
  // INSERT IGNORE : deux admins qui ouvrent l'écran au même instant ne créent
  // pas deux liens ; le second relit celui du premier.
  await pool.execute(
    'INSERT IGNORE INTO conv_invite_link (conversID, token, createdBy) VALUES (?, ?, ?)',
    [conversID, nouveauJeton(), actorId],
  );
  const [again] = await pool.execute(
    'SELECT token FROM conv_invite_link WHERE conversID = ?',
    [conversID],
  );
  return again[0]?.token ?? null;
}

/** Remplace le jeton du groupe. Renvoie le nouveau. */
async function reinitialiserJeton(conversID, actorId) {
  const token = nouveauJeton();
  await pool.execute(
    `INSERT INTO conv_invite_link (conversID, token, createdBy, createdAt)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE token = VALUES(token), createdBy = VALUES(createdBy), createdAt = NOW()`,
    [conversID, token, actorId],
  );
  return token;
}

/** Groupe désigné par un jeton, ou null (jeton inconnu, réinitialisé, pas un groupe). */
async function groupeParJeton(token) {
  if (!estJetonValide(token)) return null;
  const [rows] = await pool.execute(
    `SELECT c.conversID, c.GroupName, c.groupPhoto, c.description,
            c.hideHistoryForNewMembers, c.approveNewMembers,
            (SELECT COUNT(*) FROM conv_participants p WHERE p.conversID = c.conversID) AS memberCount
       FROM conv_invite_link l
       JOIN conversation c ON c.conversID = l.conversID
      WHERE l.token = ? AND c.isGroup = 1`,
    [token],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    conversID: Number(r.conversID),
    name: (r.GroupName || '').trim(),
    photo: r.groupPhoto || null,
    description: r.description || null,
    hideHistory: !!r.hideHistoryForNewMembers,
    approval: !!r.approveNewMembers,
    memberCount: Number(r.memberCount) || 0,
  };
}

/**
 * Situation d'une personne face à un groupe :
 * `already_member`, `removed`, `pending`, `full` ou `can_join`.
 */
async function situation(conversID, userId, memberCount) {
  const [m] = await pool.execute(
    'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ?',
    [conversID, userId],
  );
  if (m.length > 0) return 'already_member';
  const [r] = await pool.execute(
    'SELECT 1 FROM conv_removed_member WHERE conversID = ? AND alanyaID = ?',
    [conversID, userId],
  );
  if (r.length > 0) return 'removed';
  const [d] = await pool.execute(
    'SELECT 1 FROM conv_join_request WHERE conversID = ? AND alanyaID = ? AND status = 0',
    [conversID, userId],
  );
  if (d.length > 0) return 'pending';
  if (memberCount >= maxMembres()) return 'full';
  return 'can_join';
}

/** Crée ou relance une demande (une ligne par personne et par groupe). */
async function creerDemande(conversID, userId) {
  await pool.execute(
    `INSERT INTO conv_join_request (conversID, alanyaID, status, createdAt)
     VALUES (?, ?, 0, NOW())
     ON DUPLICATE KEY UPDATE
       createdAt = IF(status = 0, createdAt, NOW()),
       status = 0, decidedBy = NULL, decidedAt = NULL`,
    [conversID, userId],
  );
}

/** Annule ma demande en attente. Renvoie true si une demande a été annulée. */
async function annulerDemande(conversID, userId) {
  const [res] = await pool.execute(
    `UPDATE conv_join_request SET status = 3, decidedAt = NOW()
      WHERE conversID = ? AND alanyaID = ? AND status = 0`,
    [conversID, userId],
  );
  return res.affectedRows > 0;
}

/**
 * Tranche une demande en attente. La première réponse l'emporte : un second
 * admin qui répond trop tard reçoit `false`.
 */
async function trancherDemande(conversID, userId, accepte, adminId) {
  const [res] = await pool.execute(
    `UPDATE conv_join_request SET status = ?, decidedBy = ?, decidedAt = NOW()
      WHERE conversID = ? AND alanyaID = ? AND status = 0`,
    [accepte ? STATUT.ACCEPTEE : STATUT.REFUSEE, adminId, conversID, userId],
  );
  return res.affectedRows > 0;
}

/** Demandes en attente, les plus anciennes d'abord. */
async function demandesEnAttente(conversID) {
  const [rows] = await pool.execute(
    `SELECT r.alanyaID, r.createdAt, u.nom, u.pseudo, u.avatar_url
       FROM conv_join_request r
       JOIN users u ON u.alanyaID = r.alanyaID
      WHERE r.conversID = ? AND r.status = 0 AND u.exclus = 0
        AND NOT EXISTS (SELECT 1 FROM conv_participants p
                         WHERE p.conversID = r.conversID AND p.alanyaID = r.alanyaID)
      ORDER BY r.createdAt ASC
      LIMIT 500`,
    [conversID],
  );
  return rows;
}

async function nombreEnAttente(conversID) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS n FROM conv_join_request r
      WHERE r.conversID = ? AND r.status = 0
        AND NOT EXISTS (SELECT 1 FROM conv_participants p
                         WHERE p.conversID = r.conversID AND p.alanyaID = r.alanyaID)`,
    [conversID],
  );
  return Number(rows[0]?.n) || 0;
}

/** Admins et propriétaire du groupe. */
async function adminsDuGroupe(conversID) {
  const [rows] = await pool.execute(
    'SELECT alanyaID FROM conv_participants WHERE conversID = ? AND role >= 1',
    [conversID],
  );
  return rows.map((r) => Number(r.alanyaID));
}

/**
 * Trace d'un retrait par un admin : un exclu ne revient pas seul par le lien.
 * Tolère l'absence de la migration 116 — le retrait, lui, est déjà commis.
 */
async function noterRetrait(conversID, userId, adminId) {
  try {
    await pool.execute(
      `INSERT INTO conv_removed_member (conversID, alanyaID, removedBy, removedAt)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE removedBy = VALUES(removedBy), removedAt = NOW()`,
      [conversID, userId, adminId],
    );
  } catch (e) {
    console.warn('[groupInvite] trace de retrait non écrite :', e.code || e.message);
  }
}

/** Un membre rajoute la personne : la trace de retrait ne tient plus. */
async function oublierRetrait(conversID, userIds) {
  if (!userIds || userIds.length === 0) return;
  try {
    const ph = userIds.map(() => '?').join(',');
    await pool.execute(
      `DELETE FROM conv_removed_member WHERE conversID = ? AND alanyaID IN (${ph})`,
      [conversID, ...userIds],
    );
  } catch (e) {
    console.warn('[groupInvite] trace de retrait non effacée :', e.code || e.message);
  }
}

module.exports = {
  TOKEN_RE,
  STATUT,
  estJetonValide,
  inviteUrl,
  maxMembres,
  lireReglages,
  obtenirJeton,
  reinitialiserJeton,
  groupeParJeton,
  situation,
  creerDemande,
  annulerDemande,
  trancherDemande,
  demandesEnAttente,
  nombreEnAttente,
  adminsDuGroupe,
  noterRetrait,
  oublierRetrait,
};
