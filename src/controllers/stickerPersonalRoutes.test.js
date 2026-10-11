/**
 * Routes de CRÉATION personnelle (V1b) — `node src/controllers/stickerPersonalRoutes.test.js`.
 *
 * Vrai Express, vrai routeur, vrai multer (champ `file`) et vraies gardes ; seul
 * le service (`config/db`, `stickerPersonalService`) est remplacé, ainsi que
 * l'authentification. Les requêtes SQL transactionnelles relèvent de
 * `stickerPersonal.test.js` (sans MySQL) et de `stickerPersonal.db.test.js`.
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
  reglages: { enabled: 1, creation_enabled: 1 },
  appel: [], // [nom, ...arguments] de chaque appel au service
  erreur: null, // [code, status] : le prochain appel le lève
  panne: false, // exception sans contrat : 500 neutre
  retours: {},
};
const via = (nom) => async (...a) => {
  etat.appel.push([nom, a]);
  if (etat.panne) throw new Error('ER_NO_SUCH_TABLE: talky.sticker');
  if (etat.erreur) {
    const [code, status] = etat.erreur;
    etat.erreur = null;
    throw Object.assign(new Error(code), { code, status });
  }
  return etat.retours[nom];
};
const service = {
  creerStickerPerso: via('creerStickerPerso'),
  supprimerAssetPerso: via('supprimerAssetPerso'),
  copierStickerPerso: via('copierStickerPerso'),
  signalerSticker: via('signalerSticker'),
  creerPackPerso: via('creerPackPerso'),
};
const RETOURS = Object.freeze({
  creerStickerPerso: { assetId: 10, stickerId: 20, packId: 3, reutilise: false, bytes: 4023 },
  copierStickerPerso: { assetId: 11, stickerId: 21, packId: 3, reutilise: false, copie: true },
  signalerSticker: { ok: true, deja: false },
  creerPackPerso: { id: 4, code: 'u_7_ab12cd34' },
  supprimerAssetPerso: { assetId: 10, stickers: 2 },
});

remplace('../config/db', {
  execute: async (sql) => {
    if (/sticker_settings/.test(sql)) return [[etat.reglages]];
    return [[]];
  },
});
remplace('../middleware/auth', (req, res, next) => { req.user = { alanyaID: Number(req.headers['x-test-user'] || 7) }; next(); });
remplace('../services/billing/entitlements', { entitlementsOrNull: async () => null });
remplace('../services/stickerPersonalService', service);

const stickerSettings = require('../services/stickerSettingsService');
const router = require('../routes/stickers');

const emis = [];
const app = express();
app.use(express.json());
app.set('io', { to: (room) => ({ emit: (e, p) => emis.push([room, e, p]) }) });
app.use('/api/stickers', router);

/** Trois vérifications réutilisables : le service a-t-il été appelé ?, quoi ? */
const aLancé = (nom) => etat.appel.some(([n]) => n === nom);
const appelDe = (nom, i = 0) => etat.appel.filter(([n]) => n === nom)[i][1];

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}/api/stickers`;
  const appel = async (methode, chemin, { corps, multipart, entetes } = {}) => {
    const headers = { ...(entetes || {}) };
    let body;
    if (multipart) {
      body = corps; // FormData : fetch pose lui-même la frontière multipart
    } else if (corps !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(corps);
    }
    const r = await fetch(base + chemin, { method: methode, headers, body });
    const texte = await r.text();
    return { status: r.status, headers: r.headers, corps: texte ? JSON.parse(texte) : null };
  };
  const reinit = (patch = {}) => {
    Object.assign(etat, {
      reglages: { enabled: 1, creation_enabled: 1 }, appel: [], erreur: null,
      panne: false, retours: { ...RETOURS },
    }, patch);
    emis.length = 0;
    stickerSettings.invalidateStickerSettings();
  };

  try {
    // ── Création fermée : 404 générique, aucun appel au service ────────────
    for (const [reglages, libelle] of [
      [{ enabled: 1, creation_enabled: 0 }, 'creation_enabled = 0'],
      [{ enabled: 0, creation_enabled: 1 }, 'enabled = 0'],
    ]) {
      reinit({ reglages });
      for (const [m, c] of [
        ['POST', '/assets'], ['DELETE', '/assets/1'], ['POST', '/assets/1/copy'],
        ['POST', '/report'], ['POST', '/packs'],
      ]) {
        const r = await appel(m, c, m === 'POST' && c === '/assets' ? { corps: {} } : undefined);
        assert.strictEqual(r.status, 404, `${libelle} ${m} ${c}`);
        assert.strictEqual(r.corps.code, 'NOT_FOUND', `${libelle} ${m} ${c} : aucun code stickers`);
      }
      assert.strictEqual(etat.appel.length, 0, `${libelle} : le service n'est pas appelé`);
      assert.strictEqual(emis.length, 0);
    }

    // Fermé : la garde précède multer — un fichier volumineux n'est même pas lu
    reinit({ reglages: { enabled: 1, creation_enabled: 0 } });
    const gros = new FormData();
    gros.append('file', new Blob([Buffer.alloc(2 * 1024 * 1024, 7)], { type: 'image/png' }), 's.png');
    let r = await appel('POST', '/assets', { corps: gros, multipart: true });
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'NOT_FOUND'], 'la garde précède multer');
    assert.strictEqual(etat.appel.length, 0);

    // ── POST /assets : dépôt réussi ────────────────────────────────────────
    reinit();
    const form = new FormData();
    form.append('file', new Blob([Buffer.alloc(64, 7)], { type: 'image/png' }), 's.png');
    form.append('emoji', '⭐');
    form.append('nom', 'Nuage');
    r = await appel('POST', '/assets', { corps: form, multipart: true });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.corps, { assetId: 10, stickerId: 20, packId: 3, reutilise: false });
    assert.ok(aLancé('creerStickerPerso'));
    const [depot] = appelDe('creerStickerPerso');
    assert.strictEqual(depot.alanyaID, 7);
    assert.strictEqual(depot.packId, null);
    assert.strictEqual(depot.emoji, '⭐');
    assert.strictEqual(depot.nom, 'Nuage');
    assert.ok(Buffer.isBuffer(depot.buffer), 'octets transmis au pipeline');
    assert.deepStrictEqual(emis[0][2], { reason: 'packs', version: emis[0][2].version });

    // Sans fichier : 422 explicite, le pipeline n'est pas appelé
    reinit();
    r = await appel('POST', '/assets', { corps: {} });
    assert.deepStrictEqual([r.status, r.corps.code], [422, 'STICKER_ASSET_INVALID']);
    assert.ok(!aLancé('creerStickerPerso'));

    // Fichier trop lourd : multer répond 413, le service n'est pas appelé
    reinit();
    const lourd = new FormData();
    lourd.append('file', new Blob([Buffer.alloc(1024 * 1024 + 1, 7)], { type: 'image/png' }), 's.png');
    r = await appel('POST', '/assets', { corps: lourd, multipart: true });
    assert.deepStrictEqual([r.status, r.corps.code], [413, 'FILE_TOO_LARGE']);
    assert.ok(!aLancé('creerStickerPerso'));

    // ── DELETE /assets/:id ─────────────────────────────────────────────────
    reinit();
    assert.strictEqual((await appel('DELETE', '/assets/10')).status, 204);
    assert.deepStrictEqual(appelDe('supprimerAssetPerso'), [7, '10']);
    assert.strictEqual(emis[0][2].reason, 'packs');
    // Actif d'un autre : 404, rien n'est supprimé
    reinit({ erreur: ['STICKER_NOT_FOUND', 404] });
    r = await appel('DELETE', '/assets/77');
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'STICKER_NOT_FOUND']);

    // ── POST /assets/:id/copy ──────────────────────────────────────────────
    reinit();
    r = await appel('POST', '/assets/55/copy', { corps: { packId: 3, emoji: '🦩' } });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.corps, { assetId: 11, stickerId: 21, packId: 3, reutilise: false, copie: true });
    const [copie] = appelDe('copierStickerPerso');
    assert.strictEqual(copie.alanyaID, 7);
    assert.strictEqual(copie.assetId, '55');
    assert.strictEqual(copie.packId, 3);
    // Image bloquée : 422
    reinit({ erreur: ['STICKER_ASSET_BLOCKED', 422] });
    r = await appel('POST', '/assets/55/copy', { corps: {} });
    assert.deepStrictEqual([r.status, r.corps.code], [422, 'STICKER_ASSET_BLOCKED']);

    // ── POST /report ───────────────────────────────────────────────────────
    reinit();
    r = await appel('POST', '/report', { corps: { assetId: 9, reason: 'spam' } });
    assert.deepStrictEqual([r.status, r.corps], [200, { ok: true, deja: false }]);
    const [signal] = appelDe('signalerSticker');
    assert.strictEqual(signal.alanyaID, 7);
    assert.strictEqual(signal.assetId, 9);
    assert.strictEqual(signal.reason, 'spam');
    // Motif inconnu : 400 explicite
    reinit({ erreur: ['STICKER_INVALID_PAYLOAD', 400] });
    r = await appel('POST', '/report', { corps: { assetId: 9, reason: 'zzz' } });
    assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD']);

    // ── POST /packs ────────────────────────────────────────────────────────
    reinit();
    r = await appel('POST', '/packs');
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.corps, { id: 4, code: 'u_7_ab12cd34' });
    // Limite atteinte : 409
    reinit({ erreur: ['STICKER_PACK_LIMIT', 409] });
    r = await appel('POST', '/packs');
    assert.deepStrictEqual([r.status, r.corps.code], [409, 'STICKER_PACK_LIMIT']);

    // ── Panne sans contrat : 500 neutre, rien ne fuit du driver ────────────
    reinit({ panne: true });
    const consoleError = console.error;
    console.error = () => {};
    r = await appel('DELETE', '/assets/10');
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.corps.code, 'INTERNAL');
    assert.ok(!/ER_|talky|sticker/i.test(JSON.stringify(r.corps)), 'aucune fuite du driver');
    console.error = consoleError;
  } finally {
    serveur.close();
  }
  console.log('stickerPersonalRoutes.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });