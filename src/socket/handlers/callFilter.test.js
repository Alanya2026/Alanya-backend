/**
 * Filtre d'appels : filtre allumé, quelqu'un qui n'est pas dans mes contacts ne
 * peut pas me faire sonner, par aucun des trois chemins (appel direct, ajout à
 * un appel, appel de groupe).
 *
 * Comme pour le répondeur, l'essentiel se joue sur ce qui N'EST PAS fait :
 * aucune sonnerie, aucun push, aucune ligne au journal. D'où les assertions
 * négatives. Faux pool et fausses notifications injectés dans `require.cache`
 * avant le chargement du handler : aucune base, aucun Firebase.
 */
const assert = require('assert');

const INCONNU = 901;
const CIBLE = 902;
const AUTRE_INVITE = 903;
const AMI = 904;

// ── Doublures ───────────────────────────────────────────────────────────────

/** alanyaID → filtre allumé. */
const filtres = new Map();
/** Lien « idFriend est dans les contacts de alanyaID », sous la forme `a:b`. */
const contacts = new Set();
const historique = [];
const ecritures = [];

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    if (/FROM user_privacy_prefs/.test(texte)) {
      return filtres.has(params[0])
        ? [[{ alanyaID: params[0], callsFromContactsOnly: filtres.get(params[0]) }], []]
        : [[], []];
    }
    if (/FROM preferredContact/.test(texte)) {
      return [contacts.has(`${params[0]}:${params[1]}`) ? [{ 1: 1 }] : [], []];
    }
    if (/^INSERT INTO user_privacy_prefs/.test(texte)) {
      ecritures.push({ sql: texte, params });
      return [{ affectedRows: 1 }, []];
    }
    if (/^INSERT INTO callHistory/.test(texte)) {
      historique.push(params);
      return [{ insertId: 4242 }, []];
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
  notifyGroupCall: async (cibles) => { notifs.push({ fn: 'group', cibles }); },
  notifyCallEnded: async () => {},
  notifyVoicemailActive: async () => {},
};

let repondeurInterroge = 0;
const fakeVoicemail = {
  shouldInterceptCall: async () => {
    repondeurInterroge += 1;
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

const privacy = require('../../services/privacyPrefsService');
const callState = require('../state/callState');
const pendingCalls = require('../state/pendingCalls');
const callDeviceOwnership = require('../state/callDeviceOwnership');
const { callUser, addParticipant, createGroupCall } = require('./calls');
const { patchPrivacyPrefs } = require('../../controllers/privacyPrefsController');
const { createCall } = require('../../controllers/callController');

let droitAuFiltre = true;
privacy._setCallFilterRightChecker(async () => droitAuFiltre);

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
    async trigger(event, data) { await handlers[event](data); },
    get emitted() { return emitted; },
  };
}

function fakeIo(enLigne = [INCONNU, CIBLE, AUTRE_INVITE, AMI]) {
  const rooms = [];
  return {
    rooms,
    sockets: { adapter: { rooms: new Map() } },
    to(room) {
      return { emit(event, payload) { rooms.push({ room, event, payload }); } };
    },
    in(room) {
      const connecte = enLigne.some((id) => room === `user_${id}`);
      return { fetchSockets: async () => (connecte ? [{ id: room, data: {} }] : []) };
    },
  };
}

async function appeler(appelant) {
  const io = fakeIo();
  const sock = fakeSocket(appelant);
  callUser(io, sock, new Map());
  await sock.trigger('call_user', {
    targetUserId: CIBLE,
    callerName: 'Appelant',
    isVideo: false,
    offer: { type: 'offer', sdp: 'v=0' },
  });
  return { io, sock };
}

async function repartirDeZero() {
  for (const id of [INCONNU, CIBLE, AUTRE_INVITE, AMI]) {
    await callState.clear(id);
    await pendingCalls.clear(id);
  }
  await callDeviceOwnership.release('4242');
  filtres.clear();
  contacts.clear();
  historique.length = 0;
  ecritures.length = 0;
  notifs.length = 0;
  repondeurInterroge = 0;
  droitAuFiltre = true;
}

const sonne = (io, cible) =>
  io.rooms.some((r) => r.room === `user_${cible}` && r.event === 'incoming_call');

