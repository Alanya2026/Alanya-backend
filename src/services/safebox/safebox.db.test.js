/**
 * Le coffre-fort contre une VRAIE base, MEGA S4 remplacé par un faux stockage
 * en mémoire — `npm run test:safebox:db`.
 *
 * ⚠ Le .env de ce dépôt vise la base de production. Ce test refuse de tourner
 * ailleurs que sur une base jetable : DB_HOST local, DB_NAME finissant par
 * `_test`. Il lui faut les tables `users` et `scheduler_leases`, puis la
 * migration 101. Base jetable (MySQL 8, dossier temporaire D) :
 *
 *   mysqld --no-defaults --initialize-insecure --datadir=D/data
 *   cd D && mysqld --no-defaults --datadir=D/data --socket=m.sock \
 *     --port=33071 --bind-address=127.0.0.1 --mysqlx=OFF &
 *   mysql --no-defaults -h127.0.0.1 -P33071 -uroot -e "
 *     ALTER USER 'root'@'localhost' IDENTIFIED BY 'jetable';
 *     CREATE USER 'root'@'127.0.0.1' IDENTIFIED BY 'jetable';
 *     GRANT ALL ON *.* TO 'root'@'127.0.0.1';
 *     CREATE DATABASE talky_test; USE talky_test;
 *     CREATE TABLE users (alanyaID INT AUTO_INCREMENT PRIMARY KEY, nom VARCHAR(50),
 *       pseudo VARCHAR(80) NOT NULL DEFAULT 'alanyaUser', avatar_url VARCHAR(255) NOT NULL DEFAULT 'NON DEFINI');
 *     CREATE TABLE scheduler_leases (name VARCHAR(64) PRIMARY KEY);
 *     CREATE TABLE conversation (conversID BIGINT AUTO_INCREMENT PRIMARY KEY);
 *     CREATE TABLE conv_participants (conversID BIGINT, alanyaID INT, PRIMARY KEY (conversID, alanyaID));"
 *   for m in 101_safebox 102_safebox_partage 104_safebox_apercu_destinataires 106_safebox_perdus 107_safebox_commentaires 108_safebox_six_dossiers 109_safebox_partage_lots 111_safebox_sauvegarde_auto; do
 *     mysql --no-defaults -h127.0.0.1 -P33071 -uroot -pjetable talky_test < migrations/$m.sql; done
 *   DB_HOST=127.0.0.1 DB_PORT=33071 DB_USER=root DB_PASSWORD=jetable \
 *     DB_NAME=talky_test npm run test:safebox:db
 *
 * (Le socket relatif évite la limite de 107 caractères d'un chemin de socket.)
 */

const assert = require('assert');
const crypto = require('crypto');

const hote = process.env.DB_HOST || '';
const base = process.env.DB_NAME || '';
if (!/^(127\.0\.0\.1|localhost)$/.test(hote) || !/_test$/.test(base)) {
  console.error(
    `✗ safebox.db.test : refusé sur ${hote || '?'}/${base || '?'}. `
    + 'Lancer avec DB_HOST=127.0.0.1 et DB_NAME=<base>_test (une base jetable, jamais la production).',
  );
  process.exit(1);
}

const pool = require('../../config/db');
const { createSafeboxService } = require('./service');
const { normalize } = require('./settings');
const { runSafeboxPurge, collectOrphans, reconcile, reconcileFull } = require('./purge');
const { encryptPreview } = require('./cipher');
const { resolveSafeboxShareFields } = require('../../utils/safeboxShareMessage');
const { SafeboxError } = require('./errors');
const { Mio, BLOCK_BYTES } = require('../../constants/safebox');

const env = { SAFEBOX_KEY: crypto.randomBytes(32).toString('base64') };

function fauxStockage() {
  const objets = new Map();
  const ages = new Map();
  const contenus = new Map(); // octets des rares objets lus par le serveur (aperçus)
  return {
    objets,
    ages,
    contenus,
    getSmall: async (key, max) => {
      const c = contenus.get(key);
      if (!c || !objets.has(key)) throw new Error(`NoSuchKey ${key}`);
      if (c.length > max) throw new Error('trop gros');
      return c;
    },
    listPage: async (prefix) => ({
      objects: [...objets]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, size]) => ({ key, size, lastModified: ages.get(key) || new Date() })),
      next: undefined,
    }),
    removeKeys: async (keys) => { for (const k of keys) objets.delete(k); },
    uploadUrl: async (key, size) => `https://s4.test/put/${key}?size=${size}`,
    downloadUrl: async (key) => `https://s4.test/get/${key}`,
    list: async (prefix) => [...objets]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, size]) => ({ key, size })),
    removePrefix: async (prefix) => {
      let n = 0;
      for (const k of [...objets.keys()]) if (k.startsWith(prefix)) { objets.delete(k); n += 1; }
      return n;
    },
  };
}

const stockage = fauxStockage();
const reglages = normalize({ base_quota_bytes: 50 * Mio, max_folders: 8, max_depth: 5 });
const svc = createSafeboxService({
  db: pool,
  getStorage: () => stockage,
  env,
  getSettings: async () => reglages,
  trashDays: async () => 30,
  // Pas de tables d'abonnement dans la base jetable : l'espace de base. Le
  // calcul Alanya Plus a son propre test (plusSpace.test.js).
  spaceFor: async (id, r) => ({ quotaBytes: r.baseQuotaBytes, maxFileBytes: r.maxFileBytes, plus: false }),
});

let ok = 0;
const etapes = [];
const test = (nom, fn) => etapes.push([nom, fn]);

async function refuse(promesse, code) {
  try {
    await promesse;
  } catch (e) {
    assert.ok(e instanceof SafeboxError, `SafeboxError attendue, reçu ${e.stack}`);
    assert.strictEqual(e.code, code);
    return e;
  }
  throw new Error(`${code} attendu, rien levé`);
}

const comptes = [];
async function compte(nom) {
  const [r] = await pool.query('INSERT INTO users (nom) VALUES (?)', [nom]);
  comptes.push(r.insertId);
  return r.insertId;
}

/** Ce que ferait le téléphone : déposer chaque bloc à sa taille exacte. */
function deposer(reserve, { sauf = [], apercu = true } = {}) {
  const prefix = reserve.blocks[0].url.replace('https://s4.test/put/', '').replace(/\d{5}\?size=\d+$/, '');
  for (let n = 1; n <= reserve.blockCount; n += 1) {
    if (sauf.includes(n)) continue;
    const taille = n < reserve.blockCount ? reserve.blockSize : reserve.size - (reserve.blockCount - 1) * reserve.blockSize;
    stockage.objets.set(`${prefix}${String(n).padStart(5, '0')}`, taille);
  }
  if (apercu && reserve.preview) stockage.objets.set(`${prefix}apercu`, reserve.preview.size);
  return prefix;
}

const cle = crypto.randomBytes(32);
let A;
let B;
let racinesA;
let mariage;
let video;

test('ouverture : six racines, une seule fois même en parallèle', async () => {
  A = await compte('coffre-a');
  B = await compte('coffre-b');
  const vues = await Promise.all([svc.overview(A), svc.overview(A), svc.overview(A)]);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_folder WHERE alanyaID = ?', [A]);
  assert.strictEqual(Number(n.n), 6);
  assert.deepStrictEqual(
    vues[0].roots.map((r) => r.root),
    ['photos', 'videos', 'audios', 'documents', 'albums', 'partager'],
  );
  assert.deepStrictEqual(Object.keys(vues[0].quota.byRoot), ['photos', 'videos', 'audios', 'documents', 'albums', 'partager']);
  assert.deepStrictEqual(vues[0].roots, vues[2].roots);
  assert.strictEqual(vues[0].quota.quotaBytes, 50 * Mio);
  assert.strictEqual(vues[0].quota.usedBytes, 0);
  racinesA = Object.fromEntries(vues[0].roots.map((r) => [r.root, r.id]));
});

test('dossiers : création, nom pris (casse ignorée), profondeur bornée', async () => {
  mariage = await svc.createFolder(A, { parentId: racinesA.videos, name: 'Mariage' });
  assert.strictEqual(mariage.depth, 1);
  assert.strictEqual(mariage.root, 'videos');
  await refuse(svc.createFolder(A, { parentId: racinesA.videos, name: 'mariage' }), 'SAFEBOX_NAME_TAKEN');
  // Même nom ailleurs : permis.
  await svc.createFolder(A, { parentId: racinesA.photos, name: 'Mariage' });
  let p = mariage;
  for (let i = 2; i <= 5; i += 1) p = await svc.createFolder(A, { parentId: p.id, name: `n${i}` });
  assert.strictEqual(p.depth, 5);
  await refuse(svc.createFolder(A, { parentId: p.id, name: 'n6' }), 'SAFEBOX_TOO_DEEP');
});

test('dossiers : plafond par compte', async () => {
  // 1 (Mariage) + 1 (photos/Mariage) + 4 (n2..n5) = 6 ; le plafond est 8.
  await svc.createFolder(A, { parentId: racinesA.documents, name: 'Banque' });
  const sante = await svc.createFolder(A, { parentId: racinesA.documents, name: 'Santé' });
  await refuse(svc.createFolder(A, { parentId: racinesA.documents, name: 'Trop' }), 'SAFEBOX_FOLDER_LIMIT');
  // La corbeille compte jusqu'à ce qu'elle soit vidée.
  await svc.trashFolder(A, sante.id);
  await refuse(svc.createFolder(A, { parentId: racinesA.documents, name: 'Trop' }), 'SAFEBOX_FOLDER_LIMIT');
  await svc.emptyTrash(A);
});

test('dossiers : un autre compte ne voit rien', async () => {
  await svc.overview(B);
  await refuse(svc.listFolder(B, mariage.id), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.createFolder(B, { parentId: racinesA.videos, name: 'Intrus' }), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.updateFolder(B, mariage.id, { name: 'Volé' }), 'SAFEBOX_NOT_FOUND');
});

