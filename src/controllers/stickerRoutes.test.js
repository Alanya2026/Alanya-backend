/**
 * Routes `/api/stickers/*` — `node src/controllers/stickerRoutes.test.js`.
 *
 * Vrai Express, vrai routeur, vrai contrôleur et vraie garde ; seuls l'accès à
 * la base (`config/db`, `stickerStore`), l'authentification et les droits sont
 * remplacés. Les requêtes SQL elles-mêmes relèvent de `stickerStore.db.test.js`.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

// ── Doubles ────────────────────────────────────────────────────────────────
const etat = {
  reglages: { enabled: 1 },
  droits: null, // null = droits illisibles
  appels: [],
  pack: null,
  packParCode: null,
  catalogue: { packs: [], version: 3 },
  stickers: [],
  moi: { packs: [], favorites: [], version: 0 },
  installes: 0,
  favorisable: { id: 1 },
  panne: false,
};
const trace = (nom) => async (...a) => {
  etat.appels.push([nom, ...a.filter((x) => typeof x !== 'object' || x === null)]);
  if (etat.panne) throw Object.assign(new Error('ER_NO_SUCH_TABLE: talky.sticker'), { code: 'ER_NO_SUCH_TABLE' });
};

remplace('../config/db', {
  execute: async (sql) => {
    if (/sticker_settings/.test(sql)) return [[etat.reglages]];
    if (/user_settings/.test(sql)) return [[{ locale: 'zh' }]];
    return [[]];
  },
});
remplace('../middleware/auth', (req, res, next) => { req.user = { alanyaID: Number(req.headers['x-test-user'] || 7) }; next(); });
remplace('../services/billing/entitlements', { entitlementsOrNull: async () => etat.droits });
const store = {
  MAX_PACKS_INSTALLES: 50,
  chargeStickerPourEnvoi: async () => null,
  listeCatalogue: async (db, opts) => { await trace('listeCatalogue')(); etat.optsCatalogue = opts; return etat.catalogue; },
  chargePackParCode: async (...a) => { await trace('chargePackParCode')(...a); return etat.packParCode; },
  chargePackParId: async (...a) => { await trace('chargePackParId')(...a); return etat.pack; },
  listeStickersDuPack: async () => etat.stickers,
  chargeMoi: async (id, db, opts) => { await trace('chargeMoi')(); etat.optsMoi = opts; return etat.moi; },
  compteInstalles: async () => etat.installes,
  installerPack: trace('installerPack'),
  retirerPack: trace('retirerPack'),
  ordonnerPacks: async (id, ids) => { await trace('ordonnerPacks')(id); etat.ordre = ids; },
  chargeStickerFavorisable: async () => etat.favorisable,
  ajouterFavori: trace('ajouterFavori'),
  retirerFavori: trace('retirerFavori'),
};
remplace('../services/stickerStore', store);

const stickerSettings = require('../services/stickerSettingsService');
const router = require('../routes/stickers');

const emis = [];
const app = express();
app.use(express.json());
app.set('io', { to: (room) => ({ emit: (e, p) => emis.push([room, e, p]) }) });
app.use('/api/stickers', router);

const PACK_BASE = { id: 6, code: 'royal', is_premium: 1, visibility: 0, status: 1, installed: 0 };
const ligne = { id: 1, code: 'alanya', name_i18n: { fr: 'Alanya' }, description_i18n: null, is_premium: 0, version: 1, count: 1, cover_thumb_key: 'official/stickers/alanya/1_ab12cd34_t.webp' };

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}/api/stickers`;
  const appel = async (methode, chemin, { corps, entetes } = {}) => {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: { 'content-type': 'application/json', ...(entetes || {}) },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const texte = await r.text();
    return { status: r.status, headers: r.headers, corps: texte ? JSON.parse(texte) : null };
  };
  const reinit = (patch = {}) => {
    Object.assign(etat, {
      reglages: { enabled: 1 }, droits: null, appels: [], pack: { ...PACK_BASE },
      packParCode: null, catalogue: { packs: [ligne], version: 3 }, stickers: [], moi: { packs: [], favorites: [], version: 0 },
      installes: 0, favorisable: { id: 1 }, panne: false, ordre: null,
    }, patch);
    emis.length = 0;
    stickerSettings.invalidateStickerSettings();
  };

  try {
    // ── Fermé : 404 générique, la base n'est même pas interrogée ───────────
    for (const [reglages, libelle] of [
      [{ enabled: 0 }, 'enabled = 0'],
      [undefined, 'ligne absente'],
    ]) {
      reinit({ reglages });
      if (!reglages) etat.reglages = undefined;
      // ligne absente : le double rend [[undefined]] → `rows[0]` indéfini → défauts fermés
      for (const [m, c] of [['GET', '/catalog'], ['GET', '/packs/alanya'], ['GET', '/me'], ['PUT', '/me/packs/1'], ['DELETE', '/me/packs/1'], ['PUT', '/me/packs/order'], ['PUT', '/me/favorites/1'], ['DELETE', '/me/favorites/1']]) {
        const r = await appel(m, c, { corps: m === 'PUT' && c.endsWith('order') ? { ids: [1] } : undefined });
        assert.strictEqual(r.status, 404, `${libelle} ${m} ${c}`);
        assert.strictEqual(r.corps.code, 'NOT_FOUND', `${libelle} ${m} ${c} : aucun code spécifique aux stickers`);
      }
      assert.strictEqual(etat.appels.length, 0, `${libelle} : aucune lecture ni écriture`);
      assert.strictEqual(emis.length, 0);
    }

    // ── Catalogue : ETag / 304, langue, verrou ─────────────────────────────
    reinit({ catalogue: { packs: [ligne, { ...ligne, id: 6, code: 'royal', name_i18n: { fr: 'Royal' }, is_premium: 1 }], version: 3 } });
    let r = await appel('GET', '/catalog', { entetes: { 'accept-language': 'en' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corps.version, 3);
    assert.strictEqual(r.corps.packs[1].locked, false, 'droits illisibles : jamais verrouillé');
    const etag = r.headers.get('etag');
    assert.ok(etag, 'ETag');
    assert.match(r.headers.get('vary'), /Accept-Language/i);
    r = await appel('GET', '/catalog', { entetes: { 'if-none-match': etag } });
    assert.strictEqual(r.status, 304, 'inchangé : 304');
    etat.droits = { features: { stickers_premium: false } };
    r = await appel('GET', '/catalog', { entetes: { 'if-none-match': etag } });
    assert.strictEqual(r.status, 200, 'le verrou a changé : l\'ETag aussi');
    assert.strictEqual(r.corps.packs[1].locked, true);
    assert.strictEqual(r.corps.packs[0].locked, false);
    assert.notStrictEqual(r.headers.get('etag'), etag);
    // Langue du profil quand l'en-tête manque (`user_settings.locale` = zh → repli en → fr)
    r = await appel('GET', '/catalog');
    assert.strictEqual(r.corps.packs[0].name, 'Alanya');

    // ── Pack ───────────────────────────────────────────────────────────────
    reinit();
    r = await appel('GET', '/packs/inconnu');
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);
    for (const status of [0, 2]) {
      reinit({ packParCode: { ...PACK_BASE, status, installed: 0 } });
      r = await appel('GET', '/packs/royal');
      assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE'], `statut ${status} non installé`);
    }
    // Pack officiel archivé = « indisponible » (A14), installé ou non : 404 uniforme.
    reinit({ packParCode: { ...PACK_BASE, status: 2, installed: 1 }, stickers: [] });
    r = await appel('GET', '/packs/royal');
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE'], 'archivé MÊME installé : indisponible');
    // Republié (status 1) : redevient lisible.
    reinit({ packParCode: { ...PACK_BASE, status: 1, installed: 1 }, stickers: [] });
    assert.strictEqual((await appel('GET', '/packs/royal')).status, 200, 'republié : disponible');
    reinit({ packParCode: { ...PACK_BASE, name_i18n: { fr: 'Royal' } }, stickers: [{ id: 71, position: 0, emoji: '👑', name_i18n: { fr: 'Le roi' }, storage_key: 'official/stickers/royal/71_9f8e7d6c.webp', thumb_key: null, width: 512, height: 512, bytes: 24500, animated: 0 }] });
    r = await appel('GET', '/packs/royal');
    assert.strictEqual(r.corps.stickers[0].name, 'Le roi');
    assert.strictEqual(r.corps.stickers[0].animated, false);

    // ── /me ────────────────────────────────────────────────────────────────
    // ffmpeg n'est pas une donnée du test : on fixe `features.video` à la main.
    const stickerVideo = require(resolu('../utils/stickerVideo'));
    let videoDispo = false;
    stickerVideo.disponible = async () => videoDispo;
    reinit({ moi: { packs: [{ id: 1, code: 'alanya', position: 0 }], favorites: [1, 45], version: 12 } });
    r = await appel('GET', '/me');
    assert.deepStrictEqual(
      r.corps,
      { version: 12, packs: [{ id: 1, code: 'alanya', position: 0 }], favorites: [1, 45], features: { creation: false, animated: false, video: false } },
      'V1c : `features` additif ; tout fermé par défaut',
    );
    // Les champs historiques restent identiques à la fixture du contrat.
    const { features: _f, ...sansFeatures } = r.corps;
    assert.deepStrictEqual(Object.keys(sansFeatures), ['version', 'packs', 'favorites']);
    assert.deepStrictEqual(etat.optsMoi, { animes: false }, 'favoris animés omis tant que fermé');
    for (const [reglages, attendu] of [
      [{ enabled: 1, creation_enabled: 1, animated_enabled: 0 }, { creation: true, animated: false, video: false }],
      [{ enabled: 1, creation_enabled: 0, animated_enabled: 1 }, { creation: false, animated: true, video: false }],
      [{ enabled: 1, creation_enabled: 1, animated_enabled: 1 }, { creation: true, animated: true, video: false }],
    ]) {
      reinit({ reglages, moi: { packs: [], favorites: [], version: 1 } });
      r = await appel('GET', '/me');
      assert.deepStrictEqual(r.corps.features, attendu, JSON.stringify(reglages));
      assert.deepStrictEqual(etat.optsMoi, { animes: attendu.animated });
    }
    // V1c §4d : `features.video` = ffmpeg présent ET animés ouverts (sinon pas de sonde).
    videoDispo = true;
    for (const [reglages, video] of [
      [{ enabled: 1, creation_enabled: 1, animated_enabled: 1 }, true],
      [{ enabled: 1, creation_enabled: 1, animated_enabled: 0 }, false],
    ]) {
      reinit({ reglages, moi: { packs: [], favorites: [], version: 1 } });
      r = await appel('GET', '/me');
      assert.strictEqual(r.corps.features.video, video, `video : ${JSON.stringify(reglages)}`);
    }
    videoDispo = false;

    // ── V1c : stickers animés omis tant que `animated_enabled` est fermé ──
    const anime = { id: 72, position: 1, emoji: '🎉', name_i18n: null, storage_key: 'official/stickers/royal/72_aa.webp', thumb_key: 'official/stickers/royal/72_aa_t.webp', width: 512, height: 512, bytes: 90000, animated: 1 };
    const fixe = { id: 71, position: 0, emoji: '👑', name_i18n: null, storage_key: 'official/stickers/royal/71_bb.webp', thumb_key: null, width: 512, height: 512, bytes: 24500, animated: 0 };
    for (const [reglages, ids, libelle] of [
      [{ enabled: 1 }, [71], 'animated_enabled absent'],
      [{ enabled: 1, animated_enabled: 0 }, [71], 'animated_enabled = 0'],
      [{ enabled: 1, creation_enabled: 1, animated_enabled: 0 }, [71], 'création ouverte mais animés fermés'],
      [{ enabled: 1, animated_enabled: 1 }, [71, 72], 'animated_enabled = 1'],
    ]) {
      reinit({ reglages, packParCode: { ...PACK_BASE, name_i18n: { fr: 'Royal' } }, stickers: [fixe, anime] });
      r = await appel('GET', '/packs/royal');
      assert.deepStrictEqual(r.corps.stickers.map((x) => x.id), ids, `GET /packs/:code — ${libelle}`);
      if (ids.length === 2) assert.strictEqual(r.corps.stickers[1].animated, true);
      reinit({ reglages });
      await appel('GET', '/catalog');
      assert.deepStrictEqual(etat.optsCatalogue, { animes: ids.length === 2 }, `catalogue — ${libelle}`);
    }

    // ── Installer / retirer ────────────────────────────────────────────────
    reinit();
    r = await appel('PUT', '/me/packs/abc');
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);
    reinit({ pack: null });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).corps.code, 'STICKER_PACK_UNAVAILABLE');
    reinit({ pack: { ...PACK_BASE, status: 0 } });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).corps.code, 'STICKER_PACK_UNAVAILABLE', 'brouillon');

    reinit({ droits: { features: { stickers_premium: false } } });
    r = await appel('PUT', '/me/packs/6');
    assert.deepStrictEqual([r.status, r.corps.code, r.corps.feature], [403, 'SUBSCRIPTION_REQUIRED', 'stickers_premium']);
    assert.ok(!etat.appels.some((a) => a[0] === 'installerPack'), 'refusé : rien d\'écrit');
    assert.strictEqual(emis.length, 0);

    reinit({ droits: { features: { stickers_premium: true } } });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).status, 204, 'droit présent');
    reinit({ droits: null });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).status, 204, 'droits illisibles : ne ferme jamais');
    assert.deepStrictEqual(emis, [['user_7', 'stickers:sync', emis[0][2]]]);
    assert.strictEqual(emis[0][2].reason, 'packs');

    // Pack gratuit : jamais de lecture des droits, même sans droit
    reinit({ pack: { ...PACK_BASE, is_premium: 0 }, droits: { features: { stickers_premium: false } } });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).status, 204);

    // Déjà installé : idempotent, sans écriture ni événement, même sans droit
    reinit({ pack: { ...PACK_BASE, installed: 1 }, droits: { features: { stickers_premium: false } } });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).status, 204);
    assert.ok(!etat.appels.some((a) => a[0] === 'installerPack'));
    assert.strictEqual(emis.length, 0);
    // Archivé : installation refusée (A14), installé ou non, rien d'écrit ni d'émis.
    for (const installed of [0, 1]) {
      reinit({ pack: { ...PACK_BASE, is_premium: 0, status: 2, installed } });
      r = await appel('PUT', '/me/packs/6');
      assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE'], `archivé installed=${installed}`);
      assert.ok(!etat.appels.some((a) => a[0] === 'installerPack'), 'refusé : rien d\'écrit');
      assert.strictEqual(emis.length, 0);
    }
    // Republié : s'installe de nouveau.
    reinit({ pack: { ...PACK_BASE, is_premium: 0, status: 1, installed: 0 } });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).status, 204, 'republié : installable');
    // Désinstaller un pack archivé reste permis (le nettoyer de son compte).
    reinit({ pack: { ...PACK_BASE, status: 2, installed: 1 } });
    assert.strictEqual((await appel('DELETE', '/me/packs/6')).status, 204, 'désinstaller un archivé : permis');

    reinit({ pack: { ...PACK_BASE, is_premium: 0 }, installes: 50 });
    r = await appel('PUT', '/me/packs/6');
    assert.deepStrictEqual([r.status, r.corps.code], [409, 'STICKER_PACK_LIMIT']);
    reinit({ pack: { ...PACK_BASE, is_premium: 0 }, installes: 49 });
    assert.strictEqual((await appel('PUT', '/me/packs/6')).status, 204);

    reinit();
    assert.strictEqual((await appel('DELETE', '/me/packs/6')).status, 204);
    assert.ok(etat.appels.some((a) => a[0] === 'retirerPack'));
    assert.strictEqual(emis[0][2].reason, 'packs');
    assert.strictEqual((await appel('DELETE', '/me/packs/x')).status, 404);

    // ── Ordre : `order` n'est pas un identifiant de pack ────────────────────
    reinit();
    r = await appel('PUT', '/me/packs/order', { corps: { ids: [3, 1, 6] } });
    assert.strictEqual(r.status, 204);
    assert.deepStrictEqual(etat.ordre, [3, 1, 6]);
    assert.ok(!etat.appels.some((a) => a[0] === 'chargePackParId'), 'routé vers l\'ordre, pas vers :id');
    for (const ids of [undefined, 'x', [1, 'a'], [1, 0], [-2], ['3'], Array.from({ length: 51 }, (_, i) => i + 1)]) {
      reinit();
      r = await appel('PUT', '/me/packs/order', { corps: { ids } });
      assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD'], JSON.stringify(ids));
      assert.strictEqual(etat.ordre, null);
    }

    // ── Favoris ────────────────────────────────────────────────────────────
    reinit();
    assert.strictEqual((await appel('PUT', '/me/favorites/45')).status, 204);
    assert.ok(etat.appels.some((a) => a[0] === 'ajouterFavori'));
    assert.strictEqual(emis[0][2].reason, 'favorites');
    reinit({ favorisable: null }); // sticker d'un pack archivé ou brouillon : le store ne le rend pas
    r = await appel('PUT', '/me/favorites/45');
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_NOT_FOUND']);
    assert.strictEqual((await appel('PUT', '/me/favorites/0')).corps.code, 'STICKER_NOT_FOUND');
    assert.strictEqual((await appel('PUT', '/me/favorites/1e999')).corps.code, 'STICKER_NOT_FOUND');
    reinit();
    assert.strictEqual((await appel('DELETE', '/me/favorites/45')).status, 204);
    assert.ok(etat.appels.some((a) => a[0] === 'retirerFavori'));

    // ── Panne de base : 500 neutre, jamais le message du driver ────────────
    reinit({ panne: true });
    const consoleError = console.error;
    console.error = () => {}; // les 500 sont journalisés : c'est voulu, pas à afficher ici
    for (const [m, c] of [['GET', '/catalog'], ['GET', '/me'], ['PUT', '/me/favorites/1'], ['DELETE', '/me/packs/1']]) {
      r = await appel(m, c);
      assert.strictEqual(r.status, 500, `${m} ${c}`);
      assert.strictEqual(r.corps.code, 'INTERNAL');
      assert.ok(!/ER_|talky|sticker/i.test(JSON.stringify(r.corps)), 'aucune fuite du driver');
    }
    console.error = consoleError;
  } finally {
    serveur.close();
  }
  console.log('stickerRoutes.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
