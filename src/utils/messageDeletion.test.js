/**
 * Suppression POUR TOUS : fenêtre de 72 h et autorité (expéditeur, administrateur
 * de groupe) — `node src/utils/messageDeletion.test.js`. Pur : aucune base.
 */
const assert = require('assert');
const del = require('./messageDeletion');

const { ROLE } = del;
const H = 3600 * 1000;
const MAINTENANT = Date.UTC(2026, 9, 11, 12, 0, 0);
const avant = (ms) => new Date(MAINTENANT - ms);

const msg = (over = {}) => ({
  senderID: 10, sendAt: avant(H), type: 0, isDeleted: 0, ...over,
});
const groupe = (roleActeur, roleAuteur = ROLE.MEMBRE) => ({ isGroup: true, roleActeur, roleAuteur });
const duo = { isGroup: false, roleActeur: ROLE.MEMBRE, roleAuteur: ROLE.MEMBRE };

const decide = (acteurID, message, contexte) => del.decider({ acteurID, message, contexte, maintenant: MAINTENANT });

const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);

/* ── Fenêtre ──────────────────────────────────────────────────────────── */

test('la fenêtre est de 72 heures', () => {
  assert.strictEqual(del.FENETRE_HEURES, 72);
  assert.strictEqual(del.FENETRE_MS, 72 * H);
});

test('frontières de la fenêtre : ouverte jusqu\'à 72 h pile, fermée une milliseconde après', () => {
  assert.strictEqual(del.fenetreOuverte(avant(0), MAINTENANT), true, 'à l\'instant');
  assert.strictEqual(del.fenetreOuverte(avant(71 * H + 59 * 60000), MAINTENANT), true, '71 h 59');
  assert.strictEqual(del.fenetreOuverte(avant(72 * H), MAINTENANT), true, '72 h pile');
  assert.strictEqual(del.fenetreOuverte(avant(72 * H + 1), MAINTENANT), false, '72 h + 1 ms');
  assert.strictEqual(del.fenetreOuverte(avant(73 * H), MAINTENANT), false);
  assert.strictEqual(del.fenetreOuverte(avant(365 * 24 * H), MAINTENANT), false, 'un an');
});

test('fenêtre : dates en chaîne ISO, en millisecondes, et dates illisibles (fermées)', () => {
  assert.strictEqual(del.fenetreOuverte(avant(H).toISOString(), MAINTENANT), true);
  assert.strictEqual(del.fenetreOuverte(avant(80 * H).toISOString(), MAINTENANT), false);
  assert.strictEqual(del.fenetreOuverte(MAINTENANT - H, MAINTENANT), true, 'nombre de ms');
  for (const mauvais of [null, undefined, '', 'pas une date', NaN, {}, [], 'Invalid Date']) {
    assert.strictEqual(del.fenetreOuverte(mauvais, MAINTENANT), false, `illisible : ${String(mauvais)}`);
  }
});

test('âge négatif (horloge du serveur qui recule) : reste ouvert', () => {
  assert.strictEqual(del.fenetreOuverte(new Date(MAINTENANT + 5000), MAINTENANT), true);
});

/* ── L'expéditeur ─────────────────────────────────────────────────────── */

test('expéditeur : peut supprimer son message dans la fenêtre, 1-1 comme groupe', () => {
  for (const contexte of [duo, groupe(ROLE.MEMBRE, ROLE.MEMBRE), groupe(ROLE.ADMIN, ROLE.ADMIN), groupe(ROLE.PROPRIETAIRE, ROLE.PROPRIETAIRE)]) {
    const r = decide(10, msg(), contexte);
    assert.deepStrictEqual(r, { ok: true, parAdmin: false, dejaSupprime: false }, JSON.stringify(contexte));
  }
});

test('expéditeur : refusé après 72 h, DELETE_WINDOW_EXPIRED 403, y compris un admin pour son propre message', () => {
  for (const contexte of [duo, groupe(ROLE.MEMBRE, ROLE.MEMBRE), groupe(ROLE.PROPRIETAIRE, ROLE.PROPRIETAIRE)]) {
    const r = decide(10, msg({ sendAt: avant(73 * H) }), contexte);
    assert.deepStrictEqual([r.ok, r.status, r.code], [false, 403, 'DELETE_WINDOW_EXPIRED'], JSON.stringify(contexte));
    assert.ok(/72 heures/.test(r.message));
  }
});

