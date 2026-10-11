/**
 * Message sticker (type 10) — `node src/utils/stickerMessage.test.js`.
 * Pur : base, droits et stockage sont des doubles injectés. Les fixtures de
 * `src/testUtils/stickers/` sont les fichiers du contrat, copiés tels quels.
 */
const assert = require('assert');
const path = require('path');
const fix = (nom) => require(path.join(__dirname, '..', 'testUtils', 'stickers', nom));
const {
  StickerMessageError, parseStickerPayload, prepareStickerMessage, resolveStickerFields, toSocketError,
  CONTENT_MAX_OCTETS,
} = require('./stickerMessage');
const { decideEntitlements } = require('../services/billing/rules');

const ROW = Object.freeze({
  sid: 4812, emoji: '😂', pack_id: 3, pack_code: 'mboa', is_premium: 0, visibility: 0,
  pack_status: 1, asset_status: 0, storage_key: 'official/stickers/mboa/4812_ab12cd34.webp',
  width: 512, height: 512, animated: 0, installed: 0,
});

const deps = (over = {}) => ({
  ouvert: async () => true,
  chargeSticker: async (sid) => (sid === 4812 ? { ...ROW, ...(over.row || {}) } : null),
  droits: async () => null,
  urlDe: (k) => `https://<bucket>/${k}`,
  ...over,
});

async function refus(p, code, motif) {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof StickerMessageError, `${motif} : ${e.stack}`);
    assert.strictEqual(e.code, code, motif);
    return e;
  }
  assert.fail(`${motif} : accepté à tort`);
  return null;
}

const contentDe = (o) => JSON.stringify({ v: 1, pack: 'mboa', sid: 4812, emoji: 'x', ...o });

