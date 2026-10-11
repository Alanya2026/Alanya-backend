/**
 * Routes des packs perso et du partage (V1b) —
 * `node src/controllers/stickerPackRoutes.test.js`.
 *
 * Vrai Express, vrai routeur, vrais limiteurs et vraies gardes ; seuls le
 * service (`stickerPackService`, `stickerPersonalService`), `config/db` et
 * l'authentification sont remplacés. Les règles métier (propriétaire, quotas,
 * copie) relèvent de `stickerPack.test.js`.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const JETON = 'Zz09_-Zz09_-Zz09_-Zz09_-';

// ── Doubles ────────────────────────────────────────────────────────────────
const etat = { reglages: { enabled: 1, creation_enabled: 1 }, appel: [], erreur: null, panne: false, retours: {} };
const via = (nom) => async (...a) => {
  etat.appel.push([nom, a]);
  if (etat.panne) throw new Error('ER_NO_SUCH_TABLE: talky.sticker_pack');
  if (etat.erreur) {
    const [code, status] = etat.erreur;
    etat.erreur = null;
    throw Object.assign(new Error(code), { code, status });
  }
  return etat.retours[nom];
};
const NOMS = [
  'modifierPack', 'archiverPack', 'ordonnerStickers', 'ajouterStickerAuPack', 'retirerStickerDuPack',
  'listerMesPacks', 'partagerPack', 'revoquerPartage', 'resoudrePartage', 'ajouterPackPartage',
];
remplace('../services/stickerPackService', Object.fromEntries(NOMS.map((n) => [n, via(n)])));
remplace('../services/stickerPersonalService', {
  MAX_STICKERS_PACK: 40,
  creerStickerPerso: via('creerStickerPerso'),
  supprimerAssetPerso: via('supprimerAssetPerso'),
  copierStickerPerso: via('copierStickerPerso'),
  signalerSticker: via('signalerSticker'),
  creerPackPerso: via('creerPackPerso'),
});
const STICKER = { id: 1, position: 0, emoji: '😀', name_i18n: null, storage_key: 'stickers/u/9/s_a.webp', thumb_key: 'stickers/u/9/s_a_t.webp', width: 512, height: 512, bytes: 4000, animated: 0 };
const RETOURS = Object.freeze({
  modifierPack: { id: 3 },
  archiverPack: { id: 3, deja: false, stickers: 2 },
  ordonnerStickers: { id: 3, count: 2 },
  ajouterStickerAuPack: { stickerId: 77, packId: 3, assetId: 55 },
  retirerStickerDuPack: { packId: 3, assets: 1 },
  listerMesPacks: {
    packs: [{ id: 3, code: 'u_7_ab', name_i18n: { fr: 'Chats' }, visibility: 2, share_token: JETON, cover_sticker_id: 1, version: 5 }],
    stickers: [{ ...STICKER, pack_id: 3, asset_id: 55 }],
  },
  partagerPack: { token: JETON, cree: true },
  revoquerPartage: { id: 3 },
  resoudrePartage: {
    pack: { id: 50, name_i18n: { fr: 'Chats', en: 'Cats' }, description_i18n: null, owner_id: 9, version: 4, cover_sticker_id: null },
    stickers: [STICKER], mine: false, addedPackId: null,
  },
  ajouterPackPartage: { packId: 101, code: 'u_7_ab12cd34', deja: false, stickers: 2, ignores: 0 },
});

remplace('../config/db', {
  execute: async (sql) => {
    if (/sticker_settings/.test(sql)) return [[etat.reglages]];
    return [[]];
  },
});
remplace('../middleware/auth', (req, res, next) => { req.user = { alanyaID: Number(req.headers['x-test-user'] || 7) }; next(); });
remplace('../services/billing/entitlements', { entitlementsOrNull: async () => null });

const stickerSettings = require('../services/stickerSettingsService');
const router = require('../routes/stickers');

const emis = [];
const app = express();
app.use(express.json());
app.set('io', { to: (room) => ({ emit: (e, p) => emis.push([room, e, p]) }) });
app.use('/api/stickers', router);

const aLance = (nom) => etat.appel.some(([n]) => n === nom);
const appelDe = (nom, i = 0) => etat.appel.filter(([n]) => n === nom)[i][1];

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}/api/stickers`;
  const appel = async (methode, chemin, { corps, brut, entetes } = {}) => {
    const headers = { ...(entetes || {}) };
    let body;
    if (brut !== undefined) { headers['content-type'] = 'application/json'; body = brut; }
    else if (corps !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(corps); }
    const r = await fetch(base + chemin, { method: methode, headers, body });
    const texte = await r.text();
    return { status: r.status, headers: r.headers, corps: (() => { try { return texte ? JSON.parse(texte) : null; } catch (_) { return null; } })() };
  };
  const reinit = (patch = {}) => {
    Object.assign(etat, { reglages: { enabled: 1, creation_enabled: 1 }, appel: [], erreur: null, panne: false, retours: { ...RETOURS } }, patch);
    emis.length = 0;
    stickerSettings.invalidateStickerSettings();
  };
  let utilisateur = 100; // un compte neuf par scénario : les limiteurs sont par compte
  const moi = () => ({ 'x-test-user': String(utilisateur += 1) });

  try {
    // ── Création fermée : 404 générique, le service n'est jamais appelé ────
    const ROUTES = [
      ['GET', '/me/created'], ['PATCH', '/packs/3'], ['DELETE', '/packs/3'], ['PUT', '/packs/3/order'],
      ['POST', '/packs/3/stickers'], ['DELETE', '/packs/3/stickers/9'], ['POST', '/packs/3/share'],
      ['DELETE', '/packs/3/share'], ['GET', `/share/${JETON}`], ['POST', `/share/${JETON}/add`],
    ];
    for (const [reglages, libelle] of [
      [{ enabled: 1, creation_enabled: 0 }, 'creation_enabled = 0'],
      [{ enabled: 0, creation_enabled: 1 }, 'enabled = 0'],
    ]) {
      reinit({ reglages });
      for (const [m, c] of ROUTES) {
        const r = await appel(m, c, { entetes: moi(), corps: m === 'GET' || m === 'DELETE' ? undefined : {} });
        assert.strictEqual(r.status, 404, `${libelle} ${m} ${c}`);
        assert.strictEqual(r.corps.code, 'NOT_FOUND', `${libelle} ${m} ${c} : aucun code stickers`);
      }
      assert.strictEqual(etat.appel.length, 0, `${libelle} : le service n'est pas appelé`);
      assert.strictEqual(emis.length, 0);
    }

    // ── GET /me/created ────────────────────────────────────────────────────
    reinit();
    let r = await appel('GET', '/me/created', { entetes: { ...moi(), 'accept-language': 'en' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('cache-control'), 'private, no-store');
    const p0 = r.corps.packs[0];
    assert.strictEqual(p0.name, 'Chats');
    assert.deepStrictEqual(p0.nameI18n, { fr: 'Chats' });
    assert.strictEqual(p0.shared, true);
    assert.strictEqual(p0.shareToken, JETON, 'le jeton n\'est rendu qu\'à son propriétaire');
    assert.strictEqual(p0.count, 1);
    assert.strictEqual(p0.stickers[0].assetId, 55);
    assert.ok(p0.stickers[0].url.includes('stickers/u/9/s_a.webp'), 'URL recalculée depuis la clé');
    assert.ok(p0.cover.includes('s_a_t.webp'));
    assert.strictEqual(appelDe('listerMesPacks')[0] >= 101, true, 'propriétaire = JWT');

    // ── PATCH /packs/:id ───────────────────────────────────────────────────
    reinit();
    let h = moi();
    r = await appel('PATCH', '/packs/3', { entetes: h, corps: { nameI18n: { fr: 'Chats', en: 'Cats' }, coverStickerId: 9 } });
    assert.strictEqual(r.status, 204);
    let [uid, pid, patch] = appelDe('modifierPack');
    assert.strictEqual(uid, Number(h['x-test-user']), 'propriétaire = JWT, jamais le corps');
    assert.strictEqual(pid, '3');
    assert.deepStrictEqual(patch, { nameI18n: { fr: 'Chats', en: 'Cats' }, coverStickerId: 9 });
    assert.deepStrictEqual(emis[0][2], { reason: 'packs', version: emis[0][2].version });
    assert.strictEqual(emis[0][0], `user_${uid}`);
    // `ownerId`/`mediaUrl` dans le corps : ignorés, jamais transmis
    reinit();
    r = await appel('PATCH', '/packs/3', { entetes: moi(), corps: { name: 'X', ownerId: 1, owner_id: 1, mediaUrl: 'http://evil', status: 1 } });
    assert.strictEqual(r.status, 204);
    assert.deepStrictEqual(appelDe('modifierPack')[2], { name: 'X' });
    // Formes invalides : 400, le service n'est pas appelé
    for (const corps of [[], { nameI18n: 'Chats' }, { nameI18n: ['a'] }, { name: 42 }, { coverStickerId: '9' }, { coverStickerId: 0 }, { coverStickerId: -3 }, { coverStickerId: 1.5 }]) {
      reinit();
      r = await appel('PATCH', '/packs/3', { entetes: moi(), corps });
      assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD'], JSON.stringify(corps));
      assert.ok(!aLance('modifierPack'));
    }
    // JSON cassé : réponse d'erreur du serveur, jamais un 500 du service
    reinit();
    r = await appel('PATCH', '/packs/3', { entetes: moi(), brut: '{"name":' });
    assert.strictEqual(r.status, 400);
    assert.ok(!aLance('modifierPack'));
    // Pack d'un autre : 404, aucun événement
    reinit({ erreur: ['STICKER_PACK_UNAVAILABLE', 404] });
    r = await appel('PATCH', '/packs/3', { entetes: moi(), corps: { name: 'X' } });
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);
    assert.strictEqual(emis.length, 0, 'aucun événement quand l\'écriture échoue');

    // ── DELETE /packs/:id (archivage) ──────────────────────────────────────
    reinit();
    r = await appel('DELETE', '/packs/3', { entetes: moi() });
    assert.strictEqual(r.status, 204);
    assert.strictEqual(appelDe('archiverPack')[1], '3');
    assert.strictEqual(emis[0][2].reason, 'packs');
    reinit({ erreur: ['STICKER_PACK_UNAVAILABLE', 404] });
    r = await appel('DELETE', '/packs/77', { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);
    assert.strictEqual(emis.length, 0);

    // ── PUT /packs/:id/order ───────────────────────────────────────────────
    reinit();
    r = await appel('PUT', '/packs/3/order', { entetes: moi(), corps: { ids: [5, 4, 6] } });
    assert.strictEqual(r.status, 204);
    assert.deepStrictEqual(appelDe('ordonnerStickers')[2], [5, 4, 6]);
    for (const corps of [{}, { ids: 'x' }, { ids: [1, '2'] }, { ids: [1, 0] }, { ids: [1.5] }, { ids: [null] }, { ids: Array.from({ length: 41 }, (_, i) => i + 1) }]) {
      reinit();
      r = await appel('PUT', '/packs/3/order', { entetes: moi(), corps });
      assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD'], JSON.stringify(corps).slice(0, 40));
      assert.ok(!aLance('ordonnerStickers'));
    }
    reinit();
    r = await appel('PUT', '/packs/3/order', { entetes: moi(), corps: { ids: [] } });
    assert.strictEqual(r.status, 204, 'liste vide acceptée (aucun changement)');

    // ── POST /packs/:id/stickers, DELETE /packs/:id/stickers/:sid ──────────
    reinit();
    r = await appel('POST', '/packs/3/stickers', { entetes: moi(), corps: { assetId: 55, emoji: '🔥', nom: 'Feu', mediaUrl: 'http://evil', owner_id: 1 } });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.corps, { stickerId: 77, packId: 3, assetId: 55 });
    assert.deepStrictEqual(appelDe('ajouterStickerAuPack')[2], { assetId: 55, emoji: '🔥', nom: 'Feu' });
    for (const corps of [{}, { assetId: '55' }, { assetId: 0 }, { assetId: 'x' }, []]) {
      reinit();
      r = await appel('POST', '/packs/3/stickers', { entetes: moi(), corps });
      assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD']);
    }
    reinit({ erreur: ['STICKER_PACK_LIMIT', 409] });
    r = await appel('POST', '/packs/3/stickers', { entetes: moi(), corps: { assetId: 55 } });
    assert.deepStrictEqual([r.status, r.corps.code], [409, 'STICKER_PACK_LIMIT']);
    reinit();
    r = await appel('DELETE', '/packs/3/stickers/9', { entetes: moi() });
    assert.strictEqual(r.status, 204);
    assert.deepStrictEqual(appelDe('retirerStickerDuPack').slice(1), ['3', '9']);
    reinit({ erreur: ['STICKER_NOT_FOUND', 404] });
    r = await appel('DELETE', '/packs/3/stickers/9', { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_NOT_FOUND']);

    // ── POST/DELETE /packs/:id/share ───────────────────────────────────────
    reinit();
    r = await appel('POST', '/packs/3/share', { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps], [201, { token: JETON }]);
    reinit({ retours: { ...RETOURS, partagerPack: { token: JETON, cree: false } } });
    r = await appel('POST', '/packs/3/share', { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps], [200, { token: JETON }], 'déjà partagé : 200, même jeton');
    reinit({ erreur: ['STICKER_INVALID_PAYLOAD', 400] });
    r = await appel('POST', '/packs/3/share', { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD']);
    reinit();
    r = await appel('DELETE', '/packs/3/share', { entetes: moi() });
    assert.strictEqual(r.status, 204);
    assert.ok(aLance('revoquerPartage'));
    assert.strictEqual(emis[0][2].reason, 'packs');

    // ── GET /share/:token ──────────────────────────────────────────────────
    reinit();
    r = await appel('GET', `/share/${JETON}`, { entetes: { ...moi(), 'accept-language': 'en' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corps.name, 'Cats');
    assert.strictEqual(r.corps.count, 1);
    assert.strictEqual(r.corps.mine, false);
    assert.strictEqual(r.corps.added, false);
    assert.ok(r.corps.stickers[0].url.includes('stickers/u/9/s_a.webp'));
    const texte = JSON.stringify(r.corps);
    assert.ok(!/owner|"id":50|u_9|shareToken|token/i.test(texte), 'aucun identifiant de compte ni jeton dans la fiche');
    assert.strictEqual(appelDe('resoudrePartage')[1], JETON);
    assert.strictEqual(emis.length, 0, 'une lecture n\'émet rien');
    reinit({ erreur: ['STICKER_PACK_UNAVAILABLE', 404] });
    r = await appel('GET', `/share/${JETON}`, { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_PACK_UNAVAILABLE']);

    // ── POST /share/:token/add ─────────────────────────────────────────────
    reinit();
    r = await appel('POST', `/share/${JETON}/add`, { entetes: moi(), corps: {} });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.corps, { packId: 101, code: 'u_7_ab12cd34', deja: false, stickers: 2, ignores: 0 });
    assert.strictEqual(emis[0][2].reason, 'packs');
    reinit({ retours: { ...RETOURS, ajouterPackPartage: { packId: 61, deja: true } } });
    r = await appel('POST', `/share/${JETON}/add`, { entetes: moi() });
    assert.deepStrictEqual([r.status, r.corps], [200, { packId: 61, deja: true, mine: false }]);
    assert.strictEqual(emis.length, 0, 'rien de nouveau : aucun événement');
    for (const [code, statut] of [['STICKER_PACK_LIMIT', 409], ['STICKER_QUOTA_EXCEEDED', 429], ['STICKER_PACK_UNAVAILABLE', 404]]) {
      reinit({ erreur: [code, statut] });
      r = await appel('POST', `/share/${JETON}/add`, { entetes: moi() });
      assert.deepStrictEqual([r.status, r.corps.code], [statut, code]);
      assert.strictEqual(emis.length, 0);
    }

    // ── Limites de débit : par compte, code RATE_LIMITED ───────────────────
    reinit();
    const lui = moi();
    const autre = moi();
    let dernier;
    for (let i = 0; i < 11; i += 1) dernier = await appel('POST', `/share/${JETON}/add`, { entetes: lui });
    assert.strictEqual(dernier.status, 429, '11e installation en une minute');
    assert.strictEqual(dernier.corps.code, 'RATE_LIMITED');
    assert.strictEqual(etat.appel.filter(([n]) => n === 'ajouterPackPartage').length, 10, 'la 11e n\'atteint pas le service');
    r = await appel('POST', `/share/${JETON}/add`, { entetes: autre });
    assert.notStrictEqual(r.status, 429, 'le plafond est par compte, pas global');
    reinit();
    const lecteur = moi();
    for (let i = 0; i < 31; i += 1) dernier = await appel('GET', `/share/${JETON}`, { entetes: lecteur });
    assert.strictEqual(dernier.status, 429, '31e résolution en une minute');
    reinit();
    const gestion = moi();
    for (let i = 0; i < 21; i += 1) dernier = await appel('POST', '/packs/3/share', { entetes: gestion });
    assert.strictEqual(dernier.status, 429, '21e création de lien en une minute');
    // Fermé : la garde précède le limiteur (un 404 ne consomme pas le quota)
    reinit({ reglages: { enabled: 1, creation_enabled: 0 } });
    const ferme = moi();
    for (let i = 0; i < 15; i += 1) dernier = await appel('POST', `/share/${JETON}/add`, { entetes: ferme });
    assert.strictEqual(dernier.status, 404);

    // ── Panne sans contrat : 500 neutre, rien du driver ne fuit ────────────
    reinit({ panne: true });
    const consoleError = console.error;
    console.error = () => {};
    r = await appel('DELETE', '/packs/3', { entetes: moi() });
    console.error = consoleError;
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.corps.code, 'INTERNAL');
    assert.ok(!/ER_|talky|sticker/i.test(JSON.stringify(r.corps)), 'aucune fuite du driver');
    assert.strictEqual(emis.length, 0);
  } finally {
    serveur.close();
  }
  console.log('stickerPackRoutes.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
