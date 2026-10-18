/**
 * `node src/services/safebox/cipher.test.js` — le serveur lit l'aperçu
 * exactement comme le téléphone l'a chiffré (format SBX1).
 */

const assert = require('assert');
const crypto = require('crypto');
const C = require('./cipher');

let ok = 0;
const test = (nom, fn) => { fn(); ok += 1; };

// Produit par l'application (safeboxEncryptPreviewSync), clé = octets 0 à 31.
const VECTEUR_APP = '46b90f5a731b94ab7ba5c553b81cc13480b3c643728d468470398a354c9cb3faf51053fadc6ee60b16f8';
const cle = Buffer.from([...Array(32).keys()]);

test('un aperçu chiffré par l\'application se lit sur le serveur', () => {
  assert.strictEqual(C.decryptPreview(cle, Buffer.from(VECTEUR_APP, 'hex')).toString('utf8'), 'Alanya : aperçu du coffre');
});

test('mêmes octets que l\'application dans l\'autre sens', () => {
  assert.strictEqual(C.encryptPreview(cle, Buffer.from('Alanya : aperçu du coffre', 'utf8')).toString('hex'), VECTEUR_APP);
});

test('autre clé, octet altéré, aperçu tronqué : refusé', () => {
  const chiffre = Buffer.from(VECTEUR_APP, 'hex');
  assert.throws(() => C.decryptPreview(crypto.randomBytes(32), chiffre));
  const altere = Buffer.from(chiffre);
  altere[3] ^= 1;
  assert.throws(() => C.decryptPreview(cle, altere));
  assert.throws(() => C.decryptPreview(cle, chiffre.subarray(0, 10)), /tronqué/);
  assert.throws(() => C.decryptPreview(Buffer.alloc(16), chiffre), /32 octets/);
});

test('type d\'image reconnu à ses premiers octets', () => {
  assert.strictEqual(C.imageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])), 'image/jpeg');
  assert.strictEqual(C.imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.strictEqual(C.imageMime(Buffer.from('pas une image')), null);
});

console.log(`safebox/cipher : ${ok} tests passés`);