test('expéditeur : tous les types de message sont supprimables par leur auteur (comportement existant conservé)', () => {
  for (const type of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.strictEqual(decide(10, msg({ type }), duo).ok, true, `type ${type}`);
  }
});

/* ── L'administrateur de groupe ───────────────────────────────────────── */

test('admin : supprime le message d\'un membre, marqué « parAdmin »', () => {
  const r = decide(20, msg(), groupe(ROLE.ADMIN, ROLE.MEMBRE));
  assert.deepStrictEqual(r, { ok: true, parAdmin: true, dejaSupprime: false });
});

test('admin : la même fenêtre de 72 h s\'applique', () => {
  const r = decide(20, msg({ sendAt: avant(72 * H + 1) }), groupe(ROLE.ADMIN, ROLE.MEMBRE));
  assert.deepStrictEqual([r.ok, r.code], [false, 'DELETE_WINDOW_EXPIRED']);
  assert.strictEqual(decide(20, msg({ sendAt: avant(72 * H) }), groupe(ROLE.ADMIN, ROLE.MEMBRE)).ok, true);
});

test('admin : ne supprime ni le message d\'un autre admin ni celui du propriétaire', () => {
  for (const roleAuteur of [ROLE.ADMIN, ROLE.PROPRIETAIRE]) {
    const r = decide(20, msg(), groupe(ROLE.ADMIN, roleAuteur));
    assert.deepStrictEqual([r.ok, r.status, r.code], [false, 403, 'FORBIDDEN'], `auteur de rôle ${roleAuteur}`);
  }
});

test('propriétaire : supprime le message d\'un membre ou d\'un admin', () => {
  for (const roleAuteur of [ROLE.MEMBRE, ROLE.ADMIN]) {
    const r = decide(20, msg(), groupe(ROLE.PROPRIETAIRE, roleAuteur));
    assert.deepStrictEqual(r, { ok: true, parAdmin: true, dejaSupprime: false }, `auteur de rôle ${roleAuteur}`);
  }
});

test('auteur qui a quitté le groupe (rôle inconnu) : traité comme un membre', () => {
  const r = decide(20, msg(), { isGroup: true, roleActeur: ROLE.ADMIN, roleAuteur: null });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parAdmin, true);
});

test('membre simple : ne supprime pas le message d\'un autre', () => {
  const r = decide(20, msg(), groupe(ROLE.MEMBRE, ROLE.MEMBRE));
  assert.deepStrictEqual([r.ok, r.status, r.code], [false, 403, 'FORBIDDEN']);
});

test('conversation à deux : aucun pouvoir sur le message de l\'autre, quel que soit le rôle enregistré', () => {
  for (const roleActeur of [ROLE.MEMBRE, ROLE.ADMIN, ROLE.PROPRIETAIRE]) {
    const r = decide(20, msg(), { isGroup: false, roleActeur, roleAuteur: ROLE.MEMBRE });
    assert.deepStrictEqual([r.ok, r.code], [false, 'FORBIDDEN'], `rôle ${roleActeur}`);
  }
});

test('admin : ne modère pas un message système (6), de bienvenue (8) ou un trajet (9)', () => {
  for (const type of del.TYPES_NON_MODERABLES) {
    const r = decide(20, msg({ type }), groupe(ROLE.ADMIN, ROLE.MEMBRE));
    assert.deepStrictEqual([r.ok, r.code], [false, 'FORBIDDEN'], `type ${type}`);
  }
  assert.deepStrictEqual([...del.TYPES_NON_MODERABLES].sort(), [6, 8, 9]);
  for (const type of [0, 1, 2, 3, 4, 5, 7, 10]) {
    assert.strictEqual(decide(20, msg({ type }), groupe(ROLE.ADMIN, ROLE.MEMBRE)).ok, true, `type ${type} modérable`);
  }
});

/* ── Appartenance, idempotence ────────────────────────────────────────── */

