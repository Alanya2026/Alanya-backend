/**
 * Service des stickers personnels (V1b, plan §4) —
 * `node src/services/stickerPersonal.test.js`.
 *
 * Ce que le service garantit, et que ces tests éprouvent :
 *   - quotas personnels (20 packs, 40 stickers par pack) ;
 *   - pack par défaut : le plus ancien, créé au besoin ;
 *   - déduplication par propriétaire `(owner_id, sha256)` — un seul fichier ;
 *   - copie d'un sticker reçu : copie côté stockage (aucun octet serveur) ;
 *   - suppression en cascade (stickers, favoris, signalements, fichiers) ;
 *   - signalement idempotent, motif stocké en index, jamais en chaîne.
 *
 * Base, stockage et pipeline d'upload sont doublés : aucune dépendance externe
 * (ni MySQL, ni sharp, ni B2). Le service prend sa transaction sur le pool par
 * défaut (`pool.getConnection()`) : le double de `../config/db` renvoie donc la
 * connexion du `d` du test en cours.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

let ok = 0;
const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

const SHA = 'a'.repeat(64);

// ── Effets observés sur le stockage ─────────────────────────────────────────
const stockage = { deposes: [], copies: [], retires: [] };
const videStockage = () => { stockage.deposes = []; stockage.copies = []; stockage.retires = []; };

remplace('./mediaStorage', {
  personalStickerKey: ({ alanyaID, sha256, sel, thumb = false }) => `stickers/u/${alanyaID}/${sel}_${sha256}${thumb ? '_t' : ''}.webp`,
  putBody: async (k) => { stockage.deposes.push(k); },
  copyObject: async (src, dst) => { stockage.copies.push([src, dst]); },
  removeAllVersions: async (k) => { stockage.retires.push(k); },
});
remplace('../utils/stickerAsset', {
  preparerAsset: async () => ({
    webp: Buffer.from('w'), thumb: Buffer.from('t'), sha256: SHA,
    width: 512, height: 512, bytes: 4096, animated: false, qualite: 80,
  }),
});
remplace('./stickerAssetService', {
  depsSql: () => ({ estBloque: async () => false, usage: async () => ({ assets: 0, uploadsDerniereHeure: 0 }) }),
});

// ── Base doublée ────────────────────────────────────────────────────────────
// Le `d` du test en cours : le double du pool par défaut y délègue, car le
// service prend sa transaction sur `pool.getConnection()` et non sur `db`.
let contexte = { execute: async () => [[], []] };

/** `execute(sql, params)` journalise et applique le 1er handler qui matche. */
function base(handlers = []) {
  const requetes = [];
  const exec = async (sql, params) => {
    requetes.push([sql, params]);
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
    return [[], []];
  };
  const connexion = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {},
    release: () => {}, execute: exec,
  };
  const d = { requetes, execute: exec, getConnection: async () => connexion };
  contexte = d;
  return d;
}

remplace('../config/db', {
  execute: (sql, params) => contexte.execute(sql, params),
  getConnection: async () => ({
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    execute: (sql, params) => contexte.execute(sql, params),
  }),
});

const sp = require('./stickerPersonalService');
const { StickerPersonalError } = sp;

const attendErreur = async (fn, code) => {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof StickerPersonalError, `erreur inattendue : ${e.message}`);
    assert.strictEqual(e.code, code, `code attendu ${code}, reçu ${e.code}`);
    return e;
  }
  throw new Error(`aurait dû lever ${code}`);
};