/** L'appel a sonné : journal écrit, cible avertie en direct et par push. */
function assertSonne(io, sock) {
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_failed'), false,
    'aucun refus',
  );
  assert.strictEqual(sonne(io, CIBLE), true, 'la cible sonne');
  assert.ok(notifs.some((n) => n.fn === 'incoming' && n.cible === CIBLE), 'push parti');
  assert.strictEqual(historique.length, 1, 'une ligne au journal');
}

/** L'appel n'est pas passé : l'appelant le sait, la cible n'en sait rien. */
function assertImpossible(io, sock) {
  const refus = sock.emitted.find((e) => e.event === 'call_failed');
  assert.ok(refus, 'l’appelant reçoit un refus');
  assert.strictEqual(refus.payload.code, 'CALL_BLOCKED', 'même refus qu’un blocage');
  assert.strictEqual(refus.payload.reason, 'Appel impossible');
  assert.strictEqual(sonne(io, CIBLE), false, 'aucune sonnerie en direct');
  assert.strictEqual(notifs.length, 0, 'aucun push');
  assert.strictEqual(historique.length, 0, 'rien au journal');
  assert.strictEqual(repondeurInterroge, 0, 'pas de message à laisser');
  assert.strictEqual(
    sock.emitted.some((e) => e.event === 'call_ringing'), false,
    'aucune sonnerie de retour',
  );
}

async function testAppelDirect() {
  await repartirDeZero();
  let r = await appeler(INCONNU);
  assertSonne(r.io, r.sock);

  // Filtre présent en base mais éteint : la même chose.
  await repartirDeZero();
  filtres.set(CIBLE, 0);
  r = await appeler(INCONNU);
  assertSonne(r.io, r.sock);

  // Filtre allumé, appelant inconnu : impossible.
  await repartirDeZero();
  filtres.set(CIBLE, 1);
  r = await appeler(INCONNU);
  assertImpossible(r.io, r.sock);

  // Filtre allumé, appelant dans les contacts : ça sonne.
  await repartirDeZero();
  filtres.set(CIBLE, 1);
  contacts.add(`${CIBLE}:${AMI}`);
  r = await appeler(AMI);
  assertSonne(r.io, r.sock);

  // Le sens compte : c'est la cible qui doit avoir inscrit l'appelant.
  await repartirDeZero();
  filtres.set(CIBLE, 1);
  contacts.add(`${INCONNU}:${CIBLE}`);
  r = await appeler(INCONNU);
  assertImpossible(r.io, r.sock);

  // Abonnement fini : le filtre ne s'applique plus, le téléphone sonne.
  await repartirDeZero();
  filtres.set(CIBLE, 1);
  droitAuFiltre = false;
  r = await appeler(INCONNU);
  assertSonne(r.io, r.sock);
}

async function testAjoutAUnAppel() {
  await repartirDeZero();
  filtres.set(CIBLE, 1);
  contacts.add(`${CIBLE}:${AUTRE_INVITE}`); // Connaît l'autre présent, pas l'inviteur.
  await callState.setInCall(INCONNU, { callId: 'origine', peerId: AUTRE_INVITE });
  await callState.setInCall(AUTRE_INVITE, { callId: 'origine', peerId: INCONNU });

  const io = fakeIo();
  const sock = fakeSocket(INCONNU);
  addParticipant(io, sock, new Map());
  await sock.trigger('call_add_participant', { targetUserId: String(CIBLE), mode: 'join' });

  const refus = sock.emitted.find((e) => e.event === 'call_add_rejected');
  assert.ok(refus, 'l’invitation est refusée');
  assert.strictEqual(refus.payload.code, 'TARGET_BLOCKED');
  assert.strictEqual(notifs.length, 0, 'aucun push');
  assert.strictEqual(
    io.rooms.some((r) => r.room === `user_${CIBLE}`), false,
    'rien n’arrive à l’invité',
  );
}

