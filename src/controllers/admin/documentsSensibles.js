/**
 * Documents sensibles — enquête par empreinte, côté administration.
 * Plan : PLAN-DOCUMENTS-SENSIBLES.md ; table : migration 110.
 *
 * L'application (`GET /api/documents-sensibles/empreintes/:code`) ne répond
 * qu'à qui pouvait voir le document, et ne dit que sept choses. Ici, la
 * portée tombe : n'importe quelle empreinte, avec tout ce qui permet de
 * remonter une fuite — la session qui a fait sortir la copie, les autres
 * comptes de l'appareil, l'état du document et de sa conversation, et
 * l'HISTORIQUE complet du document (qui l'a envoyé, ouvert, fait sortir).
 *
 * C'est un pouvoir d'enquête, donc trois garde-fous :
 * - `documents.trace`, réservé au super-admin (constants/adminRoles.js) ;
 * - un MOTIF obligatoire à chaque recherche ;
 * - chaque recherche est écrite dans `admin_audit` PAR CE CONTRÔLEUR, avant
 *   la réponse, y compris quand l'empreinte est inconnue : chercher est déjà
 *   un geste d'enquête. Si l'écriture échoue, la réponse n'est pas donnée —
 *   pas de trace, pas de résultat. D'où l'entrée dans `SKIP` du journal
 *   automatique (middleware/adminAudit.js), qui ne note que les succès et
 *   doublerait les lignes.
 *
 * Le contenu du fichier n'est jamais servi : seulement ses métadonnées.
 */
const pool = require('../../config/db');
const { fail } = require('../../utils/apiError');
const { DocumentSensibleInvalide, normaliseEmpreinte } = require('../../utils/documentSensible');

const ACTION = 'documents.trace';
const ROUTE = 'POST /documents-sensibles/empreintes/:code/verification';
const MOTIF_MIN = 3;
const MOTIF_MAX = 500;
const HISTORIQUE_MAX = 500;
const SORTIES_AUTEUR_MAX = 20;
const VERIFICATIONS_MAX = 50;

const _iso = (d) => (d instanceof Date ? d.toISOString() : d ?? null);
const _tronque = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** Motif saisi : trois caractères utiles au moins, comme les autres motifs admin. */
function lireMotif(body) {
  const brut = body && typeof body === 'object' ? body.reason : null;
  if (typeof brut !== 'string') return null;
  const m = brut.trim().replace(/\s+/g, ' ');
  return m.length >= MOTIF_MIN ? m.slice(0, MOTIF_MAX) : null;
}

/**
 * État d'un compte tel que la trace le connaît. La table de traces n'a pas
 * de clé étrangère (migration 110) : un compte supprimé laisse son numéro
 * interne, plus son nom.
 */
function statutCompte(u) {
  if (!u || u.uid == null) return 'supprime';
  if (Number(u.exclus) === 1) {
    return u.excludeReason === 'self_delete_pending' ? 'suppression_programmee' : 'banni';
  }
  return 'actif';
}

/** Personne détaillée à partir des colonnes préfixées `p` (`pUid`, `pNom`…). */
function personne(id, row, p) {
  if (id == null) return null;
  const u = row && row[`${p}Uid`] != null ? {
    uid: row[`${p}Uid`],
    exclus: row[`${p}Exclus`],
    excludeReason: row[`${p}ExcludeReason`],
  } : null;
  return {
    id: Number(id),
    nom: row?.[`${p}Nom`] ?? null,
    pseudo: row?.[`${p}Pseudo`] ?? null,
    numero: row?.[`${p}Numero`] ?? null,
    avatarUrl: row?.[`${p}Avatar`] ?? null,
    typeCompte: row?.[`${p}Type`] != null ? Number(row[`${p}Type`]) : null,
    statut: statutCompte(u),
    suppressionPrevueLe: statutCompte(u) === 'suppression_programmee'
      ? _iso(row?.[`${p}DeleteAt`] ?? null) : null,
  };
}

/** Colonnes d'un compte joint sous l'alias `t`, préfixées `p`. */
const colonnesPersonne = (t, p) => `
  ${t}.alanyaID AS ${p}Uid, ${t}.nom AS ${p}Nom, ${t}.pseudo AS ${p}Pseudo,
  ${t}.alanyaPhone AS ${p}Numero, ${t}.avatar_url AS ${p}Avatar,
  ${t}.type_compte AS ${p}Type, ${t}.exclus AS ${p}Exclus,
  ${t}.exclude_reason AS ${p}ExcludeReason, ${t}.delete_scheduled_at AS ${p}DeleteAt`;

function etatDocument(r) {
  if (r.mMsgID == null) return 'purge';
  if (Number(r.mIsDeleted) === 1) return 'supprime';
  return 'present';
}

