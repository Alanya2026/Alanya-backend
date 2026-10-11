/**
 * Requêtes de lecture du store stickers — `node src/services/stickerStore.test.js`.
 *
 * SANS base (CI) : `db.execute` est un double qui journalise le SQL et ses
 * paramètres, et rend des lignes préparées. Ce test éprouve donc le TEXTE des
 * requêtes et leurs paramètres (le filtre « pack officiel archivé = indisponible »,
 * A14), pas leur exécution : celle-ci relève de `stickerStore.db.test.js`
 * (hors CI, migration 097 requise).
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
require.cache[resolu('../config/db')] = {
  id: resolu('../config/db'), filename: resolu('../config/db'), loaded: true,
  exports: { execute: async () => [[], []] },
};

const store = require('./stickerStore');

let ok = 0;
const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

function base(reponses = []) {
  const requetes = [];
  return {
    requetes,
    async execute(sql, params) {
      requetes.push([sql, params]);
      for (const [re, rows] of reponses) if (re.test(sql)) return [rows, []];
      return [[], []];
    },
  };
}
const PACKS_RE = /FROM user_sticker_pack u JOIN sticker_pack p/;
const FAV_RE = /FROM user_sticker_favorite f/;
const VERSION_RE = /GREATEST/;

test('chargeMoi : les packs installés sont filtrés sur status = publié (archivé = indisponible)', async () => {
  const d = base([[PACKS_RE, [{ id: 1, code: 'alanya', position: 0 }]], [VERSION_RE, [{ version: 5 }]]]);
  const r = await store.chargeMoi(7, d);
  const [sql, params] = d.requetes.find(([s]) => PACKS_RE.test(s));
  assert.match(sql, /p\.visibility = \?\s+AND p\.status = \?/);
  assert.deepStrictEqual(params, [7, 0, store.STATUS_PUBLIE]);
  assert.notStrictEqual(store.STATUS_PUBLIE, store.STATUS_ARCHIVE);
  assert.deepStrictEqual(r.packs, [{ id: 1, code: 'alanya', position: 0 }]);
});

test('chargeMoi : les favoris d\'un pack archivé ne sont plus renvoyés (jointure sur le pack, publié)', async () => {
  const d = base([[FAV_RE, [{ sticker_id: 4 }, { sticker_id: 9 }]], [VERSION_RE, [{ version: 5 }]]]);
  const r = await store.chargeMoi(7, d);
  const [sql, params] = d.requetes.find(([s]) => FAV_RE.test(s));
  assert.match(sql, /JOIN sticker_pack p ON p\.id = s\.pack_id/);
  assert.match(sql, /a\.status = 0 AND p\.status = \?/);
  assert.deepStrictEqual(params, [7, store.STATUS_PUBLIE]);
  assert.deepStrictEqual(r.favorites, [4, 9]);
});

test('chargeMoi : ne supprime ni ne modifie rien (lecture seule : la ligne d\'installation reste pour une republication)', async () => {
  const d = base([[VERSION_RE, [{ version: 0 }]]]);
  await store.chargeMoi(7, d);
  assert.ok(d.requetes.every(([sql]) => /^\s*SELECT/i.test(sql)), 'SELECT seulement');
});

test('chargeStickerFavorisable : pack officiel PUBLIÉ seulement', async () => {
  const d = base([[/FROM sticker s/, [{ id: 3 }]]]);
  await store.chargeStickerFavorisable(3, d);
  const [sql, params] = d.requetes[0];
  assert.match(sql, /p\.visibility = \? AND p\.status = \?/);
  assert.doesNotMatch(sql, /status IN/);
  assert.deepStrictEqual(params, [3, 0, store.STATUS_PUBLIE]);
});

test('listeCatalogue : packs officiels PUBLIÉS seulement', async () => {
  const d = base([[/COALESCE\(MAX/, [{ version: 9 }]]]);
  await store.listeCatalogue(d);
  const [sql, params] = d.requetes[0];
  assert.match(sql, /WHERE p\.visibility = \? AND p\.status = \?/);
  assert.deepStrictEqual(params, [0, store.STATUS_PUBLIE]);
});

test('V1c : catalogue et favoris — animés exclus par défaut (fragments constants), inclus sur demande', async () => {
  const d1 = base([[/COALESCE\(MAX/, [{ version: 9 }]]]);
  await store.listeCatalogue(d1);
  const [ferme, pf] = d1.requetes[0];
  assert.match(ferme, /a\.status = 0 AND a\.animated = 0\) AS count/, 'compteur sans animés');
  assert.match(ferme, /ca\.status = 0 AND ca\.animated = 0\s+ORDER BY/, 'couverture jamais un animé');
  assert.deepStrictEqual(pf, [0, store.STATUS_PUBLIE], 'paramètres inchangés');
  const d2 = base([[/COALESCE\(MAX/, [{ version: 9 }]]]);
  await store.listeCatalogue(d2, { animes: true });
  assert.doesNotMatch(d2.requetes[0][0], /animated/, 'animés ouverts : aucun filtre');

  const d3 = base([[VERSION_RE, [{ version: 1 }]]]);
  await store.chargeMoi(7, d3);
  const [favFerme, pm] = d3.requetes.find(([sql]) => FAV_RE.test(sql));
  assert.match(favFerme, /AND p\.status = \? AND a\.animated = 0/);
  assert.deepStrictEqual(pm, [7, store.STATUS_PUBLIE]);
  const d4 = base([[VERSION_RE, [{ version: 1 }]]]);
  await store.chargeMoi(7, d4, { animes: true });
  assert.doesNotMatch(d4.requetes.find(([sql]) => FAV_RE.test(sql))[0], /animated/);
});

test('chargeStickerPourEnvoi : rend le statut du pack (la décision est dans stickerMessage)', async () => {
  const d = base([[/FROM sticker s/, [{ sid: 1, pack_status: 2 }]]]);
  const r = await store.chargeStickerPourEnvoi(1, 7, d);
  assert.match(d.requetes[0][0], /p\.status AS pack_status/);
  assert.strictEqual(r.pack_status, 2, 'le store ne filtre pas : l\'envoi refuse lui-même (STICKER_PACK_UNAVAILABLE)');
});

(async () => {
  for (const [nom, fn] of tests) {
    try { await fn(); ok += 1; } catch (e) { console.error(`✗ ${nom}\n  ${e.stack}`); process.exitCode = 1; }
  }
  console.log(`stickerStore.test.js : ${ok} tests OK`);
})();
