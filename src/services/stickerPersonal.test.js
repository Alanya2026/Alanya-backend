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
const ASSET_OWNER_RE = /SELECT id FROM sticker_asset WHERE id = \? AND owner_id = \? FOR UPDATE/i;
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

test('copie puis suppression de l\'original : la copie garde son actif, son sticker et son fichier (B)', async () => {
  videStockage();
  // 1. Le compte 7 copie le sticker (actif 5, propriétaire 9) : actif 11, sticker 21, fichiers à lui.
  const copie = base([
    [SRC_ASSET_RE, () => [[sourceCopiable({ owner_id: 9, storage_key: 'stickers/u/9/orig_a.webp', thumb_key: 'stickers/u/9/orig_a_t.webp' })], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[], []]],
    [INSERT_ASSET_RE, () => [{ insertId: 11 }, []]],
    [INSERT_STICKER_RE, () => [{ insertId: 21 }, []]],
    [UPDATE_KEY_RE, () => [{ affectedRows: 1 }, []]],
  ]);
  const r = await sp.copierStickerPerso({ alanyaID: 7, assetId: 5 }, copie);
  assert.deepStrictEqual([r.assetId, r.stickerId], [11, 21]);
  const [, pInsert] = copie.requetes.find(([sql]) => INSERT_ASSET_RE.test(sql));
  assert.strictEqual(pInsert[0], 7, 'l\'actif copié appartient au copieur');
  assert.ok(stockage.copies.every(([src, dst]) => src.startsWith('stickers/u/9/') && dst.startsWith('stickers/u/7/') && src !== dst), 'fichiers distincts de ceux de l\'original');
  // 2. Le propriétaire 9 supprime l'original (actif 5, stickers 50 et 51).
  videStockage();
  const suppr = base([
    [ASSET_OWNER_RE, () => [[{ id: 5 }], []]],
    [STICKERS_ASSET_RE, () => [[{ id: 50 }, { id: 51 }], []]],
  ]);
  await sp.supprimerAssetPerso(9, 5, suppr);
  for (const [sql, params] of suppr.requetes.filter(([q]) => /^\s*(DELETE|UPDATE)/i.test(q))) {
    assert.ok((params || []).map(Number).every((v) => [5, 50, 51].includes(v)), `touche la copie : ${sql} ${JSON.stringify(params)}`);
  }
  assert.strictEqual(stockage.retires.length, 0, 'le fichier de l\'original reste servi (les anciens messages s\'affichent) ; celui de la copie aussi');
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

test('supprimerAssetPerso : supprime sticker, favoris, signalements — et AUCUN fichier (A13)', async () => {
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
  assert.deepStrictEqual(stockage.retires, [], 'aucune suppression de fichier : l\'image et la vignette restent servies');
});

test('supprimerAssetPerso : ne touche que l\'actif d\'origine, jamais les copies ni les packs installés (B)', async () => {
  videStockage();
  // Mon actif 10 porte les stickers 5 et 6. Les copies faites par d'autres
  // comptes sont d'AUTRES actifs (11, 12…) avec leurs propres stickers (50, 60) :
  // aucune requête d'écriture ne doit les viser.
  const d = base([
    [ASSET_OWNER_RE, () => [[{ id: 10, storage_key: 'stickers/u/7/x_a.webp', thumb_key: 'stickers/u/7/x_a_t.webp' }], []]],
    [STICKERS_ASSET_RE, () => [[{ id: 5 }, { id: 6 }], []]],
  ]);
  await sp.supprimerAssetPerso(7, 10, d);
  const ecritures = d.requetes.filter(([sql]) => /^\s*(DELETE|UPDATE|INSERT)/i.test(sql));
  assert.ok(ecritures.length > 0);
  for (const [sql, params] of ecritures) {
    const valeurs = (params || []).map(Number);
    assert.ok(valeurs.every((v) => [5, 6, 10].includes(v)), `écriture hors de l'original : ${sql} ${JSON.stringify(params)}`);
    assert.ok(!/user_sticker_pack|sticker_pack\s+SET\s+(status|visibility|share_token)|DELETE FROM sticker_pack/i.test(sql), `pack touché : ${sql}`);
    assert.ok(!/source_pack_id/i.test(sql), 'les copies (source_pack_id) ne sont pas lues');
  }
  // La lecture du propriétaire est dans la requête : l'actif d'un autre est introuvable.
  const [lecture, pLecture] = d.requetes.find(([sql]) => ASSET_OWNER_RE.test(sql));
  assert.match(lecture, /owner_id = \?/);
  assert.deepStrictEqual(pLecture, [10, 7]);
  assert.strictEqual(stockage.retires.length, 0);
  assert.strictEqual(stockage.copies.length, 0);
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

// ── 9. Accès par `stickerId` (sticker REÇU) ─────────────────────────────────

const RESOLU_RE = /FROM sticker s\s+JOIN sticker_pack p ON p\.id = s\.pack_id\s+JOIN sticker_asset a/i;
/** Ligne de `resoudreStickerRecu` : un sticker officiel publié et actif par défaut. */
const ligneRecue = (extra = {}) => ({
  id: 30, asset_id: 5, emoji: '🦩', visibility: 0, pack_status: 1, pack_owner: null,
  is_premium: 0, asset_status: 0, partage_conv: 0, ...extra,
});

test('accesStickerRecu : officiel PUBLIÉ seulement (archivé = indisponible, A14), jamais brouillon', () => {
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ pack_status: 1 }), 7), true);
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ pack_status: 2 }), 7), false, 'archivé : indisponible');
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ pack_status: 0 }), 7), false);
  // L'état « installé » n'y change rien : la règle ne le lit pas.
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ pack_status: 2, installed: 1 }), 7), false);
  // Republié : redevient accessible.
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ pack_status: 1 }), 7), true, 'republié');
});

