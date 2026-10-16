/**
 * `node src/controllers/admin/safebox.test.js` — validation des réglages du
 * coffre-fort saisis dans l'admin, sans base.
 */

const assert = require('assert');
const { parseSafeboxSettingsPatch: lire } = require('./safebox');

const Gio = 1024 ** 3;
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

test('valeurs normales, nombres ou chaînes de chiffres', () => {
  const r = lire({ base_quota_bytes: 10 * Gio, max_file_bytes: String(Gio), share_downloads_per_day: 5 });
  assert.deepStrictEqual(r, { ok: true, value: { base_quota_bytes: 10 * Gio, max_file_bytes: Gio, share_downloads_per_day: 5 } });
});

test('hors bornes ou mal typées : refusées', () => {
  for (const corps of [
    { base_quota_bytes: -1 },
    { max_depth: 0 },
    { max_depth: 21 },
    { max_folders: 1.5 },
    { share_downloads_per_day: 'trois' },
    { max_file_bytes: 10 }, // moins d'1 Mio
  ]) {
    assert.strictEqual(lire(corps).ok, false, JSON.stringify(corps));
  }
});

test('taille Plus jamais plus petite que la taille standard', () => {
  assert.strictEqual(lire({ max_file_bytes: 2 * Gio, max_file_bytes_plus: Gio }).ok, false);
  assert.strictEqual(lire({ max_file_bytes: Gio, max_file_bytes_plus: 2 * Gio }).ok, true);
});

test('extensions : familles connues, minuscules, sans point, sans doublon ; null = celles du code', () => {
  const r = lire({ extensions: { albums: ['.JPG', 'png', 'jpg'] } });
  assert.deepStrictEqual(r.value.extensions, { albums: ['jpg', 'png'] });
  assert.deepStrictEqual(lire({ extensions: null }).value, { extensions: null });
  assert.strictEqual(lire({ extensions: { photos: ['jpg'] } }).ok, false);
  assert.strictEqual(lire({ extensions: { albums: ['j p g'] } }).ok, false);
  assert.strictEqual(lire({ extensions: ['jpg'] }).ok, false);
});

test('rien à modifier : refusé', () => {
  assert.strictEqual(lire({}).ok, false);
  assert.strictEqual(lire({ inconnu: 3 }).ok, false);
});

console.log(`admin/safebox : ${ok} tests passés`);
