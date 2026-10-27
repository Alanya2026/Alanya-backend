/**
 * Documents sensibles — champs d'envoi et contrôles partagés par
 * `message:send` (socket) et `POST /api/conversations/:id/messages` (HTTP).
 * Plan : PLAN-DOCUMENTS-SENSIBLES.md.
 *
 * ── Ce que le serveur sait, et ce qu'il ne sait pas ──
 *
 * `isSensitive` : il le lit, car c'est lui qui refuse le transfert d'un
 * document sensible et l'écarte des galeries.
 *
 * `mediaProtection` : il ne le lit PAS. C'est le descripteur que l'expéditeur
 * écrit (`{sensible, protection?}`, mêmes clés que le descripteur chiffré
 * d'Alanya Work) ; le serveur en borne la taille, vérifie que c'est un objet,
 * puis le stocke et le relaie tel quel. Dans un message chiffré, il n'a rien à
 * faire ici : il voyage dans l'enveloppe.
 */

/** Types qui portent un fichier : image, vidéo, audio, document. */
const TYPES_SENSIBLES = new Set([1, 2, 3, 4]);

/** Le descripteur sérialisé ne dépasse pas cette taille. */
const PROTECTION_MAX_OCTETS = 2048;

/** 128 bits en hexadécimal minuscule, comme `SignatureSortie.nouveauCode`. */
const EMPREINTE_RE = /^[0-9a-f]{32}$/;

const GESTES = new Set(['CONSULTATION', 'TELECHARGEMENT', 'PARTAGE', 'TRANSFERT']);

class DocumentSensibleInvalide extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_PAYLOAD';
    this.status = 400;
  }
}

function _vrai(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * Lit `isSensitive` et `mediaProtection` d'un envoi.
 *
 * @returns {{isSensitive: boolean, mediaProtection: string|null}}
 *   `mediaProtection` déjà sérialisé, prêt pour la colonne JSON.
 * @throws {DocumentSensibleInvalide}
 */
function normaliseSensible({ isSensitive, mediaProtection, type, chiffre }) {
  if (!_vrai(isSensitive)) {
    // Un descripteur sans le drapeau serait un message ordinaire qui
    // transporte des données que personne ne lira : refusé plutôt qu'ignoré.
    if (mediaProtection != null) {
      throw new DocumentSensibleInvalide('mediaProtection sans isSensitive');
    }
    return { isSensitive: false, mediaProtection: null };
  }
  if (!TYPES_SENSIBLES.has(Number(type))) {
    throw new DocumentSensibleInvalide('seul un fichier peut être sensible');
  }
  if (mediaProtection == null) return { isSensitive: true, mediaProtection: null };
  if (chiffre) {
    throw new DocumentSensibleInvalide('mediaProtection voyage dans l\'enveloppe d\'un message chiffré');
  }

  let objet = mediaProtection;
  if (typeof objet === 'string') {
    try {
      objet = JSON.parse(objet);
    } catch (_) {
      throw new DocumentSensibleInvalide('mediaProtection illisible');
    }
  }
  if (objet === null || typeof objet !== 'object' || Array.isArray(objet)) {
    throw new DocumentSensibleInvalide('mediaProtection doit être un objet');
  }
  const json = JSON.stringify(objet);
  if (Buffer.byteLength(json, 'utf8') > PROTECTION_MAX_OCTETS) {
    throw new DocumentSensibleInvalide('mediaProtection trop volumineux');
  }
  return { isSensitive: true, mediaProtection: json };
}

/** `null` si l'empreinte est absente ; lève si elle est mal formée. */
function normaliseEmpreinte(brut) {
  if (brut == null || brut === '') return null;
  const e = String(brut).replace(/\s+/g, '').toLowerCase();
  if (!EMPREINTE_RE.test(e)) {
    throw new DocumentSensibleInvalide('empreinte mal formée');
  }
  return e;
}

module.exports = {
  TYPES_SENSIBLES,
  PROTECTION_MAX_OCTETS,
  EMPREINTE_RE,
  GESTES,
  DocumentSensibleInvalide,
  normaliseSensible,
  normaliseEmpreinte,
};