test('accesStickerRecu : actif retiré refusé partout', () => {
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ asset_status: 1 }), 7), false);
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ visibility: 1, pack_owner: 7, asset_status: 1 }), 7), false);
});

test('accesStickerRecu : perso = propriétaire ou co-participant, publié seulement', () => {
  for (const visibility of [1, 2]) {
    const perso = (extra) => ligneRecue({ visibility, pack_owner: 9, ...extra });
    assert.strictEqual(sp.accesStickerRecu(perso({ pack_owner: 7 }), 7), true, 'propriétaire');
    assert.strictEqual(sp.accesStickerRecu(perso({ partage_conv: 1 }), 7), true, 'co-participant');
    assert.strictEqual(sp.accesStickerRecu(perso({ partage_conv: 0 }), 7), false, 'inconnu');
    assert.strictEqual(sp.accesStickerRecu(perso({ pack_status: 0, partage_conv: 1 }), 7), false, 'brouillon');
    assert.strictEqual(sp.accesStickerRecu(perso({ pack_status: 2, pack_owner: 7 }), 7), false, 'archivé');
  }
  assert.strictEqual(sp.accesStickerRecu(ligneRecue({ visibility: 9, pack_owner: 7 }), 7), false, 'visibilité inconnue');
  assert.strictEqual(sp.accesStickerRecu(undefined, 7), false);
});

test('resoudreStickerRecu : identifiant invalide = 404 sans requête', async () => {
  const d = base();
  for (const id of [undefined, null, '', 'abc', '1 OR 1=1', -3, 0, 1.5, 1e999]) {
    await attendErreur(() => sp.resoudreStickerRecu(7, id, d), 'STICKER_NOT_FOUND');
  }
  assert.strictEqual(d.requetes.length, 0);
});

test('resoudreStickerRecu : inexistant et inaccessible = même 404', async () => {
  const inexistant = await attendErreur(
    () => sp.resoudreStickerRecu(7, 30, base([[RESOLU_RE, () => [[], []]]])), 'STICKER_NOT_FOUND');
  const inaccessible = await attendErreur(
    () => sp.resoudreStickerRecu(7, 30, base([[RESOLU_RE, () => [[ligneRecue({ visibility: 1, pack_owner: 9 })], []]]])),
    'STICKER_NOT_FOUND');
  assert.deepStrictEqual([inexistant.status, inexistant.message], [inaccessible.status, inaccessible.message]);
});

