/**
 * Service des packs personnels et du partage (V1b, T4d et T6) —
 * `node src/services/stickerPack.test.js`.
 *
 * Ce que le service garantit, et que ces tests éprouvent :
 *   - propriétaire seul : le pack d'un autre est « introuvable », aucune écriture ;
 *   - archivage : stickers retirés, lignes d'actifs orphelins supprimées, AUCUN
 *     fichier supprimé (A13), lien révoqué, idempotent, copies et installations
 *     des destinataires intactes (B) ;
 *   - réordonnancement : positions négatives d'abord (UNIQUE pack_id+position),
 *     ids étrangers ignorés ;
 *   - partage : jeton de 24 caractères aléatoires, révocable, pack vide refusé ;
 *   - installation d'un lien = COPIE chez le destinataire (clé salée sous son
 *     espace, jamais celle de l'auteur), idempotente, quotas 20 / 200, images
 *     bloquées ignorées, rollback + nettoyage des fichiers si une copie échoue.
 *
 * Base et stockage sont doublés : ni MySQL, ni sharp, ni B2.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

// ── Stockage doublé ─────────────────────────────────────────────────────────
const stockage = { copies: [], retires: [], echec: false };
const videStockage = () => { stockage.copies = []; stockage.retires = []; stockage.echec = false; };
remplace('./mediaStorage', {
  personalStickerKey: ({ alanyaID, sha256, sel, thumb = false }) => `stickers/u/${alanyaID}/${sel}_${sha256}${thumb ? '_t' : ''}.webp`,
  copyObject: async (src, dst) => {
    if (stockage.echec) throw new Error('B2 indisponible');
    stockage.copies.push([src, dst]);
  },
  removeAllVersions: async (k) => { stockage.retires.push(k); },
  putBody: async () => {},
});
remplace('../utils/stickerAsset', {
  preparerAsset: async () => { throw new Error('inutilisé'); },
  LIMITES: { ASSETS_PAR_COMPTE: 200 },
});
remplace('./stickerAssetService', { depsSql: () => ({}) });

// ── Base doublée ────────────────────────────────────────────────────────────
let contexte = null;
function base(handlers = []) {
  const requetes = [];
  const etat = { transactions: 0, commits: 0, rollbacks: 0 };
  const exec = async (sql, params) => {
    requetes.push([sql, params]);
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return [[], []];
  };
  const connexion = {
    beginTransaction: async () => { etat.transactions += 1; },
    commit: async () => { etat.commits += 1; },
    rollback: async () => { etat.rollbacks += 1; },
    release: () => {}, execute: exec,
  };
  const d = { requetes, etat, execute: exec, getConnection: async () => connexion };
  contexte = d;
  return d;
}
remplace('../config/db', {
  execute: (s, p) => contexte.execute(s, p),
  getConnection: (...a) => contexte.getConnection(...a),
});

const pack = require('./stickerPackService');
const { StickerPersonalError } = require('./stickerPersonalService');

const attendErreur = async (fn, code, statut) => {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof StickerPersonalError, `erreur inattendue : ${e.message}`);
    assert.strictEqual(e.code, code, `code attendu ${code}, reçu ${e.code}`);
    if (statut) assert.strictEqual(e.status, statut);
    return e;
  }
  throw new Error(`aurait dû lever ${code}`);
};
const ecrit = (d, re) => d.requetes.some(([s]) => re.test(s));
const de = (d, re) => d.requetes.find(([s]) => re.test(s));

// ── Motifs SQL ──────────────────────────────────────────────────────────────
const VERROU_PACK = /FROM sticker_pack\s+WHERE id = \? AND owner_id = \? AND visibility IN \(\?, \?\)\s+LIMIT 1 FOR UPDATE/;
const monPack = (extra = {}) => ({ id: 3, code: 'u_7_x', visibility: 1, status: 1, share_token: null, cover_sticker_id: null, ...extra });
const PACK_OK = [VERROU_PACK, () => [[monPack()], []]];

// ── 1. Purs ─────────────────────────────────────────────────────────────────

test('nomLocaliseDe : objet propre, clés inconnues et vides écartées, 60 caractères', () => {
  assert.deepStrictEqual(pack.nomLocaliseDe({ nameI18n: { fr: ' Chats ', en: '', zh: '猫', de: 'x' } }), { fr: 'Chats', zh: '猫' });
  assert.deepStrictEqual(pack.nomLocaliseDe({ name: 'Mboa' }), { fr: 'Mboa' });
  assert.strictEqual(pack.nomLocaliseDe({ name: 'x'.repeat(200) }).fr.length, 60);
  assert.strictEqual(pack.nomLocaliseDe({ name: '   ' }), null, 'nom vide : invalide');
  assert.strictEqual(pack.nomLocaliseDe({ nameI18n: ['fr'] }), null);
  assert.strictEqual(pack.nomLocaliseDe({ nameI18n: { de: 'x' } }), null, 'aucune langue connue');
  assert.strictEqual(pack.nomLocaliseDe({}), undefined, 'rien à changer');
});

test('jeton : 24 caractères base64url, aléatoires, validés strictement', () => {
  const vus = new Set();
  for (let i = 0; i < 500; i += 1) {
    const t = pack.nouveauJeton();
    assert.match(t, /^[A-Za-z0-9_-]{24}$/);
    vus.add(t);
  }
  assert.strictEqual(vus.size, 500, 'aucun doublon sur 500 tirages');
  for (const mauvais of ['', 'court', 'a'.repeat(25), `${'a'.repeat(23)}%`, null, undefined, 42, { a: 1 }, `${'a'.repeat(23)}'`]) {
    assert.strictEqual(pack.jetonValide(mauvais), false, `refusé : ${String(mauvais)}`);
  }
  assert.strictEqual(pack.jetonValide('A'.repeat(24)), true);
});

// ── 2. modifierPack ─────────────────────────────────────────────────────────

test('modifierPack : renomme, bump de version, propriétaire dans le verrou', async () => {
  const d = base([PACK_OK]);
  await pack.modifierPack(7, 3, { nameI18n: { fr: 'Chats', en: 'Cats' } }, d);
  const [, p] = de(d, VERROU_PACK);
  assert.deepStrictEqual(p, [3, 7, 1, 2], 'id, owner = JWT, visibilités privé/lien');
  const [sql, params] = de(d, /UPDATE sticker_pack SET name_i18n/);
  assert.match(sql, /version = version \+ 1/);
  assert.deepStrictEqual(JSON.parse(params[0]), { fr: 'Chats', en: 'Cats' });
  assert.strictEqual(d.etat.commits, 1);
});

test('modifierPack : le pack d\'un autre est introuvable, aucune écriture', async () => {
  const d = base([[VERROU_PACK, () => [[], []]]]);
  await attendErreur(() => pack.modifierPack(7, 3, { name: 'Pirate' }, d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.ok(!ecrit(d, /UPDATE sticker_pack/));
  assert.strictEqual(d.etat.rollbacks, 1);
});

test('modifierPack : un pack archivé ne se modifie plus', async () => {
  const d = base([[VERROU_PACK, () => [[monPack({ status: 2 })], []]]]);
  await attendErreur(() => pack.modifierPack(7, 3, { name: 'Vie' }, d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.ok(!ecrit(d, /UPDATE sticker_pack/));
});

test('modifierPack : corps vide ou nom invalide = 400, sans toucher la base', async () => {
  const d = base([PACK_OK]);
  await attendErreur(() => pack.modifierPack(7, 3, {}, d), 'STICKER_INVALID_PAYLOAD');
  await attendErreur(() => pack.modifierPack(7, 3, { name: '  ' }, d), 'STICKER_INVALID_PAYLOAD');
  assert.strictEqual(d.requetes.length, 0);
});

test('modifierPack : la couverture doit être un sticker actif de CE pack', async () => {
  const d = base([PACK_OK, [/SELECT s\.id FROM sticker s JOIN sticker_asset a/, () => [[], []]]]);
  await attendErreur(() => pack.modifierPack(7, 3, { coverStickerId: 99 }, d), 'STICKER_NOT_FOUND', 404);
  assert.ok(!ecrit(d, /UPDATE sticker_pack/));
  const [, p] = de(d, /SELECT s\.id FROM sticker s JOIN/);
  assert.deepStrictEqual(p, [99, 3], 'filtré par pack_id');
});

test('modifierPack : coverStickerId null efface la couverture', async () => {
  const d = base([PACK_OK]);
  await pack.modifierPack(7, 3, { coverStickerId: null }, d);
  const [, p] = de(d, /UPDATE sticker_pack SET cover_sticker_id/);
  assert.deepStrictEqual(p, [null, 3]);
});

// ── 3. archiverPack ─────────────────────────────────────────────────────────

test('archiverPack : retire les stickers, ne supprime que les lignes d\'actifs orphelins — aucun fichier (A13)', async () => {
  videStockage();
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker WHERE pack_id = \? FOR UPDATE/, () => [[{ id: 11 }, { id: 12 }], []]],
    [/SELECT DISTINCT asset_id FROM sticker WHERE id IN/, () => [[{ asset_id: 100 }, { asset_id: 101 }], []]],
    // 100 est encore référencé ailleurs : seul 101 est orphelin
    [/SELECT a\.id FROM sticker_asset a/, () => [[{ id: 101, storage_key: 'stickers/u/7/s_b.webp', thumb_key: 'stickers/u/7/s_b_t.webp' }], []]],
  ]);
  const r = await pack.archiverPack(7, 3, d);
  assert.deepStrictEqual(r, { id: 3, deja: false, stickers: 2 });
  for (const re of [
    /DELETE FROM user_sticker_favorite WHERE sticker_id IN/,
    /UPDATE sticker_pack SET cover_sticker_id = NULL, version = version \+ 1\s+WHERE cover_sticker_id IN/,
    /DELETE FROM sticker WHERE id IN/,
    /DELETE FROM sticker_report WHERE asset_id IN/,
    /DELETE FROM sticker_asset WHERE id IN/,
    /UPDATE sticker_pack\s+SET status = \?, visibility = \?, share_token = NULL/,
  ]) assert.ok(ecrit(d, re), `requête absente : ${re}`);
  const [, ids] = de(d, /DELETE FROM sticker_asset WHERE id IN/);
  assert.deepStrictEqual(ids, [101], 'seul l\'orphelin est supprimé');
  const [, orph] = de(d, /SELECT a\.id FROM sticker_asset a/);
  assert.strictEqual(orph[orph.length - 1], 7, 'orphelins cherchés parmi MES actifs seulement');
  const [, maj] = de(d, /SET status = \?, visibility = \?/);
  assert.deepStrictEqual(maj, [2, 1, 3], 'archivé (2), privé (1), pack 3');
  assert.deepStrictEqual(stockage.retires, [], 'aucun fichier supprimé : l\'orphelin reste servi');
});

test('archiverPack : ne touche ni les copies ni les packs installés des destinataires (B)', async () => {
  videStockage();
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker WHERE pack_id = \? FOR UPDATE/, () => [[{ id: 11 }, { id: 12 }], []]],
    [/SELECT DISTINCT asset_id FROM sticker WHERE id IN/, () => [[{ asset_id: 100 }, { asset_id: 101 }], []]],
    [/SELECT a\.id FROM sticker_asset a/, () => [[{ id: 101, storage_key: 'stickers/u/7/s_b.webp', thumb_key: null }], []]],
  ]);
  await pack.archiverPack(7, 3, d);
  // Une copie (`/stickers/:id/copy`) est un autre actif ; un lien installé est
  // un autre pack (`source_pack_id` = 3) avec ses propres actifs et stickers.
  // Les écritures ne visent que le pack 3, ses stickers (11, 12) et ses actifs (100, 101).
  const ecritures = d.requetes.filter(([sql]) => /^\s*(DELETE|UPDATE|INSERT)/i.test(sql));
  assert.ok(ecritures.length > 0);
  for (const [sql, params] of ecritures) {
    assert.ok((params || []).map(Number).every((v) => [3, 11, 12, 100, 101, 1, 2].includes(v)), `hors périmètre : ${sql} ${JSON.stringify(params)}`);
    assert.ok(!/source_pack_id/i.test(sql), 'les packs copiés ne sont jamais lus ni écrits');
    if (/user_sticker_pack/i.test(sql)) assert.deepStrictEqual(params, [3], 'seules les associations du pack archivé');
    if (/sticker_pack/i.test(sql) && /^\s*(UPDATE|DELETE)/i.test(sql) && /WHERE id = \?/i.test(sql)) {
      assert.strictEqual(params[params.length - 1], 3, 'seul le pack archivé est modifié');
    }
  }
  assert.ok(!ecrit(d, /DELETE FROM sticker_pack\b/), 'aucune ligne de pack supprimée');
  assert.strictEqual(stockage.retires.length + stockage.copies.length, 0);
});

test('archiverPack : aucun fichier supprimé quand rien n\'est orphelin', async () => {
  videStockage();
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker WHERE pack_id/, () => [[{ id: 11 }], []]],
    [/SELECT DISTINCT asset_id/, () => [[{ asset_id: 100 }], []]],
  ]);
  await pack.archiverPack(7, 3, d);
  assert.strictEqual(stockage.retires.length, 0);
  assert.ok(!ecrit(d, /DELETE FROM sticker_asset/));
});

test('archiverPack : idempotent, un pack déjà archivé ne touche à rien', async () => {
  videStockage();
  const d = base([[VERROU_PACK, () => [[monPack({ status: 2 })], []]]]);
  const r = await pack.archiverPack(7, 3, d);
  assert.strictEqual(r.deja, true);
  assert.ok(!ecrit(d, /DELETE FROM|UPDATE sticker_pack/));
  assert.strictEqual(stockage.retires.length, 0);
});

test('archiverPack : le pack d\'un autre (IDOR) est introuvable, aucun fichier retiré', async () => {
  videStockage();
  const d = base([[VERROU_PACK, () => [[], []]]]);
  await attendErreur(() => pack.archiverPack(7, 3, d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.ok(!ecrit(d, /DELETE FROM|UPDATE sticker_pack/));
  assert.strictEqual(stockage.retires.length, 0);
});

test('archiverPack : identifiant invalide = introuvable, sans requête de verrou', async () => {
  const d = base([]);
  for (const mauvais of ['abc', '0', '-1', '1.5', 'NaN', undefined]) {
    await attendErreur(() => pack.archiverPack(7, mauvais, d), 'STICKER_PACK_UNAVAILABLE', 404);
  }
  assert.ok(!ecrit(d, /FOR UPDATE/));
});

// ── 4. ordonnerStickers ─────────────────────────────────────────────────────

test('ordonnerStickers : négatif d\'abord, puis positions définitives ; ids étrangers ignorés', async () => {
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker WHERE pack_id = \? ORDER BY position/, () => [[{ id: 10 }, { id: 11 }, { id: 12 }], []]],
  ]);
  const r = await pack.ordonnerStickers(7, 3, [12, 999, 10, 12], d);
  assert.deepStrictEqual(r, { id: 3, count: 3 });
  const i = d.requetes.findIndex(([s]) => /SET position = -position - 1/.test(s));
  assert.ok(i >= 0, 'phase négative');
  const finales = d.requetes.slice(i + 1).filter(([s]) => /UPDATE sticker SET position = \?/.test(s)).map(([, p]) => p);
  assert.deepStrictEqual(finales, [[0, 12, 3], [1, 10, 3], [2, 11, 3]], '12, 10 puis 11 (absent de la liste : à la fin) ; 999 ignoré');
  assert.ok(ecrit(d, /UPDATE sticker_pack SET version = version \+ 1/));
});

test('ordonnerStickers : le pack d\'un autre est introuvable', async () => {
  const d = base([[VERROU_PACK, () => [[], []]]]);
  await attendErreur(() => pack.ordonnerStickers(7, 3, [1], d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.ok(!ecrit(d, /UPDATE sticker SET position/));
});

// ── 5. ajouter / retirer un sticker ─────────────────────────────────────────

test('ajouterStickerAuPack : seuls MES actifs actifs, verrouillés', async () => {
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker_asset WHERE id = \? AND owner_id = \? AND status = 0 FOR UPDATE/, () => [[], []]],
  ]);
  await attendErreur(() => pack.ajouterStickerAuPack(7, 3, { assetId: 55 }, d), 'STICKER_NOT_FOUND', 404);
  const [, p] = de(d, /SELECT id FROM sticker_asset WHERE id/);
  assert.deepStrictEqual(p, [55, 7], 'filtré par propriétaire = JWT');
  assert.ok(!ecrit(d, /INSERT INTO sticker/));
});

test('ajouterStickerAuPack : 40 stickers maximum par pack', async () => {
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker_asset WHERE id/, () => [[{ id: 55 }], []]],
    [/SELECT COUNT\(\*\) AS n FROM sticker WHERE pack_id/, () => [[{ n: 40 }], []]],
  ]);
  await attendErreur(() => pack.ajouterStickerAuPack(7, 3, { assetId: 55 }, d), 'STICKER_PACK_LIMIT', 409);
  assert.ok(!ecrit(d, /INSERT INTO sticker/));
});

test('ajouterStickerAuPack : insère à la position suivante, aucun fichier copié', async () => {
  videStockage();
  const d = base([
    PACK_OK,
    [/SELECT id FROM sticker_asset WHERE id/, () => [[{ id: 55 }], []]],
    [/SELECT COUNT\(\*\) AS n FROM sticker WHERE pack_id/, () => [[{ n: 3 }], []]],
    [/INSERT INTO sticker \(/, () => [{ insertId: 77 }, []]],
  ]);
  const r = await pack.ajouterStickerAuPack(7, 3, { assetId: 55, emoji: '🔥', nom: 'Feu' }, d);
  assert.deepStrictEqual(r, { stickerId: 77, packId: 3, assetId: 55 });
  const [, p] = de(d, /INSERT INTO sticker \(/);
  assert.strictEqual(p[0], 3);
  assert.strictEqual(p[1], 55);
  assert.strictEqual(p[2], '🔥');
  assert.strictEqual(stockage.copies.length, 0);
});

test('ajouterStickerAuPack : actif invalide (non numérique) = introuvable', async () => {
  const d = base([]);
  await attendErreur(() => pack.ajouterStickerAuPack(7, 3, { assetId: 'x' }, d), 'STICKER_NOT_FOUND', 404);
  assert.strictEqual(d.requetes.length, 0);
});

test('retirerStickerDuPack : un sticker d\'un autre pack est introuvable', async () => {
  videStockage();
  const d = base([PACK_OK, [/SELECT id FROM sticker WHERE id = \? AND pack_id = \? FOR UPDATE/, () => [[], []]]]);
  await attendErreur(() => pack.retirerStickerDuPack(7, 3, 500, d), 'STICKER_NOT_FOUND', 404);
  const [, p] = de(d, /SELECT id FROM sticker WHERE id = \?/);
  assert.deepStrictEqual(p, [500, 3], 'borné au pack du propriétaire');
  assert.ok(!ecrit(d, /DELETE FROM sticker/));
  assert.strictEqual(stockage.retires.length, 0);
});

test('retirerStickerDuPack : l\'actif encore référencé reste, la ligne de l\'orphelin part — jamais de fichier (A13)', async () => {
  videStockage();
  // cas 1 : encore référencé ailleurs
  let d = base([
    PACK_OK,
    [/SELECT id FROM sticker WHERE id = \? AND pack_id/, () => [[{ id: 500 }], []]],
    [/SELECT DISTINCT asset_id/, () => [[{ asset_id: 100 }], []]],
  ]);
  let r = await pack.retirerStickerDuPack(7, 3, 500, d);
  assert.deepStrictEqual(r, { packId: 3, assets: 0 });
  assert.strictEqual(stockage.retires.length, 0, 'fichier conservé');
  assert.ok(ecrit(d, /DELETE FROM user_sticker_favorite/), 'favoris retirés');
  // cas 2 : orphelin
  d = base([
    PACK_OK,
    [/SELECT id FROM sticker WHERE id = \? AND pack_id/, () => [[{ id: 500 }], []]],
    [/SELECT DISTINCT asset_id/, () => [[{ asset_id: 100 }], []]],
    [/SELECT a\.id FROM sticker_asset a/, () => [[{ id: 100, storage_key: 'stickers/u/7/k.webp', thumb_key: null }], []]],
  ]);
  r = await pack.retirerStickerDuPack(7, 3, 500, d);
  assert.deepStrictEqual(r, { packId: 3, assets: 1 });
  assert.ok(ecrit(d, /DELETE FROM sticker_asset WHERE id IN/), 'ligne de l\'orphelin supprimée');
  assert.deepStrictEqual(stockage.retires, [], 'fichier conservé');
});

// ── 6. Partage ──────────────────────────────────────────────────────────────

test('partagerPack : jeton neuf de 24 caractères, visibilité lien', async () => {
  const d = base([
    PACK_OK,
    [/SELECT COUNT\(\*\) AS n FROM sticker s JOIN sticker_asset a/, () => [[{ n: 4 }], []]],
  ]);
  const r = await pack.partagerPack(7, 3, d);
  assert.strictEqual(r.cree, true);
  assert.match(r.token, /^[A-Za-z0-9_-]{24}$/);
  const [, p] = de(d, /UPDATE sticker_pack SET share_token = \?, visibility = \?/);
  assert.deepStrictEqual(p, [r.token, 2, 3]);
});

test('partagerPack : idempotent, rend le jeton existant sans en tirer un autre', async () => {
  const d = base([[VERROU_PACK, () => [[monPack({ visibility: 2, share_token: 'T'.repeat(24) })], []]]]);
  const r = await pack.partagerPack(7, 3, d);
  assert.deepStrictEqual(r, { token: 'T'.repeat(24), cree: false });
  assert.ok(!ecrit(d, /UPDATE sticker_pack/));
});

test('partagerPack : pack vide, archivé ou d\'un autre = refus', async () => {
  let d = base([PACK_OK, [/SELECT COUNT\(\*\)/, () => [[{ n: 0 }], []]]]);
  await attendErreur(() => pack.partagerPack(7, 3, d), 'STICKER_INVALID_PAYLOAD', 400);
  d = base([[VERROU_PACK, () => [[monPack({ status: 2 })], []]]]);
  await attendErreur(() => pack.partagerPack(7, 3, d), 'STICKER_PACK_UNAVAILABLE', 404);
  d = base([[VERROU_PACK, () => [[], []]]]);
  await attendErreur(() => pack.partagerPack(7, 3, d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.ok(!ecrit(d, /UPDATE sticker_pack/));
});

test('partagerPack : collision de jeton (ER_DUP_ENTRY) rejouée', async () => {
  let essais = 0;
  const d = base([
    PACK_OK,
    [/SELECT COUNT\(\*\)/, () => [[{ n: 1 }], []]],
    [/UPDATE sticker_pack SET share_token/, () => {
      essais += 1;
      if (essais === 1) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      return [{ affectedRows: 1 }, []];
    }],
  ]);
  const r = await pack.partagerPack(7, 3, d);
  assert.strictEqual(essais, 2);
  assert.strictEqual(r.cree, true);
});

test('revoquerPartage : jeton effacé, pack redevenu privé ; idempotent ; IDOR', async () => {
  let d = base([[VERROU_PACK, () => [[monPack({ visibility: 2, share_token: 'T'.repeat(24) })], []]]]);
  await pack.revoquerPartage(7, 3, d);
  const [, p] = de(d, /UPDATE sticker_pack SET share_token = NULL, visibility = \?/);
  assert.deepStrictEqual(p, [1, 3]);
  d = base([PACK_OK]); // déjà privé, sans jeton
  await pack.revoquerPartage(7, 3, d);
  assert.ok(!ecrit(d, /UPDATE sticker_pack/), 'rien à faire');
  d = base([[VERROU_PACK, () => [[], []]]]);
  await attendErreur(() => pack.revoquerPartage(7, 3, d), 'STICKER_PACK_UNAVAILABLE', 404);
});

// ── 7. Résolution d'un lien ─────────────────────────────────────────────────
const JETON = 'Zz09_-Zz09_-Zz09_-Zz09_-';
const PAR_JETON = /FROM sticker_pack p\s+WHERE p\.share_token = \?/;
const source = (extra = {}) => ({
  id: 50, code: 'u_9_ab', name_i18n: { fr: 'Chats' }, description_i18n: null, owner_id: 9,
  version: 4, cover_sticker_id: null, added_pack_id: null, ...extra,
});

test('resoudrePartage : jeton mal formé = introuvable, sans interroger la base', async () => {
  const d = base([]);
  for (const mauvais of ['x', 'a'.repeat(23), "' OR 1=1 --", `${'a'.repeat(24)}\n`]) {
    await attendErreur(() => pack.resoudrePartage(7, mauvais, d), 'STICKER_PACK_UNAVAILABLE', 404);
  }
  assert.strictEqual(d.requetes.length, 0);
});

test('resoudrePartage : inconnu, révoqué ou archivé répondent pareil', async () => {
  const d = base([[PAR_JETON, () => [[], []]]]);
  const e = await attendErreur(() => pack.resoudrePartage(7, JETON, d), 'STICKER_PACK_UNAVAILABLE', 404);
  const [sql, p] = de(d, PAR_JETON);
  assert.match(sql, /p\.visibility = \? AND p\.status = \?/, 'lien ET publié');
  assert.deepStrictEqual(p, [7, 1, JETON, 2, 1]);
  assert.ok(!/9|50/.test(e.message));
});

const APERCU = /AS count\s+FROM sticker_pack p\s+WHERE p\.share_token = \?/;

test('apercuPartagePublic : jeton mal formé = null, sans interroger la base', async () => {
  const d = base([]);
  for (const mauvais of [undefined, null, 42, '', 'x', 'a'.repeat(25), "' OR 1=1 --", `${'a'.repeat(24)}\n`]) {
    assert.strictEqual(await pack.apercuPartagePublic(mauvais, d), null);
  }
  assert.strictEqual(d.requetes.length, 0);
});

test('apercuPartagePublic : lien publié seulement, nom et compte, rien d\'autre', async () => {
  const d = base([[APERCU, () => [[{ name_i18n: { fr: 'Chats' }, count: 3, owner_id: 9, code: 'u_9_ab' }], []]]]);
  const r = await pack.apercuPartagePublic(JETON, d);
  assert.deepStrictEqual(r, { nameI18n: { fr: 'Chats' }, count: 3 }, 'aucun compte, aucun code');
  const [sql, p] = de(d, APERCU);
  assert.match(sql, /p\.visibility = \? AND p\.status = \?/, 'lien ET publié');
  assert.match(sql, /a\.status = 0/, 'stickers actifs seulement');
  assert.deepStrictEqual(p, [JETON, 2, 1]);
});

test('apercuPartagePublic : inconnu, révoqué, archivé ou sans sticker actif = null', async () => {
  assert.strictEqual(await pack.apercuPartagePublic(JETON, base([[APERCU, () => [[], []]]])), null);
  assert.strictEqual(await pack.apercuPartagePublic(JETON,
    base([[APERCU, () => [[{ name_i18n: { fr: 'Vide' }, count: 0 }], []]]])), null);
});

test('resoudrePartage : fiche, mon état d\'installation, propriété', async () => {
  const stickers = [{ id: 1, position: 0, emoji: '😀', name_i18n: null, storage_key: 'k', thumb_key: 't', width: 512, height: 512, bytes: 9, animated: 0 }];
  const d = base([
    [PAR_JETON, () => [[source({ added_pack_id: 61 })], []]],
    [/FROM sticker s JOIN sticker_asset a ON a\.id = s\.asset_id\s+WHERE s\.pack_id = \? AND a\.status = 0/, () => [stickers, []]],
  ]);
  const r = await pack.resoudrePartage(7, JETON, d);
  assert.strictEqual(r.mine, false);
  assert.strictEqual(r.addedPackId, 61);
  assert.strictEqual(r.stickers.length, 1);
  const moi = await pack.resoudrePartage(9, JETON, d);
  assert.strictEqual(moi.mine, true);
});

// ── 8. Installation d'un lien ───────────────────────────────────────────────
const LOCK_SOURCE = /FROM sticker_pack p\s+WHERE p\.share_token = \?.*FOR UPDATE/s;
const MES_PACKS = /SELECT id FROM sticker_pack WHERE owner_id = \? AND status <> \? FOR UPDATE/;
const LUS = /SELECT s\.id, s\.emoji, s\.name_i18n, s\.position, a\.sha256/;
const TOTAL = /SELECT COUNT\(\*\) AS n FROM sticker WHERE pack_id = \?/;
const MES_SHAS = /SELECT id, sha256 FROM sticker_asset\s+WHERE owner_id = \? AND status = 0 AND sha256 IN/;
const MES_ACTIFS = /SELECT COUNT\(\*\) AS n FROM sticker_asset WHERE owner_id = \? AND status = 0/;
const INS_PACK = /INSERT INTO sticker_pack/;
const INS_ASSET = /INSERT INTO sticker_asset/;
const INS_STICKER = /INSERT INTO sticker \(/;
const SET_CLES = /UPDATE sticker_asset SET storage_key = \?, thumb_key = \?/;

const ligne = (id, sha, extra = {}) => ({
  id, emoji: '😀', name_i18n: null, position: id, sha256: sha,
  storage_key: `stickers/u/9/1234567890abcdef_${sha}.webp`,
  thumb_key: `stickers/u/9/1234567890abcdef_${sha}_t.webp`,
  mime: 'image/webp', width: 512, height: 512, bytes: 4000, animated: 0, ...extra,
});

/** Base de l'installation : paramétrable, ids auto-incrémentés. */
function baseInstall(opts = {}) {
  const o = { source: source(), miens: [], lus: [ligne(1, SHA_A), ligne(2, SHA_B)], total: null, mesShas: [], actifs: 0, ...opts };
  let pk = 100; let as = 200; let st = 300;
  return base([
    [LOCK_SOURCE, () => [o.source ? [o.source] : [], []]],
    [MES_PACKS, () => [o.miens, []]],
    [LUS, () => [o.lus, []]],
    [TOTAL, () => [[{ n: o.total ?? o.lus.length }], []]],
    [MES_SHAS, () => [o.mesShas, []]],
    [MES_ACTIFS, () => [[{ n: o.actifs }], []]],
    [INS_PACK, () => [{ insertId: (pk += 1) }, []]],
    [INS_ASSET, () => [{ insertId: (as += 1) }, []]],
    [INS_STICKER, () => [{ insertId: (st += 1) }, []]],
    [SET_CLES, () => [{ affectedRows: 1 }, []]],
  ]);
}

