/**
 * Exécuteurs des délais d'appel armés par src/socket/state/callState.js
 * (chemin Redis uniquement — le repli mémoire garde ses vrais setTimeout).
 * Calqué sur src/services/tripWorkers.js : mêmes conventions (setIo, kinds,
 * dedupe, registerJobHandler).
 *
 * Chaque handler revalide l'état courant avant d'agir — un job verrouillé par
 * le worker (SELECT...FOR UPDATE SKIP LOCKED) ne peut plus être annulé par un
 * cancelByDedupeKey concurrent, contrairement à clearTimeout(). onNoAnswer
 * (calls.js) le fait déjà nativement ; endActiveCallForUser aussi (elle
 * revérifie le statut de l'entrée avant d'agir, renvoie false sinon).
 */

const { registerJobHandler } = require('./jobQueue');
const callDeviceOwnership = require('../socket/state/callDeviceOwnership');

// Injectés par server.js : les jobs tournent hors de toute requête, ils n'ont
// donc pas accès à req.app.get('io') ni au registre de sockets du module.
let _io = null;
let _userSockets = null;
const setIo = (io) => { _io = io; };
const setUserSockets = (userSockets) => { _userSockets = userSockets; };

async function _endCallCascade({ userID, callKey }, reason) {
  // require() tardif : calls.js require callDeviceOwnership/callState, pas
  // callStateWorkers.js — pas de cycle, mais différer évite tout ordre de
  // chargement fragile au démarrage du module.
  const { endActiveCallForUser } = require('../socket/handlers/calls');
  const solde = await endActiveCallForUser(_io, _userSockets, userID, reason);
  // Appel épargné (appareil revenu, reprise confirmée) : il est vivant, sa
  // propriété d'appareil doit le rester — sans elle, la reprise suivante
  // n'aurait plus d'appareil à qui s'adresser.
  if (solde && callKey) await callDeviceOwnership.release(callKey);
}

function registerCallStateJobHandlers() {
  registerJobHandler('call_no_answer', async ({ targetID, callID, callerID }) => {
    const { onNoAnswer } = require('../socket/handlers/calls');
    await onNoAnswer(_io, _userSockets, callID, callerID, targetID);
  });

  registerJobHandler('call_disconnect_grace', async (payload) => {
    await _endCallCascade(payload, payload.reason || 'disconnect_grace_expired');
  });

  registerJobHandler('call_resume_ack', async (payload) => {
    await _endCallCascade(payload, 'resume_ack_timeout');
  });

  registerJobHandler('call_resume_owner_missing', async (payload) => {
    await _endCallCascade(payload, 'resume_owner_missing');
  });
}

module.exports = { setIo, setUserSockets, registerCallStateJobHandlers };
