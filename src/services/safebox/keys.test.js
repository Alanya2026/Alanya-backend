/**
 * `node src/services/safebox/keys.test.js` — garde des clés de fichiers sous
 * SAFEBOX_KEY, sans base ni réseau.
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
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
  assert.strictEqual(w.length, 3 + 1 + 12 + 16 + 32);
  assert.strictEqual(w.subarray(0, 3).toString(), 'SK2');
  assert.strictEqual(K.wrappedKeyNumber(w), 1);
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

/** Une enveloppe « SK1 », comme avant le trousseau. */
function enveloppeSK1(fileKey, blobId, master) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(master, 'base64'), iv);
  c.setAAD(Buffer.from(`safebox-blob:${blobId}`));
  const chiffre = Buffer.concat([c.update(fileKey), c.final()]);
  return Buffer.concat([Buffer.from('SK1'), iv, c.getAuthTag(), chiffre]);
}

test('trousseau : les clés « SK1 » d\'avant restent lisibles, sous la clé n° 1', () => {
  const ancienne = enveloppeSK1(cle, 42, env.SAFEBOX_KEY);
  assert.strictEqual(K.wrappedKeyNumber(ancienne), 1);
  assert.ok(K.unwrapFileKey(ancienne, 42, env).equals(cle));
  // Toujours en service : rechiffrée pour passer au format numéroté.
  const neuve = K.rewrapFileKey(ancienne, 42, env);
  assert.strictEqual(neuve.subarray(0, 3).toString(), 'SK2');
  assert.strictEqual(K.rewrapFileKey(neuve, 42, env), null, 'déjà sous la clé en service');
});

test('trousseau : changement de clé maîtresse sans rien perdre', () => {
  const avant = K.wrapFileKey(cle, 42, env);
  const apres = { SAFEBOX_KEY: autre.SAFEBOX_KEY, SAFEBOX_KEY_ID: '2', SAFEBOX_KEY_1: env.SAFEBOX_KEY };
  // L'ancienne se lit encore ; les nouvelles partent sous la n° 2.
  assert.ok(K.unwrapFileKey(avant, 42, apres).equals(cle));
  const neuve = K.wrapFileKey(cle, 7, apres);
  assert.strictEqual(K.wrappedKeyNumber(neuve), 2);
  const rechiffree = K.rewrapFileKey(avant, 42, apres);
  assert.strictEqual(K.wrappedKeyNumber(rechiffree), 2);
  // Une fois tout rechiffré, la n° 1 ne sert plus qu'aux empreintes.
  assert.ok(K.unwrapFileKey(rechiffree, 42, { SAFEBOX_KEY: autre.SAFEBOX_KEY, SAFEBOX_KEY_ID: '2' }).equals(cle));
  // Les empreintes ne bougent pas : la sauvegarde ne renvoie rien.
  assert.strictEqual(K.accountTag(17, apres), K.accountTag(17, env));
  assert.strictEqual(K.sourceFingerprint(17, 'ab'.repeat(32), apres), K.sourceFingerprint(17, 'ab'.repeat(32), env));
});

test('trousseau : une ancienne clé absente rend la clé indisponible, pas un plantage', () => {
  const avant = K.wrapFileKey(cle, 42, env);
  const sansLaUne = { SAFEBOX_KEY: autre.SAFEBOX_KEY, SAFEBOX_KEY_ID: '2' };
  assert.throws(() => K.unwrapFileKey(avant, 42, sansLaUne), K.SafeboxKeyUnavailable);
  assert.throws(() => K.accountTag(17, sansLaUne), K.SafeboxKeyUnavailable);
  assert.strictEqual(K.keyConfigured({ SAFEBOX_KEY: env.SAFEBOX_KEY, SAFEBOX_KEY_ID: '0' }), false);
  assert.strictEqual(K.keyConfigured({ SAFEBOX_KEY: env.SAFEBOX_KEY, SAFEBOX_KEY_ID: 'deux' }), false);
});

test('trousseau : la clé lue dans un fichier (SAFEBOX_KEY_FILE)', () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'cle-coffre-'));
  const chemin = path.join(dossier, 'safebox.key');
  fs.writeFileSync(chemin, `${env.SAFEBOX_KEY}\n`, { mode: 0o600 });
  try {
    const parFichier = { SAFEBOX_KEY_FILE: chemin };
    assert.strictEqual(K.keyConfigured(parFichier), true);
    assert.ok(K.unwrapFileKey(K.wrapFileKey(cle, 42, env), 42, parFichier).equals(cle));
    assert.strictEqual(K.accountTag(17, parFichier), K.accountTag(17, env));
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

console.log(`safebox/keys : ${ok} tests passés`);