// ── Motifs SQL ──────────────────────────────────────────────────────────────
const PACK_DEFAUT_RE = /SELECT id, code FROM sticker_pack/i;
const COUNT_PACK_RE = /SELECT COUNT\(\*\) AS n FROM sticker_pack WHERE owner_id = \?/i;
const COUNT_STICKER_RE = /SELECT COUNT\(\*\) AS n FROM sticker WHERE pack_id = \?/i;
const OWNED_SHA_RE = /SELECT id FROM sticker_asset WHERE owner_id = \? AND sha256 = \? FOR UPDATE/i;
const SRC_ASSET_RE = /SELECT id, owner_id, sha256, storage_key, thumb_key, mime, width, height, bytes, animated, status\s+FROM sticker_asset WHERE id = \? LIMIT 1/i;
const BLOCKLIST_RE = /SELECT 1 FROM sticker_blocklist WHERE sha256 = \?/i;
const INSERT_ASSET_RE = /INSERT INTO sticker_asset/i;
const INSERT_STICKER_RE = /INSERT INTO sticker \(/i;
const UPDATE_KEY_RE = /UPDATE sticker_asset SET storage_key/i;
const ASSET_OWNER_RE = /SELECT id, storage_key, thumb_key FROM sticker_asset WHERE id = \? AND owner_id = \? FOR UPDATE/i;
const STICKERS_ASSET_RE = /SELECT id FROM sticker WHERE asset_id = \?/i;
const REPORT_ASSET_RE = /SELECT id, owner_id, status FROM sticker_asset WHERE id = \? LIMIT 1/i;
const REPORT_DEJA_RE = /SELECT id FROM sticker_report WHERE asset_id = \? AND reporter_id = \?/i;
const INSERT_REPORT_RE = /INSERT INTO sticker_report/i;

const PACK_SQL = 'official/stickers/mboa/1_ab12cd34.webp';
const THUMB_SQL = 'official/stickers/mboa/1_ab12cd34_t.webp';
const sourceCopiable = (extra = {}) => ({
  id: 5, owner_id: 0, sha256: SHA, storage_key: PACK_SQL, thumb_key: THUMB_SQL,
  mime: 'image/webp', width: 512, height: 512, bytes: 4096, animated: 0, status: 0, ...extra,
});

// ── Constantes et helpers purs ──────────────────────────────────────────────

test('quotas et motifs : valeurs du contrat', () => {
  assert.strictEqual(sp.MAX_PACKS_PERSO, 20);
  assert.strictEqual(sp.MAX_STICKERS_PACK, 40);
  assert.deepStrictEqual([...sp.RAISONS], ['inapproprie', 'spam', 'droits', 'autre']);
});

test('codePackPerso : `u_<alanyaID>_<8 hex>`', () => {
  const code = sp.codePackPerso(7);
  assert.match(code, /^u_7_[0-9a-f]{8}$/);
  assert.ok(code.length <= 40, 'code ≤ 40 caractères');
});

test('emojiDe : repli sur l\'emoji par défaut quand vide', () => {
  assert.strictEqual(sp.emojiDe('   '), sp.EMOJI_DEFAUT);
  assert.strictEqual(sp.emojiDe('😀'), '😀');
});

// ── 2. creerPackPerso ───────────────────────────────────────────────────────

test('creerPackPerso : crée un pack perso (owner, privé, publié)', async () => {
  const d = base([
    [COUNT_PACK_RE, () => [[{ n: 0 }], []]],
    [/INSERT INTO sticker_pack/i, () => [{ insertId: 42 }, []]],
  ]);
  const r = await sp.creerPackPerso(7, d);
  assert.strictEqual(r.id, 42);
  assert.match(r.code, /^u_7_[0-9a-f]{8}$/);
  const [, p] = d.requetes.find(([s]) => /INSERT INTO sticker_pack/i.test(s));
  assert.strictEqual(p[1], 7, 'owner_id = 7');
  assert.strictEqual(p[3], sp.VISIBILITE_PRIVE, 'visibility privée');
  assert.strictEqual(p[4], sp.STATUT_PUBLIE, 'status publié');
  assert.strictEqual(p[5], 7, 'created_by = 7');
});

test('creerPackPerso : refuse au-delà de 20 packs', async () => {
  const d = base([[COUNT_PACK_RE, () => [[{ n: 20 }], []]]]);
  await attendErreur(() => sp.creerPackPerso(7, d), 'STICKER_PACK_LIMIT');
  assert.ok(!d.requetes.some(([s]) => /INSERT INTO sticker_pack/i.test(s)), 'aucun INSERT');
});

test('chargePackPerso : privé OU partagé par lien, jamais archivé, propriétaire dans la requête', async () => {
  const d = base([[/SELECT id, code FROM sticker_pack\s+WHERE id = \? AND owner_id = \?/, () => [[{ id: 3, code: 'u_7_x' }], []]]]);
  assert.deepStrictEqual(await sp.chargePackPerso(3, 7, d), { id: 3, code: 'u_7_x' });
  const [sql, p] = d.requetes[0];
  assert.match(sql, /visibility IN \(\?, \?\) AND status <> \?/);
  assert.deepStrictEqual(p, [3, 7, sp.VISIBILITE_PRIVE, sp.VISIBILITE_LIEN, sp.STATUT_ARCHIVE]);
});

test('creerPackPerso : le plafond de 20 ne compte pas les packs archivés', async () => {
  const d = base([
    [COUNT_PACK_RE, () => [[{ n: 3 }], []]],
    [/INSERT INTO sticker_pack/i, () => [{ insertId: 5 }, []]],
  ]);
  await sp.creerPackPerso(7, d);
  const [sql, p] = d.requetes.find(([s]) => COUNT_PACK_RE.test(s));
  assert.match(sql, /status <> \?/);
  assert.deepStrictEqual(p, [7, sp.STATUT_ARCHIVE]);
});

// ── 3. packPersoParDefaut ───────────────────────────────────────────────────

test('packPersoParDefaut : rend le pack existant sans rien créer', async () => {
  const d = base([[PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]]]);
  const r = await sp.packPersoParDefaut(7, d);
  assert.deepStrictEqual(r, { id: 3, code: 'u_7_x' });
  assert.ok(!d.requetes.some(([s]) => /INSERT INTO sticker_pack/i.test(s)));
});

