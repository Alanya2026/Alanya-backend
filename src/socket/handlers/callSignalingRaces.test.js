/**
 * Courses de signalisation 1-à-1 relevées aux essais du 17/11 :
 *
 *  1. raccrochage pendant que `call_user` tourne encore : le destinataire ne
 *     doit jamais sonner, et l'appel ne laisse pas de ligne au journal ;
 *  2. appels croisés (A→B puis B→A, et les deux en même temps) : un seul
 *     appel, celui du premier, et `call_glare` à l'autre ;
 *  3. reprise confirmée avant l'échéance de son minuteur : l'appel survit.
 *
 * Faux pool, fausses notifications et faux répondeur injectés dans
 * `require.cache` : ni base, ni Firebase, ni Redis (repli mémoire).
 */
const assert = require('assert');

const A = 701;
const B = 702;

// ── Doublures ───────────────────────────────────────────────────────────────

let prochainId = 5000;
const appels = new Map(); // IDcall -> { idCaller, idReceiver, status }
const effaces = [];

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO callHistory/.test(texte)) {
      const id = prochainId++;
      appels.set(id, { idCaller: params[0], idReceiver: params[1], status: 0 });
      return [{ insertId: id }, []];
    }
    if (/^SELECT idCaller FROM callHistory WHERE IDcall/.test(texte)) {
      const a = appels.get(Number(params[0]));
      return [a ? [{ idCaller: a.idCaller }] : [], []];
    }
    if (/^DELETE FROM callHistory/.test(texte)) {
      effaces.push(Number(params[0]));
      appels.delete(Number(params[0]));
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO conversation/.test(texte)) return [{ insertId: 77 }, []];
    if (/FROM callHistory/.test(texte)) return [[], []];
    return [[{ conversID: 77 }], []];
  },
  getConnection: async () => ({
    beginTransaction: async () => {},
    execute: async () => [{ insertId: 77 }, []],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  }),
};

const notifs = [];
const fakeNotifications = {
  notifyIncomingCall: async (cible) => { notifs.push({ fn: 'incoming', cible }); },
  notifyGroupCall: async () => {},
  notifyCallEnded: async () => {},
  notifyVoicemailActive: async () => {},
};

/** Fait patienter `shouldInterceptCall` : c'est la fenêtre lente de call_user. */
let frein = null;
const fakeVoicemail = {
  shouldInterceptCall: async () => {
    if (frein) await frein;
    return { intercept: false, schedule: {} };
  },
  shouldFallBackToVoicemail: async () => ({ fallback: false, schedule: {} }),
  noAnswerDelayMs: (schedule, defaut) => defaut,
  isNoAnswerEnabled: () => false,
};

const stub = (chemin, exports) => {
  const p = require.resolve(chemin);
  require.cache[p] = { id: p, filename: p, loaded: true, exports, paths: [], children: [] };
};

stub('../../config/db', fakePool);
stub('../../services/notificationService', fakeNotifications);
stub('../../services/voicemailScheduleService', fakeVoicemail);
stub('../../utils/blockUtils', { isBlockedEitherWay: async () => false });
stub('../../utils/officialAccountGuard', { isOfficialAccount: async () => false });
stub('../../services/billing/outgoingGate', {
  checkOutgoing: async () => ({ allowed: true }),
  OUTGOING_DENIED: { code: 'SUBSCRIPTION_REQUIRED', message: '', feature: 'outgoing' },
});
stub('../../services/privacyPrefsService', { canCallUser: async () => true });

const callState = require('../state/callState');
const pendingCalls = require('../state/pendingCalls');
const callIntents = require('../state/callIntents');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callUser, endCall, endActiveCallForUser } = require('./calls');

// ── Faux socket / io ────────────────────────────────────────────────────────

function fakeSocket(userId) {
  const handlers = {};
  const emitted = [];
  return {
    id: `sock_${userId}`,
    alanyaID: userId,
    authenticated: true,
    deviceId: `dev_${userId}`,
    emit(event, payload) { emitted.push({ event, payload }); },
    join() {},
    on(event, handler) { handlers[event] = handler; },
    trigger(event, data, ack) { return handlers[event](data, ack); },
    get emitted() { return emitted; },
  };
}

function fakeIo() {
  const rooms = [];
  return {
    rooms,
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return { emit(event, payload) { rooms.push({ room, event, payload }); } };
    },
    in(room) {
      const connecte = room === `user_${A}` || room === `user_${B}`;
      return { fetchSockets: async () => (connecte ? [{ id: room, data: {} }] : []) };
    },
  };
}

const offre = { type: 'offer', sdp: 'v=0' };
const sonnePour = (io, cible) =>
  io.rooms.filter((r) => r.room === `user_${cible}` && r.event === 'incoming_call');

async function repartirDeZero() {
  for (const id of [A, B]) {
    await callState.clear(id);
    await pendingCalls.clear(id);
  }
  for (const id of appels.keys()) await callDeviceOwnership.release(String(id));
  appels.clear();
  effaces.length = 0;
  notifs.length = 0;
  frein = null;
  callIntents._resetMemory();
}

function prise() {
  let liberer;
  const p = new Promise((r) => { liberer = r; });
  return { p, liberer };
}

// ── 1. Raccrochage pendant la numérotation ──────────────────────────────────

