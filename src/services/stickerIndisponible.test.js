/**
 * Pack officiel ARCHIVÉ = « indisponible » (A14) — matrice complète.
 * `node src/services/stickerIndisponible.test.js`
 *
 * Règle : un pack officiel archivé (`status = 2`) reste AFFICHABLE dans les
 * anciens messages (`mediaUrl` recopiée, fichier conservé) mais disparaît de
 * toutes les listes et n'est plus utilisable : catalogue, /me, lecture du pack,
 * installation, envoi, transfert, copie, signalement, page /s/. Republié
 * (`status = 1`), il redevient disponible partout. Un brouillon ne l'est jamais.
 *
 * Tout est doublé (aucune base, aucun stockage, aucun réseau) : les surfaces sont
 * les VRAIES fonctions, la base est un double qui applique le filtre de statut
 * dont le SQL porte la clause. Ce test éprouve donc le routage des règles et le
 * texte/paramètres des requêtes ; leur exécution SQL réelle relève de
 * `stickerStore.db.test.js` (hors CI).
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const stockage = { retires: [], copies: [] };
remplace('../config/db', { execute: async () => [[], []], getConnection: async () => { throw new Error('pas de transaction ici'); } });
remplace('./mediaStorage', {
  publicUrl: (k) => (k ? `https://cdn.test/${k}` : null),
  personalStickerKey: () => 'x',
  putBody: async () => {},
  copyObject: async (a, b) => { stockage.copies.push([a, b]); },
  removeAllVersions: async (k) => { stockage.retires.push(k); },
});
remplace('../middleware/auth', (req, res, next) => next());
const droits = { features: {} };
remplace('./billing/entitlements', { entitlementsOrNull: async () => droits });

const store = require('./stickerStore');
const sp = require('./stickerPersonalService');
const pack = require('./stickerPackService');
const { prepareStickerMessage, resolveStickerFields, champsDeTransfert } = require('../utils/stickerMessage');

const BROUILLON = 0;
const PUBLIE = 1;
const ARCHIVE = 2;
const DISPONIBLE = { [BROUILLON]: false, [PUBLIE]: true, [ARCHIVE]: false };

let ok = 0;
const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

// ── Base doublée : applique le filtre `p.status = ?` quand le SQL le porte ──
function baseStore(statut) {
  const requetes = [];
  return {
    requetes,
    async execute(sql, params) {
      requetes.push([sql, params]);
      const filtre = /p\.status = \?/.test(sql) ? params[params.length - 1] : null;
      const visible = filtre === null || filtre === statut;
      if (/FROM user_sticker_pack u JOIN sticker_pack p/.test(sql)) {
        return [visible ? [{ id: 1, code: 'royal', position: 0 }] : [], []];
      }
      if (/FROM user_sticker_favorite f/.test(sql)) {
        return [visible ? [{ sticker_id: 10 }] : [], []];
      }
      if (/GREATEST/.test(sql)) return [[{ version: 1 }], []];
      if (/FROM sticker_pack p\s+WHERE p\.visibility = \? AND p\.status = \?/.test(sql)) {
        return [visible ? [{ id: 1, code: 'royal' }] : [], []];
      }
      if (/COALESCE\(MAX/.test(sql)) return [[{ version: 1 }], []];
      if (/FROM sticker s\s+JOIN sticker_pack p/.test(sql) && /p\.status = \?/.test(sql)) {
        return [visible ? [{ id: 10 }] : [], []];
      }
      return [[], []];
    },
  };
}

const ligneEnvoi = (statut, over = {}) => ({
  sid: 10, emoji: '👑', pack_id: 1, pack_code: 'royal', is_premium: 0, visibility: 0,
  pack_status: statut, asset_status: 0, storage_key: 'official/stickers/royal/10_ab12cd34.webp',
  width: 512, height: 512, animated: 0, installed: 1, owner_id: null, ...over,
});
const depsEnvoi = (statut, over = {}) => ({
  ouvert: async () => true,
  chargeSticker: async () => ligneEnvoi(statut, over),
  droits: async () => null,
  urlDe: (k) => `https://cdn.test/${k}`,
});
const CONTENT = JSON.stringify({ v: 1, pack: 'royal', sid: 10, emoji: '👑', w: 512, h: 512, a: 0 });

const refuse = async (fn, code) => {
  try { await fn(); } catch (e) {
    assert.strictEqual(e.code, code, `code attendu ${code}, reçu ${e.code}`);
    return e;
  }
  throw new Error(`aurait dû lever ${code}`);
};

/** Contrôleur réel, store doublé par statut (lecture d'un pack, installation). */
function appelController(nom, { statut, installed = 0, params = {} }) {
  const ecrit = [];
  remplace('./stickerStore', {
    ...store,
    chargePackParCode: async () => ({ id: 1, code: 'royal', is_premium: 0, visibility: 0, status: statut, installed, name_i18n: { fr: 'Royal' }, version: 1 }),
    chargePackParId: async () => ({ id: 1, code: 'royal', is_premium: 0, visibility: 0, status: statut, installed }),
    listeStickersDuPack: async () => [],
    compteInstalles: async () => 0,
    installerPack: async () => { ecrit.push('installerPack'); },
  });
  delete require.cache[resolu('../controllers/stickerController')];
  const ctrl = require('../controllers/stickerController');
  return new Promise((resolve) => {
    const res = {
      statut: 200,
      set() { return res; },
      status(s) { res.statut = s; return res; },
      json(c) { resolve({ statut: res.statut, corps: c, ecrit }); return res; },
      end() { resolve({ statut: res.statut, corps: null, ecrit }); return res; },
    };
    ctrl[nom]({ params, headers: {}, user: { alanyaID: 7 }, app: { get: () => null } }, res);
  });
}

