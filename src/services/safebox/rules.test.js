/**
 * `node src/services/safebox/rules.test.js` — règles du coffre-fort, sans base
 * ni réseau.
 */

const assert = require('assert');
const R = require('./rules');
const { SafeboxError } = require('./errors');
const { DEFAULT_EXTENSIONS, Mio, Gio } = require('../../constants/safebox');

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
const refuse = (fn, code) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SafeboxError, `SafeboxError attendue, reçu ${e}`);
    assert.strictEqual(e.code, code);
    return e;
  }
  throw new Error(`${code} attendu, rien levé`);
};

const EXT = R.extensionsFrom(null);

test('nom : bords retirés, forme Unicode normalisée', () => {
  assert.strictEqual(R.normalizeName('  Mariage  ', 80), 'Mariage');
  // « É » et « é » écrits en deux points de code (lettre + accent) deviennent un seul.
  assert.strictEqual(R.normalizeName('E\u0301te\u0301', 80), '\u00c9t\u00e9');
});

test('nom : vide, « . », « .. », séparateurs et contrôles refusés', () => {
  for (const n of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a\nb', 'a\u0000b', null, 42]) {
    refuse(() => R.normalizeName(n, 80), 'SAFEBOX_INVALID_NAME');
  }
});

test('nom : longueur comptée en caractères, pas en octets', () => {
  assert.strictEqual(R.normalizeName('é'.repeat(80), 80).length, 80);
  const e = refuse(() => R.normalizeName('a'.repeat(81), 80), 'SAFEBOX_INVALID_NAME');
  assert.strictEqual(e.extra.max, 80);
});

test('extension : minuscules, sans point ; aucune pour un fichier caché ou douteux', () => {
  assert.strictEqual(R.extensionOf('Photo.JPG'), 'jpg');
  assert.strictEqual(R.extensionOf('archive.tar.gz'), 'gz');
  assert.strictEqual(R.extensionOf('.profil'), '');
  assert.strictEqual(R.extensionOf('sans-extension'), '');
  assert.strictEqual(R.extensionOf('fin.'), '');
  assert.strictEqual(R.extensionOf('x.extensiontroplongue'), '');
  assert.strictEqual(R.extensionOf('x.é'), '');
});

test('famille : par extension (décision du 15/10/2026)', () => {
  assert.strictEqual(R.familyOf('jpg', EXT), 'albums');
  assert.strictEqual(R.familyOf('heic', EXT), 'albums');
  assert.strictEqual(R.familyOf('mp4', EXT), 'videos');
  assert.strictEqual(R.familyOf('opus', EXT), 'audios');
  assert.strictEqual(R.familyOf('pdf', EXT), 'documents');
  // Un scan en .tiff est un document, pas une photo.
  assert.strictEqual(R.familyOf('tiff', EXT), 'documents');
  // Inconnue ou absente : documents.
  assert.strictEqual(R.familyOf('xyz', EXT), 'documents');
  assert.strictEqual(R.familyOf('', EXT), 'documents');
});

test('famille : un fichier dans le mauvais dossier est refusé, avec le bon dossier', () => {
  assert.deepStrictEqual(R.assertFamily('albums', 'carte.jpg', EXT), { ext: 'jpg', famille: 'albums' });
  const e = refuse(() => R.assertFamily('albums', 'acte.pdf', EXT), 'SAFEBOX_WRONG_FAMILY');
  assert.strictEqual(e.extra.expectedRoot, 'documents');
  refuse(() => R.assertFamily('documents', 'photo.jpg', EXT), 'SAFEBOX_WRONG_FAMILY');
  assert.strictEqual(R.assertFamily('documents', 'LISEZMOI', EXT).famille, 'documents');
});

test('extensions : surcharge par famille, les autres gardent celles du code', () => {
  const e = R.extensionsFrom({ albums: ['.JPG', 'png', 'n\'importe quoi'] });
  assert.deepStrictEqual(e.albums, ['jpg', 'png']);
  assert.deepStrictEqual(e.videos, [...DEFAULT_EXTENSIONS.videos]);
  // JSON lu tel quel en base, ou illisible.
  assert.deepStrictEqual(R.extensionsFrom('{"audios":["mp3"]}').audios, ['mp3']);
  assert.deepStrictEqual(R.extensionsFrom('pas du json').audios, [...DEFAULT_EXTENSIONS.audios]);
  // Une liste vide ne vide pas la famille.
  assert.deepStrictEqual(R.extensionsFrom({ albums: [] }).albums, [...DEFAULT_EXTENSIONS.albums]);
});

test('tailles : taille chiffrée cohérente avec la taille en clair', () => {
  const t = R.validateSizes({ size: 1_000_100, plainSize: 1_000_000, previewSize: 40_000 }, { maxFileBytes: Gio });
  assert.deepStrictEqual(t, { size: 1_000_100, plainSize: 1_000_000, previewSize: 40_000, originalSize: null });
  // Chaînes de chiffres acceptées (corps JSON mal typé par un client).
  assert.strictEqual(R.validateSizes({ size: '10', plainSize: '10' }, { maxFileBytes: Gio }).size, 10);
  refuse(() => R.validateSizes({ size: 900, plainSize: 1000 }, { maxFileBytes: Gio }), 'SAFEBOX_INVALID_SIZE');
  refuse(() => R.validateSizes({ size: 10 * Mio, plainSize: Mio }, { maxFileBytes: Gio }), 'SAFEBOX_INVALID_SIZE');
  refuse(() => R.validateSizes({ size: 0, plainSize: 0 }, { maxFileBytes: Gio }), 'SAFEBOX_INVALID_SIZE');
  refuse(() => R.validateSizes({ size: 1.5, plainSize: 1 }, { maxFileBytes: Gio }), 'SAFEBOX_INVALID_SIZE');
  refuse(() => R.validateSizes({ size: 10, plainSize: 10, previewSize: 300 * 1024 }, { maxFileBytes: Gio }), 'SAFEBOX_INVALID_SIZE');
});