test('resoudreStickerRecu : le demandeur vient des paramètres, jamais du corps', async () => {
  const d = base([[RESOLU_RE, () => [[ligneRecue()], []]]]);
  const r = await sp.resoudreStickerRecu(7, '30', d);
  assert.deepStrictEqual(r, { stickerId: 30, assetId: 5, emoji: '🦩', isPremium: false });
  assert.deepStrictEqual(d.requetes[0][1], [7, 30]);
  assert.ok(/conv_participants/.test(d.requetes[0][0]), 'co-participation lue dans la même requête');
});

test('copierStickerRecu : copie le fichier source, emoji du sticker par défaut', async () => {
  videStockage();
  const d = base([
    [RESOLU_RE, () => [[ligneRecue()], []]],
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[], []]],
    [INSERT_ASSET_RE, () => [{ insertId: 11 }, []]],
    [INSERT_STICKER_RE, () => [{ insertId: 21 }, []]],
    [UPDATE_KEY_RE, () => [{ affectedRows: 1 }, []]],
  ]);
  const r = await sp.copierStickerRecu({ alanyaID: 7, stickerId: 30 }, d);
  assert.deepStrictEqual(r, { assetId: 11, stickerId: 21, packId: 3, reutilise: false, copie: true });
  assert.strictEqual(stockage.copies.length, 2);
  assert.ok(stockage.copies.every(([, dst]) => dst.startsWith('stickers/u/7/')));
  const ins = d.requetes.find(([q]) => INSERT_STICKER_RE.test(q));
  assert.ok(ins[1].includes('🦩'), 'emoji source repris');
  // Un emoji fourni l'emporte.
  const d2 = base([
    [RESOLU_RE, () => [[ligneRecue()], []]], [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]], [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]], [OWNED_SHA_RE, () => [[{ id: 4 }], []]],
    [INSERT_STICKER_RE, () => [{ insertId: 22 }, []]],
  ]);
  const r2 = await sp.copierStickerRecu({ alanyaID: 7, stickerId: 30, emoji: '⭐' }, d2);
  assert.strictEqual(r2.reutilise, true);
  assert.ok(d2.requetes.find(([q]) => INSERT_STICKER_RE.test(q))[1].includes('⭐'));
});

test('copierStickerRecu : sticker inaccessible = 404, aucun fichier copié', async () => {
  videStockage();
  const d = base([[RESOLU_RE, () => [[ligneRecue({ pack_status: 0 })], []]]]);
  await attendErreur(() => sp.copierStickerRecu({ alanyaID: 7, stickerId: 30 }, d), 'STICKER_NOT_FOUND');
  assert.strictEqual(stockage.copies.length, 0);
  assert.ok(!d.requetes.some(([q]) => SRC_ASSET_RE.test(q)), 'rien lu au-delà du refus');
});

test('copierStickerRecu : pack Plus sans droit = SUBSCRIPTION_REQUIRED, droits illisibles = ouvert', async () => {
  videStockage();
  const handlers = () => [
    [RESOLU_RE, () => [[ligneRecue({ is_premium: 1 })], []]],
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[{ id: 4 }], []]],
    [INSERT_STICKER_RE, () => [{ insertId: 22 }, []]],
  ];
  const e = await attendErreur(() => sp.copierStickerRecu(
    { alanyaID: 7, stickerId: 30 }, base(handlers()),
    { droits: async () => ({ features: { stickers_premium: false } }) }), 'SUBSCRIPTION_REQUIRED');
  assert.strictEqual(e.status, 403);
  assert.strictEqual(e.feature, 'stickers_premium');
  assert.strictEqual(stockage.copies.length, 0);
  // Droit explicite, droits absents ou en panne : on laisse passer (règle de l'envoi).
  for (const droits of [
    async () => ({ features: { stickers_premium: true } }),
    async () => null,
    async () => { throw new Error('ER_NO_SUCH_TABLE'); },
  ]) {
    const r = await sp.copierStickerRecu({ alanyaID: 7, stickerId: 30 }, base(handlers()), { droits });
    assert.strictEqual(r.reutilise, true);
  }
});