for (const statut of [BROUILLON, PUBLIE, ARCHIVE]) {
  const libelle = { [BROUILLON]: 'brouillon', [PUBLIE]: 'publié', [ARCHIVE]: 'ARCHIVÉ' }[statut];
  const dispo = DISPONIBLE[statut];

  test(`[${libelle}] catalogue : ${dispo ? 'listé' : 'absent'}`, async () => {
    const { packs } = await store.listeCatalogue(baseStore(statut));
    assert.strictEqual(packs.length, dispo ? 1 : 0);
  });

  test(`[${libelle}] /me : pack installé et favoris ${dispo ? 'renvoyés' : 'NON renvoyés'}`, async () => {
    const d = baseStore(statut);
    const moi = await store.chargeMoi(7, d);
    assert.strictEqual(moi.packs.length, dispo ? 1 : 0, 'packs installés');
    assert.deepStrictEqual(moi.favorites, dispo ? [10] : [], 'favoris');
    assert.ok(d.requetes.every(([s]) => /^\s*SELECT/i.test(s)), 'lecture seule : l\'installation reste en base (republication)');
  });

  test(`[${libelle}] favori : sticker ${dispo ? 'favorisable' : 'introuvable'}`, async () => {
    const r = await store.chargeStickerFavorisable(10, baseStore(statut));
    assert.strictEqual(Boolean(r), dispo);
  });

  test(`[${libelle}] GET /packs/:code : ${dispo ? '200' : '404 STICKER_PACK_UNAVAILABLE'} (installé ou non)`, async () => {
    for (const installed of [0, 1]) {
      const r = await appelController('getPack', { statut, installed, params: { code: 'royal' } });
      if (dispo) assert.strictEqual(r.statut, 200);
      else assert.deepStrictEqual([r.statut, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);
    }
  });

  test(`[${libelle}] PUT /me/packs/:id (installer) : ${dispo ? '204' : 'refusé 404 STICKER_PACK_UNAVAILABLE'}`, async () => {
    const r = await appelController('putMyPack', { statut, installed: 0, params: { id: '1' } });
    if (dispo) {
      assert.strictEqual(r.statut, 204);
      assert.deepStrictEqual(r.ecrit, ['installerPack']);
    } else {
      assert.deepStrictEqual([r.statut, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);
      assert.deepStrictEqual(r.ecrit, [], 'rien installé');
    }
  });

  test(`[${libelle}] envoi (installé ou non) : ${dispo ? 'accepté' : 'STICKER_PACK_UNAVAILABLE'}`, async () => {
    for (const installed of [0, 1]) {
      const p = prepareStickerMessage({ content: CONTENT, senderID: 7 }, depsEnvoi(statut, { installed }));
      if (dispo) {
        const r = await p;
        assert.match(r.mediaUrl, /official\/stickers\/royal\/10_ab12cd34\.webp$/);
      } else {
        await refuse(() => p, 'STICKER_PACK_UNAVAILABLE');
      }
    }
  });

  test(`[${libelle}] transfert (référence) : ${dispo ? 'accepté' : 'STICKER_PACK_UNAVAILABLE, message source intact'}`, async () => {
    const source = Object.freeze({ type: 10, content: CONTENT, mediaUrl: 'https://cdn.test/official/stickers/royal/10_ab12cd34.webp' });
    const { content, copie } = champsDeTransfert(source, 0, '');
    assert.strictEqual(copie, false, 'jamais de copie de fichier');
    const p = resolveStickerFields({ type: source.type, content, senderID: 7 }, depsEnvoi(statut));
    if (dispo) assert.ok(await p);
    else await refuse(() => p, 'STICKER_PACK_UNAVAILABLE');
    assert.strictEqual(source.mediaUrl, 'https://cdn.test/official/stickers/royal/10_ab12cd34.webp', 'ancien message inchangé');
  });

  const ligneRecue = { id: 10, asset_id: 5, emoji: '👑', visibility: 0, pack_status: statut, pack_owner: null, is_premium: 0, asset_status: 0, partage_conv: 0 };
  const ligneAsset = { asset_id: 5, asset_owner: 0, asset_status: 0, sticker_id: 10, visibility: 0, pack_status: statut, pack_owner: null, is_premium: 0, partage_conv: 0 };

  test(`[${libelle}] copie (sid et assetId) et signalement : ${dispo ? 'permis' : 'STICKER_NOT_FOUND uniforme'}`, async () => {
    const parSid = { execute: async () => [[ligneRecue], []] };
    const parAsset = { execute: async () => [[ligneAsset], []] };
    for (const [nom, fn] of [
      ['resoudreStickerRecu (copie/signalement par sid)', () => sp.resoudreStickerRecu(7, 10, parSid)],
      ['resoudreAssetRecu (copie/signalement legacy)', () => sp.resoudreAssetRecu(7, 5, parAsset)],
    ]) {
      if (dispo) assert.ok(await fn(), nom);
      else {
        const e = await refuse(fn, 'STICKER_NOT_FOUND');
        assert.strictEqual(e.status, 404, nom);
      }
    }
    assert.strictEqual(stockage.copies.length, 0, 'aucun fichier copié par la seule résolution');
  });

  test(`[${libelle}] page /s/ : un pack officiel n'a jamais de jeton, la requête exige lien + publié`, async () => {
    const requetes = [];
    const d = { execute: async (sql, params) => { requetes.push([sql, params]); return [[], []]; } };
    assert.strictEqual(await pack.apercuPartagePublic('A'.repeat(24), d), null);
    assert.match(requetes[0][0], /p\.share_token = \? AND p\.visibility = \? AND p\.status = \?/);
    assert.deepStrictEqual(requetes[0][1], ['A'.repeat(24), sp.VISIBILITE_LIEN, sp.STATUT_PUBLIE]);
  });
}

test('republication : archivé → publié, tout redevient disponible sans nouvelle action de l\'utilisateur', async () => {
  // Même compte, même installation (jamais supprimée), seul `status` change.
  const avant = await store.chargeMoi(7, baseStore(ARCHIVE));
  const apres = await store.chargeMoi(7, baseStore(PUBLIE));
  assert.deepStrictEqual([avant.packs.length, avant.favorites.length], [0, 0]);
  assert.deepStrictEqual([apres.packs.length, apres.favorites.length], [1, 1]);
  await refuse(() => prepareStickerMessage({ content: CONTENT, senderID: 7 }, depsEnvoi(ARCHIVE)), 'STICKER_PACK_UNAVAILABLE');
  assert.ok(await prepareStickerMessage({ content: CONTENT, senderID: 7 }, depsEnvoi(PUBLIE)));
});

test('archivage admin d\'un pack officiel : un seul UPDATE du statut — aucun message, sticker, actif, installation ni fichier touché', async () => {
  stockage.retires.length = 0;
  remplace('./stickerSettingsService', { getStickerSettings: async () => ({}), invalidateStickerSettings: () => {} });
  remplace('./stickerAssetService', {});
  delete require.cache[resolu('./stickerAdminService')];
  const admin = require('./stickerAdminService');
  const requetes = [];
  const d = {
    async execute(sql, params) {
      requetes.push([sql, params]);
      if (/FROM sticker_pack p[\s\S]*WHERE p\.id = \?/i.test(sql)) return [[{ id: 1, code: 'royal', status: 1, name_i18n: '{}' }], []];
      return [[], []];
    },
  };
  const r = await admin.archivePack(1, d);
  assert.strictEqual(r.status, ARCHIVE);
  const ecritures = requetes.filter(([s]) => /^\s*(UPDATE|DELETE|INSERT)/i.test(s));
  assert.strictEqual(ecritures.length, 1);
  assert.match(ecritures[0][0], /^\s*UPDATE sticker_pack SET status = \?, version = version \+ 1 WHERE id = \?/);
  assert.deepStrictEqual(ecritures[0][1], [ARCHIVE, 1]);
  assert.deepStrictEqual(stockage.retires, [], 'aucun fichier supprimé');
});

(async () => {
  for (const [nom, fn] of tests) {
    try { await fn(); ok += 1; } catch (e) { console.error(`✗ ${nom}\n  ${e.stack}`); process.exitCode = 1; }
  }
  console.log(`stickerIndisponible.test.js : ${ok}/${tests.length} tests OK`);
})();