async function testAppelDeGroupe() {
  await repartirDeZero();
  filtres.set(CIBLE, 1);

  const io = fakeIo();
  const sock = fakeSocket(INCONNU);
  createGroupCall(io, sock, new Map());
  await sock.trigger('create_group_call', {
    roomId: 'salon-filtre-1',
    callerName: 'Appelant',
    isVideo: false,
    targetUserIds: [String(CIBLE), String(AUTRE_INVITE)],
  });

  const invites = io.rooms.filter((r) => r.event === 'group_call_invite').map((r) => r.room);
  assert.deepStrictEqual(invites, [`user_${AUTRE_INVITE}`], 'seul l’invité sans filtre sonne');
  await new Promise((fini) => setImmediate(fini));
  const push = notifs.find((n) => n.fn === 'group');
  assert.ok(push, 'le push part pour les autres');
  assert.deepStrictEqual(push.cibles, [AUTRE_INVITE], 'aucun push pour le filtré');
}

async function testCheminRest() {
  await repartirDeZero();
  filtres.set(CIBLE, 1);
  contacts.add(`${CIBLE}:${AMI}`);

  let res = fausseReponse();
  await createCall({ user: { alanyaID: INCONNU }, body: { idReceiver: CIBLE }, headers: {} }, res);
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.corps.code, 'CALL_BLOCKED');
  assert.strictEqual(historique.length, 0, 'rien au journal');

  res = fausseReponse();
  await createCall({ user: { alanyaID: AMI }, body: { idReceiver: CIBLE }, headers: {} }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(historique.length, 1, 'le contact passe');
}

async function testEcritureDuReglage() {
  await repartirDeZero();

  // Réglage voisin : la colonne de la migration 115 n'est pas citée, pour que
  // l'enregistrement marche encore sur une base pas encore migrée.
  await privacy.upsertUserPrivacyPrefs(CIBLE, { lastSeenVisibility: 'contacts' });
  assert.strictEqual(/callsFromContactsOnly/.test(ecritures[0].sql), false);
  assert.strictEqual(ecritures[0].params.length, 7);

  await privacy.upsertUserPrivacyPrefs(CIBLE, { callsFromContactsOnly: 1 });
  assert.strictEqual(/callsFromContactsOnly = VALUES/.test(ecritures[1].sql), true);
  assert.strictEqual(ecritures[1].params.length, 8);
  assert.strictEqual(ecritures[1].params[7], 1);
}

function fausseReponse() {
  const res = {
    statusCode: 200,
    corps: null,
    status(code) { this.statusCode = code; return this; },
    json(corps) { this.corps = corps; return this; },
  };
  return res;
}

async function patcher(corps) {
  const res = fausseReponse();
  await patchPrivacyPrefs({ user: { alanyaID: CIBLE }, body: corps, headers: {} }, res);
  return res;
}

async function testAllumage() {
  // Sans le droit : on n'allume pas, et rien n'est écrit.
  await repartirDeZero();
  droitAuFiltre = false;
  let res = await patcher({ callsFromContactsOnly: true });
  assert.strictEqual(res.statusCode, 403);
  assert.strictEqual(res.corps.code, 'SUBSCRIPTION_REQUIRED');
  assert.strictEqual(res.corps.feature, 'call_filter');
  assert.strictEqual(ecritures.length, 0);

  // Sans le droit : on peut toujours éteindre.
  await repartirDeZero();
  droitAuFiltre = false;
  res = await patcher({ callsFromContactsOnly: false });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.callsFromContactsOnly, false);
  assert.strictEqual(ecritures.length, 1);

  // Avec le droit : allumé, et le téléphone le relit en booléen.
  await repartirDeZero();
  res = await patcher({ callsFromContactsOnly: true });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.corps.callsFromContactsOnly, true);
  assert.strictEqual(ecritures[0].params[7], 1);

  // Le droit n'est pas consulté pour les autres réglages.
  await repartirDeZero();
  droitAuFiltre = false;
  res = await patcher({ lastSeenVisibility: 'nobody' });
  assert.strictEqual(res.statusCode, 200);
}

async function main() {
  await testAppelDirect();
  await testAjoutAUnAppel();
  await testAppelDeGroupe();
  await testCheminRest();
  await testEcritureDuReglage();
  await testAllumage();
  console.log('✓ callFilter : l’inconnu ne fait sonner personne, le contact passe, l’abonnement décide');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
