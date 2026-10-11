/**
 * Contrat stickers côté serveur — `node src/services/stickerContrat.test.js`.
 * Pur : formes de réponse contre les fixtures, réglages,
 * `stickers:sync`, clés de stockage, exemption de la purge, codes d'erreur.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fix = (nom) => require(path.join(__dirname, '..', 'testUtils', 'stickers', nom));
const { presentCatalog, presentPack, presentMe, presentMesPacks, presentPartage } = require('../utils/stickerPresenter');
const {
  stickersOuverts, creationOuverte, animesOuverts, creationAnimeeOuverte, DEFAULTS,
} = require('./stickerSettingsService');
const { syncPayload, emitStickersSync, emitStickersSyncAll, REASONS } = require('./stickerSync');
const storage = require('./mediaStorage');
const { expiredMediaWhere } = require('./mediaRetention');
const { makeFakeIo } = require('../testUtils/fakeIo');

const urlDe = (k) => `https://<bucket>/${k}`;
const memesCles = (a, b, msg) => assert.deepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort(), msg);

// ── Formes de réponse = fixtures ───────────────────────────────────────────
{
  const cat = fix('catalog.json');
  const lignes = [
    { id: 1, code: 'alanya', name_i18n: { fr: 'Alanya' }, description_i18n: { fr: 'Le pack de la maison : appels, messages, réseau.' }, is_premium: 0, version: 1, count: 14, cover_thumb_key: 'official/stickers/alanya/1_ab12cd34_t.webp' },
    { id: 6, code: 'royal', name_i18n: { fr: 'Royale', en: 'Royal' }, description_i18n: { en: 'The Plus pack: crowns, trophies, sparkle.' }, is_premium: 1, version: 1, count: 12, cover_thumb_key: 'official/stickers/royal/71_9f8e7d6c_t.webp' },
  ];
  const sortie = presentCatalog({ packs: lignes, version: 3, lang: 'en', urlDe, verrouille: true });
  memesCles(sortie, cat, 'catalogue : clés de premier niveau');
  assert.strictEqual(sortie.version, 3);
  sortie.packs.forEach((p, i) => memesCles(p, cat.packs[i], `catalogue : clés du pack ${p.code}`));
  assert.deepStrictEqual(sortie.packs[0], { ...cat.packs[0], name: 'Alanya' }, 'alanya : repli fr (pas d\'en)');
  assert.deepStrictEqual(sortie.packs[1], { ...cat.packs[1], name: 'Royal' });
  // Droit présent : plus de verrou sur le pack Plus ; le pack gratuit ne l'est jamais
  const ouvert = presentCatalog({ packs: lignes, version: 3, lang: 'fr', urlDe, verrouille: false });
  assert.strictEqual(ouvert.packs[1].locked, false);
  assert.strictEqual(ouvert.packs[1].isPremium, true);
  assert.strictEqual(sortie.packs[0].locked, false, 'un pack gratuit n\'est jamais verrouillé');
  assert.strictEqual(ouvert.packs[1].name, 'Royale');
  // Sans couverture : null, jamais une URL cassée
  assert.strictEqual(presentCatalog({ packs: [{ ...lignes[0], cover_thumb_key: null }], version: 1, lang: 'fr', urlDe }).packs[0].cover, null);

  const pk = fix('pack.json');
  const stickers = [{ id: 1, position: 0, emoji: '👋', name_i18n: { fr: 'Bienvenue sur Alanya' }, storage_key: 'official/stickers/alanya/1_ab12cd34.webp', thumb_key: 'official/stickers/alanya/1_ab12cd34_t.webp', width: 512, height: 512, bytes: 43110, animated: 0 }];
  const p = presentPack({ pack: { id: 1, code: 'alanya', name_i18n: { fr: 'Alanya' }, version: 1, is_premium: 0 }, stickers, lang: 'fr', urlDe, verrouille: false });
  for (const k of Object.keys(pk)) assert.ok(k in p, `pack : clé ${k}`);
  assert.deepStrictEqual(p.stickers[0], pk.stickers[0], 'sticker : exactement la fixture');
  // Sans vignette : le fichier lui-même
  assert.strictEqual(presentPack({ pack: { id: 1, code: 'x', version: 1 }, stickers: [{ ...stickers[0], thumb_key: null }], lang: 'fr', urlDe }).stickers[0].thumb, stickers[0].storage_key ? urlDe(stickers[0].storage_key) : null);

  const me = fix('me.json');
  const m = presentMe({ packs: [{ id: 1, code: 'alanya', position: 0 }, { id: 3, code: 'mboa', position: 1 }], favorites: ['1', 45, 46], version: 12 });
  assert.deepStrictEqual(m, me, '/me : exactement la fixture, ids seulement');
}

// ── Réglages : un seul interrupteur, fermé par défaut ──────────────────────
{
  assert.strictEqual(DEFAULTS.enabled, 0);
  assert.strictEqual(DEFAULTS.creation_enabled, 0);
  assert.strictEqual(DEFAULTS.animated_enabled, 0);
  assert.strictEqual(stickersOuverts(DEFAULTS), false, 'valeurs par défaut : fermé');
  assert.strictEqual(stickersOuverts(null), false);
  assert.strictEqual(stickersOuverts({}), false);
  assert.strictEqual(stickersOuverts({ enabled: 0 }), false);
  assert.strictEqual(stickersOuverts({ enabled: 1 }), true, 'interrupteur seul : ouvert');
  assert.strictEqual(stickersOuverts({ enabled: '1' }), true, 'toléré : TINYINT rendu en chaîne');
  // Les colonnes de cohorte de la migration 097 restent en base mais sont
  // inertes : elles n'ouvrent ni ne ferment quoi que ce soit.
  assert.strictEqual(stickersOuverts({ enabled: 0, cohort_percent: 100, cohort_ids: '[7]' }), false);
  assert.strictEqual(stickersOuverts({ enabled: 1, cohort_percent: 0, cohort_ids: '[]' }), true);
}

// ── V1c : interrupteur `animated_enabled`, `features`, omission des animés ────
{
  assert.strictEqual(animesOuverts(DEFAULTS), false, 'défaut : fermé');
  assert.strictEqual(animesOuverts({ enabled: 1 }), false, 'animated_enabled absent : fermé');
  assert.strictEqual(animesOuverts({ enabled: 1, animated_enabled: 1 }), true);
  assert.strictEqual(animesOuverts({ enabled: 0, animated_enabled: 1 }), false, '`enabled` ferme tout');
  assert.strictEqual(animesOuverts({ enabled: 1, animated_enabled: '1' }), true, 'TINYINT rendu en chaîne');
  assert.strictEqual(creationAnimeeOuverte({ enabled: 1, creation_enabled: 1, animated_enabled: 0 }), false);
  assert.strictEqual(creationAnimeeOuverte({ enabled: 1, creation_enabled: 0, animated_enabled: 1 }), false, 'création fermée : animée aussi');
  assert.strictEqual(creationAnimeeOuverte({ enabled: 0, creation_enabled: 1, animated_enabled: 1 }), false);
  assert.strictEqual(creationAnimeeOuverte({ enabled: 1, creation_enabled: 1, animated_enabled: 1 }), true);
  assert.strictEqual(creationOuverte({ enabled: 1, creation_enabled: 1 }), true, 'V1b inchangé');

  // `features` additif : absent si non fourni (fixture me.json intacte), sinon booléens.
  const base = { packs: [], favorites: [], version: 1 };
  assert.ok(!('features' in presentMe(base)), 'sans features : la fixture reste exacte');
  assert.deepStrictEqual(presentMe({ ...base, features: { creation: 1, animated: 0 } }).features, { creation: true, animated: false });
  assert.deepStrictEqual(Object.keys(presentMe({ ...base, features: { creation: true, animated: true } })), ['version', 'packs', 'favorites', 'features']);

  const fixe = { id: 1, pack_id: 9, position: 0, emoji: '😀', name_i18n: null, asset_id: 5, storage_key: 'k1', thumb_key: 't1', width: 512, height: 512, bytes: 9, animated: 0 };
  const anime = { ...fixe, id: 2, position: 1, asset_id: 6, storage_key: 'k2', thumb_key: 't2', animated: 1 };
  const pack = { id: 9, code: 'u_1_ab', name_i18n: { fr: 'P' }, version: 1, is_premium: 0, visibility: 1, cover_sticker_id: 2 };
  // pack : animés omis par défaut ET quand fermé, présents quand ouvert.
  assert.deepStrictEqual(presentPack({ pack, stickers: [fixe, anime], lang: 'fr', urlDe }).stickers.map((x) => x.id), [1], 'oubli de `animes` = fermé');
  assert.deepStrictEqual(presentPack({ pack, stickers: [fixe, anime], lang: 'fr', urlDe, animes: false }).stickers.map((x) => x.id), [1]);
  const ouvert = presentPack({ pack, stickers: [fixe, anime], lang: 'fr', urlDe, animes: true });
  assert.deepStrictEqual(ouvert.stickers.map((x) => [x.id, x.animated]), [[1, false], [2, true]]);
  // mes packs : liste, compteur et couverture suivent (la couverture animée disparaît).
  const mes = presentMesPacks({ packs: [pack], stickers: [fixe, anime], lang: 'fr', urlDe });
  assert.strictEqual(mes.packs[0].count, 1);
  assert.deepStrictEqual(mes.packs[0].stickers.map((x) => x.id), [1]);
  assert.strictEqual(mes.packs[0].cover, urlDe('t1'), 'couverture animée omise : repli sur le premier sticker visible');
  assert.strictEqual(presentMesPacks({ packs: [pack], stickers: [fixe, anime], lang: 'fr', urlDe, animes: true }).packs[0].count, 2);
  // lien de partage : idem.
  const part = presentPartage({ pack, stickers: [fixe, anime], mine: false, addedPackId: null, lang: 'fr', urlDe });
  assert.deepStrictEqual([part.count, part.stickers.length], [1, 1]);
  assert.strictEqual(presentPartage({ pack, stickers: [fixe, anime], mine: false, addedPackId: null, lang: 'fr', urlDe, animes: true }).count, 2);
}

// ── stickers:sync ──────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(REASONS, ['packs', 'favorites', 'catalog']);
  assert.deepStrictEqual(syncPayload('packs', 5_000_999), { reason: 'packs', version: 5000 });
  assert.throws(() => syncPayload('autre'), /inconnue/);
  const recu = [];
  const io = makeFakeIo([
    { id: 'a', rooms: ['user_7'], emit: (e, p) => recu.push(['a', e, p]) },
    { id: 'b', rooms: ['user_7'], emit: (e, p) => recu.push(['b', e, p]) },
    { id: 'c', rooms: ['user_8'], emit: (e, p) => recu.push(['c', e, p]) },
  ]);
  emitStickersSync(io, 7, 'favorites');
  assert.deepStrictEqual(recu.map((r) => r[0]), ['a', 'b'], 'tous les appareils du compte, aucun autre');
  assert.strictEqual(recu[0][1], 'stickers:sync');
  assert.strictEqual(recu[0][2].reason, 'favorites');
  assert.ok(Number.isInteger(recu[0][2].version));
  emitStickersSync(null, 7, 'packs'); // sans io : ne plante pas
  {
    // Archivage / publication admin : diffusion à tous les appareils connectés.
    const vus = [];
    emitStickersSyncAll({ emit: (ev, p) => vus.push([ev, p]) }, 'catalog');
    assert.strictEqual(vus.length, 1);
    assert.strictEqual(vus[0][0], 'stickers:sync');
    assert.strictEqual(vus[0][1].reason, 'catalog');
    emitStickersSyncAll(null); // sans io : ne plante pas
    assert.throws(() => emitStickersSyncAll({ emit() {} }, 'inconnue'), /inconnue/);
  }
}

// ── Clés de stockage ───────────────────────────────────────────────────────
{
  const sha = crypto.createHash('sha256').update('x').digest('hex');
  const off = storage.officialStickerKey({ pack: 'mboa', sid: 4812, sha256: sha });
  assert.strictEqual(off, `official/stickers/mboa/4812_${sha.slice(0, 8)}.webp`);
  assert.strictEqual(storage.officialStickerKey({ pack: 'mboa', sid: 4812, sha256: sha, thumb: true }), `official/stickers/mboa/4812_${sha.slice(0, 8)}_t.webp`);
  assert.throws(() => storage.officialStickerKey({ pack: '../x', sid: 1, sha256: sha }));
  assert.throws(() => storage.officialStickerKey({ pack: 'a', sid: -1, sha256: sha }));
  assert.throws(() => storage.officialStickerKey({ pack: 'a', sid: 1, sha256: 'zz' }));

  const perso = storage.personalStickerKey({ alanyaID: 12, sha256: sha, sel: '0123456789abcdef' });
  assert.strictEqual(perso, `stickers/u/12/0123456789abcdef_${sha}.webp`);
  assert.strictEqual(storage.personalStickerKey({ alanyaID: 12, sha256: sha, sel: '0123456789abcdef', thumb: true }), `stickers/u/12/0123456789abcdef_${sha}_t.webp`);
  const salee = storage.personalStickerKey({ alanyaID: 12, sha256: sha });
  assert.notStrictEqual(salee, storage.personalStickerKey({ alanyaID: 12, sha256: sha }), 'sel tiré au hasard : clé non devinable');
  assert.match(salee, /^stickers\/u\/12\/[0-9a-f]{16}_[0-9a-f]{64}\.webp$/);
  assert.throws(() => storage.personalStickerKey({ alanyaID: 0, sha256: sha }));
  assert.throws(() => storage.personalStickerKey({ alanyaID: 12, sha256: sha, sel: 'court' }));

  // Servi : `stickers` est un préfixe connu, public, bucket profilemedia
  for (const k of [off, perso]) assert.ok(storage.isSafeKey(k), k);
  assert.ok(!storage.isSafeKey('stickers/../media/x.webp'));
  assert.ok(!storage.isSafeKey('stickers'));
  storage.configureForTests({
    endpoint: 'https://s3.eu-central-003.backblazeb2.com', region: 'eu-central-003', bucket: 'prive', keyId: 'k', appKey: 's',
    publics: { profilemedia: { bucket: 'profilemedia', keyId: 'k2', appKey: 's2' } },
  });
  for (const k of [off, perso]) {
    assert.strictEqual(storage.cibleDe(k).bucket, 'profilemedia', `${k} : bucket public`);
    const url = storage.publicUrl(k);
    assert.strictEqual(url, `https://profilemedia.s3.eu-central-003.backblazeb2.com/${k}`);
    assert.strictEqual(storage.keyFromUrl(url), k, 'aller-retour URL ↔ clé');
  }

  // Purge des médias de conversation : seuls `/uploads/media/` expirent
  const { sql } = expiredMediaWhere({ mediaDays: 100 });
  assert.ok(sql.includes("LIKE '%/uploads/media/%'"), 'le prédicat de purge reste borné à /uploads/media/');
  const like = (valeur) => valeur.includes('/uploads/media/');
  for (const k of [off, perso]) {
    assert.ok(!like(storage.publicUrl(k)), `${k} : jamais purgé comme média de discussion`);
    assert.ok(!like(`http://localhost:3000/uploads/${k}`), `${k} : repli sans B2 non plus`);
  }
  assert.ok(like('http://x/uploads/media/2026-09-01/images/a.jpg'), 'précondition : un vrai média de discussion correspond');
  storage.configureForTests({});
}

// ── Codes d'erreur : docs/error-codes.md et statuts du contrat ─────────────
{
  const docs = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'error-codes.md'), 'utf8');
  const erreurs = fix('erreurs.json');
  const sept = ['STICKER_NOT_FOUND', 'STICKER_PACK_UNAVAILABLE', 'STICKER_INVALID_PAYLOAD', 'STICKER_ASSET_INVALID', 'STICKER_ASSET_BLOCKED', 'STICKER_QUOTA_EXCEEDED', 'STICKER_PACK_LIMIT'];
  for (const code of sept) {
    const ligne = docs.split('\n').find((l) => l.startsWith(`| \`${code}\` |`));
    assert.ok(ligne, `${code} manque dans docs/error-codes.md`);
    assert.ok(ligne.includes(`| ${erreurs[code].status} |`), `${code} : statut ${erreurs[code].status} attendu dans la doc`);
  }
  assert.ok(docs.includes('stickers_premium'), 'SUBSCRIPTION_REQUIRED / stickers_premium documentés');
  // Chaque code des sources `stickers` figure dans la doc
  const src = ['../utils/stickerMessage.js', '../utils/stickerAsset.js', '../controllers/stickerController.js', '../middleware/requireStickers.js']
    .map((r) => fs.readFileSync(path.join(__dirname, r), 'utf8')).join('\n');
  const emis = new Set([...src.matchAll(/'((?:STICKER_[A-Z_]+)|NOT_FOUND|SUBSCRIPTION_REQUIRED)'/g)].map((m) => m[1]));
  for (const code of emis) assert.ok(docs.includes(`\`${code}\``), `${code} émis mais non documenté`);
  assert.ok(emis.has('NOT_FOUND') && emis.has('STICKER_PACK_LIMIT'), 'précondition : l\'extraction voit les codes');
}

// ── Migration : réexécutable, sans ALTER message, valeurs figées ───────────
{
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '097_stickers.sql'), 'utf8');
  const code = sql.replace(/--.*$/gm, '');
  assert.ok(!/ALTER\s+TABLE\s+`?message/i.test(code), 'aucun ALTER message');
  assert.ok(!/\bENUM\b/i.test(code), 'pas d\'ENUM');
  assert.ok(!/DROP\s/i.test(code), 'aucune suppression');
  const tables = [...code.matchAll(/CREATE TABLE (IF NOT EXISTS )?(\w+)/g)];
  assert.strictEqual(tables.length, 8);
  for (const t of tables) assert.ok(t[1], `${t[2]} : IF NOT EXISTS`);
  for (const ins of code.matchAll(/INSERT\s+(\w+\s+)?INTO\s+(\w+)/g)) assert.strictEqual(ins[1].trim(), 'IGNORE', `${ins[2]} : INSERT IGNORE`);
  assert.ok(/owner_id\s+INT NOT NULL DEFAULT 0/.test(code), 'sticker_asset.owner_id = 0 par défaut');
  assert.ok(/UNIQUE KEY uq_asset_owner_sha \(owner_id, sha256\)/.test(code));
  assert.ok(/enabled\s+TINYINT NOT NULL DEFAULT 0/.test(code), 'enabled = 0 par défaut');
  assert.ok(/'stickers_premium'[\s\S]*0, 1, 80\)/.test(code), 'stickers_premium is_paid = 0 (régime TRIAL)');
  assert.ok(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/.test(code));
  assert.ok(!/FOREIGN KEY \(\w+\) REFERENCES users/.test(code), 'pas de FK vers users (owner 0)');
}

console.log('stickerContrat.test.js : OK');
