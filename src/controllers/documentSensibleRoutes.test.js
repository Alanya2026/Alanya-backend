/**
 * Routes `/api/documents-sensibles/*` — `node src/controllers/documentSensibleRoutes.test.js`.
 *
 * Vrai Express, vrai routeur, vrai contrôleur ; la base (`config/db`) et
 * l'authentification sont remplacées. Le double de la base répond selon la
 * requête reçue, et garde les paramètres pour vérifier ce qui est écrit.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const etat = { message: null, trace: null, inserts: [], doublon: false, lectures: [] };

remplace('../config/db', {
  execute: async (sql, params) => {
    if (/FROM message m\s+JOIN conv_participants/.test(sql)) return [[etat.message].filter(Boolean)];
    if (/INSERT INTO document_consultation/.test(sql)) {
      if (etat.doublon) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      etat.inserts.push(params);
      return [{ insertId: 41 }];
    }
    if (/FROM document_consultation dc/.test(sql)) {
      etat.lectures.push(params);
      return [[etat.trace].filter(Boolean)];
    }
    throw new Error(`requête inattendue : ${sql}`);
  },
});
remplace('../middleware/auth', (req, res, next) => {
  req.user = { alanyaID: Number(req.headers['x-test-user'] || 7), appareilId: 'app-1' };
  next();
});

const router = require('../routes/documentsSensibles');
const app = express();
app.use(express.json());
app.use('/api/documents-sensibles', router);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(500).json({ code: 'INTERNAL', error: err.message }));

const EMPREINTE = '3f9a0c1e5b7d0000111122223333abcd';

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}/api/documents-sensibles`;
  const appel = async (methode, chemin, corps) => {
    const r = await fetch(base + chemin, {
      method: methode,
      headers: { 'content-type': 'application/json' },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const texte = await r.text();
    return { status: r.status, corps: texte ? JSON.parse(texte) : null };
  };
  const reinit = (patch = {}) => Object.assign(etat, {
    message: { msgID: 5, conversationID: 9, senderID: 3, isSensitive: 1 },
    trace: null, inserts: [], doublon: false, lectures: [],
  }, patch);

  try {
    // ── Consultation ───────────────────────────────────────────────────────
    reinit();
    let r = await appel('POST', '/consultations', { msgID: 5, appareil: '  samsung SM-A515F ' });
    assert.strictEqual(r.status, 201);
    assert.deepStrictEqual(etat.inserts[0], [5, 9, 7, 3, 'CONSULTATION', null, 'samsung SM-A515F', 'app-1']);

    // Copie signée : geste et empreinte (lisible ou non) notés en hex minuscule.
    reinit();
    r = await appel('POST', '/consultations', {
      msgID: '5', geste: 'TELECHARGEMENT', empreinte: '3F9A 0C1E 5B7D 0000 1111 2222 3333 ABCD',
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(etat.inserts[0][4], 'TELECHARGEMENT');
    assert.strictEqual(etat.inserts[0][5], EMPREINTE);
    assert.strictEqual(etat.inserts[0][6], null, 'appareil absent');

    // Refus
    for (const [corps, statut, code, motif] of [
      [{}, 400, 'INVALID_PAYLOAD', 'sans msgID'],
      [{ msgID: 5, geste: 'IMPRESSION' }, 400, 'INVALID_PAYLOAD', 'geste inconnu'],
      [{ msgID: 5, geste: 'TELECHARGEMENT', empreinte: 'xyz' }, 422, 'INVALID_FINGERPRINT', 'empreinte mal formée'],
      [{ msgID: 5, empreinte: EMPREINTE }, 400, 'INVALID_PAYLOAD', 'consultation avec empreinte'],
    ]) {
      reinit();
      r = await appel('POST', '/consultations', corps);
      assert.strictEqual(r.status, statut, motif);
      assert.strictEqual(r.corps.code, code, motif);
      assert.strictEqual(etat.inserts.length, 0, `${motif} : rien d'écrit`);
    }
    reinit({ message: null });
    r = await appel('POST', '/consultations', { msgID: 5 });
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'MESSAGE_NOT_FOUND'], 'absent ou conversation étrangère');
    reinit({ message: { msgID: 5, conversationID: 9, senderID: 3, isSensitive: 0 } });
    r = await appel('POST', '/consultations', { msgID: 5 });
    assert.deepStrictEqual([r.status, r.corps.code], [400, 'NOT_SENSITIVE']);
    reinit({ doublon: true });
    r = await appel('POST', '/consultations', { msgID: 5, geste: 'TELECHARGEMENT', empreinte: EMPREINTE });
    assert.deepStrictEqual([r.status, r.corps.code], [409, 'FINGERPRINT_EXISTS']);

    // ── Empreinte ──────────────────────────────────────────────────────────
    reinit({
      trace: {
        empreinte: EMPREINTE, geste: 'TELECHARGEMENT', appareil: 'samsung SM-A515F',
        createdAt: new Date('2026-10-27T09:05:00Z'), msgID: 5, alanyaID: 8, expediteurID: 3,
        auteurNom: 'Bea', auteurNumero: '67641599', expediteurNom: 'Ali', expediteurNumero: '33333333',
        mediaName: 'contrat.pdf',
      },
    });
    r = await appel('GET', '/empreintes/3F9A%200C1E%205B7D%200000%201111%202222%203333%20ABCD');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.corps, {
      empreinte: EMPREINTE,
      geste: 'TELECHARGEMENT',
      date: '2026-10-27T09:05:00.000Z',
      appareil: 'samsung SM-A515F',
      utilisateur: { alanyaId: '67641599', nom: 'Bea' },
      expediteur: { alanyaId: '33333333', nom: 'Ali' },
      document: { msgID: 5, nom: 'contrat.pdf' },
    });
    assert.deepStrictEqual(etat.lectures[0], [EMPREINTE, 7, 7, 7], 'le demandeur borne la recherche');

    reinit();
    r = await appel('GET', `/empreintes/${EMPREINTE}`);
    assert.deepStrictEqual([r.status, r.corps.code], [404, 'FINGERPRINT_NOT_FOUND'], 'inconnue ou hors de portée');
    reinit();
    r = await appel('GET', '/empreintes/zzz');
    assert.deepStrictEqual([r.status, r.corps.code], [422, 'INVALID_FINGERPRINT']);
    assert.strictEqual(etat.lectures.length, 0, 'mal formée : la base n\'est pas interrogée');

    console.log('documentSensibleRoutes.test.js OK');
  } finally {
    serveur.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
