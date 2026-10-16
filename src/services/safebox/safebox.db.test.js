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
 *     CREATE TABLE users (alanyaID INT AUTO_INCREMENT PRIMARY KEY, nom VARCHAR(50));
 *     CREATE TABLE scheduler_leases (name VARCHAR(64) PRIMARY KEY);"
 *   mysql --no-defaults -h127.0.0.1 -P33071 -uroot -pjetable talky_test < migrations/101_safebox.sql
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
const { runSafeboxPurge, collectOrphans } = require('./purge');
const { SafeboxError } = require('./errors');
const { Mio, BLOCK_BYTES } = require('../../constants/safebox');

const env = { SAFEBOX_KEY: crypto.randomBytes(32).toString('base64') };

function fauxStockage() {
  const objets = new Map();
  return {
    objets,
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

test('ouverture : quatre racines, une seule fois même en parallèle', async () => {
  A = await compte('coffre-a');
  B = await compte('coffre-b');
  const vues = await Promise.all([svc.overview(A), svc.overview(A), svc.overview(A)]);
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM safebox_folder WHERE alanyaID = ?', [A]);
  assert.strictEqual(Number(n.n), 4);
  assert.deepStrictEqual(vues[0].roots.map((r) => r.root), ['albums', 'videos', 'audios', 'documents']);
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
  await svc.createFolder(A, { parentId: racinesA.albums, name: 'Mariage' });
  let p = mariage;
  for (let i = 2; i <= 5; i += 1) p = await svc.createFolder(A, { parentId: p.id, name: `n${i}` });
  assert.strictEqual(p.depth, 5);
  await refuse(svc.createFolder(A, { parentId: p.id, name: 'n6' }), 'SAFEBOX_TOO_DEEP');
});

test('dossiers : plafond par compte', async () => {
  // 1 (Mariage) + 1 (albums/Mariage) + 4 (n2..n5) = 6 ; le plafond est 8.
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
  const albumsB = (await svc.overview(B)).roots[0].id;
  await refuse(svc.updateFolder(B, autre.id, { parentId: albumsB }), 'SAFEBOX_WRONG_FAMILY');
  await refuse(svc.updateFolder(B, albumsB, { name: 'Photos' }), 'SAFEBOX_ROOT_LOCKED');
  await refuse(svc.trashFolder(B, albumsB), 'SAFEBOX_ROOT_LOCKED');
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
  assert.strictEqual(r.trashBytes, 0);
  assert.strictEqual((await svc.largestFiles(B)).files.length, 0);
  assert.strictEqual((await svc.largestFiles(A, { limit: 1 })).files.length, 1);
  await svc.trashFile(A, petit.fileId);
  assert.strictEqual((await svc.largestFiles(A)).files.length, 1, 'la corbeille n\'est pas listée');
  assert.ok((await svc.largestFiles(A)).trashBytes > 0);
  await svc.emptyTrash(A);
});

test('fichiers : renommer et déplacer dans la famille seulement', async () => {
  const f = await svc.updateFile(A, video.fileId, { name: 'Cérémonie.mov' });
  assert.strictEqual(f.ext, 'mov');
  await refuse(svc.updateFile(A, video.fileId, { name: 'Cérémonie.pdf' }), 'SAFEBOX_WRONG_FAMILY');
  await refuse(svc.updateFile(A, video.fileId, { folderId: racinesA.albums }), 'SAFEBOX_WRONG_FAMILY');
  const g = await svc.updateFile(A, video.fileId, { folderId: racinesA.videos });
  assert.strictEqual(g.folderId, racinesA.videos);
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
    await pool.query("DELETE FROM safebox_blob WHERE status <> 'ready' OR alanyaID IS NULL").catch(() => {});
    await pool.end();
  }
  console.log(`safebox.db : ${ok}/${etapes.length} étapes passées`);
})();
