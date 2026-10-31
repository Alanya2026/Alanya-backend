/**
 * Clés des fichiers du coffre-fort.
 *
 * Le téléphone chiffre chaque fichier sous une clé tirée au hasard (MEGA S4 ne
 * chiffre rien). Le serveur garde cette clé, elle-même chiffrée sous la clé
 * maîtresse (32 octets en base64, jamais en base) : l'inscrit retrouve son
 * coffre sur un nouveau téléphone sans rien avoir à retenir. Décision du
 * 15/10/2026 — ce n'est pas du bout en bout, la politique de confidentialité
 * doit le dire.
 *
 * Le trousseau (30/10/2026) : les clés maîtresses sont numérotées, pour
 * pouvoir en changer (fuite, départ d'un administrateur) sans perdre les
 * coffres.
 *   SAFEBOX_KEY (ou SAFEBOX_KEY_FILE, chemin d'un fichier qui la contient,
 *   lisible du seul compte du serveur) : la clé en service, numéro
 *   SAFEBOX_KEY_ID (1 par défaut). Toute clé nouvelle est chiffrée sous elle.
 *   SAFEBOX_KEY_<n> (ou SAFEBOX_KEY_<n>_FILE) : une ancienne clé, gardée tant
 *   que des clés de fichiers sont chiffrées sous elle
 *   (scripts/maintenance/safebox-rechiffrer-cles.js les passe sous la clé en
 *   service).
 *
 * Les empreintes (comptes chez MEGA, originaux de la sauvegarde automatique)
 * restent calculées sous la clé n° 1 : en changer ferait tout renvoyer par la
 * sauvegarde. Elle reste donc au trousseau après un changement, sauf fuite
 * (voir docs/conception/coffre-fort.html, section des clés).
 *
 * Formats :
 *   « SK1 » (3) · IV (12) · tag GCM (16) · clé chiffrée (32) — sous la clé n° 1 ;
 *   « SK2 » (3) · numéro de la clé maîtresse (1) · IV · tag · clé chiffrée.
 * La clé enveloppée est liée à son bloc (`safebox_blob.id`, données associées
 * GCM) : recopiée sur un autre bloc, elle est refusée.
 *
 * ⚠ Perdre une clé du trousseau rend illisibles les coffres chiffrés sous elle.
 */

const crypto = require('crypto');
const fs = require('fs');

const SK1 = Buffer.from('SK1');
const SK2 = Buffer.from('SK2');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const NUMERO_EMPREINTES = 1;

class SafeboxKeyUnavailable extends Error {
  constructor(message = 'SAFEBOX_KEY absente') {
    super(message);
    this.name = 'SafeboxKeyUnavailable';
  }
}

/** Fichiers de clés déjà lus : le chemin ne change pas sans redémarrage. */
const fichiersLus = new Map();

function lireFichier(chemin) {
  if (!fichiersLus.has(chemin)) fichiersLus.set(chemin, fs.readFileSync(chemin, 'utf8'));
  return fichiersLus.get(chemin);
}

/** Une clé du trousseau, ou null si absente. Lève si elle est posée mais invalide. */
function cleDe(nom, env) {
  const chemin = (env[`${nom}_FILE`] || '').trim();
  const raw = (chemin ? lireFichier(chemin) : env[nom] || '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`${nom} doit faire 32 octets en base64 (openssl rand -base64 32)`);
  }
  return key;
}

function numeroCourant(env) {
  const n = Number(env.SAFEBOX_KEY_ID || 1);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error('SAFEBOX_KEY_ID : un entier de 1 à 255');
  return n;
}

/** La clé maîtresse en service, ou null si absente. Lève si elle est posée mais invalide. */
function masterKey(env = process.env) {
  numeroCourant(env);
  return cleDe('SAFEBOX_KEY', env);
}

function keyConfigured(env = process.env) {
  try {
    return Boolean(masterKey(env));
  } catch {
    return false;
  }
}

function indisponible(fn) {
  let key;
  try {
    key = fn();
  } catch (e) {
    throw new SafeboxKeyUnavailable(e.message);
  }
  return key;
}