test('ajouterPackPartage : jeton mal formé = introuvable, aucune transaction', async () => {
  const d = baseInstall();
  await attendErreur(() => pack.ajouterPackPartage(7, 'nope', d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.strictEqual(d.etat.transactions, 0);
});

test('ajouterPackPartage : lien inconnu ou révoqué = introuvable', async () => {
  const d = baseInstall({ source: null });
  await attendErreur(() => pack.ajouterPackPartage(7, JETON, d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.ok(!ecrit(d, INS_PACK));
  assert.strictEqual(d.etat.rollbacks, 1);
});

test('ajouterPackPartage : COPIE chez le destinataire, clés dans son espace, sel neuf', async () => {
  videStockage();
  const d = baseInstall();
  const r = await pack.ajouterPackPartage(7, JETON, d);
  assert.strictEqual(r.deja, false);
  assert.strictEqual(r.stickers, 2);
  assert.strictEqual(r.ignores, 0);
  assert.match(r.code, /^u_7_[0-9a-f]{8}$/);
  // le pack : à MOI, privé, publié, mémoire de la source
  const [, pp] = de(d, INS_PACK);
  assert.strictEqual(pp[1], 7, 'owner_id = destinataire');
  assert.strictEqual(pp[3], 1, 'privé');
  assert.strictEqual(pp[4], 1, 'publié');
  assert.strictEqual(pp[5], 7, 'created_by');
  assert.strictEqual(pp[6], 50, 'source_pack_id');
  assert.deepStrictEqual(JSON.parse(pp[2]), { fr: 'Chats' }, 'nom hérité');
  // les fichiers : 2 stickers × (image + vignette), jamais ceux de l'auteur
  assert.strictEqual(stockage.copies.length, 4);
  for (const [src, dst] of stockage.copies) {
    assert.ok(src.startsWith('stickers/u/9/'), 'source = espace de l\'auteur');
    assert.ok(dst.startsWith('stickers/u/7/'), 'cible = mon espace');
    assert.ok(!dst.includes('1234567890abcdef'), 'sel neuf, pas celui de l\'auteur');
  }
  assert.strictEqual(d.requetes.filter(([s]) => SET_CLES.test(s)).length, 2, 'clés enregistrées sur mes actifs');
  assert.strictEqual(d.requetes.filter(([s]) => INS_STICKER.test(s)).length, 2);
  const positions = d.requetes.filter(([s]) => INS_STICKER.test(s)).map(([, p]) => p[1]);
  assert.deepStrictEqual(positions, [0, 1]);
  assert.strictEqual(d.etat.commits, 1);
  // la source est lue, jamais modifiée
  assert.ok(!ecrit(d, /UPDATE sticker_pack SET (share_token|visibility)/));
});

test('ajouterPackPartage : idempotent (déjà installé), et mon propre pack est un no-op', async () => {
  videStockage();
  let d = baseInstall({ source: source({ added_pack_id: 61 }) });
  assert.deepStrictEqual(await pack.ajouterPackPartage(7, JETON, d), { packId: 61, deja: true });
  d = baseInstall();
  assert.deepStrictEqual(await pack.ajouterPackPartage(9, JETON, d), { packId: 50, deja: true, mine: true });
  assert.strictEqual(stockage.copies.length, 0);
  assert.ok(!ecrit(d, INS_PACK));
});

test('ajouterPackPartage : 20 packs perso maximum (409), rien copié', async () => {
  videStockage();
  const d = baseInstall({ miens: Array.from({ length: 20 }, (_, i) => ({ id: i + 1 })) });
  await attendErreur(() => pack.ajouterPackPartage(7, JETON, d), 'STICKER_PACK_LIMIT', 409);
  assert.ok(!ecrit(d, INS_PACK));
  assert.strictEqual(stockage.copies.length, 0);
});

test('ajouterPackPartage : 200 stickers perso maximum (429), seuls les nouveaux comptent', async () => {
  videStockage();
  let d = baseInstall({ actifs: 199 }); // 2 nouveaux : 201 > 200
  await attendErreur(() => pack.ajouterPackPartage(7, JETON, d), 'STICKER_QUOTA_EXCEEDED', 429);
  assert.strictEqual(stockage.copies.length, 0);
  // je possède déjà l'une des deux images : un seul nouveau, 200 ≤ 200
  d = baseInstall({ actifs: 199, mesShas: [{ id: 888, sha256: SHA_A }] });
  const r = await pack.ajouterPackPartage(7, JETON, d);
  assert.strictEqual(r.deja, false);
  assert.strictEqual(stockage.copies.length, 2, 'une seule image copiée (+ vignette)');
  assert.strictEqual(d.requetes.filter(([s]) => INS_ASSET.test(s)).length, 1);
  const stk = d.requetes.filter(([s]) => INS_STICKER.test(s)).map(([, p]) => p[2]);
  assert.ok(stk.includes(888), 'le sticker réutilise mon actif existant');
});

test('ajouterPackPartage : deux stickers de même empreinte = un seul actif, un seul fichier', async () => {
  videStockage();
  const d = baseInstall({ lus: [ligne(1, SHA_A), ligne(2, SHA_A, { position: 2 })] });
  await pack.ajouterPackPartage(7, JETON, d);
  assert.strictEqual(d.requetes.filter(([s]) => INS_ASSET.test(s)).length, 1);
  assert.strictEqual(d.requetes.filter(([s]) => INS_STICKER.test(s)).length, 2);
  assert.strictEqual(stockage.copies.length, 2);
});

test('ajouterPackPartage : images bloquées/retirées ignorées, comptées dans `ignores`', async () => {
  videStockage();
  const d = baseInstall({ lus: [ligne(1, SHA_A)], total: 3 });
  const r = await pack.ajouterPackPartage(7, JETON, d);
  assert.strictEqual(r.stickers, 1);
  assert.strictEqual(r.ignores, 2);
  const [sql] = de(d, LUS);
  assert.match(sql, /a\.status = 0/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM sticker_blocklist/);
  assert.match(sql, /LIMIT 40/);
});

test('ajouterPackPartage : plus aucun sticker copiable = introuvable', async () => {
  videStockage();
  const d = baseInstall({ lus: [] });
  await attendErreur(() => pack.ajouterPackPartage(7, JETON, d), 'STICKER_PACK_UNAVAILABLE', 404);
  assert.strictEqual(stockage.copies.length, 0);
});

test('ajouterPackPartage : échec d\'une copie = rollback et fichiers déjà posés nettoyés', async () => {
  videStockage();
  stockage.echec = true;
  const d = baseInstall();
  let leve = null;
  try { await pack.ajouterPackPartage(7, JETON, d); } catch (e) { leve = e; }
  assert.ok(leve, 'l\'erreur remonte');
  assert.strictEqual(d.etat.rollbacks, 1);
  assert.strictEqual(d.etat.commits, 0);
  assert.ok(stockage.retires.every((k) => k.startsWith('stickers/u/7/')), 'seuls MES fichiers sont nettoyés, jamais ceux de l\'auteur');
  assert.ok(!stockage.retires.some((k) => k.startsWith('stickers/u/9/')));
});

test('ajouterPackPartage : verrou de la source et de mes packs avant d\'écrire (anti-doublon)', async () => {
  videStockage();
  const d = baseInstall();
  await pack.ajouterPackPartage(7, JETON, d);
  const idx = (re) => d.requetes.findIndex(([s]) => re.test(s));
  assert.ok(idx(LOCK_SOURCE) < idx(MES_PACKS), 'source puis mes packs');
  assert.ok(idx(MES_PACKS) < idx(INS_PACK), 'verrous avant l\'insertion');
});

// ── 9. Lecture de mes packs ─────────────────────────────────────────────────

test('listerMesPacks : mes packs actifs seulement, filtrés par propriétaire', async () => {
  const d = base([
    [/FROM sticker_pack\s+WHERE owner_id = \? AND visibility IN/, () => [[{ id: 3 }, { id: 4 }], []]],
    [/FROM sticker s JOIN sticker_asset a ON a\.id = s\.asset_id\s+WHERE s\.pack_id IN \(\?, \?\) AND a\.status = 0/, () => [[{ pack_id: 3, id: 1 }], []]],
  ]);
  const r = await pack.listerMesPacks(7, d);
  assert.strictEqual(r.packs.length, 2);
  const [, p] = de(d, /FROM sticker_pack\s+WHERE owner_id/);
  assert.deepStrictEqual(p, [7, 1, 2, 1], 'owner = JWT, privé/lien, publié');
  const vide = base([[/FROM sticker_pack/, () => [[], []]]]);
  assert.deepStrictEqual(await pack.listerMesPacks(7, vide), { packs: [], stickers: [] });
  assert.strictEqual(vide.requetes.length, 1, 'aucune requête de stickers sans pack');
});

// ── Exécution ───────────────────────────────────────────────────────────────

(async () => {
  let ok = 0;
  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.stack || e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`stickerPack.test.js : ${ok}/${tests.length} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
