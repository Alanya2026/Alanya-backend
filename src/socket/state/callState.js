// Registre autoritaire de l'état d'appel 1-à-1, indexé par userId.
//
// Sert à répondre « occupé » (busy) immédiatement quand une cible est déjà en
// train de sonner ou en communication, et à nettoyer proprement les deux
// participants sur tous les états terminaux (réponse, refus, fin, timeout,
// déconnexion).
//
// Statuts possibles : 'idle' (implicite, absent) | 'ringing' | 'in_call'
//
// Deux implémentations : Redis (partagée entre instances pm2) si REDIS_URL
// est configuré, sinon repli sur une Map locale au process (comportement
// mono-instance identique à avant l'intégration Redis). Le choix se fait à
// chaque appel via getDataClient().
//
// Repli mémoire : chaque entrée porte directement les handles setTimeout
// (noAnswerTimer, disconnectTimer, resumeAckTimer, resumeOwnerMissingTimer).
// Redis : ces handles n'existent pas (rien à sérialiser) — l'armement d'un
// délai devient une ligne dans job_queue (voir src/services/callStateWorkers.js,
// calqué sur tripWorkers.js), et son existence se vérifie via hasJob(), pas
// via une lecture directe de champ. `disconnectTimer` reste un seul kind
// ('call_disconnect_grace') partagé par scheduleDisconnectGrace et
// scheduleRingingDisconnectGrace — mutuellement exclusifs par statut, comme
// aujourd'hui le champ unique disconnectTimer.
//
// Sécurité multi-instance : le worker qui exécute un job verrouillé
// (SELECT...FOR UPDATE SKIP LOCKED) ne peut plus être annulé par un
// cancelByDedupeKey concurrent une fois le verrou posé — contrairement à
// clearTimeout(), garanti si appelé avant déclenchement. Chaque handler
// enregistré dans callStateWorkers.js DOIT donc revalider l'état courant
// avant d'agir (déjà le cas pour onNoAnswer dans calls.js, qui revérifie
// systématiquement le statut avant sa cascade).

const { getDataClient } = require('../../config/redisData');
const { enqueue, cancelByDedupeKey, hasJob } = require('../../services/jobQueue');
const callIntents = require('./callIntents');

const DISCONNECT_GRACE_MS = 45 * 1000;
// Grâce courte quand une socket tombe pendant la sonnerie (reconnexion cold-start).
const RINGING_DISCONNECT_GRACE_MS = 10 * 1000;
// Marge au-delà du timer no-answer (45 s) pour purger un état « ringing » fantôme.
const STALE_RINGING_MS = 50 * 1000;
// Délai pour recevoir call_resume_ack après auth (sinon l'appel in_call est soldé).
const RESUME_ACK_MS = 8 * 1000;
// in_call sans activeOwnerDeviceId : timeout dédié (indépendant de disconnectGrace).
const RESUME_OWNER_MISSING_TIMEOUT_MS = 8 * 1000;
// Sonnerie sans réponse — dupliqué de calls.js:NO_ANSWER_MS (constante isolée,
// pas de dépendance circulaire vers calls.js pour si peu).
const NO_ANSWER_MS = 45 * 1000;

const KINDS = ['call_no_answer', 'call_disconnect_grace', 'call_resume_ack', 'call_resume_owner_missing'];
const dedupe = (userId) => `call_state_${Number(userId)}`;
const keyOf = (userId) => `alanya:callState:${userId}`;

