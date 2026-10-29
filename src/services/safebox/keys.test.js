/**
 * `node src/services/safebox/keys.test.js` — garde des clés de fichiers sous
 * SAFEBOX_KEY, sans base ni réseau.
 */

const assert = require('assert');
const crypto = require('crypto');
const K = require('./keys');

let ok = 0;
const test = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.stack}`);
    process.exitCode = 1;
  }
};

const env = { SAFEBOX_KEY: crypto.randomBytes(32).toString('base64') };
const autre = { SAFEBOX_KEY: crypto.randomBytes(32).toString('base64') };
const cle = crypto.randomBytes(32);

test('aller-retour', () => {
  const w = K.wrapFileKey(cle, 42, env);
  assert.strictEqual(w.length, 3 + 12 + 16 + 32);
  assert.strictEqual(w.subarray(0, 3).toString(), 'SK1');
  assert.ok(K.unwrapFileKey(w, 42, env).equals(cle));
  // IV neuf à chaque fois.
  assert.ok(!K.wrapFileKey(cle, 42, env).equals(w));
});

test('liée à son blob : recopiée sur un autre, refusée', () => {
  const w = K.wrapFileKey(cle, 42, env);
  assert.throws(() => K.unwrapFileKey(w, 43, env));
});

test('altérée, ou sous une autre clé maîtresse : refusée', () => {
  const w = K.wrapFileKey(cle, 1, env);
  const abime = Buffer.from(w);
  abime[abime.length - 1] ^= 1;
  assert.throws(() => K.unwrapFileKey(abime, 1, env));
  assert.throws(() => K.unwrapFileKey(w, 1, autre));
  assert.throws(() => K.unwrapFileKey(Buffer.alloc(10), 1, env), /format inconnu/);
});

test('clé maîtresse absente ou invalide : indisponible, pas planté', () => {
  assert.strictEqual(K.keyConfigured({}), false);
  assert.strictEqual(K.keyConfigured({ SAFEBOX_KEY: 'trop-court' }), false);
  assert.strictEqual(K.keyConfigured(env), true);
  assert.throws(() => K.wrapFileKey(cle, 1, {}), K.SafeboxKeyUnavailable);
  assert.throws(() => K.wrapFileKey(cle, 1, { SAFEBOX_KEY: 'trop-court' }), K.SafeboxKeyUnavailable);
  assert.throws(() => K.wrapFileKey(Buffer.alloc(16), 1, env), TypeError);
});

test('empreinte de compte : stable, opaque, propre à chaque compte', () => {
  const a = K.accountTag(17, env);
  assert.match(a, /^[0-9a-f]{20}$/);
  assert.strictEqual(K.accountTag(17, env), a);
  assert.notStrictEqual(K.accountTag(18, env), a);
  // Sous une autre clé maîtresse, une autre empreinte : rien ne se devine.
  assert.notStrictEqual(K.accountTag(17, autre), a);
});

test('empreinte d\'un original : liée au compte, stable, opaque (lot 10)', () => {
  const fp = 'ab'.repeat(32);
  const a = K.sourceFingerprint(17, fp, env);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.strictEqual(K.sourceFingerprint(17, fp, env), a);
  assert.notStrictEqual(K.sourceFingerprint(18, fp, env), a, 'le même fichier chez un autre compte');
  assert.notStrictEqual(a, fp, 'ne redit pas l\'empreinte du téléphone');
});

console.log(`safebox/keys : ${ok} tests passés`);
