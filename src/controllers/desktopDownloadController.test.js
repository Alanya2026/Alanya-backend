/**
 * Page de téléchargement du coffre de bureau —
 * `node src/controllers/desktopDownloadController.test.js`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'coffre-dl-'));
process.env.DESKTOP_DOWNLOADS_DIR = dossier;
const { showDesktopPage, showVersion, sendFile, valider } = require('./desktopDownloadController');

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

const fauxRes = () => ({
  code: 200,
  corps: null,
  json_: null,
  envoi: null,
  headers: {},
  set(k, v) { this.headers[k] = v; return this; },
  type() { return this; },
  status(c) { this.code = c; return this; },
  send(c) { this.corps = c; return this; },
  json(j) { this.json_ = j; return this; },
  download(p, nom) { this.envoi = { p, nom }; return this; },
});
const appeler = (h, req) => { const res = fauxRes(); h({ query: {}, headers: {}, params: {}, ...req }, res); return res; };

const ecrireVersion = (j) => {
  const f = path.join(dossier, 'version.json');
  fs.writeFileSync(f, JSON.stringify(j));
  // mtime différent à chaque écriture : le cache relit.
  const t = new Date(Date.now() + Math.floor(Math.random() * 1e6));
  fs.utimesSync(f, t, t);
};

test('sans version publiée : « bientôt disponible », version.json en 404', () => {
  const page = appeler(showDesktopPage, {});
  assert.match(page.corps, /Bientôt disponible/);
  assert.match(page.corps, /Lier un nouvel appareil/);
  assert.strictEqual(appeler(showVersion, {}).code, 404);
});

const VERSION = {
  version: '1.0.0',
  date: '2026-11-13',
  notes: { fr: 'Première version.', en: 'First release.' },
  windows: { file: 'AlanyaCoffre-Setup-1.0.0.exe', bytes: 25 * 1024 * 1024, sha256: 'a'.repeat(64) },
  deb: { file: 'alanya-coffre_1.0.0_amd64.deb', bytes: 9 * 1024 * 1024, sha256: 'b'.repeat(64) },
  appimage: { file: 'AlanyaCoffre-1.0.0.AppImage', bytes: 30 * 1024 * 1024, sha256: 'c'.repeat(64) },
};

test('avec une version : boutons, tailles, SmartScreen expliqué, en français et en anglais', () => {
  ecrireVersion(VERSION);
  const fr = appeler(showDesktopPage, {}).corps;
  assert.match(fr, /href="\/coffre\/files\/AlanyaCoffre-Setup-1\.0\.0\.exe"/);
  assert.match(fr, /Télécharger pour Windows · 25 Mo/);
  assert.match(fr, /Exécuter quand même/);
  assert.match(fr, /Version 1\.0\.0 · 2026-11-13/);
  const en = appeler(showDesktopPage, { query: { lang: 'en' } }).corps;
  assert.match(en, /Download for Windows · 25 MB/);
  assert.match(en, /Run anyway/);
  assert.strictEqual(appeler(showVersion, {}).json_.version, '1.0.0');
});

test('seuls les fichiers annoncés se téléchargent', () => {
  ecrireVersion(VERSION);
  const bon = appeler(sendFile, { params: { nom: 'alanya-coffre_1.0.0_amd64.deb' } });
  assert.strictEqual(bon.envoi.p, path.join(dossier, 'alanya-coffre_1.0.0_amd64.deb'));
  for (const nom of ['version.json', '../server.js', '..', 'autre.exe', '.env']) {
    assert.strictEqual(appeler(sendFile, { params: { nom } }).code, 404, nom);
  }
});

test('un version.json piégé est assaini', () => {
  const v = valider({ ...VERSION, windows: { file: '../../.env', bytes: 1 }, notes: { fr: '<script>x</script>' } });
  assert.strictEqual(v.windows, null);
  ecrireVersion({ ...VERSION, notes: { fr: '<script>alert(1)</script>' } });
  const page = appeler(showDesktopPage, {}).corps;
  assert.doesNotMatch(page, /<script>alert/);
  assert.strictEqual(valider({ version: '1.0' }), null);
});

fs.rmSync(dossier, { recursive: true, force: true });
console.log(`${ok} tests réussis`);