function _samePeer(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function isStaleRinging(entry) {
  if (!entry || entry.status !== 'ringing') return false;
  const since = entry.ringingSince ?? 0;
  if (!since) return false;
  return Date.now() - since > STALE_RINGING_MS;
}

// ── Repli mémoire (userId(Number) -> entry) ─────────────────────────────────
// entry: { status, callId, peerId, noAnswerTimer, disconnectTimer,
//          resumeAckTimer, resumeOwnerMissingTimer, lastAnswer, isVideo, ringingSince }
const _states = new Map();

function _memGetEntry(userId) {
  if (userId == null) return null;
  return _states.get(userId) ?? null;
}

function _memClearTimers(entry) {
  if (!entry) return;
  if (entry.noAnswerTimer) { clearTimeout(entry.noAnswerTimer); entry.noAnswerTimer = null; }
  if (entry.disconnectTimer) { clearTimeout(entry.disconnectTimer); entry.disconnectTimer = null; }
  if (entry.resumeAckTimer) { clearTimeout(entry.resumeAckTimer); entry.resumeAckTimer = null; }
  if (entry.resumeOwnerMissingTimer) { clearTimeout(entry.resumeOwnerMissingTimer); entry.resumeOwnerMissingTimer = null; }
}

function _memSetRinging(userId, { callId = null, peerId = null, isVideo = false } = {}) {
  if (userId == null) return;
  const prev = _states.get(userId);
  _memClearTimers(prev);
  _states.set(userId, {
    status: 'ringing',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    noAnswerTimer: null,
    disconnectTimer: null,
    resumeAckTimer: null,
    resumeOwnerMissingTimer: null,
    lastAnswer: prev?.lastAnswer ?? null,
    isVideo: !!isVideo,
    ringingSince: Date.now(),
  });
}

function _memSetInGroup(userId, roomId) {
  if (userId == null) return false;
  const prev = _states.get(userId);
  if (!canRecordGroupCall(prev?.status ?? null)) return false;
  _memClearTimers(prev);
  _states.set(userId, {
    status: 'in_group',
    callId: roomId != null ? String(roomId) : (prev?.callId ?? null),
    peerId: null,
    noAnswerTimer: null,
    disconnectTimer: null,
    resumeAckTimer: null,
    resumeOwnerMissingTimer: null,
    lastAnswer: null,
    isVideo: !!prev?.isVideo,
    ringingSince: null,
  });
  return true;
}

function _memSetInCall(userId, { callId = null, peerId = null, lastAnswer = undefined, isVideo = undefined } = {}) {
  if (userId == null) return;
  const prev = _states.get(userId);
  _memClearTimers(prev);
  _states.set(userId, {
    status: 'in_call',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    noAnswerTimer: null,
    disconnectTimer: null,
    resumeAckTimer: null,
    resumeOwnerMissingTimer: null,
    lastAnswer: lastAnswer !== undefined ? lastAnswer : (prev?.lastAnswer ?? null),
    isVideo: isVideo !== undefined ? !!isVideo : !!prev?.isVideo,
    ringingSince: null,
  });
}

function _memClear(userId) {
  if (userId == null) return;
  const prev = _states.get(userId);
  _memClearTimers(prev);
  _states.delete(userId);
}

function _memSetPeer(userId, peerId) {
  const entry = _memGetEntry(userId);
  if (!entry) return false;
  entry.peerId = peerId != null ? peerId : null;
  return true;
}

function _memCancelDisconnectGrace(userId) {
  const entry = _memGetEntry(userId);
  if (!entry?.disconnectTimer) return;
  clearTimeout(entry.disconnectTimer);
  entry.disconnectTimer = null;
}

function _memCancelResumeAck(userId) {
  const entry = _memGetEntry(userId);
  if (!entry?.resumeAckTimer) return;
  clearTimeout(entry.resumeAckTimer);
  entry.resumeAckTimer = null;
}

function _memCancelResumeOwnerMissing(userId) {
  const entry = _memGetEntry(userId);
  if (!entry?.resumeOwnerMissingTimer) return;
  clearTimeout(entry.resumeOwnerMissingTimer);
  entry.resumeOwnerMissingTimer = null;
}

function _memCancelNoAnswer(userId) {
  const entry = _memGetEntry(userId);
  if (!entry?.noAnswerTimer) return;
  clearTimeout(entry.noAnswerTimer);
  entry.noAnswerTimer = null;
}

function _memScheduleNoAnswer(userId, onExpire, ms) {
  if (userId == null || typeof onExpire !== 'function') return;
  const entry = _memGetEntry(userId);
  if (!entry || entry.status !== 'ringing') return;
  _memCancelNoAnswer(userId);
  entry.noAnswerTimer = setTimeout(() => { entry.noAnswerTimer = null; onExpire(); }, ms);
}

function _memScheduleResumeAck(userId, onExpire, ms) {
  if (userId == null || typeof onExpire !== 'function') return;
  const entry = _memGetEntry(userId);
  if (!entry || entry.status !== 'in_call') return;
  _memCancelResumeAck(userId);
  _memCancelResumeOwnerMissing(userId);
  entry.resumeAckTimer = setTimeout(() => { entry.resumeAckTimer = null; onExpire(); }, ms);
}

function _memScheduleResumeOwnerMissing(userId, onExpire, ms) {
  if (userId == null || typeof onExpire !== 'function') return;
  const entry = _memGetEntry(userId);
  if (!entry || entry.status !== 'in_call') return;
  if (entry.resumeOwnerMissingTimer) return; // déjà armé
  _memCancelResumeAck(userId);
  entry.resumeOwnerMissingTimer = setTimeout(() => { entry.resumeOwnerMissingTimer = null; onExpire(); }, ms);
}

function _memScheduleDisconnectGrace(userId, onExpire) {
  if (userId == null || typeof onExpire !== 'function') return;
  const entry = _memGetEntry(userId);
  if (!entry || entry.status !== 'in_call') return;
  _memCancelDisconnectGrace(userId);
  entry.disconnectTimer = setTimeout(() => { entry.disconnectTimer = null; onExpire(); }, DISCONNECT_GRACE_MS);
}

// Grâce courte pour une déconnexion socket PENDANT la sonnerie : le destinataire
// qui démarre à froid (accept depuis notification, app tuée) peut perdre sa
// première socket avant que l'appel soit répondu. Terminer l'appel immédiatement
// rendait l'accept cold-start impossible ; le timer no-answer (45 s) reste le
// filet si personne ne se reconnecte. Annulée par `auth:login`
// (cancelDisconnectGrace) et par toute transition d'état (_memClearTimers).
function _memScheduleRingingDisconnectGrace(userId, onExpire) {
  if (userId == null || typeof onExpire !== 'function') return;
  const entry = _memGetEntry(userId);
  if (!entry || entry.status !== 'ringing') return;
  _memCancelDisconnectGrace(userId);
  entry.disconnectTimer = setTimeout(() => { entry.disconnectTimer = null; onExpire(); }, RINGING_DISCONNECT_GRACE_MS);
}

// ── Redis (entry sans handles de timer : {status, callId, peerId, lastAnswer, isVideo, ringingSince}) ──

async function _redisGetEntry(client, userId) {
  const raw = await client.get(keyOf(userId));
  return raw ? JSON.parse(raw) : null;
}

async function _redisWriteEntry(client, userId, entry) {
  await client.set(keyOf(userId), JSON.stringify(entry));
}

async function _redisSetRinging(client, userId, { callId = null, peerId = null, isVideo = false } = {}) {
  const prev = await _redisGetEntry(client, userId);
  await cancelByDedupeKey(dedupe(userId), KINDS);
  await _redisWriteEntry(client, userId, {
    status: 'ringing',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    lastAnswer: prev?.lastAnswer ?? null,
    isVideo: !!isVideo,
    ringingSince: Date.now(),
  });
}

async function _redisSetInCall(client, userId, { callId = null, peerId = null, lastAnswer = undefined, isVideo = undefined } = {}) {
  const prev = await _redisGetEntry(client, userId);
  await cancelByDedupeKey(dedupe(userId), KINDS);
  await _redisWriteEntry(client, userId, {
    status: 'in_call',
    callId: callId != null ? String(callId) : (prev?.callId ?? null),
    peerId: peerId != null ? peerId : (prev?.peerId ?? null),
    lastAnswer: lastAnswer !== undefined ? lastAnswer : (prev?.lastAnswer ?? null),
    isVideo: isVideo !== undefined ? !!isVideo : !!prev?.isVideo,
    ringingSince: null,
  });
}

async function _redisSetInGroup(client, userId, roomId) {
  const prev = await _redisGetEntry(client, userId);
  if (!canRecordGroupCall(prev?.status ?? null)) return false;
  await _redisWriteEntry(client, userId, {
    status: 'in_group',
    callId: roomId != null ? String(roomId) : (prev?.callId ?? null),
    peerId: null,
    lastAnswer: null,
    isVideo: !!prev?.isVideo,
    ringingSince: null,
  });
  return true;
}

async function _redisClear(client, userId) {
  await cancelByDedupeKey(dedupe(userId), KINDS);
  await client.del(keyOf(userId));
}

async function _redisSetPeer(client, userId, peerId) {
  const entry = await _redisGetEntry(client, userId);
  if (!entry) return false;
  entry.peerId = peerId != null ? peerId : null;
  await _redisWriteEntry(client, userId, entry);
  return true;
}

async function _redisScheduleNoAnswer(client, userId, ms) {
  const entry = await _redisGetEntry(client, userId);
  if (!entry || entry.status !== 'ringing') return;
  await cancelByDedupeKey(dedupe(userId), ['call_no_answer']);
  await enqueue(
    'call_no_answer',
    { targetID: userId, callID: entry.callId, callerID: entry.peerId },
    { dedupeKey: dedupe(userId), runAfter: new Date(Date.now() + ms) },
  );
}

async function _redisScheduleResumeAck(client, userId, ms) {
  const entry = await _redisGetEntry(client, userId);
  if (!entry || entry.status !== 'in_call') return;
  await cancelByDedupeKey(dedupe(userId), ['call_resume_ack', 'call_resume_owner_missing']);
  await enqueue(
    'call_resume_ack',
    { userID: userId, callKey: entry.callId != null ? String(entry.callId) : null },
    { dedupeKey: dedupe(userId), runAfter: new Date(Date.now() + ms) },
  );
}

async function _redisScheduleResumeOwnerMissing(client, userId, ms) {
  const entry = await _redisGetEntry(client, userId);
  if (!entry || entry.status !== 'in_call') return;
  // Pas de pré-check "déjà armé" : enqueue() est un no-op silencieux si la
  // clé (kind, dedupeKey) existe déjà (ON DUPLICATE KEY UPDATE id=id) — c'est
  // exactement la sémantique "déjà armé, ne pas re-planifier" recherchée ici.
  await cancelByDedupeKey(dedupe(userId), ['call_resume_ack']);
  await enqueue(
    'call_resume_owner_missing',
    { userID: userId, callKey: entry.callId != null ? String(entry.callId) : null },
    { dedupeKey: dedupe(userId), runAfter: new Date(Date.now() + ms) },
  );
}

async function _redisScheduleDisconnectGrace(client, userId) {
  const entry = await _redisGetEntry(client, userId);
  if (!entry || entry.status !== 'in_call') return;
  await cancelByDedupeKey(dedupe(userId), ['call_disconnect_grace']);
  await enqueue(
    'call_disconnect_grace',
    { userID: userId, callKey: entry.callId != null ? String(entry.callId) : null, reason: 'disconnect_grace_expired' },
    { dedupeKey: dedupe(userId), runAfter: new Date(Date.now() + DISCONNECT_GRACE_MS) },
  );
}

async function _redisScheduleRingingDisconnectGrace(client, userId) {
  const entry = await _redisGetEntry(client, userId);
  if (!entry || entry.status !== 'ringing') return;
  await cancelByDedupeKey(dedupe(userId), ['call_disconnect_grace']);
  await enqueue(
    'call_disconnect_grace',
    { userID: userId, callKey: entry.callId != null ? String(entry.callId) : null, reason: 'ringing_disconnect_grace_expired' },
    { dedupeKey: dedupe(userId), runAfter: new Date(Date.now() + RINGING_DISCONNECT_GRACE_MS) },
  );
}

// ── API publique ─────────────────────────────────────────────────────────

async function getEntry(userId) {
  if (userId == null) return null;
  const client = getDataClient();
  if (client) return _redisGetEntry(client, userId);
  return _memGetEntry(userId);
}

async function get(userId) {
  const entry = await getEntry(userId);
  return entry?.status ?? 'idle';
}

/** @deprecated Préférer isBusyForNewCall avec remoteId. */
/**
 * Ce statut occupe-t-il l'utilisateur pour un NOUVEL appel ?
 *
 * `in_group` s'ajoute aux deux historiques. Les appels de groupe n'étaient
 * inscrits nulle part : ni `create_group_call` ni `join_group_call` n'écrivaient
 * dans `callState`. Un utilisateur en pleine conversation de groupe était donc
 * invisible à cette question, et `call_user` — qui protège sa cible depuis
 * toujours — laissait passer un appel à deux vers lui. Sonnerie plein écran
 * par-dessus sa conversation.
 *
 * Le statut est distinct, et c'est l'essentiel : partout ailleurs, les chemins
 * 1-à-1 testent explicitement `ringing` ou `in_call` — la grâce de déconnexion,
 * l'appariement d'`answer_call`, la sortie de `end_call`, le refus tardif. Un
 * `in_group` leur reste invisible, et ne peut donc pas les faire dérailler.
 */
function statusOccupies(status) {
  return status === 'ringing' || status === 'in_call' || status === 'in_group';
}

/**
 * Peut-on inscrire un appel de groupe par-dessus l'état courant ?
 *
 * Non si l'utilisateur est déjà dans un appel à deux : cet état-là porte un
 * pair et un identifiant dont tout le reste dépend, et l'écraser coûterait plus
 * cher que le renseignement gagné. `isBusyForNewCall` le voit déjà occupé.
 */
function canRecordGroupCall(currentStatus) {
  return currentStatus == null || currentStatus === 'in_group';
}

async function isBusy(userId) {
  return statusOccupies(await get(userId));
}

async function findExistingRingingPair(callerID, targetID) {
  const targetEntry = await getEntry(targetID);
  if (targetEntry?.status === 'ringing' && _samePeer(targetEntry.peerId, callerID)) {
    return { callId: targetEntry.callId, calleeId: targetID, callerId: callerID };
  }
  const callerEntry = await getEntry(callerID);
  if (callerEntry?.status === 'ringing' && _samePeer(callerEntry.peerId, targetID)) {
    return { callId: callerEntry.callId, calleeId: targetID, callerId: callerID };
  }
  return null;
}

async function clearStaleRinging(userId, pendingCalls = null) {
  const entry = await getEntry(userId);
  if (!entry || !isStaleRinging(entry)) return false;
  const peerId = entry.peerId;
  await clear(userId);
  if (peerId != null) {
    const peerEntry = await getEntry(peerId);
    if (peerEntry?.status === 'ringing' && _samePeer(peerEntry.peerId, userId)) {
      await clear(peerId);
    }
    if (pendingCalls?.clear) await pendingCalls.clear(peerId);
  }
  if (pendingCalls?.clear) await pendingCalls.clear(userId);
  return true;
}

/**
 * true si [userId] ne peut pas recevoir/lancer un appel avec [remoteId].
 * - « Glare » : déjà en sonnerie avec CE correspondant → pas occupé.
 * - Sonnerie périmée → purge puis libre.
 */
async function isBusyForNewCall(userId, remoteId, pendingCalls = null) {
  await clearStaleRinging(userId, pendingCalls);
  const entry = await getEntry(userId);
  if (!entry) return false;
  if (!statusOccupies(entry.status)) return false;
  // Un appel de groupe occupe, mais n'a pas de pair : la clause d'exception
  // ci-dessous ne le concerne pas.
  if (entry.status === 'in_group') return true;
  if (entry.status === 'ringing' && _samePeer(entry.peerId, remoteId)) return false;
  return true;
}

// Marque [userId] comme « ringing ». Le timeout « pas de réponse » s'arme
// séparément via scheduleNoAnswer (auparavant passé en paramètre `timer` —
// un handle setTimeout ne se sérialise pas vers job_queue).
async function setRinging(userId, opts = {}) {
  if (userId == null) return;
  const client = getDataClient();
  if (client) return _redisSetRinging(client, userId, opts);
  return _memSetRinging(userId, opts);
}

async function setInCall(userId, opts = {}) {
  if (userId == null) return;
  const client = getDataClient();
  if (client) return _redisSetInCall(client, userId, opts);
  return _memSetInCall(userId, opts);
}

/**
 * Inscrit [userId] comme engagé dans l'appel de groupe [roomId].
 * Rend `false` si un appel à deux occupe déjà l'état — voir `canRecordGroupCall`.
 */
async function setInGroup(userId, roomId) {
  if (userId == null) return false;
  const client = getDataClient();
  if (client) return _redisSetInGroup(client, userId, roomId);
  return _memSetInGroup(userId, roomId);
}

/**
 * Retire l'inscription de groupe, et **seulement** elle.
 *
 * Un `clear` nu effacerait un appel à deux commencé entre-temps.
 */
async function clearGroup(userId) {
  if (userId == null) return false;
  const entry = await getEntry(userId);
  if (entry?.status !== 'in_group') return false;
  await clear(userId);
  return true;
}

async function clear(userId) {
  if (userId == null) return;
  const client = getDataClient();
  if (client) return _redisClear(client, userId);
  return _memClear(userId);
}

/**
 * Réaffecte le correspondant d'un utilisateur déjà engagé, SANS toucher aux
 * timers en cours — contrairement à setInCall, qui les remet à zéro.
 *
 * Sert quand un participant quitte une session à trois : les deux restants se
 * retrouvent face à face et doivent se désigner mutuellement, sans que la grâce
 * de reconnexion éventuellement armée sur l'un d'eux soit annulée au passage.
 *
 * @returns {boolean} false si l'utilisateur n'a aucun état courant.
 */
async function setPeer(userId, peerId) {
  const client = getDataClient();
  if (client) return _redisSetPeer(client, userId, peerId);
  return _memSetPeer(userId, peerId);
}

async function cancelDisconnectGrace(userId) {
  if (getDataClient()) return cancelByDedupeKey(dedupe(userId), ['call_disconnect_grace']);
  return _memCancelDisconnectGrace(userId);
}

async function cancelResumeAck(userId) {
  if (getDataClient()) return cancelByDedupeKey(dedupe(userId), ['call_resume_ack']);
  return _memCancelResumeAck(userId);
}

async function cancelResumeOwnerMissing(userId) {
  if (getDataClient()) return cancelByDedupeKey(dedupe(userId), ['call_resume_owner_missing']);
  return _memCancelResumeOwnerMissing(userId);
}

async function cancelNoAnswer(userId) {
  if (getDataClient()) return cancelByDedupeKey(dedupe(userId), ['call_no_answer']);
  return _memCancelNoAnswer(userId);
}

/**
 * Confirme une reprise client (call_resume_ack ou call_rejoin implicite) :
 * annule la grâce de déconnexion et le timeout d'ack.
 */
async function confirmResume(userId) {
  // Marque d'abord : si le job d'accusé est déjà verrouillé par un worker,
  // l'annulation ci-dessous ne l'arrête plus — c'est la marque qui le fera.
  await callIntents.markResumeConfirmed(userId);
  await cancelResumeAck(userId);
  await cancelResumeOwnerMissing(userId);
  await cancelDisconnectGrace(userId);
}

async function scheduleNoAnswer(userId, onExpire, ms = NO_ANSWER_MS) {
  const client = getDataClient();
  if (client) return _redisScheduleNoAnswer(client, userId, ms);
  return _memScheduleNoAnswer(userId, onExpire, ms);
}

async function scheduleResumeAck(userId, onExpire, ms = RESUME_ACK_MS) {
  const client = getDataClient();
  if (client) return _redisScheduleResumeAck(client, userId, ms);
  return _memScheduleResumeAck(userId, onExpire, ms);
}

/**
 * in_call sans device owner : timer dédié (ne pas réutiliser disconnectGrace).
 * Armé même si aucune socket owner n'est connectée.
 */
async function scheduleResumeOwnerMissing(userId, onExpire, ms = RESUME_OWNER_MISSING_TIMEOUT_MS) {
  const client = getDataClient();
  if (client) return _redisScheduleResumeOwnerMissing(client, userId, ms);
  return _memScheduleResumeOwnerMissing(userId, onExpire, ms);
}

async function scheduleDisconnectGrace(userId, onExpire) {
  const client = getDataClient();
  if (client) return _redisScheduleDisconnectGrace(client, userId);
  return _memScheduleDisconnectGrace(userId, onExpire);
}

async function scheduleRingingDisconnectGrace(userId, onExpire) {
  const client = getDataClient();
  if (client) return _redisScheduleRingingDisconnectGrace(client, userId);
  return _memScheduleRingingDisconnectGrace(userId, onExpire);
}

/**
 * Une grâce de déconnexion (in_call ou ringing) est-elle actuellement armée ?
 * Remplace la lecture directe de `entry.disconnectTimer` (un handle setTimeout
 * ne veut rien dire côté Redis) — voir calls.js reclaimStaleSession/reclaimStaleBusy.
 */
async function hasDisconnectGrace(userId) {
  const client = getDataClient();
  if (client) return hasJob(dedupe(userId), 'call_disconnect_grace');
  return !!(await _memGetEntry(userId))?.disconnectTimer;
}

/** Un timeout d'ack de reprise est-il actuellement armé ? Voir hasDisconnectGrace. */
async function hasResumeAckTimer(userId) {
  const client = getDataClient();
  if (client) return hasJob(dedupe(userId), 'call_resume_ack');
  return !!(await _memGetEntry(userId))?.resumeAckTimer;
}

module.exports = {
  setInGroup,
  clearGroup,
  statusOccupies,
  canRecordGroupCall,
  get,
  isBusy,
  isBusyForNewCall,
  findExistingRingingPair,
  clearStaleRinging,
  getEntry,
  setRinging,
  setInCall,
  setPeer,
  clear,
  cancelDisconnectGrace,
  cancelResumeAck,
  cancelResumeOwnerMissing,
  cancelNoAnswer,
  confirmResume,
  scheduleNoAnswer,
  scheduleDisconnectGrace,
  scheduleRingingDisconnectGrace,
  scheduleResumeAck,
  scheduleResumeOwnerMissing,
  hasDisconnectGrace,
  hasResumeAckTimer,
  DISCONNECT_GRACE_MS,
  RINGING_DISCONNECT_GRACE_MS,
  STALE_RINGING_MS,
  RESUME_ACK_MS,
  RESUME_OWNER_MISSING_TIMEOUT_MS,
  NO_ANSWER_MS,
};
