/**
 * Page publique d'un lien de partage (`GET /s/:token`) —
 * `node src/controllers/stickerLanding.test.js`.
 *
 * Vrai Express, vrai routeur `qrLanding`, vraie garde de réglages et vrai service
 * d'aperçu ; seule la base (`config/db`) et le stockage sont doublés. Éprouve :
 *   - le rendu : nom résolu (fr, repli), nombre, bouton au schéma applicatif,
 *     repli boutiques, échappement HTML strict, `Cache-Control: no-store` ;
 *   - les échecs : jeton mal formé, inconnu, révoqué, archivé, vide, module
 *     fermé, réglages ou base en panne — UNE seule page neutre, sans fuite ;
 *   - les fichiers d'association (le chemin `/s/*` est couvert côté iOS).
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

process.env.QR_PLAY_STORE_URL = 'https://play.example/store?id=a&b=2';
process.env.QR_APP_STORE_URL = 'https://apps.example/app';
process.env.QR_IOS_TEAM_ID = 'TEAM123456';
process.env.QR_ANDROID_SHA256 = 'AA:BB';

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const JETON = 'Zz09_-Zz09_-Zz09_-Zz09_-';
const etat = {
  reglages: { enabled: 1, creation_enabled: 1 },
  pack: { name_i18n: { fr: 'Chats', en: 'Cats' }, count: 3 }, // null = aucun pack
  panneReglages: false,
  panneBase: false,
  requetesPack: [],
};

remplace('../config/db', {
  execute: async (sql, params) => {
    if (/sticker_settings/.test(sql)) {
      if (etat.panneReglages) throw new Error('ER_NO_SUCH_TABLE: talky.sticker_settings');
      return [[etat.reglages]];
    }
    if (/FROM sticker_pack p/.test(sql)) {
      etat.requetesPack.push([sql, params]);
      if (etat.panneBase) throw new Error('ER_ACCESS_DENIED_ERROR: talky');
      return [etat.pack && params[0] === JETON ? [{ ...etat.pack, owner_id: 9, code: 'u_9_ab', share_token: JETON }] : []];
    }
    return [[]];
  },
});
remplace('../services/mediaStorage', {});
remplace('../utils/stickerAsset', { LIMITES: {} });
remplace('../services/stickerAssetService', { depsSql: () => ({}) });
remplace('../socket/state/qrContactTokens', { get: async () => null });
remplace('./qrController', { qrPermanentAutorise: () => false });

const stickerSettings = require('../services/stickerSettingsService');
const router = require('../routes/qrLanding');

const app = express();
app.use('/', router);

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}`;
  const get = async (chemin) => {
    const r = await fetch(base + chemin);
    return { status: r.status, headers: r.headers, texte: await r.text() };
  };
  const reinit = (patch = {}) => {
    Object.assign(etat, {
      reglages: { enabled: 1, creation_enabled: 1 },
      pack: { name_i18n: { fr: 'Chats', en: 'Cats' }, count: 3 },
      panneReglages: false, panneBase: false, requetesPack: [],
    }, patch);
    stickerSettings.invalidateStickerSettings();
  };
  const sansBruit = async (fn) => {
    const w = console.warn; const e = console.error;
    console.warn = () => {}; console.error = () => {};
    try { return await fn(); } finally { console.warn = w; console.error = e; }
  };

  try {
    // ── Rendu nominal ──────────────────────────────────────────────────────
    reinit();
    let r = await get(`/s/${JETON}`);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.match(r.texte, /<h1>Chats<\/h1>/);
    assert.match(r.texte, /3 stickers/);
    assert.ok(r.texte.includes(`href="alanya://sticker/${JETON}"`), 'bouton au schéma applicatif');
    assert.match(r.texte, />Ouvrir dans Alanya</);
    assert.ok(r.texte.includes('href="https://play.example/store?id=a&amp;b=2"'), 'repli Android, échappé');
    assert.ok(r.texte.includes('href="https://apps.example/app"'), 'repli iPhone');
    assert.match(r.texte, /noindex/);
    for (const interdit of ['u_9_ab', '"owner', 'alanyaID', 'share_token', 'storage', JETON.toLowerCase() + 'x']) {
      assert.ok(!r.texte.includes(interdit), `la page ne contient pas « ${interdit} »`);
    }
    // Le jeton n'apparaît que dans le lien d'ouverture
    assert.strictEqual(r.texte.split(JETON).length - 1, 1);

    // Un seul sticker : singulier
    reinit({ pack: { name_i18n: { fr: 'Solo' }, count: 1 } });
    r = await get(`/s/${JETON}`);
    assert.match(r.texte, /1 sticker</);
    assert.ok(!/1 stickers/.test(r.texte));

    // ── Langue : fr par défaut, repli de contrat ───────────────────────────
    reinit({ pack: { name_i18n: { en: 'Cats', zh: '猫' }, count: 2 } });
    assert.match((await get(`/s/${JETON}`)).texte, /<h1>Cats<\/h1>/, 'fr absent : repli en');
    reinit({ pack: { name_i18n: JSON.stringify({ fr: '  ', zh: '猫' }), count: 2 } });
    r = await get(`/s/${JETON}`);
    assert.strictEqual(r.status, 404, 'seule la langue zh, fr vide : repli en/fr impossible = neutre');
    reinit({ pack: { name_i18n: JSON.stringify({ fr: 'Nuit', en: 'Night' }), count: 2 } });
    assert.match((await get(`/s/${JETON}`)).texte, /<h1>Nuit<\/h1>/, 'JSON texte décodé');

    // ── Échappement HTML strict ────────────────────────────────────────────
    const hostile = `<script>alert("x")</script> & 'q' </title><img src=x onerror=1>`;
    reinit({ pack: { name_i18n: { fr: hostile }, count: 2 } });
    r = await get(`/s/${JETON}`);
    assert.strictEqual(r.status, 200);
    assert.ok(!/<script|<img|<\/title><|onerror=1>/.test(r.texte.replace(/<style>[\s\S]*<\/style>/, '')), 'aucune balise injectée');
    assert.ok(r.texte.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;'));

    // ── Échecs : une seule page neutre ─────────────────────────────────────
    const neutre = [];
    const enregistre = (nom, rep, statut = 404) => {
      assert.strictEqual(rep.status, statut, `${nom} : statut`);
      assert.strictEqual(rep.headers.get('cache-control'), 'no-store', `${nom} : no-store`);
      assert.match(rep.texte, /Ce lien n'est plus valide/, `${nom} : page neutre`);
      assert.ok(!/Chats|stickers|alanya:\/\/|u_9_ab/.test(rep.texte), `${nom} : rien du pack`);
      neutre.push(rep.texte);
    };

    reinit();
    for (const mauvais of ['x', 'a'.repeat(23), 'a'.repeat(25), '%27%20OR%201%3D1', `${JETON.slice(0, 23)}!`, '..%2F..%2Fetc']) {
      enregistre(`jeton mal formé ${mauvais}`, await get(`/s/${mauvais}`));
    }
    assert.strictEqual(etat.requetesPack.length, 0, 'un jeton mal formé n\'atteint pas la base');

    reinit({ pack: null });
    enregistre('inconnu/révoqué/archivé', await get(`/s/${JETON}`));
    assert.match(etat.requetesPack[0][0], /p\.visibility = \? AND p\.status = \?/);

    reinit({ pack: { name_i18n: { fr: 'Vide' }, count: 0 } });
    enregistre('pack sans sticker actif', await get(`/s/${JETON}`));

    reinit({ pack: { name_i18n: {}, count: 2 } });
    enregistre('nom vide', await get(`/s/${JETON}`));

    reinit({ reglages: { enabled: 0, creation_enabled: 0 } });
    enregistre('module fermé', await get(`/s/${JETON}`));
    assert.strictEqual(etat.requetesPack.length, 0, 'module fermé : aucune lecture de pack');

    reinit({ reglages: { enabled: 1, creation_enabled: 0 } });
    enregistre('création fermée', await get(`/s/${JETON}`));

    reinit({ panneReglages: true });
    enregistre('réglages illisibles', await sansBruit(() => get(`/s/${JETON}`)));

    reinit({ panneBase: true });
    const panne = await sansBruit(() => get(`/s/${JETON}`));
    enregistre('base en panne', panne, 500);
    assert.ok(!/ER_|talky/.test(panne.texte), 'aucune fuite du driver');

    assert.ok(neutre.every((t) => t === neutre[0]), 'la page neutre est identique pour tous les échecs');

    // ── Fichiers d'association ─────────────────────────────────────────────
    r = await get('/.well-known/apple-app-site-association');
    assert.strictEqual(r.status, 200);
    const paths = JSON.parse(r.texte).applinks.details[0].paths;
    assert.deepStrictEqual(paths, ['/q/u/*', '/q/c/*', '/s/*']);
    r = await get('/.well-known/assetlinks.json');
    assert.strictEqual(r.status, 200);
    const cible = JSON.parse(r.texte)[0];
    assert.strictEqual(cible.relation[0], 'delegate_permission/common.handle_all_urls');
    assert.ok(!('paths' in cible) && !('paths' in cible.target), 'Android : tous les chemins du domaine');
  } finally {
    serveur.close();
  }
  console.log('stickerLanding.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