async function journaliser(req, code, motif, statusCode) {
  await pool.execute(
    `INSERT INTO admin_audit
       (admin_id, action, route, target_type, target_id, reason, ip, user_agent, status_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.alanyaID, ACTION, ROUTE, 'empreinte', code, motif,
      _tronque(req.ip, 64), _tronque(req.get('user-agent'), 255), statusCode,
    ],
  );
}

async function lireSession(appareilId, auteurId) {
  const id = Number.parseInt(appareilId, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== String(appareilId).trim()) {
    return appareilId ? { appareilId: String(appareilId), connue: false } : null;
  }
  const [rows] = await pool.execute(
    `SELECT id, alanyaID, device_id, device_name, platform, ip_address, login_method,
            created_at, last_active_at, revoked_at
       FROM appareils WHERE id = ? LIMIT 1`,
    [id],
  );
  const a = rows[0];
  // Appareils supprimés avec le compte (ON DELETE CASCADE) : il ne reste que
  // le numéro de session écrit dans la trace.
  if (!a) return { appareilId: String(id), connue: false };

  const [autres] = await pool.execute(
    `SELECT DISTINCT u.alanyaID, u.nom, u.alanyaPhone
       FROM appareils a2
       JOIN users u ON u.alanyaID = a2.alanyaID
      WHERE a2.device_id = ? AND a2.alanyaID <> ?
      ORDER BY u.alanyaID
      LIMIT 20`,
    [a.device_id, auteurId ?? a.alanyaID],
  );
  return {
    appareilId: String(a.id),
    connue: true,
    nom: a.device_name ?? null,
    plateforme: a.platform ?? null,
    ip: a.ip_address ?? null,
    connexion: a.login_method ?? null,
    ouverteLe: _iso(a.created_at),
    derniereActivite: _iso(a.last_active_at),
    revoqueeLe: _iso(a.revoked_at),
    autresComptes: autres.map((u) => ({ id: Number(u.alanyaID), nom: u.nom ?? null, numero: u.alanyaPhone ?? null })),
  };
}

async function lireHistorique(msgID, empreinte) {
  const [rows] = await pool.execute(
    `SELECT dc.id, dc.geste, dc.empreinte, dc.appareil, dc.createdAt, dc.alanyaID,
            u.alanyaID AS uid, u.nom, u.alanyaPhone
       FROM document_consultation dc
       LEFT JOIN users u ON u.alanyaID = dc.alanyaID
      WHERE dc.msgID = ?
      ORDER BY dc.createdAt ASC, dc.id ASC
      LIMIT ${HISTORIQUE_MAX + 1}`,
    [msgID],
  );
  return {
    tronque: rows.length > HISTORIQUE_MAX,
    evenements: rows.slice(0, HISTORIQUE_MAX).map((r) => ({
      id: Number(r.id),
      geste: r.geste,
      date: _iso(r.createdAt),
      empreinte: r.empreinte ?? null,
      appareil: r.appareil ?? null,
      cetteCopie: r.empreinte === empreinte,
      personne: { id: Number(r.alanyaID), nom: r.nom ?? null, numero: r.alanyaPhone ?? null, supprime: r.uid == null },
    })),
  };
}

async function lireSortiesAuteur(auteurId, empreinte) {
  const [[{ n }]] = await pool.execute(
    `SELECT COUNT(*) AS n FROM document_consultation
      WHERE alanyaID = ? AND empreinte IS NOT NULL`,
    [auteurId],
  );
  const [rows] = await pool.execute(
    `SELECT dc.empreinte, dc.geste, dc.createdAt, dc.msgID, m.mediaName
       FROM document_consultation dc
       LEFT JOIN message m ON m.msgID = dc.msgID
      WHERE dc.alanyaID = ? AND dc.empreinte IS NOT NULL AND dc.empreinte <> ?
      ORDER BY dc.createdAt DESC, dc.id DESC
      LIMIT ${SORTIES_AUTEUR_MAX}`,
    [auteurId, empreinte],
  );
  return {
    total: Number(n) || 0,
    dernieres: rows.map((r) => ({
      empreinte: r.empreinte,
      geste: r.geste,
      date: _iso(r.createdAt),
      document: { msgID: Number(r.msgID), nom: r.mediaName ?? null },
    })),
  };
}

/** Recherches précédentes de la même empreinte — la présente comprise. */
async function lireVerifications(empreinte) {
  const [rows] = await pool.execute(
    `SELECT a.created_at, a.reason, a.status_code, a.admin_id, u.nom
       FROM admin_audit a
       LEFT JOIN users u ON u.alanyaID = a.admin_id
      WHERE a.action = ? AND a.target_type = 'empreinte' AND a.target_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${VERIFICATIONS_MAX}`,
    [ACTION, empreinte],
  );
  return rows.map((r) => ({
    date: _iso(r.created_at),
    motif: r.reason ?? null,
    trouvee: Number(r.status_code) === 200,
    admin: r.admin_id == null ? null : { id: Number(r.admin_id), nom: r.nom ?? null },
  }));
}

/**
 * POST /api/admin/documents-sensibles/empreintes/:code/verification
 * Corps : `{ reason }` (obligatoire).
 *
 * POST et non GET : la recherche porte un motif, et un motif n'a rien à faire
 * dans une URL (journaux du proxy, historique du navigateur).
 */
const verifierEmpreinteAdmin = async (req, res, next) => {
  try {
    let empreinte;
    try {
      empreinte = normaliseEmpreinte(req.params.code);
    } catch (e) {
      if (!(e instanceof DocumentSensibleInvalide)) throw e;
      return fail(res, 422, 'INVALID_FINGERPRINT', e.message);
    }
    if (!empreinte) return fail(res, 422, 'INVALID_FINGERPRINT', 'empreinte requise');

    const motif = lireMotif(req.body);
    if (!motif) return fail(res, 400, 'REASON_REQUIRED', `motif requis (${MOTIF_MIN} caractères au moins)`);

    const [rows] = await pool.execute(
      `SELECT dc.id, dc.empreinte, dc.geste, dc.appareil, dc.appareilId, dc.createdAt,
              dc.msgID, dc.conversationID, dc.alanyaID, dc.expediteurID,
              ${colonnesPersonne('u', 'a')},
              ${colonnesPersonne('e', 'e')},
              m.msgID AS mMsgID, m.mediaName, m.type AS mType, m.mediaSize, m.sendAt,
              m.isDeleted AS mIsDeleted,
              c.conversID AS cId, c.isGroup, c.GroupName,
              (SELECT COUNT(*) FROM conv_participants cp WHERE cp.conversID = dc.conversationID) AS membres
         FROM document_consultation dc
         LEFT JOIN users u ON u.alanyaID = dc.alanyaID
         LEFT JOIN users e ON e.alanyaID = dc.expediteurID
         LEFT JOIN message m ON m.msgID = dc.msgID
         LEFT JOIN conversation c ON c.conversID = dc.conversationID
        WHERE dc.empreinte = ?
        LIMIT 1`,
      [empreinte],
    );
    const r = rows[0];

    // Journal AVANT la réponse : s'il échoue, l'erreur part au gestionnaire
    // et rien n'est révélé.
    await journaliser(req, empreinte, motif, r ? 200 : 404);
    if (!r) return fail(res, 404, 'FINGERPRINT_NOT_FOUND', 'Empreinte inconnue');

    const [session, historique, sortiesAuteur, verifications] = await Promise.all([
      lireSession(r.appareilId, r.alanyaID),
      lireHistorique(r.msgID, empreinte),
      lireSortiesAuteur(r.alanyaID, empreinte),
      lireVerifications(empreinte),
    ]);

    return res.json({
      empreinte: r.empreinte,
      geste: r.geste,
      date: _iso(r.createdAt),
      appareil: r.appareil ?? null,
      auteur: personne(r.alanyaID, r, 'a'),
      expediteur: personne(r.expediteurID, r, 'e'),
      session,
      document: {
        msgID: Number(r.msgID),
        nom: r.mediaName ?? null,
        type: r.mType != null ? Number(r.mType) : null,
        taille: r.mediaSize != null ? Number(r.mediaSize) : null,
        envoyeLe: _iso(r.sendAt),
        etat: etatDocument(r),
      },
      conversation: {
        id: Number(r.conversationID),
        existe: r.cId != null,
        groupe: r.cId != null ? Number(r.isGroup) === 1 : null,
        nom: r.GroupName ?? null,
        membres: Number(r.membres) || 0,
      },
      historique,
      sortiesAuteur,
      verifications,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/admin/users/:id/documents-sensibles
 *
 * Résumé pour la fiche d'un compte : des NOMBRES seulement. Les empreintes et
 * le détail passent par la vérification, qui exige un motif.
 */
const resumeDocumentsSensiblesUtilisateur = async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, 'INVALID_PAYLOAD', 'id invalide');
    const [[s]] = await pool.execute(
      `SELECT
         SUM(CASE WHEN alanyaID = ? AND geste = 'CONSULTATION' THEN 1 ELSE 0 END) AS consultations,
         SUM(CASE WHEN alanyaID = ? AND empreinte IS NOT NULL THEN 1 ELSE 0 END) AS copies,
         MAX(CASE WHEN alanyaID = ? AND empreinte IS NOT NULL THEN createdAt END) AS derniereCopie,
         SUM(CASE WHEN expediteurID = ? AND alanyaID <> ? AND empreinte IS NOT NULL THEN 1 ELSE 0 END) AS copiesDeSesEnvois
       FROM document_consultation
      WHERE alanyaID = ? OR expediteurID = ?`,
      [id, id, id, id, id, id, id],
    );
    return res.json({
      consultations: Number(s?.consultations) || 0,
      copies: Number(s?.copies) || 0,
      derniereCopie: _iso(s?.derniereCopie ?? null),
      copiesDeSesEnvois: Number(s?.copiesDeSesEnvois) || 0,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  verifierEmpreinteAdmin,
  resumeDocumentsSensiblesUtilisateur,
  lireMotif,
  statutCompte,
  ACTION,
  ROUTE,
};