test('non participant : 404 MESSAGE_NOT_FOUND, jamais un 403 qui confirmerait le message', () => {
  for (const contexte of [
    { isGroup: true, roleActeur: null, roleAuteur: ROLE.MEMBRE },
    { isGroup: false, roleActeur: undefined, roleAuteur: ROLE.MEMBRE },
    null,
    undefined,
  ]) {
    const r = decide(99, msg(), contexte);
    assert.deepStrictEqual([r.ok, r.status, r.code], [false, 404, 'MESSAGE_NOT_FOUND'], JSON.stringify(contexte));
  }
  // Même l'ex-membre qui est l'AUTEUR du message : il n'est plus dans la conversation.
  const exMembre = decide(10, msg(), { isGroup: true, roleActeur: null, roleAuteur: null });
  assert.strictEqual(exMembre.status, 404);
});

test('message déjà supprimé : idempotent, même après 72 h', () => {
  const r = decide(10, msg({ isDeleted: 1, sendAt: avant(200 * H) }), duo);
  assert.deepStrictEqual(r, { ok: true, parAdmin: false, dejaSupprime: true });
  assert.strictEqual(decide(20, msg({ isDeleted: true, sendAt: avant(200 * H) }), groupe(ROLE.ADMIN)).dejaSupprime, true);
});

test('message déjà supprimé : l\'autorité reste vérifiée (pas d\'oracle pour un tiers)', () => {
  const r = decide(20, msg({ isDeleted: 1 }), groupe(ROLE.MEMBRE, ROLE.MEMBRE));
  assert.deepStrictEqual([r.ok, r.code], [false, 'FORBIDDEN']);
});

test('identifiants en chaîne ou en nombre : comparés comme des nombres', () => {
  assert.strictEqual(decide('10', msg({ senderID: 10 }), duo).ok, true);
  assert.strictEqual(decide(10, msg({ senderID: '10' }), duo).ok, true);
  assert.strictEqual(decide(20, msg({ senderID: '10' }), groupe(ROLE.ADMIN, ROLE.MEMBRE)).parAdmin, true);
});

/* ── Lecture des rôles (base doublée) ─────────────────────────────────── */

test('chargerContextes : une requête, rôle de l\'acteur et des auteurs par conversation', async () => {
  const appels = [];
  const db = {
    execute: async (sql, params) => {
      appels.push([sql, params]);
      return [[
        { conversID: 1, isGroup: 1, alanyaID: 20, role: 1 },
        { conversID: 1, isGroup: 1, alanyaID: 10, role: 0 },
        { conversID: 2, isGroup: 0, alanyaID: 20, role: 0 },
      ], []];
    },
  };
  const lignes = [
    { msgID: 5, conversationID: 1, senderID: 10 },
    { msgID: 6, conversationID: 2, senderID: 30 },
    { msgID: 7, conversationID: 3, senderID: 40 },
  ];
  const ctx = await del.chargerContextes(db, 20, lignes);
  assert.strictEqual(appels.length, 1, 'une seule requête');
  assert.ok(/conv_participants/.test(appels[0][0]) && /\?/.test(appels[0][0]));
  assert.ok(!/\b1\b|\b20\b/.test(appels[0][0].replace(/\$\{[^}]*\}/g, '')), 'valeurs en paramètres, pas dans le SQL');
  assert.deepStrictEqual(appels[0][1].slice(0, 3), [1, 2, 3], 'conversations, sans doublon');
  assert.deepStrictEqual(del.contexteDe(ctx, lignes[0]), { isGroup: true, roleActeur: 1, roleAuteur: 0 });
  assert.deepStrictEqual(del.contexteDe(ctx, lignes[1]), { isGroup: false, roleActeur: 0, roleAuteur: null });
  assert.deepStrictEqual(del.contexteDe(ctx, lignes[2]), { isGroup: false, roleActeur: null, roleAuteur: null }, 'conversation sans l\'acteur');
});

test('chargerContextes : aucune ligne → aucune requête', async () => {
  let n = 0;
  const ctx = await del.chargerContextes({ execute: async () => { n += 1; return [[], []]; } }, 1, []);
  assert.strictEqual(n, 0);
  assert.strictEqual(ctx.size, 0);
});

(async () => {
  let ok = 0;
  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.stack.split('\n').slice(0, 4).join('\n  ')}`);
      process.exit(1);
    }
  }
  console.log(`messageDeletion.test.js : ${ok} tests OK`);
})();
