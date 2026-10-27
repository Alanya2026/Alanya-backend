/**
 * Documents sensibles — traces de consultation et recherche par empreinte.
 * Plan : PLAN-DOCUMENTS-SENSIBLES.md ; table : migration 110.
 *
 * L'application note ici chaque ouverture d'un document sensible dans la
 * visionneuse protégée (`CONSULTATION`), et chaque copie signée qui sort
 * (`TELECHARGEMENT`…) avec l'EMPREINTE NUMÉRIQUE qu'elle a écrite dedans. Un
 * fichier retrouvé ailleurs renvoie ainsi, par son empreinte, à qui l'a fait
 * sortir — même si l'on a effacé le nom écrit aux bords.
 */
const pool = require('../config/db');
const { fail } = require('../utils/apiError');
const {
  GESTES,
  DocumentSensibleInvalide,
  normaliseEmpreinte,
} = require('../utils/documentSensible');

const APPAREIL_MAX = 120;

function _appareil(brut) {
  if (typeof brut !== 'string') return null;
  const a = brut.trim();
  return a ? a.slice(0, APPAREIL_MAX) : null;
}

function _personne(id, nom, numero) {
  if (id == null) return null;
  return { alanyaId: numero ?? null, nom: nom ?? null };
}

/**
 * POST /api/documents-sensibles/consultations
 * Corps : `{ msgID, geste?, empreinte?, appareil? }`.
 *
 * La trace ne doit jamais empêcher la lecture : l'application ignore l'échec.
 * Mais le serveur, lui, ne note que ce qui est vrai — un membre de la
 * conversation, un message sensible, une empreinte bien formée et neuve.
 */
const enregistrerConsultation = async (req, res, next) => {
  try {
    const alanyaID = req.user.alanyaID;
    const msgID = Number.parseInt(req.body?.msgID, 10);
    if (!Number.isInteger(msgID) || msgID <= 0) {
      return fail(res, 400, 'INVALID_PAYLOAD', 'msgID requis');
    }
    const geste = req.body?.geste == null ? 'CONSULTATION' : String(req.body.geste);
    if (!GESTES.has(geste)) {
      return fail(res, 400, 'INVALID_PAYLOAD', 'geste inconnu');
    }
    let empreinte;
    try {
      empreinte = normaliseEmpreinte(req.body?.empreinte);
    } catch (e) {
      if (!(e instanceof DocumentSensibleInvalide)) throw e;
      return fail(res, 422, 'INVALID_FINGERPRINT', e.message);
    }
    // Une consultation ne fait rien sortir : elle n'a pas d'empreinte.
    if (geste === 'CONSULTATION' && empreinte) {
      return fail(res, 400, 'INVALID_PAYLOAD', 'une consultation n\'a pas d\'empreinte');
    }

    const [rows] = await pool.execute(
      `SELECT m.msgID, m.conversationID, m.senderID, m.isSensitive
         FROM message m
         JOIN conv_participants cp
           ON cp.conversID = m.conversationID AND cp.alanyaID = ?
        WHERE m.msgID = ? AND m.isDeleted = 0
        LIMIT 1`,
      [alanyaID, msgID],
    );
    // Message absent ou conversation étrangère : la même réponse, pour ne
    // rien dire de l'existence d'un message qu'on ne peut pas lire.
    const msg = rows[0];
    if (!msg) return fail(res, 404, 'MESSAGE_NOT_FOUND', 'Message introuvable');
    if (!Number(msg.isSensitive)) {
      return fail(res, 400, 'NOT_SENSITIVE', 'Ce message n\'est pas un document sensible');
    }

    try {
      const [r] = await pool.execute(
        `INSERT INTO document_consultation
           (msgID, conversationID, alanyaID, expediteurID, geste, empreinte, appareil, appareilId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          msg.msgID, msg.conversationID, alanyaID, msg.senderID, geste, empreinte,
          _appareil(req.body?.appareil), req.user.appareilId ?? null,
        ],
      );
      return res.status(201).json({ id: r.insertId });
    } catch (e) {
      // 128 bits tirés au hasard : un doublon n'est pas une collision, c'est
      // un rejeu — ou une tentative d'écraser la trace d'un autre.
      if (e.code === 'ER_DUP_ENTRY') {
        return fail(res, 409, 'FINGERPRINT_EXISTS', 'Empreinte déjà enregistrée');
      }
      throw e;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/documents-sensibles/empreintes/:code
 *
 * Qui a fait sortir la copie qui porte cette empreinte. Réservé à qui pouvait
 * voir le document : un membre de sa conversation, son expéditeur, ou l'auteur
 * de la copie. Pour tout autre, 404 — comme une empreinte inconnue, pour ne
 * pas servir d'oracle.
 */
const trouverEmpreinte = async (req, res, next) => {
  try {
    let empreinte;
    try {
      empreinte = normaliseEmpreinte(req.params.code);
    } catch (e) {
      if (!(e instanceof DocumentSensibleInvalide)) throw e;
      return fail(res, 422, 'INVALID_FINGERPRINT', e.message);
    }
    if (!empreinte) return fail(res, 422, 'INVALID_FINGERPRINT', 'empreinte requise');

    const demandeur = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT dc.empreinte, dc.geste, dc.appareil, dc.createdAt, dc.msgID,
              dc.alanyaID, dc.expediteurID,
              u.nom AS auteurNom, u.alanyaPhone AS auteurNumero,
              e.nom AS expediteurNom, e.alanyaPhone AS expediteurNumero,
              m.mediaName
         FROM document_consultation dc
         LEFT JOIN users u ON u.alanyaID = dc.alanyaID
         LEFT JOIN users e ON e.alanyaID = dc.expediteurID
         LEFT JOIN message m ON m.msgID = dc.msgID
        WHERE dc.empreinte = ?
          AND (dc.alanyaID = ? OR dc.expediteurID = ?
               OR EXISTS (SELECT 1 FROM conv_participants cp
                           WHERE cp.conversID = dc.conversationID AND cp.alanyaID = ?))
        LIMIT 1`,
      [empreinte, demandeur, demandeur, demandeur],
    );
    const r = rows[0];
    if (!r) return fail(res, 404, 'FINGERPRINT_NOT_FOUND', 'Empreinte inconnue');

    return res.json({
      empreinte: r.empreinte,
      geste: r.geste,
      date: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      appareil: r.appareil ?? null,
      utilisateur: _personne(r.alanyaID, r.auteurNom, r.auteurNumero),
      expediteur: _personne(r.expediteurID, r.expediteurNom, r.expediteurNumero),
      document: { msgID: r.msgID, nom: r.mediaName ?? null },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { enregistrerConsultation, trouverEmpreinte };