(async () => {
  // ── Fixture « valide » : tout ce que le client envoie est ignoré ─────────
  {
    const f = fix('message-sticker-valide.json');
    const r = await prepareStickerMessage({ content: f.entree_client.content, senderID: 7 }, deps());
    assert.strictEqual(r.content, f.sortie_serveur.content, 'content canonique (w, h, a relus en base)');
    assert.strictEqual(r.mediaUrl, f.sortie_serveur.mediaUrl, 'mediaUrl recalculée, pas celle de evil.example');
    assert.strictEqual(r.mediaName, f.sortie_serveur.mediaName);
    assert.ok(!r.mediaUrl.includes('evil'));
    // emoji du client ignoré : celui de la base fait foi
    const r2 = await prepareStickerMessage({ content: contentDe({ emoji: '💀' }), senderID: 7 }, deps());
    assert.strictEqual(JSON.parse(r2.content).emoji, '😂');
    // champ supplémentaire accepté et ignoré
    await prepareStickerMessage({ content: contentDe({ nouveau: { x: 1 } }), senderID: 7 }, deps());
  }

  // ── Fixture « version future » ───────────────────────────────────────────
  {
    const f = fix('message-sticker-version-future.json');
    await refus(prepareStickerMessage({ content: f.content, senderID: 7 }, deps()),
      f.attendu_serveur_v_inconnu.erreur, 'v inconnue');
    await refus(prepareStickerMessage({ content: contentDe({ v: '1' }), senderID: 7 }, deps()),
      'STICKER_INVALID_PAYLOAD', 'v texte');
    await refus(prepareStickerMessage({ content: contentDe({ v: undefined }), senderID: 7 }, deps()),
      'STICKER_INVALID_PAYLOAD', 'v absente');
  }

  // ── Fixture « hostile » ──────────────────────────────────────────────────
  {
    const f = fix('message-sticker-hostile.json');
    let appels = 0;
    const d = deps({ chargeSticker: async () => { appels++; return null; } });
    for (const cas of f.cas) {
      const content = cas.content_longueur ? 'x'.repeat(cas.content_longueur) : cas.content;
      if (cas.nom === 'proto') {
        // accepté : champ ignoré, aucune pollution
        await prepareStickerMessage({ content, senderID: 7 }, deps({ chargeSticker: async (sid) => (sid === 1 ? { ...ROW, sid: 1 } : null) }));
        assert.strictEqual({}.polluted, undefined, 'Object.prototype pollué');
        assert.strictEqual(Object.prototype.polluted, undefined);
        continue;
      }
      await refus(prepareStickerMessage({ content, senderID: 7 }, d), 'STICKER_INVALID_PAYLOAD', cas.nom);
    }
    assert.strictEqual(appels, 0, 'un payload invalide ne touche jamais la base');
    assert.strictEqual(CONTENT_MAX_OCTETS, 512);
    // 512 octets exactement : lu ; 513 : refusé (octets, pas caractères)
    const rempli = (n) => `{"v":1,"sid":4812,"pad":"${'a'.repeat(n)}"}`;
    const base = Buffer.byteLength(rempli(0));
    assert.deepStrictEqual(parseStickerPayload(rempli(512 - base)), { sid: 4812 });
    assert.throws(() => parseStickerPayload(rempli(513 - base)), /Sticker invalide/);
    assert.throws(() => parseStickerPayload(`{"v":1,"sid":4812,"pad":"${'é'.repeat(260)}"}`), /Sticker invalide/, 'multi-octets comptés en octets');
    // types incongrus
    for (const mauvais of [null, undefined, 42, {}, [], true]) {
      assert.throws(() => parseStickerPayload(mauvais), /Sticker invalide/);
    }
    for (const sid of [0, 1.5, 2 ** 53, -1, null, true, [4812], '4812']) {
      assert.throws(() => parseStickerPayload(JSON.stringify({ v: 1, sid })), /Sticker invalide/, `sid ${JSON.stringify(sid)}`);
    }
    assert.strictEqual(parseStickerPayload(JSON.stringify({ v: 1, sid: 2 ** 53 - 1 })).sid, 2 ** 53 - 1);
  }

  // ── Fonctionnalité fermée : rien n'est révélé ────────────────────────────
  {
    let lu = false;
    const e = await refus(
      prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({
        ouvert: async () => false, chargeSticker: async () => { lu = true; return { ...ROW }; },
      })),
      'STICKER_INVALID_PAYLOAD', 'fermé');
    assert.strictEqual(e.status, 400);
    assert.ok(!lu, 'fermé : aucune lecture');
  }

  // ── Existence, fichier retiré, état du pack ──────────────────────────────
  await refus(prepareStickerMessage({ content: contentDe({ sid: 999 }), senderID: 7 }, deps()), 'STICKER_NOT_FOUND', 'inconnu');
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { asset_status: 1 } })), 'STICKER_NOT_FOUND', 'fichier retiré');
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 0 } })), 'STICKER_PACK_UNAVAILABLE', 'brouillon');
  // Pack officiel archivé = « indisponible » (A14) : plus d'envoi, installé ou non.
  const e404 = await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 2, installed: 0 } })), 'STICKER_PACK_UNAVAILABLE', 'archivé non installé');
  assert.strictEqual(e404.status, 404);
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 2, installed: 1 } })), 'STICKER_PACK_UNAVAILABLE', 'archivé MÊME installé (remplace la décision 9)');
  // Republié (status 1) : redevient envoyable, installé ou non.
  await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 1, installed: 1 } }));
  await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 1, installed: 0 } }));
  // Archivé + fichier retiré : le fichier retiré passe d'abord (STICKER_NOT_FOUND), jamais d'écriture.
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 2, asset_status: 1 } })), 'STICKER_NOT_FOUND', 'archivé et fichier retiré');
  // Via le point d'entrée commun (socket ET HTTP) : même refus.
  await refus(resolveStickerFields({ type: 10, content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 2, installed: 1 } })), 'STICKER_PACK_UNAVAILABLE', 'resolveStickerFields : archivé installé');
  // Pack perso : le propriétaire oui, les autres non.
  await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 1, owner_id: 7 } }));
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 1, owner_id: 9 } })), 'STICKER_PACK_UNAVAILABLE', 'pack perso d\'un autre');
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 1 } })), 'STICKER_PACK_UNAVAILABLE', 'pack perso sans propriétaire lisible');
  // Pack partagé : installé oui, sinon non.
  await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 2, installed: 1 } }));
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 2, installed: 0 } })), 'STICKER_PACK_UNAVAILABLE', 'pack partagé non installé');
  // Pack partagé : son propriétaire envoie toujours, même sans l'avoir « installé ».
  await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 2, owner_id: 7, installed: 0 } }));
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 2, owner_id: 9, installed: 0 } })), 'STICKER_PACK_UNAVAILABLE', 'pack partagé d\'un autre, non installé');
  // Pack perso archivé : plus d'envoi, y compris pour son propriétaire.
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 1, owner_id: 7, pack_status: 2 } })), 'STICKER_PACK_UNAVAILABLE', 'pack perso archivé');
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 2, owner_id: 7, pack_status: 2, installed: 1 } })), 'STICKER_PACK_UNAVAILABLE', 'pack partagé archivé');
  // Visibilité inconnue : refus.
  await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { visibility: 3 } })), 'STICKER_PACK_UNAVAILABLE', 'visibilité inconnue');
  assert.strictEqual((await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ row: { pack_status: 0 } })), 'STICKER_PACK_UNAVAILABLE', 'statut')).status, 404);

  // ── Verrou Plus : gratuit/Plus × abonné × PLUS/TRIAL × base indisponible ──
  {
    const DAY = 86_400_000;
    const NOW = new Date('2026-10-10T10:00:00Z');
    const jour = (n) => new Date(NOW.getTime() + n * DAY);
    const CATALOG = [{ code: 'stickers_premium', is_paid: 1, is_available: 1 }];
    const PLUS_PAYANT = { model: 1, paid_enabled: 1, grace_until: jour(-30) };
    const PLUS_ETEINT = { model: 1, paid_enabled: 0, grace_until: null };
    const ESSAI = { model: 2, paid_enabled: 1, grace_until: jour(-30), trial_days: 90 };
    const abonne = (avecFeature) => ({
      periods: [{ plan_code: 'plus', starts_at: jour(-5), ends_at: jour(300), source: 0 }],
      planFeatures: avecFeature ? ['stickers_premium'] : [],
    });
    const droitsDe = (p) => async () => decideEntitlements({ catalog: CATALOG, now: NOW, ...p });
    const ancien = jour(-400);
    const recent = jour(-10);

    const cas = [
      // [libellé, paramètres de droits, attendu : envoi du pack Plus autorisé ?]
      ['PLUS payant, non abonné', { settings: PLUS_PAYANT, createdAt: ancien }, false],
      ['PLUS payant, abonné avec la fonctionnalité', { settings: PLUS_PAYANT, createdAt: ancien, ...abonne(true) }, true],
      ['PLUS payant, abonné SANS la fonctionnalité', { settings: PLUS_PAYANT, createdAt: ancien, ...abonne(false) }, false],
      ['PLUS payant éteint (phase gratuite)', { settings: PLUS_ETEINT, createdAt: ancien }, true],
      ['PLUS payant, équipe (exemptée)', { settings: PLUS_PAYANT, createdAt: ancien, exempt: true }, true],
      ['TRIAL, pendant l\'essai', { settings: ESSAI, createdAt: recent }, true],
      ['TRIAL, essai fini, non abonné', { settings: ESSAI, createdAt: ancien }, false],
      ['TRIAL, essai fini, abonné avec la fonctionnalité', { settings: ESSAI, createdAt: ancien, ...abonne(true) }, true],
      ['TRIAL, essai fini, abonné SANS la fonctionnalité', { settings: ESSAI, createdAt: ancien, ...abonne(false) }, false],
    ];
    for (const [libelle, p, autorise] of cas) {
      const d = deps({ row: { is_premium: 1, pack_code: 'royal' }, droits: droitsDe(p) });
      if (autorise) {
        await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, d);
      } else {
        const e = await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, d), 'SUBSCRIPTION_REQUIRED', libelle);
        assert.strictEqual(e.status, 403, libelle);
        assert.strictEqual(e.feature, 'stickers_premium', libelle);
      }
      // Un pack GRATUIT n'appelle jamais les droits, quel que soit le compte.
      let consultes = false;
      await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({
        droits: async () => { consultes = true; return decideEntitlements({ catalog: CATALOG, now: NOW, ...p }); },
      }));
      assert.ok(!consultes, `${libelle} : pack gratuit, droits non consultés`);
    }

    // Base indisponible : ne ferme JAMAIS.
    const plus = { row: { is_premium: 1 } };
    await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ ...plus, droits: async () => { throw new Error('ECONNREFUSED'); } }));
    await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ ...plus, droits: async () => null }));
    await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ ...plus, droits: async () => ({}) }));
    await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ ...plus, droits: async () => ({ features: {} }) }));
    await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ ...plus, droits: async () => ({ features: { stickers_premium: true } }) }));
    // Seul un `false` explicite ferme.
    await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ ...plus, droits: async () => ({ features: { stickers_premium: false } }) })), 'SUBSCRIPTION_REQUIRED', 'false explicite');
  }

  // ── Point d'entrée des deux chemins ──────────────────────────────────────
  {
    assert.strictEqual(await resolveStickerFields({ type: 0, content: 'salut', senderID: 7 }, deps()), null, 'texte : intact');
    assert.strictEqual(await resolveStickerFields({ type: 1, content: '', senderID: 7 }, deps()), null);
    // Chiffré type 10 : on ne stocke JAMAIS le contenu du client en clair. Les
    // trois champs repartent à NULL — l'enveloppe chiffrée porte tout.
    assert.deepStrictEqual(
      await resolveStickerFields({
        type: 10,
        content: '{"v":1,"pack":"evil","sid":9,"w":1,"h":1,"a":0}',
        senderID: 7,
        chiffre: { enveloppes: [] },
      }, deps()),
      { content: null, mediaUrl: null, mediaName: null },
      'chiffré : champs du client forcés à NULL, jamais stockés en clair',
    );
    // Un type non-10 chiffré reste intact : l'E2EE des autres types ne bouge pas.
    assert.strictEqual(await resolveStickerFields({ type: 0, content: 'salut', senderID: 7, chiffre: { enveloppes: [] } }, deps()), null, 'texte chiffré : intact');
    const r = await resolveStickerFields({ type: '10', content: contentDe({}), senderID: 7 }, deps());
    assert.deepStrictEqual(Object.keys(r).sort(), ['content', 'mediaName', 'mediaUrl']);
    await refus(resolveStickerFields({ type: 10, content: '', senderID: 7 }, deps()), 'STICKER_INVALID_PAYLOAD', 'type 10 sans contenu');
    assert.deepStrictEqual(toSocketError(new StickerMessageError('SUBSCRIPTION_REQUIRED', { feature: 'stickers_premium' })),
      { code: 'SUBSCRIPTION_REQUIRED', message: 'Pack réservé à Alanya Plus', feature: 'stickers_premium' });
  }

  // ── Réglages illisibles : 503 retryable, jamais un STICKER_* terminal ────
  {
    // `ouvert` qui lève (base injoignable, migration non jouée) → retryable.
    const e = await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({
      ouvert: async () => { throw new Error('ECONNREFUSED'); },
    })), 'SERVICE_UNAVAILABLE', 'réglages illisibles');
    assert.strictEqual(e.status, 503, 'retryable');
    assert.ok(!e.feature, 'aucune feature : rien de métier à débloquer');

    // Fonctionnalité fermée MAIS lisible → refus terminal, distinct.
    const f = await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({
      ouvert: async () => false,
    })), 'STICKER_INVALID_PAYLOAD', 'fermé mais lisible');
    assert.strictEqual(f.status, 400, 'terminal');

    // Surtout pas le même code : l'app doit savoir rejouer dans un cas, pas
    // dans l'autre.
    assert.notStrictEqual(f.code, e.code, 'illisible ≠ fermé');
  }

  // ── V1c : `a` posé par le serveur d'après l'actif ; animés fermés → introuvable ──
  {
    const anime = { animated: 1 };
    const ouvert = { animesOuverts: async () => true };
    // Ouvert : a = 1 d'après l'actif, mediaUrl/mediaName inchangés. Le client dit a:0.
    const r = await prepareStickerMessage({ content: contentDe({ a: 0 }), senderID: 7 }, deps({ row: anime, ...ouvert }));
    assert.strictEqual(JSON.parse(r.content).a, 1, 'a = 1 vient de sticker_asset.animated');
    assert.strictEqual(r.mediaUrl, 'https://<bucket>/official/stickers/mboa/4812_ab12cd34.webp');
    assert.strictEqual(r.mediaName, 'Sticker 😂', 'mediaName / aperçu inchangés');
    // Le client ne peut PAS poser a = 1 sur un sticker fixe.
    const fixe = await prepareStickerMessage({ content: contentDe({ a: 1 }), senderID: 7 }, deps({ row: { animated: 0 }, ...ouvert }));
    assert.strictEqual(JSON.parse(fixe.content).a, 0, 'a:1 du client ignoré sur un actif fixe');
    assert.strictEqual(JSON.parse(fixe.content).w, 512);
    // Fermé : même STICKER_NOT_FOUND (404) qu'un fichier retiré, sans code propre.
    for (const [libelle, d] of [
      ['animated_enabled = 0', { row: anime, animesOuverts: async () => false }],
      ['dépendance absente (fermé par défaut)', { row: anime }],
    ]) {
      const e = await refus(prepareStickerMessage({ content: contentDe({ a: 1 }), senderID: 7 }, deps(d)), 'STICKER_NOT_FOUND', libelle);
      assert.strictEqual(e.status, 404);
    }
    // Un sticker FIXE ne lit même pas le réglage animé.
    let lu = 0;
    await prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({ animesOuverts: async () => { lu += 1; return false; } }));
    assert.strictEqual(lu, 0, 'sticker fixe : aucune lecture du réglage animé');
    // Réglage illisible juste après un `ouvert` lisible : retryable, jamais terminal.
    const ind = await refus(prepareStickerMessage({ content: contentDe({}), senderID: 7 }, deps({
      row: anime, animesOuverts: async () => { throw new Error('ECONNREFUSED'); },
    })), 'SERVICE_UNAVAILABLE', 'réglage animé illisible');
    assert.strictEqual(ind.status, 503);
    // resolveStickerFields (point d'entrée des DEUX chemins d'envoi) : même règle.
    await refus(resolveStickerFields({ type: 10, content: contentDe({}), senderID: 7 }, deps({ row: anime, animesOuverts: async () => false })), 'STICKER_NOT_FOUND', 'resolveStickerFields fermé');
    const ok2 = await resolveStickerFields({ type: 10, content: contentDe({}), senderID: 7 }, deps({ row: anime, ...ouvert }));
    assert.strictEqual(JSON.parse(ok2.content).a, 1);
  }

  // ── Statuts alignés sur fixtures/erreurs.json ────────────────────────────
  {
    const erreurs = fix('erreurs.json');
    for (const code of ['STICKER_NOT_FOUND', 'STICKER_PACK_UNAVAILABLE', 'STICKER_INVALID_PAYLOAD', 'SUBSCRIPTION_REQUIRED']) {
      assert.strictEqual(new StickerMessageError(code).status, erreurs[code].status, code);
    }
  }

  console.log('stickerMessage.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