test('signalerStickerRecu : résout l\'actif côté serveur puis signale, idempotent', async () => {
  const h = (deja) => [
    [RESOLU_RE, () => [[ligneRecue({ asset_id: 5 })], []]],
    [REPORT_ASSET_RE, () => [[{ id: 5, owner_id: 9, status: 0 }], []]],
    [REPORT_DEJA_RE, () => [deja ? [{ id: 1 }] : [], []]],
    [INSERT_REPORT_RE, () => [{ insertId: 1 }, []]],
  ];
  const d = base(h(false));
  assert.deepStrictEqual(await sp.signalerStickerRecu({ alanyaID: 7, stickerId: 30, reason: 'spam' }, d), { ok: true, deja: false });
  assert.deepStrictEqual(d.requetes.find(([q]) => INSERT_REPORT_RE.test(q))[1], [5, 7, 1], 'asset 5, rapporteur 7, motif spam = 1');
  const d2 = base(h(true));
  assert.deepStrictEqual(await sp.signalerStickerRecu({ alanyaID: 7, stickerId: 30, reason: 'spam' }, d2), { ok: true, deja: true });
  assert.ok(!d2.requetes.some(([q]) => INSERT_REPORT_RE.test(q)), 'aucun doublon');
});

test('signalerStickerRecu : l\'accès précède la validation du motif (pas d\'oracle)', async () => {
  const d = base([[RESOLU_RE, () => [[ligneRecue({ visibility: 1, pack_owner: 9 })], []]]]);
  await attendErreur(() => sp.signalerStickerRecu({ alanyaID: 7, stickerId: 30, reason: 'zzz' }, d), 'STICKER_NOT_FOUND');
  const d2 = base([[RESOLU_RE, () => [[ligneRecue()], []]], [REPORT_ASSET_RE, () => [[{ id: 5, owner_id: 9, status: 0 }], []]]]);
  await attendErreur(() => sp.signalerStickerRecu({ alanyaID: 7, stickerId: 30, reason: 'zzz' }, d2), 'STICKER_INVALID_PAYLOAD');
});

// ── 10. Routes legacy par `assetId` : même règle que le `stickerId` ─────────

const ASSET_ACCES_RE = /FROM sticker_asset a\s+LEFT JOIN sticker s ON s\.asset_id = a\.id\s+LEFT JOIN sticker_pack p/i;
/** Ligne de `resoudreAssetRecu` : actif officiel actif, porté par un sticker d'un pack publié. */
const ligneAsset = (extra = {}) => ({
  asset_id: 5, asset_owner: 0, asset_status: 0, sticker_id: 30,
  visibility: 0, pack_status: 1, pack_owner: null, is_premium: 0, partage_conv: 0, ...extra,
});
const NOT_FOUND = 'STICKER_NOT_FOUND';
const accesAsset = (lignes) => base([[ASSET_ACCES_RE, () => [lignes, []]]]);

test('resoudreAssetRecu : propriétaire de l\'actif, même hors de tout pack', async () => {
  const r = await sp.resoudreAssetRecu(7, 5, accesAsset([
    ligneAsset({ asset_owner: 7, sticker_id: null, visibility: null, pack_status: null }),
  ]));
  assert.deepStrictEqual(r, { assetId: 5, proprietaire: true, isPremium: false });
});

