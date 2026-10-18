/**
 * Lecture de l'aperçu d'un fichier du coffre par le serveur (format SBX1, voir
 * l'application : lib/core/services/safebox/safebox_cipher.dart).
 *
 * Le serveur ne déchiffre jamais un fichier : il le laisse au téléphone. La
 * seule exception est l'aperçu (quelques dizaines de Ko) d'un fichier
 * signalé, pour que la modération juge sans télécharger 1 Go (décision du
 * 18/10/2026, point 7 A).
 *
 * Aperçu : un seul morceau AES-256-GCM, étiquette de 16 octets à la fin.
 * Nonce de 12 octets : [domaine = 1][6 × 0][index 0, 4 octets gros-boutiens]
 * [dernier = 1]. Données associées : « SBX1 ».
 */

const crypto = require('crypto');

const AAD = Buffer.from('SBX1', 'ascii');
const TAG = 16;
const DOMAINE_APERCU = 1;

function nonce(index, { last, domain }) {
  const n = Buffer.alloc(12);
  n[0] = domain;
  n.writeUInt32BE(index, 7);
  n[11] = last ? 1 : 0;
  return n;
}

/** L'aperçu en clair. Lève si la clé ou le contenu ne correspondent pas. */
function decryptPreview(fileKey, cipher) {
  if (!Buffer.isBuffer(fileKey) || fileKey.length !== 32) throw new Error('clé de fichier : 32 octets attendus');
  if (!Buffer.isBuffer(cipher) || cipher.length <= TAG) throw new Error('aperçu tronqué');
  const d = crypto.createDecipheriv('aes-256-gcm', fileKey, nonce(0, { last: true, domain: DOMAINE_APERCU }));
  d.setAAD(AAD);
  d.setAuthTag(cipher.subarray(cipher.length - TAG));
  return Buffer.concat([d.update(cipher.subarray(0, cipher.length - TAG)), d.final()]);
}

/** Pour les tests : le même format, dans l'autre sens. */
function encryptPreview(fileKey, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', fileKey, nonce(0, { last: true, domain: DOMAINE_APERCU }));
  c.setAAD(AAD);
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

/** Type d'image d'après ses premiers octets (les aperçus sont JPEG ou PNG). */
function imageMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

module.exports = { decryptPreview, encryptPreview, imageMime, nonce };
