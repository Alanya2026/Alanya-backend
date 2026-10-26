/**
 * Clés des fichiers du coffre-fort.
 *
 * Le téléphone chiffre chaque fichier sous une clé tirée au hasard (MEGA S4 ne
 * chiffre rien). Le serveur garde cette clé, elle-même chiffrée sous la clé
 * maîtresse `SAFEBOX_KEY` (32 octets en base64, posée dans le .env, jamais en
 * base) : l'inscrit retrouve son coffre sur un nouveau téléphone sans rien
 * avoir à retenir. Décision du 15/10/2026 — ce n'est pas du bout en bout, la
 * politique de confidentialité doit le dire.
 *
 * Format : « SK1 » (3 octets) · IV (12) · tag GCM (16) · clé chiffrée (32).
 * La clé enveloppée est liée à son bloc (`safebox_blob.id`, données associées
 * GCM) : recopiée sur un autre bloc, elle est refusée.
 *
 * ⚠ Perdre `SAFEBOX_KEY` rend tous les coffres illisibles. La changer exige un
 * script qui rechiffre toutes les clés : elle n'a pas de numéro de version.
 */

const crypto = require('crypto');

const MAGIC = Buffer.from('SK1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

class SafeboxKeyUnavailable extends Error {
  constructor(message = 'SAFEBOX_KEY absente') {
    super(message);
    this.name = 'SafeboxKeyUnavailable';
  }
}

/** La clé maîtresse, ou null si absente. Lève si elle est posée mais invalide. */
function masterKey(env = process.env) {
  const raw = (env.SAFEBOX_KEY || '').trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('SAFEBOX_KEY doit faire 32 octets en base64 (openssl rand -base64 32)');
  }
  return key;
}

function keyConfigured(env = process.env) {
  try {
    return Boolean(masterKey(env));
  } catch {
    return false;
  }
}

function requireMaster(env) {
  let key;
  try {
    key = masterKey(env);
  } catch (e) {
    throw new SafeboxKeyUnavailable(e.message);
  }
  if (!key) throw new SafeboxKeyUnavailable();
  return key;
}

const aad = (blobId) => Buffer.from(`safebox-blob:${blobId}`);

/** Chiffre la clé d'un fichier pour la ranger en base. */
function wrapFileKey(fileKey, blobId, env = process.env) {
  if (!Buffer.isBuffer(fileKey) || fileKey.length !== KEY_BYTES) {
    throw new TypeError('clé de fichier : 32 octets attendus');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const c = crypto.createCipheriv('aes-256-gcm', requireMaster(env), iv);
  c.setAAD(aad(blobId));
  const chiffre = Buffer.concat([c.update(fileKey), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), chiffre]);
}

/** Rend la clé d'un fichier. Lève si l'enveloppe est altérée ou d'un autre bloc. */
function unwrapFileKey(wrapped, blobId, env = process.env) {
  const buf = Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped || []);
  if (buf.length !== MAGIC.length + IV_BYTES + TAG_BYTES + KEY_BYTES
      || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('clé de fichier enveloppée : format inconnu');
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buf.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const d = crypto.createDecipheriv('aes-256-gcm', requireMaster(env), iv);
  d.setAAD(aad(blobId));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(MAGIC.length + IV_BYTES + TAG_BYTES)), d.final()]);
}

/**
 * Empreinte opaque d'un compte, pour nommer ses objets chez MEGA sans y
 * écrire son identifiant : `u/<empreinte>/<uuid>/00001`.
 */
function accountTag(alanyaID, env = process.env) {
  return crypto.createHmac('sha256', requireMaster(env))
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
  return crypto.createHmac('sha256', requireMaster(env))
    .update(`safebox-source:${alanyaID}:${fp}`)
    .digest('hex');
}

module.exports = {
  SafeboxKeyUnavailable,
  sourceFingerprint,
  keyConfigured,
  wrapFileKey,
  unwrapFileKey,
  accountTag,
};