test('dossiers : renommer, déplacer avec la descendance, garde-fous', async () => {
  const cible = await svc.createFolder(B, { parentId: (await svc.overview(B)).roots[1].id, name: 'Cible' });
  const sous = await svc.createFolder(B, { parentId: cible.id, name: 'Sous' });
  const feuille = await svc.createFolder(B, { parentId: sous.id, name: 'Feuille' });
  const autre = await svc.createFolder(B, { parentId: cible.parentId, name: 'Autre' });
  await svc.updateFolder(B, sous.id, { name: 'Sous renommé', parentId: autre.id });
  const [[f]] = await pool.query('SELECT path, depth FROM safebox_folder WHERE id = ?', [feuille.id]);
  assert.strictEqual(f.path, `/${cible.parentId}/${autre.id}/${sous.id}/${feuille.id}/`);
  assert.strictEqual(Number(f.depth), 3);
  await refuse(svc.updateFolder(B, autre.id, { parentId: feuille.id }), 'SAFEBOX_INVALID_MOVE');
  const racinesB = Object.fromEntries((await svc.overview(B)).roots.map((r) => [r.root, r.id]));
  await refuse(svc.updateFolder(B, autre.id, { parentId: racinesB.photos }), 'SAFEBOX_WRONG_FAMILY');
  // Un dossier reste dans sa racine, même vers Albums qui accepte tous les fichiers.
  await refuse(svc.updateFolder(B, autre.id, { parentId: racinesB.albums }), 'SAFEBOX_WRONG_FAMILY');
  await refuse(svc.updateFolder(B, racinesB.photos, { name: 'Images' }), 'SAFEBOX_ROOT_LOCKED');
  await refuse(svc.trashFolder(B, racinesB.partager), 'SAFEBOX_ROOT_LOCKED');
});

test('envoi : famille, espace réservé, blocs manquants, fin, clé', async () => {
  await refuse(svc.reserveUpload(A, {
    folderId: mariage.id, name: 'photo.jpg', size: 100, plainSize: 100, cipherFormat: 'E2C1',
  }), 'SAFEBOX_WRONG_FAMILY');
  const taille = 2 * BLOCK_BYTES + 3 * Mio;
  video = await svc.reserveUpload(A, {
    folderId: mariage.id, name: 'Cérémonie.mp4', mime: 'video/mp4',
    size: taille, plainSize: taille - 300, originalSize: 60 * Mio, compressed: true,
    previewSize: 1000, cipherFormat: 'E2C1',
  });
  assert.strictEqual(video.blockCount, 3);
  assert.deepStrictEqual(video.blocks.map((b) => b.size), [BLOCK_BYTES, BLOCK_BYTES, 3 * Mio]);
  assert.match(video.blocks[0].url, /\/u\/[0-9a-f]{20}\/[0-9a-f-]{36}\/00001\?size=/);
  assert.strictEqual(video.preview.size, 1000);

  // La réservation compte : 19 Mio réservés, 50 Mio d'espace, 40 de plus ne passent pas.
  const e = await refuse(svc.reserveUpload(A, {
    folderId: racinesA.documents, name: 'gros.pdf', size: 40 * Mio, plainSize: 40 * Mio, cipherFormat: 'E2C1',
  }), 'SAFEBOX_QUOTA_EXCEEDED');
  assert.strictEqual(e.extra.usedBytes, taille + 1000);

  // Invisible tant qu'il n'est pas fini.
  assert.strictEqual((await svc.listFolder(A, mariage.id)).files.length, 0);

  const etat = await svc.uploadStatus(A, video.fileId);
  assert.deepStrictEqual(etat.missing, [1, 2, 3]);
  assert.strictEqual(etat.previewMissing, true);

  const prefix = deposer(video, { sauf: [2] });
  stockage.objets.set(`${prefix}00003`, 3 * Mio - 1); // bloc tronqué
  const inc = await refuse(svc.completeUpload(A, video.fileId, { key: cle.toString('base64') }), 'SAFEBOX_UPLOAD_INCOMPLETE');
  assert.deepStrictEqual(inc.extra.missing, [2, 3]);

  const urls = await svc.uploadUrls(A, video.fileId, { blocks: [2, 3] });
  assert.deepStrictEqual(urls.blocks.map((b) => b.n), [2, 3]);
  await refuse(svc.uploadUrls(A, video.fileId, { blocks: [4] }), 'SAFEBOX_INVALID_BLOCKS');
  await refuse(svc.uploadUrls(A, video.fileId, { blocks: [1, 1] }), 'SAFEBOX_INVALID_BLOCKS');
  await refuse(svc.completeUpload(B, video.fileId, { key: cle.toString('base64') }), 'SAFEBOX_NOT_FOUND');

  deposer(video);
  const fichier = await svc.completeUpload(A, video.fileId, { key: cle.toString('base64') });
  assert.strictEqual(fichier.name, 'Cérémonie.mp4');
  assert.strictEqual(fichier.family, 'videos');
  assert.strictEqual(fichier.key, cle.toString('base64'));
  assert.strictEqual(fichier.originalBytes, 60 * Mio);
  assert.strictEqual(fichier.quality, 'hd', 'un ancien client ne dit que « compressed » : lu comme HD');
  assert.ok(fichier.previewUrl.endsWith('/apercu'));
  await refuse(svc.uploadUrls(A, video.fileId, { blocks: [1] }), 'SAFEBOX_NOT_FOUND');

  const [[b]] = await pool.query('SELECT wrapped_key FROM safebox_blob b JOIN safebox_file f ON f.blob_id = b.id WHERE f.id = ?', [video.fileId]);
  assert.ok(!b.wrapped_key.includes(cle), 'la clé ne doit pas être en clair en base');
});

test('lecture : liste, téléchargement, isolement', async () => {
  const l = await svc.listFolder(A, mariage.id);
  assert.strictEqual(l.files.length, 1);
  assert.deepStrictEqual(l.breadcrumbs.map((d) => d.name), [null, 'Mariage']);
  assert.ok(l.folders.some((d) => d.name === 'n2'));
  const d = await svc.downloadFile(A, video.fileId);
  assert.strictEqual(d.key, cle.toString('base64'));
  assert.deepStrictEqual(d.blocks.map((x) => x.size), [BLOCK_BYTES, BLOCK_BYTES, 3 * Mio]);
  await refuse(svc.downloadFile(B, video.fileId), 'SAFEBOX_NOT_FOUND');
});

test('plus gros fichiers : triés par poids, avec leur dossier, d\'un seul compte', async () => {
  const petit = await svc.reserveUpload(A, {
    folderId: racinesA.documents, name: 'petit.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1',
  });
  deposer(petit);
  await svc.completeUpload(A, petit.fileId, { key: cle.toString('base64') });
  const r = await svc.largestFiles(A, { limit: 10 });
  assert.deepStrictEqual(r.files.map((f) => f.name), ['Cérémonie.mp4', 'petit.pdf']);
  assert.strictEqual(r.files[0].folderName, 'Mariage');
  assert.strictEqual(r.files[1].folderName, null, 'racine : nom traduit par l\'application');
  assert.strictEqual(r.files[1].folderRoot, 'documents');
  assert.strictEqual(r.trashBytes, 0);
  assert.strictEqual((await svc.largestFiles(B)).files.length, 0);
  assert.strictEqual((await svc.largestFiles(A, { limit: 1 })).files.length, 1);
  await svc.trashFile(A, petit.fileId);
  assert.strictEqual((await svc.largestFiles(A)).files.length, 1, 'la corbeille n\'est pas listée');
  assert.ok((await svc.largestFiles(A)).trashBytes > 0);
  await svc.emptyTrash(A);
});

test('fichiers : renommer dans la famille ; déplacer vers sa famille, Albums ou Partager', async () => {
  const f = await svc.updateFile(A, video.fileId, { name: 'Cérémonie.mov' });
  assert.strictEqual(f.ext, 'mov');
  await refuse(svc.updateFile(A, video.fileId, { name: 'Cérémonie.pdf' }), 'SAFEBOX_WRONG_FAMILY');
  await refuse(svc.updateFile(A, video.fileId, { folderId: racinesA.photos }), 'SAFEBOX_WRONG_FAMILY');
  const g = await svc.updateFile(A, video.fileId, { folderId: racinesA.videos });
  assert.strictEqual(g.folderId, racinesA.videos);
  assert.strictEqual((await svc.updateFile(A, video.fileId, { folderId: racinesA.albums })).folderId, racinesA.albums);
  const p = await svc.updateFile(A, video.fileId, { folderId: racinesA.partager });
  assert.strictEqual(p.folderId, racinesA.partager);
  assert.strictEqual(p.family, 'videos', 'le type ne change pas avec le dossier');
  await svc.updateFile(A, video.fileId, { folderId: mariage.id });
});

test('abandon d\'un envoi : l\'espace revient, rien ne reste chez MEGA', async () => {
  const avant = (await svc.usageOf(A)).usedBytes;
  const r = await svc.reserveUpload(A, {
    folderId: racinesA.documents, name: 'brouillon.pdf', size: 2000, plainSize: 1900, cipherFormat: 'E2C1',
  });
  const prefix = deposer(r);
  assert.strictEqual((await svc.usageOf(A)).usedBytes, avant + 2000);
  await svc.cancelUpload(A, r.fileId);
  assert.strictEqual((await svc.usageOf(A)).usedBytes, avant);
  assert.strictEqual((await stockage.list(prefix)).length, 0);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_blob WHERE prefix = ?', [prefix]);
  assert.strictEqual(Number(n.n), 0);
});

test('corbeille : dossier avec son contenu, nom libéré puis « (2) » au retour', async () => {
  await svc.trashFolder(A, mariage.id);
  await refuse(svc.listFolder(A, mariage.id), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.downloadFile(A, video.fileId), 'SAFEBOX_NOT_FOUND');
  const t = await svc.listTrash(A);
  assert.strictEqual(t.folders.length, 1);
  assert.strictEqual(t.folders[0].files, 1);
  assert.strictEqual(t.files.length, 0, 'le fichier part avec son dossier, pas comme entrée à part');
  assert.ok((await svc.usageOf(A)).trashBytes > 0);
  const neuf = await svc.createFolder(A, { parentId: racinesA.videos, name: 'Mariage' });
  const revenu = await svc.restoreFolder(A, mariage.id);
  assert.strictEqual(revenu.name, 'Mariage (2)');
  assert.strictEqual((await svc.listFolder(A, mariage.id)).files.length, 1);
  assert.strictEqual((await svc.listFolder(A, mariage.id)).folders[0].name, 'n2');
  await svc.trashFolder(A, neuf.id);
});

test('corbeille : un fichier dont le dossier est à la corbeille revient à la racine', async () => {
  await svc.trashFile(A, video.fileId);
  await svc.trashFolder(A, mariage.id);
  // Restaurer le dossier ne ramène pas ce qui avait été jeté avant lui.
  await svc.restoreFolder(A, mariage.id);
  assert.strictEqual((await svc.listFolder(A, mariage.id)).files.length, 0);
  await svc.trashFolder(A, mariage.id);
  const f = await svc.restoreFile(A, video.fileId);
  assert.strictEqual(f.folderId, racinesA.videos);
});

