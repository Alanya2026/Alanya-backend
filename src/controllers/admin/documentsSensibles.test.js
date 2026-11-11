/**
 * Enquête par empreinte (admin) — `node src/controllers/admin/documentsSensibles.test.js`.
 *
 * Vrai Express, vraie garde de permission, vrai contrôleur ; la base est un
 * double qui répond selon la requête et garde ce qui est écrit au journal.
 */
const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const EMPREINTE = '3f9a0c1e5b7d0000111122223333abcd';
const etat = {};
const reinit = (patch = {}) => Object.assign(etat, {
  trace: {
    id: 12, empreinte: EMPREINTE, geste: 'TELECHARGEMENT', appareil: 'samsung SM-A515F',
    appareilId: '77', createdAt: new Date('2026-11-05T13:32:07Z'),
    msgID: 99120, conversationID: 4410, alanyaID: 10432, expediteurID: 8812,
    aUid: 10432, aNom: 'Jean M.', aPseudo: null, aNumero: '237600000001', aAvatar: null,
    aType: 0, aExclus: 0, aExcludeReason: null, aDeleteAt: null,
    eUid: null, eNom: null, ePseudo: null, eNumero: null, eAvatar: null,
    eType: null, eExclus: null, eExcludeReason: null, eDeleteAt: null,
    mMsgID: null, mediaName: null, mType: null, mediaSize: null, sendAt: null, mIsDeleted: null,
    cId: 4410, isGroup: 1, GroupName: 'Achats', membres: 12,
  },
  appareil: {
    id: 77, alanyaID: 10432, device_id: 'dev-A', device_name: 'Galaxy A51', platform: 'android',
    ip_address: '41.202.1.1', login_method: 'password',
    created_at: new Date('2026-10-01T08:00:00Z'), last_active_at: new Date('2026-11-06T08:00:00Z'), revoked_at: null,
  },
  autresComptes: [{ alanyaID: 555, nom: 'Double', alanyaPhone: '237600000555' }],
  historique: [
    { id: 1, geste: 'CONSULTATION', empreinte: null, appareil: 'x', createdAt: new Date('2026-11-02T09:20:00Z'), alanyaID: 3, uid: 3, nom: 'Paul K.', alanyaPhone: '2376003' },
    { id: 12, geste: 'TELECHARGEMENT', empreinte: EMPREINTE, appareil: 'samsung SM-A515F', createdAt: new Date('2026-11-05T13:32:07Z'), alanyaID: 10432, uid: 10432, nom: 'Jean M.', alanyaPhone: '237600000001' },
    { id: 14, geste: 'PARTAGE', empreinte: 'c71d0000000000000000000000000000', appareil: null, createdAt: new Date('2026-11-06T08:01:00Z'), alanyaID: 9, uid: null, nom: null, alanyaPhone: null },
  ],
  journal: [],
  journalEnPanne: false,
  resume: null,
}, patch);

remplace('../../config/db', {
  execute: async (sql, params) => {
    if (/INSERT INTO admin_audit/.test(sql)) {
      if (etat.journalEnPanne) throw new Error('ER_LOCK_WAIT_TIMEOUT');
      etat.journal.push(params);
      return [{ insertId: etat.journal.length }];
    }
    if (/WHERE dc\.empreinte = \?/.test(sql)) return [[etat.trace].filter(Boolean)];
    if (/FROM appareils WHERE id = \?/.test(sql)) return [[etat.appareil].filter(Boolean)];
    if (/FROM appareils a2/.test(sql)) {
      assert.deepStrictEqual(params, ['dev-A', 10432], 'autres comptes : même appareil, hors auteur');
      return [etat.autresComptes];
    }
    if (/WHERE dc\.msgID = \?/.test(sql)) return [etat.historique];
    if (/SELECT COUNT\(\*\) AS n FROM document_consultation/.test(sql)) return [[{ n: 4 }]];
    if (/dc\.alanyaID = \? AND dc\.empreinte IS NOT NULL AND dc\.empreinte <> \?/.test(sql)) {
      return [[{ empreinte: 'aa'.repeat(16), geste: 'TELECHARGEMENT', createdAt: new Date('2026-10-30T10:00:00Z'), msgID: 5, mediaName: 'devis.pdf' }]];
    }
    if (/FROM admin_audit a/.test(sql)) {
      return [etat.journal.map((p) => ({
        created_at: new Date(), reason: p[5], status_code: p[8], admin_id: p[0], nom: 'Super',
      })).reverse()];
    }
    if (/SUM\(CASE WHEN alanyaID = \? AND geste = 'CONSULTATION'/.test(sql)) return [[etat.resume]];
    throw new Error(`requête inattendue : ${sql}`);
  },
});

const { requirePermission } = require('../../middleware/adminAuth');
const ctrl = require('./documentsSensibles');

const app = express();
app.set('trust proxy', false);
app.use(express.json());
const auth = (req, res, next) => {
  req.user = { alanyaID: 1, typeCompte: Number(req.headers['x-test-role'] ?? 2) };
  next();
};
app.post('/api/admin/documents-sensibles/empreintes/:code/verification',
  auth, requirePermission('documents.trace'), ctrl.verifierEmpreinteAdmin);
app.get('/api/admin/users/:id/documents-sensibles',
  auth, requirePermission('documents.trace'), ctrl.resumeDocumentsSensiblesUtilisateur);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => res.status(500).json({ code: 'INTERNAL' }));

(async () => {
  const serveur = http.createServer(app);
  await new Promise((r) => serveur.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${serveur.address().port}/api/admin`;
  const verifier = async (code, corps, role) => {
    const r = await fetch(`${base}/documents-sensibles/empreintes/${encodeURIComponent(code)}/verification`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(role != null ? { 'x-test-role': String(role) } : {}) },
      body: JSON.stringify(corps ?? {}),
    });
    return { status: r.status, corps: await r.json() };
  };

  try {
    // ── Garde : super-admin seul ─────────────────────────────────────────
    reinit();
    let r = await verifier(EMPREINTE, { reason: 'Signalement #482' }, 1);
    assert.strictEqual(r.status, 403, 'un admin simple est refusé');
    assert.strictEqual(etat.journal.length, 0);

    // ── Motif obligatoire, empreinte bien formée ─────────────────────────
    reinit();
    r = await verifier(EMPREINTE, {});
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.corps.code, 'REASON_REQUIRED');
    r = await verifier(EMPREINTE, { reason: '  a  ' });
    assert.strictEqual(r.corps.code, 'REASON_REQUIRED', 'deux caractères ne font pas un motif');
    r = await verifier('pas-une-empreinte', { reason: 'Signalement #482' });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.corps.code, 'INVALID_FINGERPRINT');
    assert.strictEqual(etat.journal.length, 0, 'une saisie invalide ne cherche rien');

    // ── Empreinte inconnue : 404, mais la recherche est journalisée ──────
    reinit({ trace: null });
    r = await verifier(EMPREINTE, { reason: 'Fuite   signalée par RH' });
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.corps.code, 'FINGERPRINT_NOT_FOUND');
    assert.strictEqual(etat.journal.length, 1);
    const [adminId, action, route, cible, cibleId, motif, , , statut] = etat.journal[0];
    assert.deepStrictEqual(
      [adminId, action, route, cible, cibleId, motif, statut],
      [1, 'documents.trace', 'POST /documents-sensibles/empreintes/:code/verification', 'empreinte', EMPREINTE, 'Fuite signalée par RH', 404],
    );

    // ── Journal en panne : aucune réponse utile ──────────────────────────
    reinit({ journalEnPanne: true });
    r = await verifier(EMPREINTE, { reason: 'Signalement #482' });
    assert.strictEqual(r.status, 500, 'pas de trace, pas de résultat');
    assert.ok(!('auteur' in r.corps));

    // ── Fiche complète ───────────────────────────────────────────────────
    reinit();
    r = await verifier('3F9A 0C1E 5B7D 0000 1111 2222 3333 ABCD', { reason: 'Signalement #482' });
    assert.strictEqual(r.status, 200);
    const f = r.corps;
    assert.strictEqual(etat.journal[0][4], EMPREINTE, 'journal en hex minuscule');
    assert.strictEqual(etat.journal[0][8], 200);
    assert.strictEqual(f.date, '2026-11-05T13:32:07.000Z');
    assert.deepStrictEqual(
      [f.auteur.id, f.auteur.nom, f.auteur.statut, f.auteur.typeCompte],
      [10432, 'Jean M.', 'actif', 0],
    );
    assert.deepStrictEqual(
      [f.expediteur.id, f.expediteur.nom, f.expediteur.statut],
      [8812, null, 'supprime'],
      'expéditeur supprimé : il reste son numéro interne',
    );
    assert.strictEqual(f.session.connue, true);
    assert.strictEqual(f.session.ip, '41.202.1.1');
    assert.deepStrictEqual(f.session.autresComptes, [{ id: 555, nom: 'Double', numero: '237600000555' }]);
    assert.strictEqual(f.document.etat, 'purge', 'message absent : purgé, la trace reste');
    assert.deepStrictEqual(f.conversation, { id: 4410, existe: true, groupe: true, nom: 'Achats', membres: 12 });
    assert.strictEqual(f.historique.evenements.length, 3);
    assert.deepStrictEqual(f.historique.evenements.map((e) => e.cetteCopie), [false, true, false]);
    assert.strictEqual(f.historique.evenements[2].personne.supprime, true);
    assert.strictEqual(f.sortiesAuteur.total, 4);
    assert.strictEqual(f.sortiesAuteur.dernieres[0].document.nom, 'devis.pdf');
    assert.strictEqual(f.verifications.length, 1, 'la recherche en cours figure dans l\'historique des vérifications');
    assert.strictEqual(f.verifications[0].motif, 'Signalement #482');

    // Session d'avant la migration 026, ou effacée avec le compte.
    reinit({ appareil: null });
    r = await verifier(EMPREINTE, { reason: 'Signalement #482' });
    assert.deepStrictEqual(r.corps.session, { appareilId: '77', connue: false });
    reinit({ trace: { ...etat.trace, appareilId: null } });
    r = await verifier(EMPREINTE, { reason: 'Signalement #482' });
    assert.strictEqual(r.corps.session, null);

    // ── Statuts de compte ────────────────────────────────────────────────
    assert.strictEqual(ctrl.statutCompte(null), 'supprime');
    assert.strictEqual(ctrl.statutCompte({ uid: 1, exclus: 0 }), 'actif');
    assert.strictEqual(ctrl.statutCompte({ uid: 1, exclus: 1, excludeReason: 'spam' }), 'banni');
    assert.strictEqual(ctrl.statutCompte({ uid: 1, exclus: 1, excludeReason: 'self_delete_pending' }), 'suppression_programmee');

    // ── Résumé de la fiche : des nombres, aucune empreinte ───────────────
    reinit({ resume: { consultations: '3', copies: '2', derniereCopie: new Date('2026-11-05T13:32:07Z'), copiesDeSesEnvois: null } });
    const res = await fetch(`${base}/users/10432/documents-sensibles`);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), {
      consultations: 3, copies: 2, derniereCopie: '2026-11-05T13:32:07.000Z', copiesDeSesEnvois: 0,
    });
    const refus = await fetch(`${base}/users/10432/documents-sensibles`, { headers: { 'x-test-role': '1' } });
    assert.strictEqual(refus.status, 403);

    console.log('documentsSensibles (admin) : OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    serveur.close();
  }
})();