test('resoudreAssetRecu : accès légitime = règle de resoudreStickerRecu', async () => {
  // officiel publié (l'archivé est refusé : voir plus bas)
  {
    const r = await sp.resoudreAssetRecu(7, '5', accesAsset([ligneAsset({ pack_status: 1 })]));
    assert.deepStrictEqual(r, { assetId: 5, proprietaire: false, isPremium: false });
  }
  // perso (privé et lien) : publié + co-participant
  for (const visibility of [1, 2]) {
    const r = await sp.resoudreAssetRecu(7, 5, accesAsset([
      ligneAsset({ asset_owner: 9, visibility, pack_owner: 9, partage_conv: 1 }),
    ]));
    assert.strictEqual(r.proprietaire, false);
  }
  // un seul sticker accessible parmi plusieurs suffit
  const r = await sp.resoudreAssetRecu(7, 5, accesAsset([
    ligneAsset({ asset_owner: 9, sticker_id: 31, visibility: 1, pack_owner: 9, partage_conv: 0 }),
    ligneAsset({ asset_owner: 9, sticker_id: 32, visibility: 1, pack_owner: 9, partage_conv: 1 }),
  ]));
  assert.strictEqual(r.assetId, 5);
});

test('resoudreAssetRecu : le demandeur vient des paramètres, requête unique', async () => {
  const d = accesAsset([ligneAsset()]);
  await sp.resoudreAssetRecu(7, '5', d);
  assert.strictEqual(d.requetes.length, 1);
  assert.deepStrictEqual(d.requetes[0][1], [7, 5]);
  assert.ok(/conv_participants/.test(d.requetes[0][0]), 'co-participation lue dans la même requête');
});

test('resoudreAssetRecu : refusés = MÊME 404 (privé d\'un autre, retiré, brouillon, archivé, inexistant, invalide)', async () => {
  const refuses = {
    'inexistant': [],
    'actif retiré (officiel)': [ligneAsset({ asset_status: 1 })],
    'actif retiré (à moi)': [ligneAsset({ asset_status: 1, asset_owner: 7 })],
    'privé d\'un autre, sans conversation': [ligneAsset({ asset_owner: 9, visibility: 1, pack_owner: 9, partage_conv: 0 })],
    'lien d\'un autre, sans conversation': [ligneAsset({ asset_owner: 9, visibility: 2, pack_owner: 9, partage_conv: 0 })],
    'privé d\'un autre : pack brouillon, même co-participant': [ligneAsset({ asset_owner: 9, visibility: 1, pack_status: 0, pack_owner: 9, partage_conv: 1 })],
    'privé d\'un autre : pack archivé, même co-participant': [ligneAsset({ asset_owner: 9, visibility: 1, pack_status: 2, pack_owner: 9, partage_conv: 1 })],
    'officiel : pack brouillon': [ligneAsset({ pack_status: 0 })],
    'officiel : pack archivé (indisponible, A14)': [ligneAsset({ pack_status: 2 })],
    'actif orphelin d\'un autre (aucun sticker)': [ligneAsset({ asset_owner: 9, sticker_id: null, visibility: null, pack_status: null })],
    'visibilité inconnue': [ligneAsset({ asset_owner: 9, visibility: 9, pack_owner: 9, partage_conv: 1 })],
  };
  const erreurs = [];
  for (const [libelle, lignes] of Object.entries(refuses)) {
    const e = await attendErreur(() => sp.resoudreAssetRecu(7, 5, accesAsset(lignes)), NOT_FOUND);
    erreurs.push([libelle, e.status, e.message]);
  }
  for (const id of [undefined, null, '', 'abc', '1 OR 1=1', -3, 0, 1.5, 1e999]) {
    const d = base();
    const e = await attendErreur(() => sp.resoudreAssetRecu(7, id, d), NOT_FOUND);
    erreurs.push([String(id), e.status, e.message]);
    assert.strictEqual(d.requetes.length, 0, 'identifiant invalide : aucune requête');
  }
  const [, st, msg] = erreurs[0];
  for (const [libelle, status, message] of erreurs) {
    assert.deepStrictEqual([status, message], [st, msg], `réponse distincte : ${libelle}`);
  }
});