test('packPersoParDefaut : crée le pack quand le compte n\'en a aucun', async () => {
  const d = base([
    [PACK_DEFAUT_RE, () => [[], []]],
    [COUNT_PACK_RE, () => [[{ n: 0 }], []]],
    [/INSERT INTO sticker_pack/i, () => [{ insertId: 9 }, []]],
  ]);
  const r = await sp.packPersoParDefaut(7, d);
  assert.strictEqual(r.id, 9);
  assert.match(r.code, /^u_7_/);
  assert.ok(d.requetes.some(([s]) => /INSERT INTO sticker_pack/i.test(s)));
});

// ── 4 & 5. creerStickerPerso ────────────────────────────────────────────────

test('creerStickerPerso : dépose l\'actif et le sticker, 2 fichiers', async () => {
  videStockage();
  const d = base([
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[], []]],
    [INSERT_ASSET_RE, () => [{ insertId: 10 }, []]],
    [INSERT_STICKER_RE, () => [{ insertId: 20 }, []]],
    [UPDATE_KEY_RE, () => [{ affectedRows: 1 }, []]],
  ]);
  const r = await sp.creerStickerPerso({ buffer: Buffer.from('png'), alanyaID: 7 }, d);
  assert.strictEqual(r.assetId, 10);
  assert.strictEqual(r.stickerId, 20);
  assert.strictEqual(r.packId, 3);
  assert.strictEqual(r.reutilise, false);
  assert.strictEqual(r.bytes, 4096);
  assert.strictEqual(stockage.deposes.length, 2, 'image + vignette déposées');
  assert.ok(d.requetes.some(([s]) => UPDATE_KEY_RE.test(s)), 'clé écrite sur l\'actif');
});

test('creerStickerPerso : refuse au-delà de 40 stickers dans le pack', async () => {
  videStockage();
  const d = base([
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 40 }], []]],
  ]);
  await attendErreur(() => sp.creerStickerPerso({ buffer: Buffer.from('png'), alanyaID: 7 }, d), 'STICKER_PACK_LIMIT');
  assert.strictEqual(stockage.deposes.length, 0);
});

test('creerStickerPerso : réutilise l\'actif du même propriétaire (aucun dépôt)', async () => {
  videStockage();
  const d = base([
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 1 }], []]],
    [OWNED_SHA_RE, () => [[{ id: 10 }], []]],
    [INSERT_STICKER_RE, () => [{ insertId: 20 }, []]],
  ]);
  const r = await sp.creerStickerPerso({ buffer: Buffer.from('png'), alanyaID: 7 }, d);
  assert.strictEqual(r.reutilise, true);
  assert.strictEqual(r.assetId, 10);
  assert.strictEqual(stockage.deposes.length, 0, 'rien n\'est redéposé');
  assert.ok(!d.requetes.some(([s]) => UPDATE_KEY_RE.test(s)), 'pas de réécriture de clé');
});

// ── 6. copierStickerPerso ───────────────────────────────────────────────────

test('copierStickerPerso : copie le fichier côté stockage, jamais les octets', async () => {
  videStockage();
  const d = base([
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[], []]],
    [INSERT_ASSET_RE, () => [{ insertId: 11 }, []]],
    [INSERT_STICKER_RE, () => [{ insertId: 21 }, []]],
    [UPDATE_KEY_RE, () => [{ affectedRows: 1 }, []]],
  ]);
  const r = await sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, d);
  assert.strictEqual(r.copie, true);
  assert.strictEqual(r.assetId, 11);
  assert.strictEqual(r.stickerId, 21);
  assert.strictEqual(stockage.copies.length, 2, 'image + vignette copiées');
  assert.ok(stockage.copies.every(([, dst]) => dst.startsWith('stickers/u/7/')), 'cible sous mon espace');
  assert.ok(d.requetes.some(([s]) => UPDATE_KEY_RE.test(s)));
});

test('copierStickerPerso : refuse une image de la liste de blocage', async () => {
  videStockage();
  const d = base([
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [['x'], []]],
  ]);
  await attendErreur(() => sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, d), 'STICKER_ASSET_BLOCKED');
  assert.strictEqual(stockage.copies.length, 0);
});