/** La clé numéro [n] : celle en service, ou une ancienne du trousseau. */
function cleNumero(n, env) {
  return indisponible(() => {
    const key = n === numeroCourant(env) ? cleDe('SAFEBOX_KEY', env) : cleDe(`SAFEBOX_KEY_${n}`, env);
    if (!key) throw new Error(n === numeroCourant(env) ? 'SAFEBOX_KEY absente' : `SAFEBOX_KEY_${n} absente du trousseau`);
    return key;
  });
}

const aad = (blobId) => Buffer.from(`safebox-blob:${blobId}`);

/** Chiffre la clé d'un fichier pour la ranger en base, sous la clé en service. */
function wrapFileKey(fileKey, blobId, env = process.env) {
  if (!Buffer.isBuffer(fileKey) || fileKey.length !== KEY_BYTES) {
    throw new TypeError('clé de fichier : 32 octets attendus');
  }
  const n = indisponible(() => numeroCourant(env));
  const master = cleNumero(n, env);
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', master, iv);
  c.setAAD(aad(blobId));
  const chiffre = Buffer.concat([c.update(fileKey), c.final()]);
  return Buffer.concat([SK2, Buffer.from([n]), iv, c.getAuthTag(), chiffre]);
}

/** Le numéro de la clé maîtresse d'une enveloppe, et où commence son IV. */
function lireEnveloppe(wrapped) {
  const buf = Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped || []);
  const corps = IV_BYTES + TAG_BYTES + KEY_BYTES;
  if (buf.length === SK1.length + corps && buf.subarray(0, 3).equals(SK1)) {
    return { buf, numero: NUMERO_EMPREINTES, debut: 3 };
  }
  if (buf.length === SK2.length + 1 + corps && buf.subarray(0, 3).equals(SK2)) {
    return { buf, numero: buf[3], debut: 4 };
  }
  throw new Error('clé de fichier enveloppée : format inconnu');
}

/** Rend la clé d'un fichier. Lève si l'enveloppe est altérée ou d'un autre bloc. */
function unwrapFileKey(wrapped, blobId, env = process.env) {
  const { buf, numero, debut } = lireEnveloppe(wrapped);
  const iv = buf.subarray(debut, debut + IV_BYTES);
  const tag = buf.subarray(debut + IV_BYTES, debut + IV_BYTES + TAG_BYTES);
  const d = crypto.createDecipheriv('aes-256-gcm', cleNumero(numero, env), iv);
  d.setAAD(aad(blobId));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(debut + IV_BYTES + TAG_BYTES)), d.final()]);
}

/** Numéro de la clé maîtresse sous laquelle une clé de fichier est rangée. */
function wrappedKeyNumber(wrapped) {
  return lireEnveloppe(wrapped).numero;
}

/** La même clé de fichier sous la clé en service, ou null si elle y est déjà. */
function rewrapFileKey(wrapped, blobId, env = process.env) {
  const { numero, debut } = lireEnveloppe(wrapped);
  if (debut === 4 && numero === numeroCourant(env)) return null;
  return wrapFileKey(unwrapFileKey(wrapped, blobId, env), blobId, env);
}

/** La clé des empreintes : la n° 1, qui ne change pas. */
const cleEmpreintes = (env) => cleNumero(NUMERO_EMPREINTES, env);

/**
 * Empreinte opaque d'un compte, pour nommer ses objets chez MEGA sans y
 * écrire son identifiant : `u/<empreinte>/<uuid>/00001`.
 */
function accountTag(alanyaID, env = process.env) {
  return crypto.createHmac('sha256', cleEmpreintes(env))
    .update(`safebox-account:${alanyaID}`)
    .digest('hex')
    .slice(0, 20);
}

/**
 * Empreinte de l'original d'un fichier, liée au compte (lot 10) : le
 * téléphone envoie l'empreinte de son fichier, le serveur garde celle-ci.
 * Deux comptes qui sauvegardent la même photo n'ont pas la même, et elle ne
 * permet pas de reconnaître un fichier connu.
 */
function sourceFingerprint(alanyaID, fp, env = process.env) {
  return crypto.createHmac('sha256', cleEmpreintes(env))
    .update(`safebox-source:${alanyaID}:${fp}`)
    .digest('hex');
}

module.exports = {
  SafeboxKeyUnavailable,
  sourceFingerprint,
  keyConfigured,
  wrapFileKey,
  unwrapFileKey,
  wrappedKeyNumber,
  rewrapFileKey,
  accountTag,
};
