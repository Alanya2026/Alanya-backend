/**
 * Message « fichier du coffre » (type 11) : un fichier du coffre-fort partagé
 * dans une discussion (conception : docs/conception/coffre-fort.html,
 * section 07). Validation et canonisation PARTAGÉES par `message:send`
 * (socket) et `POST /api/conversations/:id/messages` (HTTP), comme les
 * stickers : une règle ajoutée ici arrive des deux côtés.
 *
 * ── Ce que le serveur décide ──
 *
 * Le client envoie `{"v":1,"share":<id>}` et, au besoin, une mini-image floue
 * (`b`, quelques Ko de base64). Le serveur relit le partage en base : il doit
 * appartenir à l'expéditeur ET à cette discussion. `content` est réécrit
 * (nom, taille, type, famille), `mediaUrl` vaut NULL (le fichier ne passe
 * jamais par les médias de discussion) et `mediaName` porte un repli lisible
 * pour les applications qui ne connaissent pas le type 11 : elles affichent
 * « 📦 Mariage.mp4 · 840 Mo » au lieu de rien.
 *
 * ── E2EE ──
 *
 * Dans une conversation chiffrée, `content` est scellé : le serveur ne peut
 * rien vérifier et ne garde rien en clair. Sans risque : les téléchargements
 * passent par `/api/safebox/shares/:id`, qui vérifie l'appartenance.
 */

const pool = require('../config/db');

const SAFEBOX_SHARE_TYPE = 11;
const SAFEBOX_SHARE_PREVIEW = '📦 Fichier';
const PAYLOAD_VERSION = 1;
const FLOU_MAX = 6000; // caractères de base64, ~4,5 Ko

class SafeboxShareMessageError extends Error {
  constructor(code = 'SAFEBOX_SHARE_INVALID', status = 400, message = 'Partage du coffre invalide') {
    super(message);
    this.name = 'SafeboxShareMessageError';
    this.code = code;
    this.status = status;
  }
}

const estPartageCoffre = (type) => Number(type) === SAFEBOX_SHARE_TYPE;

/** Taille lisible, en français : les anciennes applications l'affichent telle quelle. */
function tailleLisible(octets) {
  const n = Number(octets) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1).replace('.', ',')} Go`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} Mo`;
  return `${Math.max(1, Math.round(n / 1024))} Ko`;
}

function lirePayload(content) {
  if (typeof content !== 'string' || content.length > FLOU_MAX + 500) return null;
  try {
    const d = JSON.parse(content);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    if (!Number.isSafeInteger(d.share) || d.share <= 0) return null;
    const flou = typeof d.b === 'string' && d.b.length <= FLOU_MAX && /^[A-Za-z0-9+/=]+$/.test(d.b) ? d.b : null;
    return { share: d.share, flou };
  } catch {
    return null;
  }
}

/**
 * Champs à écrire pour un message de type 11, ou null pour un autre type.
 * @throws {SafeboxShareMessageError}
 */
async function resolveSafeboxShareFields({
  type, content, senderID, conversationID, chiffre = null,
}, { db = pool } = {}) {
  if (!estPartageCoffre(type)) return null;
  if (chiffre) return { content: null, mediaUrl: null, mediaName: null };
  const p = lirePayload(content);
  if (!p) throw new SafeboxShareMessageError();
  let s;
  try {
    [[s]] = await db.query(
      `SELECT id, name, mime, family, plain_bytes FROM safebox_share
        WHERE id = ? AND sender_id = ? AND conversation_id = ? AND revoked_at IS NULL`,
      [p.share, senderID, conversationID],
    );
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') throw new SafeboxShareMessageError();
    throw e;
  }
  if (!s) throw new SafeboxShareMessageError();
  const canonique = {
    v: PAYLOAD_VERSION,
    share: Number(s.id),
    name: s.name,
    size: Number(s.plain_bytes),
    mime: s.mime,
    family: s.family,
    ...(p.flou ? { b: p.flou } : {}),
  };
  return {
    content: JSON.stringify(canonique),
    mediaUrl: null,
    mediaName: `📦 ${s.name} · ${tailleLisible(s.plain_bytes)}`,
  };
}

/** Aperçu (liste des discussions, notifications) : jamais le JSON. */
function safeboxSharePreview(content) {
  try {
    const d = JSON.parse(String(content || ''));
    if (d && typeof d.name === 'string' && d.name) return `📦 ${d.name}`;
  } catch { /* contenu chiffré ou ancien */ }
  return SAFEBOX_SHARE_PREVIEW;
}

/** Citation d'un fichier du coffre : libellé, jamais le JSON. */
function sanitizeShareReply(replyToContent, replyToType = null) {
  if (replyToContent == null) return replyToContent;
  if (estPartageCoffre(replyToType)) return safeboxSharePreview(replyToContent);
  return replyToContent;
}

/** Forme d'erreur du socket (`message:send_failed`). */
const toSocketError = (err) => ({ code: err.code, message: err.message });

module.exports = {
  SAFEBOX_SHARE_TYPE,
  SAFEBOX_SHARE_PREVIEW,
  SafeboxShareMessageError,
  estPartageCoffre,
  tailleLisible,
  resolveSafeboxShareFields,
  safeboxSharePreview,
  sanitizeShareReply,
  toSocketError,
};