test('officiel ARCHIVÉ (A14) : copie et signalement, par sid comme par assetId = même 404, rien de copié ni d\'écrit', async () => {
  for (const pack_status of [2, 0]) {
    videStockage();
    const parSid = base([[RESOLU_RE, () => [[ligneRecue({ pack_status })], []]]]);
    const e1 = await attendErreur(() => sp.copierStickerRecu({ alanyaID: 7, stickerId: 30 }, parSid), NOT_FOUND);
    const e2 = await attendErreur(() => sp.signalerStickerRecu({ alanyaID: 7, stickerId: 30, reason: 'spam' }, parSid), NOT_FOUND);
    const parAsset = accesAsset([ligneAsset({ pack_status })]);
    const e3 = await attendErreur(() => sp.copierAssetRecu({ alanyaID: 7, assetId: 5 }, parAsset), NOT_FOUND);
    const e4 = await attendErreur(() => sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason: 'spam' }, parAsset), NOT_FOUND);
    for (const e of [e1, e2, e3, e4]) assert.deepStrictEqual([e.status, e.message], [e1.status, e1.message]);
    assert.strictEqual(stockage.copies.length, 0, 'aucun fichier copié');
    for (const d of [parSid, parAsset]) {
      assert.ok(!d.requetes.some(([sql]) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)), 'aucune écriture');
    }
  }
  // Republié : redevient copiable.
  videStockage();
  const d = base([
    [RESOLU_RE, () => [[ligneRecue({ pack_status: 1 })], []]],
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[], []]],
    [INSERT_ASSET_RE, () => [{ insertId: 11 }, []]],
    [INSERT_STICKER_RE, () => [{ insertId: 21 }, []]],
    [UPDATE_KEY_RE, () => [{ affectedRows: 1 }, []]],
  ]);
  const r = await sp.copierStickerRecu({ alanyaID: 7, stickerId: 30 }, d);
  assert.strictEqual(r.copie, true, 'republié : copiable de nouveau');
});

test('copierAssetRecu : propriétaire et accès légitime copient (réponse inchangée)', async () => {
  videStockage();
  const handlers = (ligne) => [
    [ASSET_ACCES_RE, () => [[ligne], []]],
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[], []]],
    [INSERT_ASSET_RE, () => [{ insertId: 11 }, []]],
    [INSERT_STICKER_RE, () => [{ insertId: 21 }, []]],
    [UPDATE_KEY_RE, () => [{ affectedRows: 1 }, []]],
  ];
  for (const ligne of [
    ligneAsset({ asset_owner: 7, sticker_id: null, visibility: null, pack_status: null }), // propriétaire
    ligneAsset(), // officiel publié
    ligneAsset({ asset_owner: 9, visibility: 1, pack_owner: 9, partage_conv: 1 }), // co-participant
  ]) {
    videStockage();
    const r = await sp.copierAssetRecu({ alanyaID: 7, assetId: 5 }, base(handlers(ligne)));
    assert.deepStrictEqual(r, { assetId: 11, stickerId: 21, packId: 3, reutilise: false, copie: true });
    assert.strictEqual(stockage.copies.length, 2);
  }
});

test('copierAssetRecu : actif inaccessible = 404 AVANT toute lecture de la source ou copie', async () => {
  videStockage();
  for (const lignes of [
    [], // inexistant
    [ligneAsset({ asset_owner: 9, visibility: 1, pack_owner: 9, partage_conv: 0 })], // privé d'un autre
    [ligneAsset({ asset_owner: 9, visibility: 1, pack_owner: 9, pack_status: 0, partage_conv: 1 })], // brouillon
    [ligneAsset({ asset_status: 1 })], // retiré
  ]) {
    const d = accesAsset(lignes);
    await attendErreur(() => sp.copierAssetRecu({ alanyaID: 7, assetId: 5 }, d), NOT_FOUND);
    assert.strictEqual(stockage.copies.length, 0);
    assert.ok(!d.requetes.some(([q]) => SRC_ASSET_RE.test(q) || INSERT_ASSET_RE.test(q)), 'rien lu ni écrit au-delà du refus');
  }
});

