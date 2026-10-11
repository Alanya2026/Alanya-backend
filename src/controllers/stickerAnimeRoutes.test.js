/**
 * Route de création ANIMÉE (V1c) — `node src/controllers/stickerAnimeRoutes.test.js`.
 *
 * Vrai Express, vrai routeur, vrai multer dédié (≤ 3 Mo), vraies gardes et vrai
 * limiteur (10 par heure et par compte) ; seuls `config/db` (réglages), l'auth
 * et le service sont remplacés. La conversion elle-même est éprouvée par
 * `utils/stickerAnime.test.js`, le service par `services/stickerAnimeService.test.js`.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const GIF = fs.readFileSync(path.join(__dirname, '..', 'testUtils', 'stickers', 'anime', 'gif-30-carre.gif'));

// ── Doubles ────────────────────────────────────────────────────────────────
const etat = {
  reglages: { enabled: 1, creation_enabled: 1, animated_enabled: 1 },
  appels: [],
  erreur: null, // Error à lever au prochain appel
  retour: { assetId: 10, stickerId: 20, packId: 3, reutilise: false, bytes: 68584, animated: true, frames: 30, durationMs: 3000 },
};
remplace('../config/db', {
  execute: async (sql) => (/sticker_settings/.test(sql) ? [[etat.reglages]] : [[]]),
});
remplace('../middleware/auth', (req, res, next) => { req.user = { alanyaID: Number(req.headers['x-test-user'] || 7) }; next(); });
remplace('../services/billing/entitlements', { entitlementsOrNull: async () => null });
remplace('../services/stickerPersonalService', {
  creerStickerPerso: async () => { throw new Error('route statique appelée à tort'); },
  creerStickerPersoAnime: async (p) => {
    etat.appels.push(p);
    if (etat.erreur) { const e = etat.erreur; etat.erreur = null; throw e; }
    return etat.retour;
  },
  supprimerAssetPerso: async () => ({}),
});

const stickerSettings = require('../services/stickerSettingsService');
const { SlotOccupe } = require('../utils/stickerSemaphore');
const { StickerAssetError } = require('../utils/stickerAsset');
const router = require('../routes/stickers');

const emis = [];
const app = express();
app.use(express.json());
app.set('io', { to: (room) => ({ emit: (e, p) => emis.push([room, e, p]) }) });
app.use('/api/stickers', router);

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}/api/stickers`;
  const envoyer = async ({
    fichier = GIF, type = 'image/gif', champs = {}, utilisateur = 7, nomChamp = 'file',
  } = {}) => {
    const fd = new FormData();
    if (fichier) fd.append(nomChamp, new Blob([fichier], { type }), 'sticker.gif');
    for (const [k, v] of Object.entries(champs)) fd.append(k, v);
    const r = await fetch(`${base}/assets/animated`, {
      method: 'POST', headers: { 'x-test-user': String(utilisateur) }, body: fd,
    });
    const texte = await r.text();
    return { status: r.status, headers: r.headers, corps: texte ? JSON.parse(texte) : null };
  };
  const reinit = (patch = {}) => {
    Object.assign(etat, {
      reglages: { enabled: 1, creation_enabled: 1, animated_enabled: 1 }, appels: [], erreur: null,
    }, patch);
    emis.length = 0;
    stickerSettings.invalidateStickerSettings();
  };
  let compte = 100; // un compte neuf par scénario : le limiteur garde son état
  const neuf = () => { compte += 1; return compte; };

  try {
    // ── Fermé : 404 générique, rien n'est lu, rien n'est appelé ─────────────
    for (const [reglages, libelle] of [
      [{ enabled: 1, creation_enabled: 1, animated_enabled: 0 }, 'animated_enabled = 0'],
      [{ enabled: 1, creation_enabled: 1 }, 'animated_enabled absent'],
      [{ enabled: 1, creation_enabled: 0, animated_enabled: 1 }, 'creation_enabled = 0'],
      [{ enabled: 0, creation_enabled: 1, animated_enabled: 1 }, 'enabled = 0'],
      [undefined, 'ligne absente'],
    ]) {
      reinit({ reglages });
      const r = await envoyer({ utilisateur: 40 });
      assert.strictEqual(r.status, 404, libelle);
      assert.strictEqual(r.corps.code, 'NOT_FOUND', `${libelle} : aucun code propre aux stickers`);
      assert.strictEqual(etat.appels.length, 0, `${libelle} : le service n'est pas appelé`);
    }
    // Un très gros fichier sur une route fermée : 404, pas 413 (multer n'est pas atteint).
    reinit({ reglages: { enabled: 1, creation_enabled: 1, animated_enabled: 0 } });
    const gros = await envoyer({ fichier: Buffer.alloc(4 * 1024 * 1024, 1), utilisateur: 40 });
    assert.strictEqual(gros.status, 404, 'la garde précède multer');
    // … et ces 404 n'ont consommé AUCUN quota : 10 créations passent ensuite.
    reinit();
    for (let i = 0; i < 10; i += 1) assert.strictEqual((await envoyer({ utilisateur: 40 })).status, 201, `création ${i + 1}/10`);
    const onze = await envoyer({ utilisateur: 40 });
    assert.deepStrictEqual([onze.status, onze.corps.code], [429, 'RATE_LIMITED'], '11e : limite 10/h/compte');
    assert.match(onze.headers.get('ratelimit-limit') || '10', /10/);
    assert.strictEqual(etat.appels.length, 10, 'la 11e n\'atteint pas le service');
    // Par COMPTE, pas par IP : un autre compte (même IP) passe.
    assert.strictEqual((await envoyer({ utilisateur: 41 })).status, 201);

    // ── Ouvert : réponse du contrat, identité du JWT, forme transmise ──────
    reinit();
    let u = neuf();
    let r = await envoyer({ utilisateur: u, champs: { shape: 'cercle', packId: '3', emoji: '🎉', nom: 'Fête', alanyaID: '999', owner_id: '999', url: 'https://evil.example/x.webp', storage_key: 'x' } });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(r.corps, { assetId: 10, stickerId: 20, packId: 3, reutilise: false, animated: true, bytes: 68584, frames: 30, durationMs: 3000 });
    const a = etat.appels[0];
    assert.strictEqual(a.alanyaID, u, 'identité = JWT, jamais le corps');
    assert.strictEqual(a.forme, 'cercle');
    assert.strictEqual(a.packId, '3');
    assert.strictEqual(a.emoji, '🎉');
    assert.strictEqual(a.nom, 'Fête');
    assert.ok(Buffer.compare(a.buffer, GIF) === 0, 'les octets reçus sont transmis tels quels');
    assert.deepStrictEqual(Object.keys(a).sort(), ['alanyaID', 'buffer', 'emoji', 'forme', 'nom', 'packId'], 'aucune clé, URL ni chemin ne passe');
    assert.deepStrictEqual(emis[0].slice(1), ['stickers:sync', { reason: 'packs', version: emis[0][2].version }], 'stickers:sync packs');

    // Forme par défaut, absente ou vide.
    u = neuf();
    reinit();
    await envoyer({ utilisateur: u });
    await envoyer({ utilisateur: u, champs: { shape: '' } });
    assert.deepStrictEqual(etat.appels.map((x) => x.forme), ['carre-arrondi', 'carre-arrondi']);
    assert.strictEqual(etat.appels[0].packId, null);

    // ── Entrées invalides : refus avant le service ──────────────────────────
    u = neuf();
    reinit();
    r = await envoyer({ utilisateur: u, champs: { shape: 'triangle' } });
    assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD']);
    r = await envoyer({ utilisateur: u, champs: { shape: '../../etc/passwd' } });
    assert.deepStrictEqual([r.status, r.corps.code], [400, 'STICKER_INVALID_PAYLOAD']);
    r = await envoyer({ utilisateur: u, fichier: null });
    assert.deepStrictEqual([r.status, r.corps.code], [422, 'STICKER_ASSET_INVALID'], 'fichier manquant');
    r = await envoyer({ utilisateur: u, nomChamp: 'photo' });
    assert.ok(r.status >= 400 && r.status < 500, 'mauvais nom de champ : refus');
    r = await envoyer({ utilisateur: u, type: 'image/png' });
    assert.deepStrictEqual([r.status, r.corps.code], [400, 'INVALID_EXTENSION'], 'type déclaré PNG refusé');
    r = await envoyer({ utilisateur: u, type: 'image/svg+xml' });
    assert.strictEqual(r.status, 400, 'SVG refusé');
    r = await envoyer({ utilisateur: u, fichier: Buffer.alloc(3 * 1024 * 1024 + 1, 1) });
    assert.deepStrictEqual([r.status, r.corps.code], [413, 'FILE_TOO_LARGE'], '> 3 Mo');
    assert.strictEqual(etat.appels.length, 0, 'aucun de ces refus n\'a atteint le service');
    // Le type déclaré n'est qu'un filtre : un GIF « déclaré WebP » arrive au pipeline,
    // qui lit les octets (c'est lui qui décide, voir stickerAnime.test.js).
    r = await envoyer({ utilisateur: u, type: 'image/webp' });
    assert.strictEqual(r.status, 201);

    // ── Erreurs du pipeline et du service : code + statut du contrat ───────
    for (const [erreur, statut, code] of [
      [new StickerAssetError('STICKER_ASSET_INVALID', 'animation trop lourde (300 Ko maximum, même à qualité minimale)', 422), 422, 'STICKER_ASSET_INVALID'],
      [new StickerAssetError('STICKER_ASSET_BLOCKED', 'Image bloquée', 422), 422, 'STICKER_ASSET_BLOCKED'],
      [new StickerAssetError('STICKER_QUOTA_EXCEEDED', 'Quota de stickers atteint', 429), 429, 'STICKER_QUOTA_EXCEEDED'],
      [Object.assign(new Error('x'), { code: 'STICKER_PACK_LIMIT', status: 409 }), 409, 'STICKER_PACK_LIMIT'],
    ]) {
      reinit({ erreur });
      r = await envoyer({ utilisateur: neuf() });
      assert.deepStrictEqual([r.status, r.corps.code], [statut, code]);
    }

    // File pleine ou délai dépassé : 503 SERVICE_UNAVAILABLE retryable + Retry-After.
    for (const raison of ['file_pleine', 'delai']) {
      reinit({ erreur: new SlotOccupe(raison, 10) });
      r = await envoyer({ utilisateur: neuf() });
      assert.deepStrictEqual([r.status, r.corps.code], [503, 'SERVICE_UNAVAILABLE'], raison);
      assert.strictEqual(r.headers.get('retry-after'), '10');
      assert.ok(!JSON.stringify(r.corps).includes(raison), 'la raison interne ne sort pas');
    }

    // Exception sans contrat (message de pilote, de libvips…) : 500 neutre, rien ne fuit.
    reinit({ erreur: new Error('gifload_buffer: Invalid frame data /home/chris/x ER_NO_SUCH_TABLE') });
    r = await envoyer({ utilisateur: neuf() });
    assert.strictEqual(r.status, 500);
    assert.ok(!/gifload|frame|home|ER_/.test(JSON.stringify(r.corps)), `fuite : ${JSON.stringify(r.corps)}`);

    // La route littérale ne masque pas les routes voisines.
    reinit();
    const del = await fetch(`${base}/assets/5`, { method: 'DELETE' });
    assert.strictEqual(del.status, 204);

    console.log('stickerAnimeRoutes.test.js : OK');
    serveur.close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
