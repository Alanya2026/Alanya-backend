/**
 * Service du back-office stickers (T2) — `node src/services/stickerAdmin.test.js`.
 *
 * Règles tenues par le service, pas par la route :
 *   - la liste de contrôle de publication (noms FR+EN, icône, ≥ 8 stickers) ;
 *   - un pack publié/archivé ne se réécrit pas sticker à sticker (on archive) ;
 *   - 40 stickers maximum par pack (comme `uploadSticker`) ;
 *   - les colonnes de cohorte de la migration 097 sont ignorées (inertes).
 *
 * Base, stockage et pipeline d'upload sont doublés : aucune dépendance externe.
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

/** Base doublée : on répond aux requêtes reconnues, sinon `[[], []]`. */
function db(handlers) {
  return {
    requetes: [],
    async execute(sql, params) {
      this.requetes.push([sql, params]);
      for (const [re, fn] of handlers) if (re.test(sql)) return fn(sql, params);
      return [[], []];
    },
  };
}

(async () => {
  remplace('./stickerAssetService', {
    creerStickerOfficiel: async ({ position }) => ({ stickerId: 1000 + position, reutilise: false, bytes: 4096 }),
  });
  const retraits = [];
  remplace('./mediaStorage', { publicUrl: (k) => (k ? `https://cdn.test/${k}` : null), removeAllVersions: async (k) => { retraits.push(k); } });
  remplace('./stickerSettingsService', {
    getStickerSettings: async () => ({ id: 1, enabled: 0, creation_enabled: 0, animated_enabled: 0 }),
    invalidateStickerSettings: () => {},
  });

  const admin = require('./stickerAdminService');
  const { StickerAdminError } = admin;

  const attendErreur = async (fn, code) => {
    try {
      await fn();
    } catch (e) {
      assert.ok(e instanceof StickerAdminError, `erreur inattendue : ${e.message}`);
      assert.strictEqual(e.code, code, `code attendu ${code}, reçu ${e.code}`);
      return e;
    }
    throw new Error(`aurait dû lever ${code}`);
  };

  const PACK_RE = /FROM sticker_pack p[\s\S]*WHERE p\.id = \?/i;
  const STICKERS_RE = /SELECT s\.id, s\.position[\s\S]*WHERE s\.pack_id = \?/i;
  const COUNT_RE = /SELECT COUNT\(\*\) AS n FROM sticker s JOIN sticker_asset a/i;
  const COUNT_PACK_RE = /SELECT COUNT\(\*\) AS n FROM sticker WHERE pack_id/i;

  test('slugifier : accents, espaces et ponctuation', () => {
    assert.strictEqual(admin.slugifier('Pack Mboa !'), 'pack_mboa');
    assert.strictEqual(admin.slugifier('Été 2026'), 'ete_2026');
  });

  test('createPack refuse un name_i18n sans fr', async () => {
    const d = db([]);
    const e = await attendErreur(() => admin.createPack({ name_i18n: { en: 'Mboa' } }, { by: 1 }, d), 'STICKER_INVALID_PAYLOAD');
    assert.ok(/fr/.test(e.message));
  });

  test('createPack dérive un code unique', async () => {
    const d = db([
      [/SELECT 1 FROM sticker_pack WHERE code = \?/i, () => [[{ 1: 1 }], []]], // 'mboa' pris
      [/INSERT INTO sticker_pack/i, () => [{ insertId: 7 }, []]],
    ]);
    // Première vérif 'mboa' prise, la boucle passe à 'mboa_2' : libre.
    let appel = 0;
    d.execute = async function (sql, params) {
      this.requetes.push([sql, params]);
      if (/SELECT 1 FROM sticker_pack WHERE code = \?/i.test(sql)) {
        appel += 1;
        return appel === 1 ? [[{ 1: 1 }], []] : [[], []];
      }
      if (/INSERT INTO sticker_pack/i.test(sql)) return [{ insertId: 7 }, []];
      return [[], []];
    };
    const r = await admin.createPack({ name_i18n: { fr: 'Mboa' } }, { by: 2 }, d);
    assert.strictEqual(r.code, 'mboa_2');
    assert.strictEqual(r.id, 7);
  });

  test('publishPack : liste de contrôle incomplète', async () => {
    const d = db([
      [PACK_RE, () => [[{ id: 1, code: 'mboa', status: 0, name_i18n: JSON.stringify({ fr: 'Mboa' }), cover_sticker_id: null }], []]],
      [STICKERS_RE, () => [[], []]],
      [COUNT_RE, () => [[{ n: 3 }], []]],
    ]);
    const e = await attendErreur(() => admin.publishPack(1, d), 'STICKER_PACK_INCOMPLETE');
    assert.deepStrictEqual(e.missing, ['name_i18n.en', 'cover_sticker_id', 'stickers>=8']);
  });

  test('publishPack : complet → publie', async () => {
    const d = db([
      [PACK_RE, () => [[{ id: 1, code: 'mboa', status: 0, name_i18n: JSON.stringify({ fr: 'Mboa', en: 'Mboa' }), cover_sticker_id: 5 }], []]],
      [STICKERS_RE, () => [[], []]],
      [COUNT_RE, () => [[{ n: 8 }], []]],
    ]);
    const r = await admin.publishPack(1, d);
    assert.strictEqual(r.status, admin.STATUT.PUBLIE);
    assert.ok(d.requetes.some(([sql]) => /UPDATE sticker_pack[\s\S]*SET status = \?/i.test(sql)));
  });

  const STICKER_PACK_RE = /FROM sticker s JOIN sticker_pack p[\s\S]*WHERE s\.id = \?/i;

  test('updateSticker refuse un pack publié', async () => {
    const d = db([[STICKER_PACK_RE, () => [[{ id: 9, pack_id: 1, asset_id: 3, status: 1 }], []]]]);
    await attendErreur(() => admin.updateSticker(9, { emoji: '🙂' }, d), 'STICKER_PACK_PUBLISHED');
  });

  test('deleteSticker refuse un pack publié', async () => {
    const d = db([[STICKER_PACK_RE, () => [[{ id: 9, pack_id: 1, asset_id: 3, status: 2 }], []]]]);
    await attendErreur(() => admin.deleteSticker(9, d), 'STICKER_PACK_PUBLISHED');
  });

  test('deleteSticker (brouillon) : lignes supprimées, AUCUN fichier effacé (A13)', async () => {
    retraits.length = 0;
    const d = db([
      [STICKER_PACK_RE, () => [[{ id: 9, pack_id: 1, asset_id: 3, status: 0 }], []]],
      [/SELECT COUNT\(\*\) AS n FROM sticker WHERE asset_id/i, () => [[{ n: 0 }], []]],
    ]);
    await admin.deleteSticker(9, d);
    assert.ok(d.requetes.some(([s]) => /DELETE FROM sticker WHERE id/i.test(s)));
    assert.ok(d.requetes.some(([s]) => /DELETE FROM sticker_asset WHERE id/i.test(s)), 'ligne d\'actif orphelin supprimée');
    assert.deepStrictEqual(retraits, [], 'aucun fichier supprimé');
    assert.ok(!d.requetes.some(([s]) => /storage_key/i.test(s)), 'les clés de fichier ne sont même pas lues');
  });

  test('addStickers refuse au-delà de 40 par pack', async () => {
    const d = db([
      [PACK_RE, () => [[{ id: 1, code: 'mboa', status: 0, cover_sticker_id: 5, name_i18n: '{}' }], []]],
      [STICKERS_RE, () => [[], []]],
      [COUNT_PACK_RE, () => [[{ n: 39 }], []]],
    ]);
    const entrees = [{ buffer: Buffer.from('a'), emoji: '🙂' }, { buffer: Buffer.from('b'), emoji: '😀' }];
    await attendErreur(() => admin.addStickers(1, entrees, d), 'STICKER_PACK_LIMIT');
  });

  test('addStickers pose les positions à la suite', async () => {
    const d = db([
      [PACK_RE, () => [[{ id: 1, code: 'mboa', status: 0, cover_sticker_id: 5, name_i18n: '{}' }], []]],
      [STICKERS_RE, () => [[], []]],
      [COUNT_PACK_RE, () => [[{ n: 2 }], []]],
      [/SELECT COALESCE\(MAX\(position\)/i, () => [[{ p: 4 }], []]],
    ]);
    const crees = await admin.addStickers(1, [{ buffer: Buffer.from('a'), emoji: '🙂' }], d);
    assert.strictEqual(crees[0].position, 5);
  });

  test('updateSettings écrit les champs, retour en camelCase', async () => {
    const d = db([[/UPDATE sticker_settings/i, () => [{ affectedRows: 1 }, []]]]);
    const r = await admin.updateSettings({ enabled: true, min_app_version: '3.4.0' }, { by: 1 }, d);
    const [sql, params] = d.requetes.find(([s]) => /UPDATE sticker_settings/i.test(s));
    assert.match(sql, /enabled = \?/);
    assert.match(sql, /min_app_version = \?/);
    assert.deepStrictEqual(params.slice(0, 2), [1, '3.4.0']);
    assert.ok('creationEnabled' in r && 'minAppVersion' in r, 'retour camelCase');
  });

  test('updateSettings ignore les colonnes de cohorte (inertes)', async () => {
    const d = db([]);
    const r = await admin.updateSettings({ cohort_percent: 150, cohort_ids: [1, 2] }, { by: 1 }, d);
    assert.strictEqual(d.requetes.some(([sql]) => /UPDATE sticker_settings/i.test(sql)), false, 'aucune écriture');
    assert.ok('enabled' in r, 'retour = relecture des réglages');
  });

  test('takedownAsset retire ET bloque l\'empreinte', async () => {
    const sha = 'a'.repeat(64);
    const d = db([[/SELECT id, sha256 FROM sticker_asset WHERE id = \?/i, () => [[{ id: 3, sha256: sha }], []]]]);
    await admin.takedownAsset(3, { by: 42 }, d);
    assert.ok(d.requetes.some(([s]) => /UPDATE sticker_asset SET status = 1/i.test(s)));
    const blocage = d.requetes.find(([s]) => /INSERT IGNORE INTO sticker_blocklist/i.test(s));
    assert.ok(blocage, 'empreinte bloquée');
    assert.deepStrictEqual(blocage[1], [sha, 'retrait admin', 42]);
  });

  test('takedownAsset : actif inconnu → 404', async () => {
    const d = db([[/SELECT id, sha256 FROM sticker_asset WHERE id = \?/i, () => [[], []]]]);
    await attendErreur(() => admin.takedownAsset(999, {}, d), 'STICKER_NOT_FOUND');
  });

  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`stickerAdmin.test.js : ${ok} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