test('tailles : 1 Go en clair passe, malgré le surcoût du chiffrement ; au-delà, 413', () => {
  assert.strictEqual(R.validateSizes({ size: Gio + 16 * 1024, plainSize: Gio }, { maxFileBytes: Gio }).plainSize, Gio);
  const e = refuse(() => R.validateSizes({ size: Gio + 2, plainSize: Gio + 1 }, { maxFileBytes: Gio }), 'SAFEBOX_FILE_TOO_LARGE');
  assert.strictEqual(e.status, 413);
  assert.strictEqual(e.extra.maxBytes, Gio);
});

test('format de chiffrement', () => {
  assert.strictEqual(R.validateCipherFormat(' E2C1 '), 'E2C1');
  refuse(() => R.validateCipherFormat(''), 'SAFEBOX_INVALID_CIPHER');
  refuse(() => R.validateCipherFormat('a b'), 'SAFEBOX_INVALID_CIPHER');
});

test('blocs : nombre, taille du dernier, noms', () => {
  const bloc = 8 * Mio;
  assert.strictEqual(R.blockCount(1, bloc), 1);
  assert.strictEqual(R.blockCount(bloc, bloc), 1);
  assert.strictEqual(R.blockCount(bloc + 1, bloc), 2);
  assert.strictEqual(R.blockCount(Gio, bloc), 128);
  const geo = { size: 2 * bloc + 5, blockSize: bloc, count: 3 };
  assert.strictEqual(R.blockSizeOf(1, geo), bloc);
  assert.strictEqual(R.blockSizeOf(3, geo), 5);
  assert.throws(() => R.blockSizeOf(4, geo), RangeError);
  assert.strictEqual(R.blockKey('u/abc/x/', 7), 'u/abc/x/00007');
  assert.strictEqual(R.blockNumberOf('u/abc/x/', 'u/abc/x/00007'), 7);
  assert.strictEqual(R.blockNumberOf('u/abc/x/', 'u/abc/x/apercu'), null);
  assert.strictEqual(R.blockNumberOf('u/abc/x/', 'u/abc/y/00001'), null);
});

test('blocs : un bloc de mauvaise taille compte comme manquant', () => {
  const p = 'u/t/f/';
  const geo = { prefix: p, size: 25, blockSize: 10, count: 3, previewSize: 4 };
  const etat = R.compareBlocks([
    { key: `${p}00001`, size: 10 },
    { key: `${p}00002`, size: 9 }, // tronqué
    { key: `${p}00003`, size: 5 },
    { key: `${p}00004`, size: 10 }, // hors plan
    { key: `${p}apercu`, size: 4 },
  ], geo);
  assert.deepStrictEqual(etat, { recus: [1, 3], manquants: [2], apercuManquant: false });
  assert.strictEqual(R.compareBlocks([], geo).apercuManquant, true);
  assert.strictEqual(R.compareBlocks([], { ...geo, previewSize: 0 }).apercuManquant, false);
});

test('ascendance des dossiers', () => {
  assert.strictEqual(R.childPath('/1/', 5), '/1/5/');
  assert.ok(R.isWithin('/1/5/9/', '/1/5/'));
  assert.ok(R.isWithin('/1/5/', '/1/5/'));
  // /1/50/ n'est pas sous /1/5/ : la barre finale l'empêche.
  assert.ok(!R.isWithin('/1/50/', '/1/5/'));
});

test('nom libre : « (2) », extension gardée, casse ignorée', () => {
  assert.strictEqual(R.freeName('Mariage', [], 80), 'Mariage');
  assert.strictEqual(R.freeName('Mariage', ['mariage'], 80), 'Mariage (2)');
  assert.strictEqual(R.freeName('Mariage', ['Mariage', 'Mariage (2)'], 80), 'Mariage (3)');
  assert.strictEqual(R.freeName('photo.jpg', ['photo.jpg'], 180), 'photo (2).jpg');
  const long = 'a'.repeat(80);
  assert.strictEqual([...R.freeName(long, [long], 80)].length, 80);
});

test('identifiants et clé de fichier', () => {
  assert.strictEqual(R.parseId('12'), 12);
  assert.strictEqual(R.parseId(12), 12);
  for (const v of ['0', '-1', '1.5', 'abc', '', null, undefined]) assert.strictEqual(R.parseId(v), null);
  const cle = Buffer.alloc(32, 7);
  assert.ok(R.decodeFileKey(cle.toString('base64')).equals(cle));
  assert.ok(R.decodeFileKey(cle.toString('base64url')).equals(cle));
  refuse(() => R.decodeFileKey(Buffer.alloc(16).toString('base64')), 'SAFEBOX_INVALID_KEY');
  refuse(() => R.decodeFileKey('pas une clé !'), 'SAFEBOX_INVALID_KEY');
});

test('espace : la réservation doit tenir', () => {
  assert.ok(R.fitsQuota({ usedBytes: 9 * Gio, quotaBytes: 10 * Gio, addBytes: Gio }));
  assert.ok(!R.fitsQuota({ usedBytes: 9 * Gio, quotaBytes: 10 * Gio, addBytes: Gio + 1 }));
});

console.log(`safebox/rules : ${ok} tests passés`);
