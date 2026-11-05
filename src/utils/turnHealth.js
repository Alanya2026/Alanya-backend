// Disponibilité des serveurs TURN prioritaires, vue du backend.
//
// WebRTC n'a aucune notion de priorité entre serveurs TURN : il réserve un relais
// sur chacun de ceux qu'on lui donne, puis retient le meilleur chemin. Donner
// Cloudflare aux téléphones reviendrait donc à l'utiliser, et à le payer, en
// permanence. Pour qu'il reste un vrai repli, il ne doit figurer dans la liste
// que si nos serveurs ne répondent plus — d'où cette sonde STUN.

const crypto = require('crypto');
const dgram = require('dgram');

const STUN_BINDING_REQUEST = 0x0001;
const STUN_BINDING_SUCCESS = 0x0101;
const STUN_BINDING_ERROR = 0x0111;
const STUN_MAGIC_COOKIE = 0x2112a442;
const STUN_HEADER_BYTES = 20;

const PROBE_TIMEOUT_MS = 2500;
// UDP peut perdre un paquet : un seul envoi déclarerait mort un serveur vivant.
const PROBE_RESEND_MS = 800;
const HEALTH_MAX_AGE_MS = 30 * 1000;
const DEFAULT_STUN_PORT = 3478;

/** Adresses à sonder : `turns:` est exclu, il exige une poignée de main TLS. */
const probeTargets = (servers) => {
  const targets = new Map();
  for (const server of servers) {
    for (const url of server.urls || []) {
      const match = /^(?:stun|turn):([^:?]+)(?::(\d+))?/.exec(url);
      if (!match) continue;
      const host = match[1];
      const port = match[2] ? Number(match[2]) : DEFAULT_STUN_PORT;
      targets.set(`${host}:${port}`, { host, port });
    }
  }
  return [...targets.values()];
};

/** Rend `true` si le serveur répond, jamais d'exception. */
const probeStun = (
  { host, port },
  { timeoutMs = PROBE_TIMEOUT_MS, resendMs = PROBE_RESEND_MS } = {},
) =>
  new Promise((resolve) => {
    const id = crypto.randomBytes(12);
    const packet = Buffer.alloc(STUN_HEADER_BYTES);
    packet.writeUInt16BE(STUN_BINDING_REQUEST, 0);
    packet.writeUInt32BE(STUN_MAGIC_COOKIE, 4);
    id.copy(packet, 8);

    const socket = dgram.createSocket('udp4');
    let done = false;
    let resendTimer = null;
    let timeoutTimer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearInterval(resendTimer);
      clearTimeout(timeoutTimer);
      socket.close();
      resolve(result);
    };
    const send = () =>
      socket.send(packet, port, host, (err) => {
        if (err) finish(false);
      });

    socket.on('error', () => finish(false));
    socket.on('message', (message) => {
      if (message.length < STUN_HEADER_BYTES) return;
      if (!message.subarray(8, STUN_HEADER_BYTES).equals(id)) return;
      const type = message.readUInt16BE(0);
      // Une erreur STUN prouve elle aussi que le serveur est debout.
      if (type === STUN_BINDING_SUCCESS || type === STUN_BINDING_ERROR) {
        finish(true);
      }
    });

    resendTimer = setInterval(send, resendMs);
    timeoutTimer = setTimeout(() => finish(false), timeoutMs);
    send();
  });

const createTurnHealth = ({
  probe = probeStun,
  now = Date.now,
  maxAgeMs = HEALTH_MAX_AGE_MS,
} = {}) => {
  let available = null;
  let checkedAt = 0;
  let inFlight = null;

  const check = (targets) => {
    if (!inFlight) {
      inFlight = Promise.all(targets.map((target) => probe(target)))
        .then((results) => {
          const next = results.some(Boolean);
          if (next !== available) {
            console.warn(
              next
                ? '[TURN] serveurs prioritaires disponibles'
                : '[TURN] serveurs prioritaires indisponibles : repli activé',
            );
          }
          available = next;
          checkedAt = now();
          return next;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  /** Au moins un serveur répond-il ? Sans serveur configuré, la réponse est non. */
  const isAnyAvailable = async (targets) => {
    if (targets.length === 0) return false;
    if (available !== null && now() - checkedAt < maxAgeMs) return available;
    return check(targets);
  };

  return { isAnyAvailable };
};

module.exports = { createTurnHealth, probeStun, probeTargets };