test('copierStickerPerso : un actif retiré (status ≠ 0) est introuvable', async () => {
  videStockage();
  const d = base([[SRC_ASSET_RE, () => [[sourceCopiable({ status: 1 })], []]]]);
  await attendErreur(() => sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, d), 'STICKER_NOT_FOUND');
  assert.strictEqual(stockage.copies.length, 0);
});

// ── 7. supprimerAssetPerso ──────────────────────────────────────────────────

test('supprimerAssetPerso : supprime sticker, favoris, signalements et fichiers', async () => {
  videStockage();
  const d = base([
    [ASSET_OWNER_RE, () => [[{ id: 10, storage_key: 'stickers/u/7/x_a.webp', thumb_key: 'stickers/u/7/x_a_t.webp' }], []]],
    [STICKERS_ASSET_RE, () => [[{ id: 5 }, { id: 6 }], []]],
  ]);
  const r = await sp.supprimerAssetPerso(7, 10, d);
  assert.deepStrictEqual(r, { assetId: 10, stickers: 2 });
  for (const re of [
    /DELETE FROM user_sticker_favorite/i,
    /UPDATE sticker_pack SET cover_sticker_id/i,
    /DELETE FROM sticker_report/i,
    /DELETE FROM sticker WHERE asset_id = \?/i,
    /DELETE FROM sticker_asset WHERE id = \?/i,
  ]) {
    assert.ok(d.requetes.some(([s]) => re.test(s)), `requête absente : ${re}`);
  }
  assert.ok(stockage.retires.includes('stickers/u/7/x_a.webp'), 'image retirée');
  assert.ok(stockage.retires.includes('stickers/u/7/x_a_t.webp'), 'vignette retirée');
});

test('supprimerAssetPerso : refuse un actif dont je ne suis pas propriétaire', async () => {
  videStockage();
  const d = base([[ASSET_OWNER_RE, () => [[], []]]]);
  await attendErreur(() => sp.supprimerAssetPerso(7, 10, d), 'STICKER_NOT_FOUND');
  assert.strictEqual(stockage.retires.length, 0, 'aucun fichier retiré');
});

// ── 8. signalerSticker ──────────────────────────────────────────────────────

test('signalerSticker : enregistre le motif en index', async () => {
  const d = base([
    [REPORT_ASSET_RE, () => [[{ id: 5, owner_id: 9, status: 0 }], []]],
    [REPORT_DEJA_RE, () => [[], []]],
    [INSERT_REPORT_RE, () => [{ insertId: 1 }, []]],
  ]);
  const r = await sp.signalerSticker({ alanyaID: 7, assetId: 5, reason: 'spam' }, d);
  assert.deepStrictEqual(r, { ok: true, deja: false });
  const [, p] = d.requetes.find(([s]) => INSERT_REPORT_RE.test(s));
  assert.strictEqual(p[2], sp.RAISONS.indexOf('spam'), 'motif = index de « spam »');
});

test('signalerSticker : idempotent pour un même rapporteur', async () => {
  const d = base([
    [REPORT_ASSET_RE, () => [[{ id: 5, owner_id: 9, status: 0 }], []]],
    [REPORT_DEJA_RE, () => [[{ id: 1 }], []]],
    [INSERT_REPORT_RE, () => [{ insertId: 1 }, []]],
  ]);
  const r = await sp.signalerSticker({ alanyaID: 7, assetId: 5, reason: 'spam' }, d);
  assert.deepStrictEqual(r, { ok: true, deja: true });
  assert.ok(!d.requetes.some(([s]) => INSERT_REPORT_RE.test(s)), 'aucun doublon');
});

test('signalerSticker : motif inconnu refusé', async () => {
  const d = base([[REPORT_ASSET_RE, () => [[{ id: 5, owner_id: 9, status: 0 }], []]]]);
  await attendErreur(() => sp.signalerSticker({ alanyaID: 7, assetId: 5, reason: 'zzz' }, d), 'STICKER_INVALID_PAYLOAD');
});

test('signalerSticker : on ne se signale pas soi-même', async () => {
  const d = base([[REPORT_ASSET_RE, () => [[{ id: 5, owner_id: 7, status: 0 }], []]]]);
  await attendErreur(() => sp.signalerSticker({ alanyaID: 7, assetId: 5, reason: 'spam' }, d), 'STICKER_INVALID_PAYLOAD');
});

// ── Exécution ───────────────────────────────────────────────────────────────

(async () => {
  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`stickerPersonal.test.js : ${ok} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
