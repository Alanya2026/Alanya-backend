// Marques éphémères autour de la signalisation 1-à-1.
//
// `callState` décrit un appel qui EXISTE (ringing, in_call). Ce module couvre
// les fenêtres où il n'existe pas encore — ou plus — et où deux événements
// concurrents se marchaient dessus :
//
//  - « numérotation en cours » : `call_user` met plusieurs secondes à poser
//    l'état `ringing` (contrôles, répondeur, insertion en base). Un `end_call`
//    arrivé dans cette fenêtre trouvait l'appelant « idle », sortait par
//    `already_idle`… et `call_user` faisait sonner le destinataire ensuite.
//    L'annulation est désormais mémorisée et relue avant de faire sonner.
//
//  - verrou de paire : deux `call_user` croisés (A→B et B→A) passaient tous
//    les deux le test `findExistingRingingPair` avant que l'un ait posé son
//    état, et créaient deux appels. Le verrou les sérialise : le second voit
//    le premier et le traite comme un croisement.
//
//  - reprise confirmée : `call_resume_ack` peut arriver avant que le minuteur
//    qu'il doit annuler soit en base. La marque permet au minuteur, à son
//    échéance, de constater que la reprise a bien été confirmée.
//
// Redis (multi-instance) si disponible, sinon Map locale avec expiration.

const { getDataClient } = require('../../config/redisData');
const { runScript } = require('../../utils/redisScript');

const DIALING_TTL_MS = 30 * 1000;
const CANCEL_TTL_MS = 30 * 1000;
const PAIR_LOCK_TTL_MS = 15 * 1000;
const PAIR_LOCK_WAIT_MS = 8 * 1000;
const RESUME_CONFIRMED_TTL_MS = 60 * 1000;

const _mem = new Map(); // clé -> { value, expiresAt }

function _memGet(key) {
  const e = _mem.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    _mem.delete(key);
    return null;
  }
  return e.value;
}

function _memSet(key, value, ttlMs, { nx = false } = {}) {
  if (nx && _memGet(key) != null) return false;
  _mem.set(key, { value, expiresAt: Date.now() + ttlMs });
  return true;
}

async function _set(key, value, ttlMs, opts = {}) {
  const client = getDataClient();
  if (client) {
    const r = await client.set(key, value, opts.nx ? { NX: true, PX: ttlMs } : { PX: ttlMs });
    return r === 'OK';
  }
  return _memSet(key, value, ttlMs, opts);
}

async function _get(key) {
  const client = getDataClient();
  if (client) return client.get(key);
  return _memGet(key);
}

async function _del(key) {
  const client = getDataClient();
  if (client) {
    await client.del(key);
    return;
  }
  _mem.delete(key);
}

const dialingKey = (callerID, targetID) => `alanya:callIntent:dialing:${callerID}:${targetID}`;
const cancelKey = (callerID, targetID) => `alanya:callIntent:cancel:${callerID}:${targetID}`;
const pairKey = (a, b) => {
  const [x, y] = [Number(a), Number(b)].sort((m, n) => m - n);
  return `alanya:callIntent:pair:${x}:${y}`;
};
const resumeKey = (userID) => `alanya:callIntent:resumeConfirmed:${userID}`;

// ── Numérotation / annulation ───────────────────────────────────────────────

/** `call_user` commence : un `end_call` reçu d'ici la sonnerie sera mémorisé. */
async function markDialing(callerID, targetID) {
  if (callerID == null || targetID == null) return;
  // Un nouvel appel efface l'annulation d'un appel précédent vers la même cible.
  await _del(cancelKey(callerID, targetID));
  await _set(dialingKey(callerID, targetID), String(Date.now()), DIALING_TTL_MS);
}

async function clearDialing(callerID, targetID) {
  if (callerID == null || targetID == null) return;
  await _del(dialingKey(callerID, targetID));
}

async function isDialing(callerID, targetID) {
  if (callerID == null || targetID == null) return false;
  return (await _get(dialingKey(callerID, targetID))) != null;
}

/** `end_call` reçu pendant la numérotation : l'appel ne doit pas sonner. */
async function markCancelled(callerID, targetID) {
  if (callerID == null || targetID == null) return;
  await _set(cancelKey(callerID, targetID), '1', CANCEL_TTL_MS);
}

async function isCancelled(callerID, targetID) {
  if (callerID == null || targetID == null) return false;
  return (await _get(cancelKey(callerID, targetID))) != null;
}

async function clearCancelled(callerID, targetID) {
  if (callerID == null || targetID == null) return;
  await _del(cancelKey(callerID, targetID));
}

// ── Verrou de paire ─────────────────────────────────────────────────────────

const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/**
 * Prend le verrou de la paire {a, b} (ordre indifférent).
 * @returns {Promise<string|null>} le jeton à rendre à [unlockPair], ou null
 *   si le verrou n'a pas pu être pris dans le délai (on continue alors sans).
 */
async function lockPair(a, b, { waitMs = PAIR_LOCK_WAIT_MS } = {}) {
  if (a == null || b == null) return null;
  const key = pairKey(a, b);
  const token = `${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (await _set(key, token, PAIR_LOCK_TTL_MS, { nx: true })) return token;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function unlockPair(a, b, token) {
  if (a == null || b == null || !token) return;
  const key = pairKey(a, b);
  const client = getDataClient();
  if (client) {
    await runScript(client, UNLOCK, [key], [token]);
    return;
  }
  if (_memGet(key) === token) _mem.delete(key);
}

// ── Reprise confirmée ───────────────────────────────────────────────────────

/** Une reprise va être proposée : toute confirmation antérieure est caduque. */
async function clearResumeConfirmed(userID) {
  if (userID == null) return;
  await _del(resumeKey(userID));
}

async function markResumeConfirmed(userID) {
  if (userID == null) return;
  await _set(resumeKey(userID), String(Date.now()), RESUME_CONFIRMED_TTL_MS);
}

async function isResumeConfirmed(userID) {
  if (userID == null) return false;
  return (await _get(resumeKey(userID))) != null;
}

/** Remise à zéro — tests uniquement. */
function _resetMemory() {
  _mem.clear();
}

module.exports = {
  markDialing,
  clearDialing,
  isDialing,
  markCancelled,
  isCancelled,
  clearCancelled,
  lockPair,
  unlockPair,
  clearResumeConfirmed,
  markResumeConfirmed,
  isResumeConfirmed,
  _resetMemory,
};
