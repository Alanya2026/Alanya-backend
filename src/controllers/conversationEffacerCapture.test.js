/**
 * « Effacer la discussion » et « capture d'écran » par les contrôleurs réels —
 * `node src/controllers/conversationEffacerCapture.test.js`.
 *
 * Base en mémoire : le test vérifie l'ÉTAT (qui voit quoi après l'effacement, ce
 * qui est écrit dans le fil), pas qu'une requête est partie.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

let etat;
const neuf = () => {
  etat = {
    participants: [], // { conversID, alanyaID, unreadCount, historyCutoffAt }
    messages: [], // { conversationID, senderID, type, content, ageS }
    politique: { isDirect: true, action: 'deliver' },
    systeme: [], // appels à postSystemMessage
    postEchoue: false,
    maintenant: new Date('2026-10-11T08:00:00.000Z'),
  };
};

async function executer(sql, p = []) {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^UPDATE conv_participants SET historyCutoffAt = NOW\(\), unreadCount = 0 WHERE conversID = \? AND alanyaID = \?/.test(s)) {
    const r = etat.participants.find((x) => x.conversID === p[0] && x.alanyaID === p[1]);
    if (r) { r.historyCutoffAt = new Date(etat.maintenant); r.unreadCount = 0; }
    return [{ affectedRows: r ? 1 : 0 }, []];
  }
  if (/^SELECT historyCutoffAt FROM conv_participants WHERE conversID = \? AND alanyaID = \?/.test(s)) {
    const r = etat.participants.find((x) => x.conversID === p[0] && x.alanyaID === p[1]);
    return [r ? [{ historyCutoffAt: r.historyCutoffAt }] : [], []];
  }
  if (/^SELECT 1 FROM message WHERE conversationID = \? AND senderID = \? AND type = 6/.test(s)) {
    const trouve = etat.messages.some((m) => m.conversationID === p[0] && m.senderID === p[1]
      && m.type === 6 && m.ageS <= 60 && s.includes(`LIKE '%${m.content.slice(1, -1)}%'`));
    return [trouve ? [{ 1: 1 }] : [], []];
  }
  throw new Error(`requête non prévue par le test : ${s.slice(0, 120)}`);
}

remplace('../config/db', { execute: executer });
remplace('../utils/blockUtils', { evaluateDirectMessageSend: async () => etat.politique });
remplace('../utils/systemMessage', {
  postSystemMessage: async (a) => {
    etat.systeme.push(a);
    if (etat.postEchoue) return null;
    etat.messages.push({ conversationID: a.conversationID, senderID: a.actorID, type: 6, content: `{"e":"${a.event}"}`, ageS: 0 });
    return { msgID: 500 + etat.systeme.length };
  },
});
const { effacerDiscussion } = require('./conversationClearController');
const { signalerCapture, signalerEnregistrement } = require('./conversationScreenshotController');

const evenements = [];
const io = { to: (room) => ({ emit: (nom, charge) => evenements.push([room, nom, charge]) }) };

function appeler(fn, { conversID = 1, acteur }) {
  evenements.length = 0;
  return new Promise((resoudre) => {
    const req = {
      membership: { conversID }, user: { alanyaID: acteur },
      app: { get: (k) => (k === 'io' ? io : null) },
    };
    const res = {
      status: (st) => ({ json: (j) => resoudre({ statut: st, corps: j }) }),
      json: (j) => resoudre({ statut: 200, corps: j }),
    };
    fn(req, res, (e) => resoudre({ erreur: e })).catch((e) => resoudre({ erreur: e }));
  });
}

const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);
const deuxPersonnes = () => etat.participants.push(
  { conversID: 1, alanyaID: 7, unreadCount: 4, historyCutoffAt: null },
  { conversID: 1, alanyaID: 8, unreadCount: 2, historyCutoffAt: null },
);

/* ── Effacer la discussion ─────────────────────────────────────────────── */

test('pose le curseur du SEUL appelant, remet son non-lu à zéro, ne touche pas l\'autre', async () => {
  neuf(); deuxPersonnes();
  const r = await appeler(effacerDiscussion, { acteur: 7 });
  assert.strictEqual(r.statut, 200);
  assert.deepStrictEqual(r.corps, { conversationID: 1, historyCutoffAt: '2026-10-11T08:00:00.000Z' });
  const [moi, lui] = etat.participants;
  assert.strictEqual(moi.historyCutoffAt.toISOString(), '2026-10-11T08:00:00.000Z');
  assert.strictEqual(moi.unreadCount, 0);
  assert.strictEqual(lui.historyCutoffAt, null);
  assert.strictEqual(lui.unreadCount, 2);
});

test('diffuse « conversation:cleared » aux appareils de l\'appelant uniquement', async () => {
  neuf(); deuxPersonnes();
  await appeler(effacerDiscussion, { acteur: 7 });
  assert.deepStrictEqual(evenements, [['user_7', 'conversation:cleared', {
    conversationID: 1, historyCutoffAt: '2026-10-11T08:00:00.000Z',
  }]]);
});

test('rejouable : un second effacement avance le curseur sans erreur', async () => {
  neuf(); deuxPersonnes();
  await appeler(effacerDiscussion, { acteur: 7 });
  etat.maintenant = new Date('2026-10-11T09:00:00.000Z');
  const r = await appeler(effacerDiscussion, { acteur: 7 });
  assert.strictEqual(r.corps.historyCutoffAt, '2026-10-11T09:00:00.000Z');
});