test('vider la corbeille : supprimé tout de suite chez MEGA', async () => {
  const prefixes = [...stockage.objets.keys()].map((k) => k.replace(/[^/]+$/, ''));
  await svc.trashFile(A, video.fileId);
  const r = await svc.emptyTrash(A);
  assert.strictEqual(r.ok, true);
  assert.strictEqual((await svc.listTrash(A)).folders.length, 0);
  assert.strictEqual(stockage.objets.size, 0, `restent : ${[...stockage.objets.keys()]} (préfixes ${prefixes})`);
  assert.strictEqual((await svc.usageOf(A)).usedBytes, 0);
});

test('purge : corbeille échue, envoi abandonné, garde-fou, suppression de compte', async () => {
  // Un fichier prêt, mis à la corbeille il y a 31 jours.
  const r1 = await svc.reserveUpload(B, {
    folderId: (await svc.overview(B)).roots[3].id, name: 'vieux.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1',
  });
  deposer(r1);
  await svc.completeUpload(B, r1.fileId, { key: cle.toString('base64') });
  await svc.trashFile(B, r1.fileId);
  await pool.query('UPDATE safebox_file SET trashed_at = DATE_SUB(NOW(), INTERVAL 31 DAY) WHERE id = ?', [r1.fileId]);
  // Un envoi sans nouvelles depuis trois jours.
  const r2 = await svc.reserveUpload(B, {
    folderId: (await svc.overview(B)).roots[3].id, name: 'perdu.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1',
  });
  deposer(r2, { sauf: [1] });
  await pool.query(
    'UPDATE safebox_blob b JOIN safebox_file f ON f.blob_id = b.id SET b.activity_at = DATE_SUB(NOW(), INTERVAL 3 DAY) WHERE f.id = ?',
    [r2.fileId],
  );
  const opts = { trashDays: 30, abandonHours: 48, alertFloor: 1 };
  // Deux orphelins, seuil à 1 : la nuit s'arrête avant MEGA…
  await assert.rejects(runSafeboxPurge(opts, { trigger: 'auto', db: pool, storage: stockage }), /seuil/);
  // … la main confirme.
  const res = await runSafeboxPurge(opts, { trigger: 'manual', db: pool, storage: stockage });
  assert.strictEqual(res.supprimes, 2);
  assert.strictEqual(res.echecs, 0);

  // Suppression de compte : la cascade rend ses blobs orphelins, la purge les efface.
  const r3 = await svc.reserveUpload(B, {
    folderId: (await svc.overview(B)).roots[3].id, name: 'reste.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1',
  });
  deposer(r3);
  await svc.completeUpload(B, r3.fileId, { key: cle.toString('base64') });
  await pool.query('DELETE FROM users WHERE alanyaID = ?', [B]);
  const fin = await runSafeboxPurge({ ...opts, alertFloor: 100 }, { trigger: 'auto', db: pool, storage: stockage });
  assert.strictEqual(fin.supprimes, 1);
  assert.strictEqual(stockage.objets.size, 0);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_blob');
  assert.strictEqual(Number(n.n), 0);
});

test('ramassage : un blob encore désigné n\'est jamais supprimé', async () => {
  const r = await svc.reserveUpload(A, {
    folderId: racinesA.documents, name: 'garde.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1',
  });
  deposer(r);
  await svc.completeUpload(A, r.fileId, { key: cle.toString('base64') });
  const [[b]] = await pool.query('SELECT blob_id FROM safebox_file WHERE id = ?', [r.fileId]);
  const res = await collectOrphans(pool, stockage, { blobIds: [Number(b.blob_id)] });
  assert.deepStrictEqual(res, { supprimes: 0, echecs: 0 });
  assert.strictEqual((await svc.downloadFile(A, r.fileId)).blocks.length, 1);
});

// ── Lot 3 : partage entre inscrits ─────────────────────────────────────────
let E;
let D;
let X;
let conv;
let fichierE;
let partage;

async function deposerFichier(qui, folderId, name, taille = 10) {
  const r = await svc.reserveUpload(qui, { folderId, name, size: taille, plainSize: taille, cipherFormat: 'E2C1' });
  deposer(r);
  return svc.completeUpload(qui, r.fileId, { key: cle.toString('base64') });
}

test('six dossiers (24/10/2026) : types acceptés, un contenu à plusieurs endroits compté une fois', async () => {
  const M = await compte('six-dossiers');
  const racines = Object.fromEntries((await svc.overview(M)).roots.map((r) => [r.root, r.id]));
  // Les dossiers automatiques n'acceptent que leur type ; Albums et Partager tout.
  await refuse(svc.reserveUpload(M, {
    folderId: racines.photos, name: 'acte.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1',
  }), 'SAFEBOX_WRONG_FAMILY');
  const zip = await deposerFichier(M, racines.partager, 'chantier.zip', 40);
  assert.strictEqual(zip.family, 'documents');
  const clip = await deposerFichier(M, racines.albums, 'danse.mp4', 20);
  assert.strictEqual(clip.family, 'videos');
  assert.strictEqual(clip.quality, 'original');
  // Format choisi au dépôt (24/10/2026), et sa copie dans un album le garde.
  const r480 = await svc.reserveUpload(M, {
    folderId: racines.videos, name: 'fete.mp4', size: 15, plainSize: 15, cipherFormat: 'SBX1',
    quality: 'compressed', compressed: true, meta: { durationMs: 4000, codec: 'hevc' },
  });
  deposer(r480);
  const fete = await svc.completeUpload(M, r480.fileId, { key: cle.toString('base64') });
  assert.strictEqual(fete.quality, 'compressed');
  assert.strictEqual(fete.meta.codec, 'hevc');

  const photo = await deposerFichier(M, racines.photos, 'Plage.jpg', 30);
  const avant = await svc.usageOf(M);
  const kribi = await svc.createFolder(M, { parentId: racines.albums, name: 'Kribi 2026' });
  const { files: [copie] } = await svc.addToFolder(M, kribi.id, { fileIds: [photo.id] });
  assert.notStrictEqual(copie.id, photo.id);
  assert.strictEqual(copie.folderId, kribi.id);
  assert.strictEqual(copie.family, 'photos');
  const { files: [feteAlbum] } = await svc.addToFolder(M, kribi.id, { fileIds: [fete.id] });
  assert.strictEqual(feteAlbum.quality, 'compressed');
  assert.deepStrictEqual(copie.alsoIn, [{ fileId: photo.id, folderId: racines.photos, root: 'photos', folderName: null }]);
  // Pas de copie chez MEGA, pas de place en plus.
  assert.deepStrictEqual(await svc.usageOf(M), avant);
  // Ajouté deux fois : un seul exemplaire.
  assert.strictEqual((await svc.addToFolder(M, kribi.id, { fileIds: [photo.id, copie.id] })).files.every((f) => f.id === copie.id), true);
  await refuse(svc.addToFolder(M, racines.photos, { fileIds: [photo.id] }), 'SAFEBOX_INVALID_MOVE');
  await refuse(svc.addToFolder(M, kribi.id, { fileIds: [] }), 'SAFEBOX_INVALID_MOVE');
  await refuse(svc.addToFolder(M, kribi.id, { fileIds: [video.fileId] }), 'SAFEBOX_NOT_FOUND'); // fichier d'un autre
  const dansPhotos = (await svc.listFolder(M, racines.photos)).files.find((f) => f.id === photo.id);
  assert.deepStrictEqual(dansPhotos.alsoIn, [{ fileId: copie.id, folderId: kribi.id, root: 'albums', folderName: 'Kribi 2026' }]);

  // Par racine, chaque contenu une fois, dans la première racine où il se trouve.
  const parRacine = (await svc.overview(M)).quota.byRoot;
  assert.strictEqual(parRacine.photos.files, 1);
  assert.strictEqual(parRacine.albums.files, 1, 'seulement la vidéo déposée dans Albums');
  assert.strictEqual(parRacine.partager.files, 1);
  // « Libérer de l'espace » ne montre le contenu qu'une fois.
  assert.strictEqual((await svc.largestFiles(M)).files.filter((f) => f.name === 'Plage.jpg').length, 1);

  // Retirer de l'album seulement : la photo reste dans Photos, rien n'est libéré.
  assert.strictEqual((await svc.trashFile(M, copie.id)).trashed, 1);
  assert.strictEqual((await svc.usageOf(M)).trashBytes, 0, 'vider la corbeille ne libérerait rien');
  assert.deepStrictEqual((await svc.listFolder(M, racines.photos)).files.find((f) => f.id === photo.id).alsoIn, []);
  await svc.restoreFile(M, copie.id);
  // Supprimer partout : les deux exemplaires, puis la place à la corbeille vidée.
  assert.strictEqual((await svc.trashFile(M, photo.id, { everywhere: true })).trashed, 2);
  assert.strictEqual((await svc.usageOf(M)).trashBytes, 30);
  await svc.emptyTrash(M);
  assert.strictEqual((await svc.usageOf(M)).usedBytes, avant.usedBytes - 30);
  await refuse(svc.downloadFile(M, copie.id), 'SAFEBOX_NOT_FOUND');
});

test('partage : seulement un fichier à moi, dans une discussion dont je suis membre', async () => {
  E = await compte('expediteur');
  D = await compte('destinataire');
  X = await compte('etranger');
  const [c] = await pool.query('INSERT INTO conversation () VALUES ()');
  conv = c.insertId;
  await pool.query('INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?)', [conv, E, conv, D]);
  const racinesE = Object.fromEntries((await svc.overview(E)).roots.map((r) => [r.root, r.id]));
  fichierE = await deposerFichier(E, racinesE.documents, 'Contrat.pdf', 20);
  await refuse(svc.createShare(X, { fileId: fichierE.id, conversationId: conv }), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.createShare(E, { fileId: fichierE.id, conversationId: conv + 999 }), 'SAFEBOX_NOT_FOUND');
  partage = await svc.createShare(E, { fileId: fichierE.id, conversationId: conv });
  assert.strictEqual(partage.name, 'Contrat.pdf');
  assert.strictEqual(partage.plainBytes, 20);
});

test('message de type 11 : contenu réécrit depuis le partage', async () => {
  const r = await resolveSafeboxShareFields(
    { type: 11, content: JSON.stringify({ v: 1, share: partage.shareId }), senderID: E, conversationID: conv },
    { db: pool },
  );
  assert.strictEqual(JSON.parse(r.content).name, 'Contrat.pdf');
  assert.ok(r.mediaName.startsWith('📦 Contrat.pdf'));
  await assert.rejects(resolveSafeboxShareFields(
    { type: 11, content: JSON.stringify({ v: 1, share: partage.shareId }), senderID: D, conversationID: conv },
    { db: pool },
  ), /invalide/);
});