test('copierAssetRecu : pack Plus sans droit = SUBSCRIPTION_REQUIRED, mon propre actif jamais', async () => {
  videStockage();
  const handlers = (ligne) => [
    [ASSET_ACCES_RE, () => [[ligne], []]],
    [SRC_ASSET_RE, () => [[sourceCopiable()], []]],
    [BLOCKLIST_RE, () => [[], []]],
    [PACK_DEFAUT_RE, () => [[{ id: 3, code: 'u_7_x' }], []]],
    [COUNT_STICKER_RE, () => [[{ n: 0 }], []]],
    [OWNED_SHA_RE, () => [[{ id: 4 }], []]],
    [INSERT_STICKER_RE, () => [{ insertId: 22 }, []]],
  ];
  const non = { droits: async () => ({ features: { stickers_premium: false } }) };
  const e = await attendErreur(() => sp.copierAssetRecu(
    { alanyaID: 7, assetId: 5 }, base(handlers(ligneAsset({ is_premium: 1 }))), non), 'SUBSCRIPTION_REQUIRED');
  assert.deepStrictEqual([e.status, e.feature], [403, 'stickers_premium']);
  // Mon propre actif : aucun contrôle de droits.
  const r = await sp.copierAssetRecu({ alanyaID: 7, assetId: 5 },
    base(handlers(ligneAsset({ asset_owner: 7, is_premium: 1 }))), non);
  assert.strictEqual(r.reutilise, true);
  // Droits illisibles ou « oui » : ouvert.
  for (const droits of [async () => null, async () => { throw new Error('x'); }]) {
    const r2 = await sp.copierAssetRecu({ alanyaID: 7, assetId: 5 }, base(handlers(ligneAsset({ is_premium: 1 }))), { droits });
    assert.strictEqual(r2.reutilise, true);
  }
});

test('signalerAssetRecu : accès légitime signale, idempotent ; l\'accès précède le motif', async () => {
  const h = (ligne, deja) => [
    [ASSET_ACCES_RE, () => [[ligne], []]],
    [REPORT_ASSET_RE, () => [[{ id: 5, owner_id: ligne.asset_owner, status: 0 }], []]],
    [REPORT_DEJA_RE, () => [deja ? [{ id: 1 }] : [], []]],
    [INSERT_REPORT_RE, () => [{ insertId: 1 }, []]],
  ];
  const d = base(h(ligneAsset({ asset_owner: 9, visibility: 1, pack_owner: 9, partage_conv: 1 }), false));
  assert.deepStrictEqual(await sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason: 'spam' }, d), { ok: true, deja: false });
  assert.deepStrictEqual(d.requetes.find(([q]) => INSERT_REPORT_RE.test(q))[1], [5, 7, 1]);
  const d2 = base(h(ligneAsset(), true));
  assert.deepStrictEqual(await sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason: 'spam' }, d2), { ok: true, deja: true });
  assert.ok(!d2.requetes.some(([q]) => INSERT_REPORT_RE.test(q)), 'aucun doublon');
  // Actif d'un autre compte (privé) : 404 même avec un motif invalide ; rien n'est écrit.
  for (const reason of ['spam', 'zzz', undefined]) {
    const d3 = base(h(ligneAsset({ asset_owner: 9, visibility: 1, pack_owner: 9, partage_conv: 0 }), false));
    await attendErreur(() => sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason }, d3), NOT_FOUND);
    assert.ok(!d3.requetes.some(([q]) => INSERT_REPORT_RE.test(q) || REPORT_ASSET_RE.test(q)), 'rien écrit ni lu au-delà');
  }
  // Inexistant et retiré : même 404.
  await attendErreur(() => sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason: 'spam' }, accesAsset([])), NOT_FOUND);
  await attendErreur(() => sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason: 'spam' },
    accesAsset([ligneAsset({ asset_status: 1 })])), NOT_FOUND);
  // Mon propre actif : accès accordé, puis refus habituel de se signaler soi-même.
  await attendErreur(() => sp.signalerAssetRecu({ alanyaID: 7, assetId: 5, reason: 'spam' },
    base(h(ligneAsset({ asset_owner: 7 }), false))), 'STICKER_INVALID_PAYLOAD');
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
