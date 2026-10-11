/**
 * Création d'un sticker perso ANIMÉ, de bout en bout hors base et hors stockage —
 * `node src/services/stickerAnimeService.test.js`.
 *
 * Réel : `stickerPersonalService`, `stickerAssetService.depsSql`, `stickerAnime`
 * (vraie conversion `sharp` sur les GIF de `testUtils/stickers/anime`). Doublés :
 * le pool MySQL (un mini-état en mémoire) et le stockage (journal des dépôts).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};
const gif = (nom) => fs.readFileSync(path.join(__dirname, '..', 'testUtils', 'stickers', 'anime', nom));

// ── Stockage doublé ─────────────────────────────────────────────────────────
const stockage = { deposes: [], copies: [], retires: [] };
remplace('./mediaStorage', {
  officialStickerKey: ({ pack, sid, sha256, thumb = false }) => `official/stickers/${pack}/${sid}_${sha256.slice(0, 8)}${thumb ? '_t' : ''}.webp`,
  personalStickerKey: ({ alanyaID, sha256, sel, thumb = false }) => `stickers/u/${alanyaID}/${sel}_${sha256}${thumb ? '_t' : ''}.webp`,
  putBody: async (k, corps, o) => { stockage.deposes.push({ k, corps, type: o && o.contentType }); },
  copyObject: async (src, dst) => { stockage.copies.push([src, dst]); },
  removeAllVersions: async (k) => { stockage.retires.push(k); },
});

// ── Base doublée : état minimal en mémoire ──────────────────────────────────
const etat = {
  assets: [], // { id, owner_id, sha256, animated, ... }
  insertsAsset: [],
  insertsOfficiel: [],
  insertsSticker: [],
  bloques: new Set(),
  usage: { assets: 0, uploads: 0 },
  stickersDuPack: 0,
  requetes: [],
};
let seq = 100;
const exec = async (sql, params) => {
  etat.requetes.push([sql, params]);
  if (/SELECT id, code FROM sticker_pack\s+WHERE owner_id/i.test(sql)) return [[{ id: 3, code: 'u_7_x' }], []];
  if (/SELECT COUNT\(\*\) AS n FROM sticker WHERE pack_id = \?/i.test(sql)) return [[{ n: etat.stickersDuPack }], []];
  if (/FROM sticker_blocklist/i.test(sql)) return [etat.bloques.has(params[0]) ? [{ 1: 1 }] : [], []];
  if (/SELECT\s+\(SELECT COUNT\(\*\) FROM sticker_asset/i.test(sql)) return [[{ assets: etat.usage.assets, uploads: etat.usage.uploads }], []];
  if (/SELECT id FROM sticker_asset WHERE owner_id = \? AND sha256 = \? FOR UPDATE/i.test(sql)) {
    return [etat.assets.filter((a) => a.owner_id === params[0] && a.sha256 === params[1]).map((a) => ({ id: a.id })), []];
  }
  if (/SELECT id, storage_key FROM sticker_asset WHERE owner_id = 0 AND sha256 = \? FOR UPDATE/i.test(sql)) return [[], []];
  if (/INSERT INTO sticker_asset \(owner_id, sha256, storage_key, mime, width, height, bytes, animated\)\s+VALUES \(0,/i.test(sql)) {
    etat.insertsOfficiel.push(params);
    return [{ insertId: (seq += 1) }, []];
  }
  if (/INSERT INTO sticker_asset/i.test(sql)) {
    const a = { id: (seq += 1), owner_id: params[0], sha256: params[1], width: params[2], height: params[3], bytes: params[4], animated: params[5] };
    etat.assets.push(a);
    etat.insertsAsset.push({ sql, params });
    return [{ insertId: a.id }, []];
  }
  if (/INSERT INTO sticker \(/i.test(sql)) {
    etat.insertsSticker.push(params);
    return [{ insertId: (seq += 1) }, []];
  }
  return [{ affectedRows: 1 }, []];
};
const connexion = {
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, execute: exec,
};
const db = { execute: exec, getConnection: async () => connexion };
remplace('../config/db', db);

const sp = require('./stickerPersonalService');
const { semaphoreAnime } = require('../utils/stickerAnime');

const reinit = () => {
  etat.assets = []; etat.insertsAsset = []; etat.insertsOfficiel = []; etat.insertsSticker = []; etat.bloques = new Set();
  etat.usage = { assets: 0, uploads: 0 }; etat.stickersDuPack = 0; etat.requetes = [];
  stockage.deposes = []; stockage.copies = []; stockage.retires = [];
};
const ecritures = () => etat.requetes.filter(([s]) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)).length;

let nb = 0;
const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);
const attendErreur = async (fn, code, status) => {
  try { await fn(); } catch (e) {
    assert.strictEqual(e.code, code, `code attendu ${code}, reçu ${e.code} (${e.message})`);
    if (status) assert.strictEqual(e.status, status);
    return e;
  }
  throw new Error(`aurait dû lever ${code}`);
};

test('création : actif animé=1, deux fichiers sous une clé SALÉE, vignette 96×96 statique, empreinte du fichier FINAL', async () => {
  reinit();
  const t0 = Date.now();
  const r = await sp.creerStickerPersoAnime({ buffer: gif('gif-30-carre.gif'), alanyaID: 7, emoji: '🎉', nom: 'Fête', forme: 'cercle' });
  const ms = Date.now() - t0;
  assert.strictEqual(r.animated, true);
  assert.strictEqual(r.frames, 30);
  assert.strictEqual(r.durationMs, 3000);
  assert.strictEqual(r.reutilise, false);
  assert.strictEqual(r.packId, 3);
  assert.ok(r.bytes > 0 && r.bytes <= 300 * 1024);

  const [{ params }] = etat.insertsAsset;
  assert.deepStrictEqual(params.slice(2, 4), [512, 512]);
  assert.strictEqual(params[5], 1, 'sticker_asset.animated = 1');
  assert.strictEqual(etat.assets[0].owner_id, 7, 'propriétaire = JWT');

  assert.strictEqual(stockage.deposes.length, 2);
  const [fichier, vignette] = stockage.deposes;
  assert.match(fichier.k, /^stickers\/u\/7\/[0-9a-f]{16}_[0-9a-f]{64}\.webp$/, 'sel16 + sha256 du fichier final');
  assert.strictEqual(vignette.k, fichier.k.replace(/\.webp$/, '_t.webp'));
  assert.strictEqual(fichier.type, 'image/webp');
  assert.ok(fichier.k.includes(etat.assets[0].sha256), 'l\'empreinte nommée est celle des octets déposés');
  assert.strictEqual(require('crypto').createHash('sha256').update(fichier.corps).digest('hex'), etat.assets[0].sha256);
  const m = await sharp(fichier.corps, { animated: true, pages: -1 }).metadata();
  assert.deepStrictEqual([m.pages, m.width, m.pageHeight, m.loop], [30, 512, 512, 0]);
  const t = await sharp(vignette.corps).metadata();
  assert.deepStrictEqual([t.width, t.height, t.pages || 1], [96, 96, 1]);
  const pos = etat.insertsSticker[0];
  assert.strictEqual(pos[1], etat.assets[0].id);
  assert.strictEqual(pos[2], '🎉');
  assert.deepStrictEqual(JSON.parse(pos[3]), { fr: 'Fête' });
  console.log(`  mesure : création animée de bout en bout (service + conversion) : ${ms} ms, ${r.bytes} o`);
});

test('idempotence : le même fichier converti deux fois = un seul actif, aucun nouveau dépôt', async () => {
  reinit();
  const buffer = gif('gif-30-carre.gif');
  const a = await sp.creerStickerPersoAnime({ buffer, alanyaID: 7, forme: 'carre' });
  const deposes = stockage.deposes.length;
  const b = await sp.creerStickerPersoAnime({ buffer, alanyaID: 7, forme: 'carre' });
  assert.strictEqual(b.reutilise, true);
  assert.strictEqual(b.assetId, a.assetId);
  assert.notStrictEqual(b.stickerId, a.stickerId, 'une nouvelle ligne sticker dans le pack');
  assert.strictEqual(stockage.deposes.length, deposes, 'aucun fichier de plus');
  assert.strictEqual(etat.insertsAsset.length, 1);
  // Une autre forme est un autre fichier, donc un autre actif.
  const c = await sp.creerStickerPersoAnime({ buffer, alanyaID: 7, forme: 'cercle' });
  assert.strictEqual(c.reutilise, false);
  assert.notStrictEqual(c.assetId, a.assetId);
  // Un autre compte : son propre actif et son propre sel (jamais d'oracle d'existence).
  const d = await sp.creerStickerPersoAnime({ buffer, alanyaID: 8, forme: 'carre' });
  assert.strictEqual(d.reutilise, false);
  const cles = stockage.deposes.map((x) => x.k).filter((k) => !k.endsWith('_t.webp'));
  assert.strictEqual(new Set(cles.map((k) => k.split('/').pop().split('_')[0])).size, cles.length, 'sels distincts');
});

test('quotas et blocklist : refus AVANT toute écriture, et les quotas AVANT la conversion', async () => {
  reinit();
  const buffer = gif('gif-30-carre.gif');
  etat.usage = { assets: 200, uploads: 0 };
  const t0 = Date.now();
  await attendErreur(() => sp.creerStickerPersoAnime({ buffer, alanyaID: 7 }), 'STICKER_QUOTA_EXCEEDED', 429);
  assert.ok(Date.now() - t0 < 500, 'quota refusé sans convertir (3 à 15 s de CPU épargnées)');
  etat.usage = { assets: 0, uploads: 30 };
  await attendErreur(() => sp.creerStickerPersoAnime({ buffer, alanyaID: 7 }), 'STICKER_QUOTA_EXCEEDED', 429);
  assert.strictEqual(ecritures(), 0);
  assert.strictEqual(stockage.deposes.length, 0);

  // Blocklist : l'empreinte du fichier final (un 1er passage la révèle).
  etat.usage = { assets: 0, uploads: 0 };
  const premier = await sp.creerStickerPersoAnime({ buffer, alanyaID: 7, forme: 'carre' });
  etat.bloques.add(etat.assets.find((a) => a.id === premier.assetId).sha256);
  reinit2();
  await attendErreur(() => sp.creerStickerPersoAnime({ buffer, alanyaID: 9, forme: 'carre' }), 'STICKER_ASSET_BLOCKED', 422);
  assert.strictEqual(ecritures(), 0, 'rien n\'est écrit pour une image bloquée');
  assert.strictEqual(stockage.deposes.length, 0);
});
function reinit2() { etat.assets = []; etat.insertsAsset = []; etat.insertsSticker = []; etat.requetes = []; stockage.deposes = []; }

test('plafond du pack : 40 stickers = refus avant la conversion', async () => {
  reinit();
  etat.stickersDuPack = 40;
  const t0 = Date.now();
  await attendErreur(() => sp.creerStickerPersoAnime({ buffer: gif('gif-30-carre.gif'), alanyaID: 7 }), 'STICKER_PACK_LIMIT', 409);
  assert.ok(Date.now() - t0 < 500);
  assert.strictEqual(ecritures(), 0);
});

test('bombes et faux fichiers : STICKER_ASSET_INVALID, rien d\'écrit, rien de déposé', async () => {
  reinit();
  for (const [nom, buffer] of [
    ['6000×6000', gif('gif-6000x6000.gif')],
    ['301 pages', gif('gif-301-pages.gif')],
    ['80 Mpx', gif('gif-2000x2000-20.gif')],
    ['faux GIF', Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(300, 9)])],
    ['PNG', await sharp({ create: { width: 512, height: 512, channels: 4, background: '#fff' } }).png().toBuffer()],
    ['bruit trop lourd', gif('gif-bruite-lourd.gif')],
  ]) {
    const e = await attendErreur(() => sp.creerStickerPersoAnime({ buffer, alanyaID: 7 }), 'STICKER_ASSET_INVALID', 422);
    assert.ok(!/vips|sharp|\/home\//i.test(e.message), `${nom} : message uniforme (${e.message})`);
  }
  assert.strictEqual(ecritures(), 0);
  assert.strictEqual(stockage.deposes.length, 0);
});

test('file pleine : 503 SERVICE_UNAVAILABLE retryable, rien d\'écrit ; le créneau est rendu ensuite', async () => {
  reinit();
  const stats = () => semaphoreAnime.stats();
  assert.strictEqual(stats().actifs, 0);
  const tenu = await semaphoreAnime.acquerir(); // un encodage « en cours »
  const attentes = [];
  for (let i = 0; i < stats().fileMax; i += 1) attentes.push(semaphoreAnime.acquerir()); // la file courte est pleine
  const e = await attendErreur(() => sp.creerStickerPersoAnime({ buffer: gif('gif-30-carre.gif'), alanyaID: 7 }), 'SERVICE_UNAVAILABLE', 503);
  assert.ok(Number.isInteger(e.retryAfterS) && e.retryAfterS > 0, 'Retry-After suggéré');
  assert.strictEqual(ecritures(), 0);
  tenu();
  for (const a of attentes) (await a)(); // chacun reçoit le créneau à son tour
  assert.strictEqual(stats().actifs, 0);
  assert.strictEqual(stats().enAttente, 0);
});

test('animés fermés : la copie d\'un sticker animé reçu est refusée (STICKER_NOT_FOUND) ; ouverts, elle garde l\'indicateur', async () => {
  reinit();
  const SHA = 'c'.repeat(64);
  const source = { id: 5, owner_id: 0, sha256: SHA, storage_key: 'official/stickers/x/1_a.webp', thumb_key: 'official/stickers/x/1_a_t.webp', mime: 'image/webp', width: 512, height: 512, bytes: 9000, animated: 1, status: 0 };
  const base = {
    execute: async (sql, p) => {
      if (/SELECT id, owner_id, sha256, storage_key, thumb_key, mime, width, height, bytes, animated, status/.test(sql)) return [[source], []];
      return exec(sql, p);
    },
    getConnection: db.getConnection,
  };
  await attendErreur(() => sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, base, { animesOuverts: async () => false }), 'STICKER_NOT_FOUND', 404);
  await attendErreur(() => sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, base, { animesOuverts: async () => { throw new Error('panne'); } }), 'STICKER_NOT_FOUND', 404);
  assert.strictEqual(ecritures(), 0);
  await sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, base, { animesOuverts: async () => true });
  assert.strictEqual(etat.insertsAsset[0].params.at(-1), 1, 'la copie reste un actif animé');
  assert.strictEqual(stockage.copies.length, 2, 'fichier + vignette copiés côté stockage');
});

test('officiel (admin) : un WebP animé final est déposé, ré-encodé, animated = 1 ; un statique reste à 0', async () => {
  reinit();
  const { creerStickerOfficiel } = require('./stickerAssetService');
  const src = gif('gif-30-carre.gif');
  const anime = await sharp(src, { animated: true, pages: 15, limitInputPixels: 320 * 320 * 15 + 1 })
    .resize(512, 512, { fit: 'cover' }).ensureAlpha()
    .webp({ quality: 80, effort: 3, loop: 0, delay: Array(15).fill(100) }).toBuffer();
  const r = await creerStickerOfficiel({ buffer: anime, packId: 6, packCode: 'royal', position: 0, emoji: '👑' });
  assert.strictEqual(r.animated, true);
  assert.strictEqual(etat.insertsOfficiel.length, 1);
  assert.strictEqual(etat.insertsOfficiel[0].at(-1), 1, 'sticker_asset.animated = 1');
  assert.deepStrictEqual(etat.insertsOfficiel[0].slice(1, 3), [512, 512]);
  assert.strictEqual(stockage.deposes.length, 2);
  assert.match(stockage.deposes[0].k, /^official\/stickers\/royal\/\d+_[0-9a-f]{8}\.webp$/);
  assert.match(stockage.deposes[1].k, /_t\.webp$/);
  const m = await sharp(stockage.deposes[0].corps, { animated: true, pages: -1 }).metadata();
  assert.deepStrictEqual([m.pages, m.width, m.pageHeight, m.loop], [15, 512, 512, 0]);
  assert.strictEqual((await sharp(stockage.deposes[1].corps).metadata()).width, 96, 'vignette 96×96');
  // Statique : exactement comme avant (animated = 0).
  reinit();
  const png = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 9, g: 9, b: 200, alpha: 0.6 } } }).png().toBuffer();
  const s2 = await creerStickerOfficiel({ buffer: png, packId: 6, packCode: 'royal', position: 1, emoji: '👑' });
  assert.strictEqual(s2.animated, false);
  assert.strictEqual(etat.insertsOfficiel[0].at(-1), 0);
  // Un animé hors limites (46 images) est refusé sans rien écrire.
  reinit();
  const trop = await sharp(gif('gif-60-non-carre.gif'), { animated: true, pages: 46, limitInputPixels: 320 * 240 * 46 + 1 })
    .resize(512, 512, { fit: 'cover' }).ensureAlpha()
    .webp({ quality: 80, effort: 3, loop: 0, delay: Array(46).fill(50) }).toBuffer();
  await attendErreur(() => creerStickerOfficiel({ buffer: trop, packId: 6, packCode: 'royal', position: 2, emoji: '👑' }), 'STICKER_ASSET_INVALID', 422);
  assert.strictEqual(stockage.deposes.length, 0);
});

(async () => {
  for (const [nom, fn] of tests) {
    try { await fn(); nb += 1; } catch (e) { console.error(`ÉCHEC : ${nom}`); console.error(e); process.exit(1); }
  }
  console.log(`stickerAnimeService.test.js : ${nb} tests OK`);
})();