async function testAnnulationPendantNumerotation() {
  await repartirDeZero();
  const io = fakeIo();
  const sockA = fakeSocket(A);
  callUser(io, sockA, new Map());
  endCall(io, sockA, new Map());

  const lent = prise();
  frein = lent.p;
  const enCours = sockA.trigger('call_user', { targetUserId: B, callerName: 'A', offer: offre });
  await new Promise((r) => setTimeout(r, 20));

  let accuse = null;
  await sockA.trigger('end_call', { targetUserId: B }, (r) => { accuse = r; });
  assert.strictEqual(accuse?.ok, true, 'raccrochage accusé');
  assert.strictEqual(accuse?.handled, 'cancelled_while_dialing', 'annulation mémorisée');

  lent.liberer();
  await enCours;

  assert.strictEqual(sonnePour(io, B).length, 0, 'B ne sonne pas');
  assert.strictEqual(notifs.length, 0, 'aucun push d’appel');
  assert.strictEqual(
    sockA.emitted.some((e) => e.event === 'call_ringing'), false,
    'aucune sonnerie de retour',
  );
  assert.strictEqual(await callState.getEntry(B), null, 'B reste libre');
  assert.strictEqual(await callState.getEntry(A), null, 'A reste libre');

  // Le suivant passe normalement : l'annulation ne déborde pas.
  await sockA.trigger('call_user', { targetUserId: B, callerName: 'A', offer: offre });
  assert.strictEqual(sonnePour(io, B).length, 1, 'l’appel suivant sonne');
  console.log('✓ raccrochage pendant la numérotation : rien ne sonne, l’appel suivant passe');
}

// ── 2. Appels croisés ───────────────────────────────────────────────────────

async function testCroisementSuccessif() {
  await repartirDeZero();
  const io = fakeIo();
  const sockA = fakeSocket(A);
  const sockB = fakeSocket(B);
  callUser(io, sockA, new Map());
  callUser(io, sockB, new Map());

  await sockA.trigger('call_user', { targetUserId: B, callerName: 'A', offer: offre });
  const appelDeA = [...appels.keys()][0];
  await sockB.trigger('call_user', { targetUserId: A, callerName: 'B', offer: offre });

  assert.strictEqual(appels.size, 1, 'un seul appel créé');
  const glare = sockB.emitted.find((e) => e.event === 'call_glare');
  assert.ok(glare, 'B reçoit call_glare');
  assert.strictEqual(glare.payload.callId, String(appelDeA), 'on garde l’appel de A');
  assert.strictEqual(glare.payload.peerId, String(A));
  assert.strictEqual(sonnePour(io, A).length, 0, 'A ne sonne pas');
  assert.ok(sonnePour(io, B).length >= 1, 'B voit l’appel de A');
  console.log('✓ croisement successif : un seul appel, call_glare au second');
}

async function testCroisementSimultane() {
  await repartirDeZero();
  const io = fakeIo();
  const sockA = fakeSocket(A);
  const sockB = fakeSocket(B);
  callUser(io, sockA, new Map());
  callUser(io, sockB, new Map());

  const lent = prise();
  frein = lent.p;
  const deA = sockA.trigger('call_user', { targetUserId: B, callerName: 'A', offer: offre });
  const deB = sockB.trigger('call_user', { targetUserId: A, callerName: 'B', offer: offre });
  await new Promise((r) => setTimeout(r, 30));
  lent.liberer();
  frein = null;
  await Promise.all([deA, deB]);

  assert.strictEqual(appels.size, 1, 'un seul appel malgré la simultanéité');
  const glares = [...sockA.emitted, ...sockB.emitted].filter((e) => e.event === 'call_glare');
  assert.strictEqual(glares.length, 1, 'un seul call_glare');
  console.log('✓ croisement simultané : verrou de paire, un seul appel');
}

// ── 3. Reprise confirmée avant le minuteur ──────────────────────────────────

async function testRepriseConfirmee() {
  await repartirDeZero();
  const io = fakeIo();
  await callState.setInCall(A, { callId: 6000, peerId: B });
  await callState.setInCall(B, { callId: 6000, peerId: A });

  await callIntents.clearResumeConfirmed(A);
  await callState.confirmResume(A);
  const solde = await endActiveCallForUser(io, new Map(), A, 'resume_ack_timeout');
  assert.strictEqual(solde, false, 'appel épargné');
  assert.strictEqual((await callState.getEntry(A))?.status, 'in_call', 'A toujours en appel');
  assert.strictEqual(
    io.rooms.some((r) => r.event === 'call_ended'), false,
    'personne ne reçoit call_ended',
  );

  // Sans confirmation, le délai solde l'appel et prévient LES DEUX côtés.
  await callIntents.clearResumeConfirmed(A);
  const solde2 = await endActiveCallForUser(io, new Map(), A, 'resume_ack_timeout');
  assert.strictEqual(solde2, true, 'appel soldé sans confirmation');
  const finis = io.rooms.filter((r) => r.event === 'call_ended').map((r) => r.room);
  assert.ok(finis.includes(`user_${B}`), 'le pair est prévenu');
  assert.ok(finis.includes(`user_${A}`), 'l’intéressé aussi');
  console.log('✓ reprise confirmée : épargnée ; non confirmée : les deux prévenus');
}

(async () => {
  try {
    await testAnnulationPendantNumerotation();
    await testCroisementSuccessif();
    await testCroisementSimultane();
    await testRepriseConfirmee();
    console.log('callSignalingRaces.test.js OK');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