test('une erreur de base est confiée à next(), sans exposer son message', async () => {
  neuf(); deuxPersonnes();
  const exec = executer;
  const pool = require('../config/db');
  pool.execute = async () => { throw new Error('secret interne'); };
  const r = await appeler(effacerDiscussion, { acteur: 7 });
  pool.execute = exec;
  assert.ok(r.erreur, 'erreur transmise au middleware');
});

/* ── Capture d'écran ───────────────────────────────────────────────────── */

test('discussion à deux : une ligne système « screenshot » est écrite, essentielle, avec io', async () => {
  neuf(); deuxPersonnes();
  const r = await appeler(signalerCapture, { acteur: 7 });
  assert.deepStrictEqual(r.corps, { posted: true, msgID: 501 });
  assert.strictEqual(etat.systeme.length, 1);
  const a = etat.systeme[0];
  assert.deepStrictEqual([a.conversationID, a.actorID, a.event, a.essential], [1, 7, 'screenshot', true]);
  assert.strictEqual(a.io, io);
});

test('groupe ou conversation avec soi-même : rien d\'écrit', async () => {
  neuf(); deuxPersonnes();
  etat.politique = { isDirect: false };
  const r = await appeler(signalerCapture, { acteur: 7 });
  assert.deepStrictEqual(r.corps, { posted: false, reason: 'not_direct' });
  assert.strictEqual(etat.systeme.length, 0);
});

test('bloqué, ayant bloqué, ou compte officiel : rien d\'écrit, même réponse neutre', async () => {
  for (const action of ['reject', 'silent']) {
    neuf(); deuxPersonnes();
    etat.politique = { isDirect: true, action };
    const r = await appeler(signalerCapture, { acteur: 7 });
    assert.deepStrictEqual(r.corps, { posted: false, reason: 'not_allowed' });
    assert.strictEqual(etat.systeme.length, 0);
  }
});

test('anti-rafale : une seconde capture dans la minute n\'écrit rien ; passé la minute, oui', async () => {
  neuf(); deuxPersonnes();
  assert.strictEqual((await appeler(signalerCapture, { acteur: 7 })).corps.posted, true);
  const deuxieme = await appeler(signalerCapture, { acteur: 7 });
  assert.deepStrictEqual(deuxieme.corps, { posted: false, reason: 'throttled' });
  assert.strictEqual(etat.systeme.length, 1);
  etat.messages.forEach((m) => { m.ageS = 61; });
  assert.strictEqual((await appeler(signalerCapture, { acteur: 7 })).corps.posted, true);
});

test('l\'anti-rafale est par auteur : l\'autre participant peut signaler la sienne', async () => {
  neuf(); deuxPersonnes();
  await appeler(signalerCapture, { acteur: 7 });
  assert.strictEqual((await appeler(signalerCapture, { acteur: 8 })).corps.posted, true);
});

test('écriture impossible : 200 « failed », jamais d\'erreur côté client', async () => {
  neuf(); deuxPersonnes();
  etat.postEchoue = true;
  const r = await appeler(signalerCapture, { acteur: 7 });
  assert.deepStrictEqual([r.statut, r.corps], [200, { posted: false, reason: 'failed' }]);
});

/* ── Enregistrement d'écran ────────────────────────────────────────────── */

test('enregistrement : une ligne système « screen_recording », essentielle', async () => {
  neuf(); deuxPersonnes();
  const r = await appeler(signalerEnregistrement, { acteur: 7 });
  assert.deepStrictEqual(r.corps, { posted: true, msgID: 501 });
  const a = etat.systeme[0];
  assert.deepStrictEqual([a.conversationID, a.actorID, a.event, a.essential], [1, 7, 'screen_recording', true]);
});

test('enregistrement : groupe et blocage refusés comme pour la capture', async () => {
  neuf(); deuxPersonnes();
  etat.politique = { isDirect: false };
  assert.deepStrictEqual((await appeler(signalerEnregistrement, { acteur: 7 })).corps, { posted: false, reason: 'not_direct' });
  etat.politique = { isDirect: true, action: 'reject' };
  assert.deepStrictEqual((await appeler(signalerEnregistrement, { acteur: 7 })).corps, { posted: false, reason: 'not_allowed' });
  assert.strictEqual(etat.systeme.length, 0);
});

test('anti-rafale par événement : une capture n\'empêche pas de dire l\'enregistrement, ni l\'inverse', async () => {
  neuf(); deuxPersonnes();
  assert.strictEqual((await appeler(signalerCapture, { acteur: 7 })).corps.posted, true);
  assert.strictEqual((await appeler(signalerEnregistrement, { acteur: 7 })).corps.posted, true);
  assert.deepStrictEqual((await appeler(signalerEnregistrement, { acteur: 7 })).corps, { posted: false, reason: 'throttled' });
  assert.deepStrictEqual((await appeler(signalerCapture, { acteur: 7 })).corps, { posted: false, reason: 'throttled' });
});

(async () => {
  let ko = 0;
  for (const [nom, fn] of tests) {
    try { await fn(); console.log(`✓ ${nom}`); } catch (e) { ko += 1; console.log(`✗ ${nom}\n  ${e.stack}`); }
  }
  if (ko) process.exit(1);
  console.log(`conversationEffacerCapture.test.js : ${tests.length} tests OK`);
})();