test('carte : membres seulement, avec la clé et les téléchargements restants', async () => {
  await refuse(svc.shareInfo(X, partage.shareId), 'SAFEBOX_NOT_FOUND');
  const vu = await svc.shareInfo(D, partage.shareId);
  assert.strictEqual(vu.available, true);
  assert.strictEqual(vu.key, cle.toString('base64'));
  assert.strictEqual(vu.downloadsLeft, 3);
  assert.strictEqual(vu.isSender, false);
  assert.strictEqual(vu.savedFileId, null);
  const parE = await svc.shareInfo(E, partage.shareId);
  assert.strictEqual(parE.isSender, true);
  assert.strictEqual(parE.downloadsLeft, null);
  assert.strictEqual(parE.savedFileId, fichierE.id, 'déjà dans le coffre de l\'expéditeur');
});

test('téléchargement : compté une fois par 2 h, 3 par 24 h, l\'expéditeur jamais limité', async () => {
  const t = await svc.shareDownload(D, partage.shareId);
  assert.strictEqual(t.blocks.length, 1);
  assert.strictEqual(t.file.id, null, 'rien du coffre de l\'expéditeur ne sort');
  await svc.shareDownload(D, partage.shareId); // reprise : ne compte pas
  assert.strictEqual((await svc.shareInfo(D, partage.shareId)).downloadsLeft, 2);
  for (let i = 0; i < 2; i += 1) {
    await pool.query('UPDATE safebox_share_download SET created_at = DATE_SUB(created_at, INTERVAL 3 HOUR) WHERE alanyaID = ?', [D]);
    await svc.shareDownload(D, partage.shareId);
  }
  await pool.query('UPDATE safebox_share_download SET created_at = DATE_SUB(created_at, INTERVAL 3 HOUR) WHERE alanyaID = ?', [D]);
  const e = await refuse(svc.shareDownload(D, partage.shareId), 'SAFEBOX_DOWNLOAD_LIMIT');
  assert.strictEqual(e.status, 429);
  for (let i = 0; i < 5; i += 1) await svc.shareDownload(E, partage.shareId);
});

test('enregistrer dans mon coffre : mêmes blocs, compté chez moi, survit au retrait', async () => {
  const avant = (await svc.usageOf(D)).usedBytes;
  const f = await svc.saveShare(D, partage.shareId);
  assert.strictEqual(f.family, 'documents');
  assert.strictEqual(f.key, cle.toString('base64'));
  assert.strictEqual((await svc.usageOf(D)).usedBytes, avant + 20);
  const encore = await svc.saveShare(D, partage.shareId);
  assert.strictEqual(encore.id, f.id, 'pas de doublon');
  const [[b]] = await pool.query(
    'SELECT COUNT(DISTINCT blob_id) AS n FROM safebox_file WHERE id IN (?, ?)', [f.id, fichierE.id]);
  assert.strictEqual(Number(b.n), 1, 'aucune copie chez MEGA');
  // L'expéditeur retire le fichier : la carte le dit, mais la copie du destinataire reste.
  await svc.trashFile(E, fichierE.id);
  assert.strictEqual((await svc.shareInfo(D, partage.shareId)).available, false);
  await refuse(svc.shareDownload(D, partage.shareId), 'SAFEBOX_SHARE_REVOKED');
  await svc.emptyTrash(E);
  assert.strictEqual((await svc.downloadFile(D, f.id)).blocks.length, 1, 'les blocs sont restés pour le destinataire');
  await refuse(svc.saveShare(X, partage.shareId), 'SAFEBOX_NOT_FOUND');
});

test('un membre qui quitte la discussion perd l\'accès', async () => {
  const racinesE = Object.fromEntries((await svc.overview(E)).roots.map((r) => [r.root, r.id]));
  const f = await deposerFichier(E, racinesE.documents, 'Second.pdf');
  const p2 = await svc.createShare(E, { fileId: f.id, conversationId: conv });
  await svc.shareInfo(D, p2.shareId);
  await pool.query('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [conv, D]);
  await refuse(svc.shareInfo(D, p2.shareId), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.shareDownload(D, p2.shareId), 'SAFEBOX_NOT_FOUND');
});

test('détails de la carte et badge de l\'expéditeur (migration 104, ou son absence tolérée)', async () => {
  // Sans la migration 104, tout doit marcher quand même : ni détails, ni « reçu par ».
  const [[col]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND COLUMN_NAME = 'meta'`,
  );
  const avec104 = Number(col.n) > 0;
  const recu = (n) => (avec104 ? n : null);
  const M = await compte('membre3');
  const [c] = await pool.query('INSERT INTO conversation () VALUES ()');
  const conv2 = c.insertId;
  await pool.query('INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?), (?, ?)',
    [conv2, E, conv2, D, conv2, M]);
  const racinesE = Object.fromEntries((await svc.overview(E)).roots.map((r) => [r.root, r.id]));
  const r = await svc.reserveUpload(E, {
    folderId: racinesE.videos, name: 'Mariage.mp4', size: 30, plainSize: 30, cipherFormat: 'E2C1',
    meta: { durationMs: 767000, width: 1920, height: 1080, intrus: 'x' },
  });
  deposer(r);
  const f = await svc.completeUpload(E, r.fileId, { key: cle.toString('base64') });
  const attendu = avec104 ? { durationMs: 767000, width: 1920, height: 1080 } : null;
  assert.deepStrictEqual(f.meta, attendu);
  const liste = () => svc.listFolder(E, racinesE.videos).then((p) => p.files.find((x) => x.id === f.id));
  // Lot 9 : la discussion du dernier partage (« Famille Ngono · téléchargé par 5 sur 8 »).
  const envoi = (recipients, received) => ({ shares: 1, recipients, received: recu(received), lastConversationId: conv2 });
  assert.strictEqual((await liste()).sent, null, 'jamais partagé');

  const p3 = await svc.createShare(E, { fileId: f.id, conversationId: conv2 });
  assert.deepStrictEqual(p3.meta, attendu);
  const msg = await resolveSafeboxShareFields(
    { type: 11, content: JSON.stringify({ v: 1, share: p3.shareId }), senderID: E, conversationID: conv2 },
    { db: pool },
  );
  assert.deepStrictEqual(JSON.parse(msg.content).meta ?? null, attendu, 'la carte du destinataire les reçoit');
  assert.deepStrictEqual((await svc.shareInfo(D, p3.shareId)).meta, attendu);
  assert.deepStrictEqual((await liste()).sent, envoi(2, 0));

  await svc.shareDownload(D, p3.shareId);
  await svc.shareDownload(D, p3.shareId);
  await svc.shareDownload(E, p3.shareId); // l'expéditeur ne compte pas
  assert.deepStrictEqual((await liste()).sent, envoi(2, 1));
  const copie = await svc.saveShare(M, p3.shareId);
  assert.deepStrictEqual(copie.meta, attendu, 'même blob, mêmes détails');
  assert.deepStrictEqual((await liste()).sent, envoi(2, 2));
  // Survit à la purge du journal des téléchargements (31 jours).
  await pool.query('DELETE FROM safebox_share_download WHERE share_id = ?', [p3.shareId]);
  assert.strictEqual((await liste()).sent.received, recu(2));
  const gros = (await svc.largestFiles(E)).files.find((x) => x.id === f.id);
  assert.deepStrictEqual(gros.sent, envoi(2, 2));

  // Un destinataire qui quitte la discussion ne compte plus, ni comme destinataire ni comme reçu.
  await pool.query('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [conv2, M]);
  assert.deepStrictEqual((await liste()).sent, envoi(1, 1));

  const sans = await svc.reserveUpload(E, {
    folderId: racinesE.documents, name: 'Note.pdf', size: 5, plainSize: 5, cipherFormat: 'E2C1',
    meta: { width: 'x', pages: -2 },
  });
  deposer(sans);
  assert.strictEqual((await svc.completeUpload(E, sans.fileId, { key: cle.toString('base64') })).meta, null);
});

// ── Lot 9 : un lot en une carte, Reçus, suivi, retrait (migration 109) ─────

let lot9;
test('lot 9 : un album en un seul partage, sa carte, ses éléments', async () => {
  const Ex = await compte('Clarisse');
  const Dx = await compte('Paul');
  const Mx = await compte('Lina');
  const Hx = await compte('hors-discussion');
  const [c] = await pool.query('INSERT INTO conversation () VALUES ()');
  const conv = c.insertId;
  await pool.query('INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?), (?, ?)',
    [conv, Ex, conv, Dx, conv, Mx]);
  const racines = Object.fromEntries((await svc.overview(Ex)).roots.map((r) => [r.root, r.id]));
  const album = await svc.createFolder(Ex, { parentId: racines.albums, name: 'Kribi 2026' });
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(100)]);
  const deposerDans = async (folderId, name, size) => {
    const apercu = encryptPreview(cle, jpeg);
    const r = await svc.reserveUpload(Ex, {
      folderId, name, size, plainSize: size, previewSize: apercu.length, cipherFormat: 'SBX1',
    });
    stockage.contenus.set(`${deposer(r)}apercu`, apercu);
    return svc.completeUpload(Ex, r.fileId, { key: cle.toString('base64') });
  };
  const plage = await deposerDans(album.id, 'Plage.jpg', 100);
  const danse = await deposerDans(album.id, 'Danse.mp4', 300);
  const hotel = await deposerDans(album.id, 'Hotel.pdf', 50);
  const coucher = await deposerDans(album.id, 'Coucher.jpg', 120);
  const seule = await deposerDans(racines.photos, 'Seule.jpg', 70);

  // Un album fait un lot ; un seul fichier reste un partage simple.
  await refuse(svc.createShare(Hx, { folderId: album.id, conversationId: conv }), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.createShare(Ex, { fileIds: [plage.id, 999999], conversationId: conv }), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.createShare(Ex, { fileIds: [], conversationId: conv }), 'SAFEBOX_SHARE_INVALID');
  const vide = await svc.createFolder(Ex, { parentId: racines.albums, name: 'Vide' });
  await refuse(svc.createShare(Ex, { folderId: vide.id, conversationId: conv }), 'SAFEBOX_SHARE_INVALID');
  const simple = await svc.createShare(Ex, { fileIds: [seule.id], conversationId: conv });
  assert.strictEqual(simple.kind, 'file');
  const p = await svc.createShare(Ex, { folderId: album.id, conversationId: conv });
  assert.strictEqual(p.kind, 'batch');
  assert.strictEqual(p.name, 'Kribi 2026');
  assert.strictEqual(p.count, 4);
  assert.strictEqual(p.plainBytes, 570);
  assert.deepStrictEqual(p.families, { photos: 2, videos: 1, documents: 1 });
  assert.strictEqual(p.family, 'photos');
  assert.deepStrictEqual(p.cover, [coucher.id, hotel.id, danse.id, plage.id], 'les plus récents d\'abord');
  const selection = await svc.createShare(Ex, { fileIds: [danse.id, plage.id], title: 'Pour Paul', conversationId: conv });
  assert.strictEqual(selection.name, 'Pour Paul');

  // Le message porte le lot ; les anciennes applications lisent titre et taille.
  const msg = await resolveSafeboxShareFields(
    { type: 11, content: JSON.stringify({ v: 1, share: p.shareId, bs: ['QUJD', '', 'REVG'] }), senderID: Ex, conversationID: conv },
    { db: pool },
  );
  const contenu = JSON.parse(msg.content);
  assert.deepStrictEqual(
    { kind: contenu.kind, count: contenu.count, families: contenu.families, name: contenu.name, size: contenu.size, bs: contenu.bs },
    { kind: 'batch', count: 4, families: { photos: 2, videos: 1, documents: 1 }, name: 'Kribi 2026', size: 570, bs: ['QUJD', '', 'REVG'] },
  );

  // La carte : mosaïque des quatre premiers, clé, expéditeur ; le suivi pour l'expéditeur seul.
  await refuse(svc.shareInfo(Hx, p.shareId), 'SAFEBOX_NOT_FOUND');
  const carte = await svc.shareInfo(Dx, p.shareId);
  assert.strictEqual(carte.kind, 'batch');
  assert.strictEqual(carte.available, true);
  assert.strictEqual(carte.availableCount, 4);
  assert.deepStrictEqual(carte.cover.map((e) => e.name), ['Coucher.jpg', 'Hotel.pdf', 'Danse.mp4', 'Plage.jpg']);
  assert.ok(carte.cover.every((e) => e.key && e.previewUrl && e.available));
  assert.deepStrictEqual(carte.sender, { id: Ex, name: 'Clarisse', avatarUrl: null });
  assert.strictEqual(carte.downloadsLeft, 3);
  assert.strictEqual(carte.savedCount, 0);
  assert.strictEqual(carte.tracking, undefined);
  const vueExpediteur = await svc.shareInfo(Ex, p.shareId);
  assert.deepStrictEqual(vueExpediteur.tracking, { members: 2, downloaded: 0, saved: 0 });
  assert.deepStrictEqual(vueExpediteur.fileIds, [coucher.id, hotel.id, danse.id, plage.id], 'pour « Envoyer ailleurs »');
  assert.strictEqual(carte.fileIds, undefined, 'rien du coffre de l\'expéditeur pour les autres');

  // Les éléments, par pages ; un partage simple rend son fichier en élément 0.
  const { items, nextCursor } = await svc.shareItems(Dx, p.shareId);
  assert.deepStrictEqual(items.map((i) => [i.position, i.name, i.family]), [
    [0, 'Coucher.jpg', 'photos'], [1, 'Hotel.pdf', 'documents'], [2, 'Danse.mp4', 'videos'], [3, 'Plage.jpg', 'photos'],
  ]);
  assert.strictEqual(nextCursor, null);
  assert.deepStrictEqual((await svc.shareItems(Dx, p.shareId, { cursor: 1 })).items.map((i) => i.position), [2, 3]);
  const unSeul = (await svc.shareItems(Dx, simple.shareId)).items;
  assert.deepStrictEqual(unSeul.map((i) => [i.id, i.name, i.available]), [[0, 'Seule.jpg', true]]);
  lot9 = { Ex, Dx, Mx, Hx, conv, p, simple, selection, items, plage, danse, hotel, coucher, album };
});

test('lot 9 : un lot se télécharge élément par élément, compté une fois par 2 h', async () => {
  const { Ex, Dx, p, items } = lot9;
  await refuse(svc.shareDownload(Dx, p.shareId), 'SAFEBOX_SHARE_ITEM_REQUIRED');
  await refuse(svc.shareDownload(Dx, p.shareId, { item: 999999 }), 'SAFEBOX_NOT_FOUND');
  for (const i of items) {
    const plan = await svc.shareDownload(Dx, p.shareId, { item: i.id });
    assert.strictEqual(plan.file.id, null, 'rien du coffre de l\'expéditeur ne sort');
    assert.ok(plan.blocks.length >= 1);
  }
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_share_download WHERE share_id = ? AND alanyaID = ?', [p.shareId, Dx]);
  assert.strictEqual(Number(n.n), 1, 'tout l\'album dans la fenêtre de 2 h : un seul téléchargement');
  assert.strictEqual((await svc.shareInfo(Dx, p.shareId)).downloadsLeft, 2);
  assert.deepStrictEqual((await svc.shareInfo(Ex, p.shareId)).tracking, { members: 2, downloaded: 1, saved: 0 });
});

test('lot 9 : garder un lot en fait un album, sans doublon d\'espace', async () => {
  const { Ex, Mx, p, items } = lot9;
  // Lina garde d'abord une vidéo seule, puis l'album entier.
  const video = items.find((i) => i.name === 'Danse.mp4');
  const seule = await svc.saveShare(Mx, p.shareId, { itemId: video.id });
  assert.strictEqual(seule.family, 'videos');
  const avant = (await svc.usageOf(Mx)).usedBytes;
  const garde = await svc.saveShare(Mx, p.shareId);
  assert.strictEqual(garde.folder.name, 'Kribi 2026');
  assert.strictEqual(garde.folder.root, 'albums');
  assert.strictEqual(garde.files, 4);
  const apres = (await svc.usageOf(Mx)).usedBytes;
  const [[nouveaux]] = await pool.query(
    'SELECT SUM(b.stored_bytes + b.preview_bytes) AS t FROM safebox_blob b JOIN safebox_file f ON f.blob_id = b.id WHERE f.id IN (?)',
    [[lot9.plage.id, lot9.hotel.id, lot9.coucher.id]],
  );
  assert.strictEqual(apres - avant, Number(nouveaux.t), 'seuls les contenus nouveaux comptent');
  // Ce que Lina avait déjà (la vidéo) ne compte pas deux fois.
  const [blobs] = await pool.query(
    'SELECT COALESCE(SUM(t), 0) AS t FROM (SELECT DISTINCT b.id, b.stored_bytes + b.preview_bytes AS t FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id WHERE f.alanyaID = ? AND f.trashed_at IS NULL) x',
    [Mx],
  );
  assert.strictEqual(apres, Number(blobs[0].t));
  const contenu = await svc.listFolder(Mx, garde.folder.id);
  assert.deepStrictEqual(contenu.files.map((f) => f.name).sort(), ['Coucher.jpg', 'Danse.mp4', 'Hotel.pdf', 'Plage.jpg']);
  // Garder encore : un second album « (2) ».
  assert.strictEqual((await svc.saveShare(Mx, p.shareId)).folder.name, 'Kribi 2026 (2)');
  const carte = await svc.shareInfo(Mx, p.shareId);
  assert.strictEqual(carte.savedCount, 4);
  assert.deepStrictEqual((await svc.shareInfo(Ex, p.shareId)).tracking, { members: 2, downloaded: 1, saved: 1 });
  // Pas d'espace : rien n'est gardé.
  const Px = await compte('sans-place');
  await pool.query('INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?)', [lot9.conv, Px]);
  const petit = createSafeboxService({
    db: pool, getStorage: () => stockage, env, getSettings: async () => reglages, trashDays: async () => 30,
    spaceFor: async () => ({ quotaBytes: 100, maxFileBytes: reglages.maxFileBytes, plus: false }),
  });
  await refuse(petit.saveShare(Px, p.shareId), 'SAFEBOX_QUOTA_EXCEEDED');
  const [[dossiers]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_folder WHERE alanyaID = ? AND parent_id IS NOT NULL', [Px]);
  assert.strictEqual(Number(dossiers.n), 0, 'l\'album n\'est pas resté à moitié');
  await pool.query('DELETE FROM conv_participants WHERE conversID = ? AND alanyaID = ?', [lot9.conv, Px]);
});

test('lot 9 : Reçus, suivi, badge des fichiers partagés en lot', async () => {
  const { Ex, Dx, Hx, p, simple, selection, plage, danse, album } = lot9;
  const recus = await svc.receivedShares(Dx);
  assert.deepStrictEqual(recus.shares.map((s) => s.id), [selection.shareId, p.shareId, simple.shareId]);
  const albumRecu = recus.shares.find((s) => s.id === p.shareId);
  assert.strictEqual(albumRecu.kind, 'batch');
  assert.strictEqual(albumRecu.count, 4);
  assert.deepStrictEqual(albumRecu.sender, { id: Ex, name: 'Clarisse', avatarUrl: null });
  assert.ok(albumRecu.receivedAt, 'téléchargé');
  assert.ok(albumRecu.cover.previewUrl && albumRecu.cover.key);
  const simpleRecu = recus.shares.find((s) => s.id === simple.shareId);
  assert.strictEqual(simpleRecu.receivedAt, null);
  assert.strictEqual(simpleRecu.quality, 'original');
  assert.deepStrictEqual((await svc.receivedShares(Ex)).shares, [], 'mes envois n\'y sont pas');
  assert.deepStrictEqual((await svc.receivedShares(Hx)).shares, [], 'pas membre : rien');
  assert.deepStrictEqual((await svc.receivedShares(Dx, { cursor: selection.shareId })).shares.map((s) => s.id), [p.shareId, simple.shareId]);

  // Le suivi : l'expéditeur seul.
  await refuse(svc.shareRecipients(Dx, p.shareId), 'SAFEBOX_NOT_FOUND');
  const suivi = await svc.shareRecipients(Ex, p.shareId);
  assert.deepStrictEqual(suivi.members.map((m) => [m.name, m.state]), [['Lina', 'saved'], ['Paul', 'downloaded']]);
  assert.deepStrictEqual(suivi.tracking, { members: 2, downloaded: 1, saved: 1 });

  // Le badge d'un fichier compte aussi les partages en lot.
  const vus = (await svc.listFolder(Ex, album.id)).files;
  const badge = (f) => vus.find((x) => x.id === f.id).sent;
  assert.deepStrictEqual(badge(danse), { shares: 2, recipients: 2, received: 2, lastConversationId: lot9.conv });
  assert.deepStrictEqual(badge(plage), { shares: 2, recipients: 2, received: 2, lastConversationId: lot9.conv });
});

test('lot 9 : retirer le partage, fichier supprimé dans un lot, modération d\'un lot', async () => {
  const { Ex, Dx, Hx, p, selection, plage, hotel } = lot9;
  // Un élément mis à la corbeille par l'expéditeur n'est plus disponible ; le reste oui.
  await svc.trashFile(Ex, hotel.id);
  const carte = await svc.shareInfo(Dx, p.shareId);
  assert.strictEqual(carte.availableCount, 3);
  const hotelItem = (await svc.shareItems(Dx, p.shareId)).items.find((i) => i.name === 'Hotel.pdf');
  assert.deepStrictEqual([hotelItem.available, hotelItem.key], [false, undefined]);
  await refuse(svc.shareDownload(Dx, p.shareId, { item: hotelItem.id }), 'SAFEBOX_SHARE_REVOKED');

  // Retirer le partage : l'expéditeur seul ; la carte le dit, le fichier reste chez lui.
  await refuse(svc.revokeShare(Dx, selection.shareId), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.revokeShare(Hx, selection.shareId), 'SAFEBOX_NOT_FOUND');
  assert.deepStrictEqual(await svc.revokeShare(Ex, selection.shareId), { id: selection.shareId, revoked: true });
  assert.deepStrictEqual(await svc.revokeShare(Ex, selection.shareId), { id: selection.shareId, revoked: true }, 'rejouable');
  const retiree = await svc.shareInfo(Dx, selection.shareId);
  assert.deepStrictEqual(
    [retiree.available, retiree.revokedBySender, retiree.removedByModeration, retiree.cover],
    [false, true, false, []],
  );
  const [elementRetire] = (await svc.shareItems(Dx, selection.shareId)).items;
  assert.strictEqual(elementRetire.available, false);
  await refuse(svc.shareDownload(Dx, selection.shareId, { item: elementRetire.id }), 'SAFEBOX_SHARE_REVOKED');
  assert.strictEqual((await svc.downloadFile(Ex, plage.id)).blocks.length, 1, 'le fichier reste dans le coffre');
  await assert.rejects(resolveSafeboxShareFields(
    { type: 11, content: JSON.stringify({ v: 1, share: selection.shareId }), senderID: Ex, conversationID: lot9.conv },
    { db: pool },
  ), (e) => e.code === 'SAFEBOX_SHARE_INVALID', 'un partage retiré ne repart pas dans un message');

  // Modération d'un lot : un aperçu, tous ses contenus retirés puis supprimés partout.
  const vu = await svc.moderationView(p.shareId);
  assert.deepStrictEqual([vu.kind, vu.count], ['batch', 4]);
  assert.ok(vu.preview.startsWith('data:image/jpeg;base64,'));
  assert.ok(vu.activeShares >= 1);
  assert.ok((await svc.moderationRevoke(p.shareId)).revoked >= 1);
  const apres = await svc.shareInfo(Dx, p.shareId);
  assert.deepStrictEqual([apres.available, apres.removedByModeration, apres.revokedBySender], [false, true, false]);
  const sup = await svc.moderationDelete(p.shareId);
  assert.strictEqual(sup.megaDeleted, true);
  await refuse(svc.downloadFile(Ex, plage.id), 'SAFEBOX_NOT_FOUND');
  assert.strictEqual((await svc.usageOf(lot9.Mx)).usedBytes, 0, 'les copies gardées partent aussi');
});

// ── Lot 10 : sauvegarde automatique (migration 111) ───────────────────────

test('sauvegarde automatique : doublons, ajout sans copie à Photos, « ne plus sauvegarder »', async () => {
  const P = await compte('sauvegarde');
  const Q = await compte('autre-telephone');
  const racines = Object.fromEntries((await svc.overview(P)).roots.map((r) => [r.root, r.id]));
  const fp = (n) => crypto.createHash('sha256').update(`original-${n}`).digest('hex');
  const deposerAvec = async (qui, folderId, name, empreinte) => {
    const r = await svc.reserveUpload(qui, {
      folderId, name, size: 20, plainSize: 20, cipherFormat: 'SBX1', sourceFp: empreinte,
    });
    deposer(r);
    return svc.completeUpload(qui, r.fileId, { key: cle.toString('base64') });
  };
  await refuse(svc.reserveUpload(P, { folderId: racines.photos, name: 'x.jpg', size: 20, plainSize: 20, cipherFormat: 'SBX1', sourceFp: 'zz' }), 'SAFEBOX_INVALID_FINGERPRINT');

  // Sauvegardée dans Photos, ajoutée à la main dans un album, envoi en cours.
  const sauvee = await deposerAvec(P, racines.photos, 'Sauvee.jpg', fp(1));
  const album = await svc.createFolder(P, { parentId: racines.albums, name: 'Kribi' });
  const dansAlbum = await deposerAvec(P, album.id, 'Album.jpg', fp(2));
  await svc.reserveUpload(P, { folderId: racines.videos, name: 'EnCours.mp4', size: 20, plainSize: 20, cipherFormat: 'SBX1', sourceFp: fp(3) });

  const etats = (r) => Object.fromEntries(Object.entries(r.results).map(([k, v]) => [k, v.state]));
  const avant = await svc.backupCheck(P, { fps: [fp(1), fp(2), fp(3), fp(4)] });
  assert.deepStrictEqual(etats(avant), { [fp(1)]: 'saved', [fp(2)]: 'elsewhere', [fp(3)]: 'uploading', [fp(4)]: 'new' });
  assert.strictEqual(avant.results[fp(1)].fileId, sauvee.id);

  // L'empreinte est liée au compte : le même original n'est pas « déjà là » chez un autre.
  assert.deepStrictEqual(etats(await svc.backupCheck(Q, { fps: [fp(1)] })), { [fp(1)]: 'new' });

  // « link » : la photo de l'album rejoint Photos, sans copie ni espace en plus.
  const espace = (await svc.usageOf(P)).usedBytes;
  const lie = await svc.backupCheck(P, { fps: [fp(2)], link: true });
  assert.strictEqual(lie.results[fp(2)].state, 'saved');
  assert.strictEqual(lie.results[fp(2)].linked, true);
  const photos = await svc.listFolder(P, racines.photos);
  assert.ok(photos.files.some((f) => f.name === 'Album.jpg'), 'dans Photos aussi');
  assert.strictEqual((await svc.usageOf(P)).usedBytes, espace);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(2)] })).results[fp(2)].state, 'saved');

  // Supprimée d'un seul endroit : encore là. Supprimée partout : ne plus sauvegarder.
  const lienPhotos = photos.files.find((f) => f.name === 'Album.jpg');
  await svc.trashFile(P, dansAlbum.id);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(2)] })).results[fp(2)].state, 'saved');
  await svc.trashFile(P, lienPhotos.id);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(2)] })).results[fp(2)].state, 'skip');
  await svc.emptyTrash(P);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(2)] })).results[fp(2)].state, 'skip', 'même après la corbeille vidée');

  // Restaurée : elle se sauvegarde de nouveau.
  await svc.trashFile(P, sauvee.id);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(1)] })).results[fp(1)].state, 'skip');
  await svc.restoreFile(P, sauvee.id);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(1)] })).results[fp(1)].state, 'saved');

  // Un dossier mis à la corbeille avec ses photos sauvegardées : pareil, et son retour aussi.
  const sous = await svc.createFolder(P, { parentId: racines.photos, name: 'Vacances' });
  await deposerAvec(P, sous.id, 'Plage.jpg', fp(5));
  await svc.trashFolder(P, sous.id);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(5)] })).results[fp(5)].state, 'skip');
  await svc.restoreFolder(P, sous.id);
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(5)] })).results[fp(5)].state, 'saved');

  // « Ne plus sauvegarder » demandé par le téléphone.
  await svc.backupSkip(P, { fps: [fp(4), fp(4)] });
  assert.strictEqual((await svc.backupCheck(P, { fps: [fp(4)] })).results[fp(4)].state, 'skip');
  await refuse(svc.backupCheck(P, { fps: [] }), 'SAFEBOX_INVALID_FINGERPRINT');
  await refuse(svc.backupSkip(P, { fps: ['x'] }), 'SAFEBOX_INVALID_FINGERPRINT');
});

// ── Lot 4 : espace Alanya Plus ─────────────────────────────────────────────

test('Alanya Plus : espace et taille de fichier du plan', async () => {
  const plus = createSafeboxService({
    db: pool, getStorage: () => stockage, env, getSettings: async () => reglages, trashDays: async () => 30,
    spaceFor: async () => ({ quotaBytes: 200 * Mio, maxFileBytes: 2 * 1024 * Mio, plus: true }),
  });
  const v = await plus.overview(E);
  assert.strictEqual(v.quota.quotaBytes, 200 * Mio);
  assert.strictEqual(v.quota.plus, true);
  assert.strictEqual(v.quota.baseQuotaBytes, 50 * Mio);
  assert.strictEqual(v.limits.maxFileBytes, 2 * 1024 * Mio);
  // 60 Mio passe avec Plus, alors que l'espace de base (50 Mio) le refuserait.
  const racines = Object.fromEntries(v.roots.map((r) => [r.root, r.id]));
  const r = await plus.reserveUpload(E, { folderId: racines.documents, name: 'gros.pdf', size: 60 * Mio, plainSize: 60 * Mio, cipherFormat: 'E2C1' });
  await refuse(svc.reserveUpload(E, { folderId: racines.documents, name: 'gros2.pdf', size: 60 * Mio, plainSize: 60 * Mio, cipherFormat: 'E2C1' }), 'SAFEBOX_QUOTA_EXCEEDED');
  await plus.cancelUpload(E, r.fileId);
});

test('fin d\'Alanya Plus : envois et corbeille d\'abord, puis les plus récents', async () => {
  const reduit = createSafeboxService({
    db: pool, getStorage: () => stockage, env, getSettings: async () => reglages, trashDays: async () => 30,
    spaceFor: async () => ({ quotaBytes: 25 * Mio, maxFileBytes: 1024 * Mio, plus: false }),
  });
  const racines = Object.fromEntries((await svc.overview(X)).roots.map((r) => [r.root, r.id]));
  const vieux = await deposerFichier(X, racines.documents, 'vieux.pdf', 10 * Mio);
  await pool.query('UPDATE safebox_file SET created_at = DATE_SUB(NOW(), INTERVAL 10 DAY) WHERE id = ?', [vieux.id]);
  const moyen = await deposerFichier(X, racines.documents, 'moyen.pdf', 10 * Mio);
  await pool.query('UPDATE safebox_file SET created_at = DATE_SUB(NOW(), INTERVAL 5 DAY) WHERE id = ?', [moyen.id]);
  const recent = await deposerFichier(X, racines.documents, 'recent.pdf', 10 * Mio);
  const jete = await deposerFichier(X, racines.documents, 'jete.pdf', 5 * Mio);
  await svc.trashFile(X, jete.id);
  await svc.reserveUpload(X, { folderId: racines.documents, name: 'en-cours.pdf', size: 3 * Mio, plainSize: 3 * Mio, cipherFormat: 'E2C1' });
  // 38 Mio pour 25 : partent l'envoi (3), la corbeille (5), puis le plus récent (10) → 20 Mio.
  const r = await reduit.purgeExcess(X);
  assert.strictEqual(r.files, 3);
  const restants = (await svc.largestFiles(X)).files.map((f) => f.name).sort();
  assert.deepStrictEqual(restants, ['moyen.pdf', 'vieux.pdf']);
  assert.strictEqual((await svc.usageOf(X)).usedBytes, 20 * Mio);
  assert.ok(recent.id);
  // Sous l'espace, ou abonné : rien ne part.
  assert.deepStrictEqual(await reduit.purgeExcess(X), { files: 0, bytes: 0 });
});

test('rapprochement : objets sans fichier en base supprimés après deux jours', async () => {
  stockage.objets.set('u/inconnu/vieux/00001', 5);
  stockage.ages.set('u/inconnu/vieux/00001', new Date(Date.now() - 3 * 86_400_000));
  stockage.objets.set('u/inconnu/jeune/00001', 5);
  await assert.rejects(reconcile(pool, stockage, { alertFloor: 0, trigger: 'auto' }), /seuil/);
  assert.ok(stockage.objets.has('u/inconnu/vieux/00001'), 'rien supprimé au-delà du seuil');
  assert.strictEqual(await reconcile(pool, stockage, { alertFloor: 0, trigger: 'manual' }), 1);
  assert.ok(!stockage.objets.has('u/inconnu/vieux/00001'));
  assert.ok(stockage.objets.has('u/inconnu/jeune/00001'), 'trop récent : gardé');
  stockage.objets.delete('u/inconnu/jeune/00001');
  const avant = stockage.objets.size;
  assert.strictEqual(await reconcile(pool, stockage, { alertFloor: 10, trigger: 'manual' }), 0, 'les vrais blocs ne bougent pas');
  assert.strictEqual(stockage.objets.size, avant);
});

// ── Modération et fichiers perdus (décisions du 18/10/2026, points 7 et 8) ──

test('modération : aperçu, retrait de tous les partages, suppression partout', async () => {
  const Ex = await compte('expediteur-signale');
  const Dx = await compte('destinataire-x');
  const Rx = await compte('troisieme-x');
  const [c] = await pool.query('INSERT INTO conversation () VALUES ()');
  const convX = c.insertId;
  await pool.query('INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?), (?, ?)',
    [convX, Ex, convX, Dx, convX, Rx]);
  const racinesEx = Object.fromEntries((await svc.overview(Ex)).roots.map((r) => [r.root, r.id]));
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(200)]);
  const apercuChiffre = encryptPreview(cle, jpeg);
  const r = await svc.reserveUpload(Ex, {
    folderId: racinesEx.photos, name: 'Signalee.jpg', size: 40, plainSize: 40,
    previewSize: apercuChiffre.length, cipherFormat: 'E2C1',
  });
  const prefixe = deposer(r);
  stockage.contenus.set(`${prefixe}apercu`, apercuChiffre);
  const f = await svc.completeUpload(Ex, r.fileId, { key: cle.toString('base64') });
  const p = await svc.createShare(Ex, { fileId: f.id, conversationId: convX });
  // Le destinataire l'enregistre puis le renvoie lui-même dans la discussion.
  const copie = await svc.saveShare(Dx, p.shareId);
  const p2 = await svc.createShare(Dx, { fileId: copie.id, conversationId: convX });

  // A : ce que voit la modération.
  const vu = await svc.moderationView(p.shareId);
  assert.ok(vu.preview.startsWith('data:image/jpeg;base64,'));
  assert.ok(Buffer.from(vu.preview.split(',')[1], 'base64').equals(jpeg), 'aperçu déchiffré par le serveur');
  assert.strictEqual(vu.vaults, 2);
  assert.strictEqual(vu.activeShares, 2);
  assert.strictEqual(vu.fileDeleted, false);
  await refuse(svc.moderationView(999999999), 'SAFEBOX_NOT_FOUND');

  // B : plus personne ne télécharge, d'aucun des deux partages ; les copies restent.
  assert.strictEqual((await svc.moderationRevoke(p.shareId)).revoked, 2);
  const carte = await svc.shareInfo(Rx, p.shareId);
  assert.strictEqual(carte.available, false);
  assert.strictEqual(carte.removedByModeration, true);
  await refuse(svc.shareDownload(Rx, p2.shareId), 'SAFEBOX_SHARE_REVOKED');
  await refuse(svc.saveShare(Rx, p.shareId), 'SAFEBOX_SHARE_REVOKED');
  assert.strictEqual((await svc.downloadFile(Dx, copie.id)).blocks.length, 1, 'la copie enregistrée reste');
  assert.strictEqual((await svc.moderationRevoke(p.shareId)).revoked, 0, 'rejouable');

  // C : supprimé partout, chez MEGA aussi.
  const sup = await svc.moderationDelete(p.shareId);
  assert.deepStrictEqual({ files: sup.files, vaults: sup.vaults, megaDeleted: sup.megaDeleted }, { files: 2, vaults: 2, megaDeleted: true });
  assert.ok(![...stockage.objets.keys()].some((k) => k.startsWith(prefixe)), 'plus rien chez MEGA');
  await refuse(svc.downloadFile(Dx, copie.id), 'SAFEBOX_NOT_FOUND');
  await refuse(svc.downloadFile(Ex, f.id), 'SAFEBOX_NOT_FOUND');
  assert.strictEqual((await svc.usageOf(Dx)).usedBytes, 0, 'l\'espace revient');
  const apres = await svc.moderationView(p.shareId);
  assert.strictEqual(apres.fileDeleted, true);
  assert.strictEqual(apres.preview, null);
});

test('fichiers perdus chez MEGA : marqués, refusés, démarqués s\'ils reviennent (migration 106)', async () => {
  const [[col]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND COLUMN_NAME = 'lost_at'`,
  );
  const avec106 = Number(col.n) > 0;
  const P = await compte('proprietaire-perdu');
  const racinesP = Object.fromEntries((await svc.overview(P)).roots.map((r) => [r.root, r.id]));
  const r = await svc.reserveUpload(P, { folderId: racinesP.documents, name: 'Acte.pdf', size: 10, plainSize: 10, cipherFormat: 'E2C1' });
  const prefixe = deposer(r);
  const f = await svc.completeUpload(P, r.fileId, { key: cle.toString('base64') });
  const plusTard = new Date(Date.now() + 5000);
  const bloc = `${prefixe}00001`;
  const taille = stockage.objets.get(bloc);
  stockage.objets.delete(bloc); // disparu chez MEGA

  const r1 = await reconcileFull(pool, stockage, { alertFloor: 10, trigger: 'manual', now: plusTard });
  const lu = async () => (await svc.listFolder(P, racinesP.documents)).files.find((x) => x.id === f.id);
  if (!avec106) {
    assert.strictEqual(r1.perdus, null);
    assert.strictEqual((await lu()).lost, false);
    stockage.objets.set(bloc, taille);
    return;
  }
  assert.ok(r1.perdus >= 1);
  assert.strictEqual((await lu()).lost, true);
  const e = await refuse(svc.downloadFile(P, f.id), 'SAFEBOX_FILE_LOST');
  assert.strictEqual(e.status, 410);

  // Le contenu revient (lecture incomplète la fois d'avant) : démarqué.
  stockage.objets.set(bloc, taille);
  const r2 = await reconcileFull(pool, stockage, { alertFloor: 10, trigger: 'manual', now: plusTard });
  assert.ok(r2.retrouves >= 1);
  assert.strictEqual((await lu()).lost, false);
  assert.strictEqual((await svc.downloadFile(P, f.id)).blocks.length, 1);

  // Lecture du bucket qui revient vide : un passage automatique ne marque rien.
  for (let i = 0; i < 12; i += 1) await deposerFichier(P, racinesP.documents, `lot-${i}.pdf`, 3);
  const vide = { listPage: async () => ({ objects: [], next: undefined }), removeKeys: async () => {} };
  await assert.rejects(reconcileFull(pool, vide, { alertFloor: 10, trigger: 'auto', now: plusTard }), /semblent perdus/);
  assert.strictEqual((await lu()).lost, false, 'rien marqué au-delà du seuil');
});

test('commentaire d\'une photo : texte, audio, privé, compté dans l\'espace (migration 107)', async () => {
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_note'`,
  );
  const K = await compte('photographe');
  const racinesK = Object.fromEntries((await svc.overview(K)).roots.map((r) => [r.root, r.id]));
  const photo = await deposerFichier(K, racinesK.photos, 'Plage.jpg', 30);
  const pdf = await deposerFichier(K, racinesK.documents, 'Contrat.pdf', 30);
  const vue = async () => (await svc.listFolder(K, racinesK.photos)).files.find((x) => x.id === photo.id);
  if (!Number(t.n)) {
    assert.strictEqual((await vue()).note, null, 'sans la migration 107 : pas de commentaire, rien ne casse');
    return;
  }
  await refuse(svc.setNoteText(K, pdf.id, { text: 'x' }), 'SAFEBOX_NOTE_UNAVAILABLE');
  await refuse(svc.setNoteText(K, photo.id, { text: 'é'.repeat(201) }), 'SAFEBOX_NOTE_TOO_LONG');
  await refuse(svc.setNoteText(A, photo.id, { text: 'pas à moi' }), 'SAFEBOX_NOT_FOUND');
  assert.strictEqual((await svc.setNoteText(K, photo.id, { text: '  Mariage de Paul  ' })).note.text, 'Mariage de Paul');
  assert.deepStrictEqual((await vue()).note.audio, null);

  // Audio : réservé, compté, vérifié chez MEGA, puis lisible par son propriétaire.
  const avant = (await svc.usageOf(K)).usedBytes;
  await refuse(svc.reserveNoteAudio(K, photo.id, { size: 2000, plainSize: 1984, durationMs: 301_500 }), 'SAFEBOX_NOTE_TOO_LONG');
  const r1 = await svc.reserveNoteAudio(K, photo.id, { size: 2000, plainSize: 1984, durationMs: 60_000 });
  assert.strictEqual((await svc.usageOf(K)).usedBytes, avant + 2000);
  await refuse(svc.completeNoteAudio(K, photo.id, { key: cle.toString('base64') }), 'SAFEBOX_UPLOAD_INCOMPLETE');
  const objet1 = r1.url.replace('https://s4.test/put/', '').replace(/\?size=\d+$/, '');
  stockage.objets.set(objet1, 2000);
  const fin = await svc.completeNoteAudio(K, photo.id, { key: cle.toString('base64') });
  assert.strictEqual(fin.note.text, 'Mariage de Paul');
  assert.strictEqual(fin.note.audio.durationMs, 60_000);
  assert.strictEqual(fin.note.audio.key, cle.toString('base64'));
  assert.ok(fin.note.audio.url.endsWith('00001'));

  // Réenregistré : l'ancien audio part tout de suite de chez MEGA, l'espace ne compte que le nouveau.
  const r2 = await svc.reserveNoteAudio(K, photo.id, { size: 3000, plainSize: 2984, durationMs: 90_000 });
  assert.ok(!stockage.objets.has(objet1));
  assert.strictEqual((await svc.usageOf(K)).usedBytes, avant + 3000);
  const objet2 = r2.url.replace('https://s4.test/put/', '').replace(/\?size=\d+$/, '');
  stockage.objets.set(objet2, 3000);
  await svc.completeNoteAudio(K, photo.id, { key: cle.toString('base64') });

  // Privé : ni le destinataire d'un partage, ni sa copie enregistrée ne le voient.
  const Q = await compte('ami-photo');
  const [c] = await pool.query('INSERT INTO conversation () VALUES ()');
  await pool.query('INSERT INTO conv_participants (conversID, alanyaID) VALUES (?, ?), (?, ?)', [c.insertId, K, c.insertId, Q]);
  const p = await svc.createShare(K, { fileId: photo.id, conversationId: c.insertId });
  const plan = await svc.shareDownload(Q, p.shareId);
  assert.ok(!('note' in plan.file), 'le commentaire ne part pas avec la photo');
  const copie = await svc.saveShare(Q, p.shareId);
  const racinesQ = Object.fromEntries((await svc.overview(Q)).roots.map((r) => [r.root, r.id]));
  assert.strictEqual((await svc.listFolder(Q, racinesQ.photos)).files.find((x) => x.id === copie.id).note, null);

  // Le rapprochement ne prend pas l'audio pour un objet orphelin.
  stockage.ages.set(objet2, new Date(Date.now() - 10 * 86_400_000));
  await reconcileFull(pool, stockage, { alertFloor: 10, trigger: 'manual' });
  assert.ok(stockage.objets.has(objet2));

  // Supprimer l'audio garde le texte ; effacer le texte ensuite efface le commentaire.
  const sansAudio = await svc.deleteNoteAudio(K, photo.id);
  assert.strictEqual(sansAudio.note.audio, null);
  assert.strictEqual(sansAudio.note.text, 'Mariage de Paul');
  assert.ok(!stockage.objets.has(objet2));
  assert.strictEqual((await svc.usageOf(K)).usedBytes, avant);
  assert.strictEqual((await svc.setNoteText(K, photo.id, { text: '' })).note, null);
  const [[reste]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_note WHERE file_id = ?', [photo.id]);
  assert.strictEqual(Number(reste.n), 0);

  // La photo supprimée emporte son commentaire.
  await svc.setNoteText(K, photo.id, { text: 'encore' });
  await svc.trashFile(K, photo.id);
  await svc.emptyTrash(K);
  const [[parti]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_note WHERE file_id = ?', [photo.id]);
  assert.strictEqual(Number(parti.n), 0);
});

test('commentaire : un seul par photo, dans Photos comme dans ses albums, et il suit la photo (31/10/2026)', async () => {
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_note'`,
  );
  if (!Number(t.n)) return;
  const L = await compte('Lina');
  const racines = Object.fromEntries((await svc.overview(L)).roots.map((r) => [r.root, r.id]));
  const photo = await deposerFichier(L, racines.photos, 'Kribi.jpg', 30);
  const album = await svc.createFolder(L, { parentId: racines.albums, name: 'Kribi' });
  const { files: [copie] } = await svc.addToFolder(L, album.id, { fileIds: [photo.id] });
  const noteDans = async (dossier, id) => (await svc.listFolder(L, dossier)).files.find((x) => x.id === id).note;
  const lignes = async () => (await pool.query(
    'SELECT n.file_id FROM safebox_note n JOIN safebox_file f ON f.id = n.file_id WHERE f.alanyaID = ?', [L],
  ))[0].map((r) => Number(r.file_id));

  // Écrit dans Photos, lu dans l'album ; modifié dans l'album, c'est le même.
  await svc.setNoteText(L, photo.id, { text: 'Avant la pluie' });
  assert.strictEqual((await noteDans(album.id, copie.id)).text, 'Avant la pluie');
  await svc.setNoteText(L, copie.id, { text: 'Avant la pluie, avec Paul' });
  assert.strictEqual((await noteDans(racines.photos, photo.id)).text, 'Avant la pluie, avec Paul');
  assert.deepStrictEqual(await lignes(), [photo.id], 'une seule ligne, sur le premier exemplaire');

  // Un audio ajouté depuis l'album rejoint le même commentaire.
  const r = await svc.reserveNoteAudio(L, copie.id, { size: 1000, plainSize: 984, durationMs: 5000 });
  stockage.objets.set(r.url.replace('https://s4.test/put/', '').replace(/\?size=\d+$/, ''), 1000);
  await svc.completeNoteAudio(L, copie.id, { key: cle.toString('base64') });
  assert.strictEqual((await noteDans(racines.photos, photo.id)).audio.durationMs, 5000);

  // La photo de Photos à la corbeille : le commentaire passe sur l'exemplaire de
  // l'album, audio lisible (clé rechiffrée), rien de compté comme corbeille.
  await svc.trashFile(L, photo.id);
  assert.deepStrictEqual(await lignes(), [copie.id]);
  const deplace = await noteDans(album.id, copie.id);
  assert.strictEqual(deplace.text, 'Avant la pluie, avec Paul');
  assert.strictEqual(deplace.audio.key, cle.toString('base64'));
  assert.strictEqual((await svc.usageOf(L)).trashBytes, 0);
  // La corbeille vidée, il reste.
  await svc.emptyTrash(L);
  assert.strictEqual((await noteDans(album.id, copie.id)).text, 'Avant la pluie, avec Paul');

  // Le dernier exemplaire à la corbeille puis restauré : le commentaire revient avec lui.
  await svc.trashFile(L, copie.id);
  await svc.restoreFile(L, copie.id);
  assert.strictEqual((await noteDans(album.id, copie.id)).text, 'Avant la pluie, avec Paul');
});

test('albums récents (30/10/2026) : les derniers remplis, leur nombre, quatre couvertures', async () => {
  const R2 = await compte('Rita');
  const racines = Object.fromEntries((await svc.overview(R2)).roots.map((r) => [r.root, r.id]));
  assert.deepStrictEqual((await svc.recentAlbums(R2)).albums, []);
  const ancien = await svc.createFolder(R2, { parentId: racines.albums, name: 'Ancien' });
  const plein = await svc.createFolder(R2, { parentId: racines.albums, name: 'Plein' });
  const vide = await svc.createFolder(R2, { parentId: racines.albums, name: 'Vide' });
  const sousPhotos = await svc.createFolder(R2, { parentId: racines.photos, name: 'Pas un album' });
  await deposerFichier(R2, ancien.id, 'a.jpg');
  const docs = [];
  for (let i = 0; i < 3; i += 1) docs.push(await deposerFichier(R2, plein.id, `doc${i}.pdf`));
  const photos = [];
  for (let i = 0; i < 3; i += 1) photos.push(await deposerFichier(R2, plein.id, `p${i}.jpg`));
  await deposerFichier(R2, sousPhotos.id, 'x.jpg');
  // L'ordre suit le dernier ajout, pas la création : « Ancien » vient d'être rempli.
  await pool.query('UPDATE safebox_folder SET created_at = NOW() - INTERVAL 3 DAY WHERE id IN (?)', [[ancien.id, plein.id]]);
  await pool.query('UPDATE safebox_folder SET created_at = NOW() - INTERVAL 2 DAY WHERE id = ?', [vide.id]);
  await pool.query('UPDATE safebox_file SET created_at = NOW() - INTERVAL 1 DAY WHERE folder_id = ?', [plein.id]);
  const { albums } = await svc.recentAlbums(R2);
  assert.deepStrictEqual(albums.map((a) => a.name), ['Ancien', 'Plein', 'Vide']);
  const [a, p, v] = albums;
  assert.strictEqual(a.fileCount, 1);
  assert.strictEqual(p.fileCount, 6);
  assert.strictEqual(v.fileCount, 0);
  assert.strictEqual(v.lastAddedAt, null);
  assert.deepStrictEqual(v.cover, []);
  // Quatre couvertures, photos d'abord (les plus récentes), puis un document ; clé comprise.
  assert.deepStrictEqual(p.cover.map((f) => f.name), ['p2.jpg', 'p1.jpg', 'p0.jpg', 'doc2.pdf']);
  assert.ok(p.cover.every((f) => f.key && f.folderId === plein.id));
  // Une corbeille et un sous-dossier de Photos n'y sont pas.
  await svc.trashFile(R2, photos[2].id);
  assert.deepStrictEqual((await svc.recentAlbums(R2)).albums[1].cover.map((f) => f.name), ['p1.jpg', 'p0.jpg', 'doc2.pdf', 'doc1.pdf']);
  assert.strictEqual((await svc.recentAlbums(R2)).albums[1].fileCount, 5);
  assert.ok(!(await svc.recentAlbums(R2, { limit: 12 })).albums.some((x) => x.name === 'Pas un album'));
  assert.strictEqual((await svc.recentAlbums(R2, { limit: 1 })).albums.length, 1);
});

(async () => {
  try {
    for (const [nom, fn] of etapes) {
      try {
        await fn();
        ok += 1;
      } catch (e) {
        console.error(`✗ ${nom}\n  ${e.stack}`);
        process.exitCode = 1;
        break; // les étapes s'enchaînent : la suite n'a plus de sens
      }
    }
  } finally {
    if (comptes.length) await pool.query('DELETE FROM users WHERE alanyaID IN (?)', [comptes]).catch(() => {});
    await pool.query('DELETE FROM conversation').catch(() => {});
    await pool.query("DELETE FROM safebox_blob WHERE status <> 'ready' OR alanyaID IS NULL").catch(() => {});
    await pool.end();
  }
  console.log(`safebox.db : ${ok}/${etapes.length} étapes passées`);
})();
