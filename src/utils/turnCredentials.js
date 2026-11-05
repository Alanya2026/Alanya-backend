const crypto = require('crypto');
const { createCloudflareTurn } = require('./cloudflareTurn');
const { createTurnHealth, probeTargets } = require('./turnHealth');

// Temps pendant lequel un téléphone garde la liste : l'application conserve
// `ttlSec - 600` secondes, soit cinq minutes. Sans cela, il la gardait aussi
// longtemps que ses identifiants, et ne voyait pas le repli en cas de panne.
const CLIENT_LIST_TTL_SEC = 900;

const turnHealth = createTurnHealth();
const cloudflareTurn = createCloudflareTurn();

const DEFAULT_STUN = [
  { urls: 'stun:turn.kemita.eu:3478' },
  { urls: 'stun:turn.alanya226.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const resolveAuthMode = (server) => {
  if (server.auth === 'hmac' || server.auth === 'static') {
    return server.auth;
  }
  if (server.username && server.credential) {
    return 'static';
  }
  return null;
};

const parseTurnServers = () => {
  const raw = (process.env.TURN_SERVERS || '').trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((server) => {
      if (!server.urls || !Array.isArray(server.urls) || server.urls.length === 0) {
        return false;
      }
      const auth = resolveAuthMode(server);
      if (auth === 'hmac') return true;
      if (auth === 'static' && server.username && server.credential) return true;
      return false;
    });
  } catch (e) {
    console.error('[TURN] Failed to parse TURN_SERVERS JSON:', e.message);
  }
  return [];
};

const generateEphemeralCredentials = (userId, ttlSec) => {
  const expiry = Math.floor(Date.now() / 1000) + ttlSec;
  const username = `${expiry}:${userId}`;
  const hmac = crypto.createHmac('sha1', process.env.TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');
  return { username, credential, ttlSec };
};

const buildIceServers = (userId) => {
  const turnServers = parseTurnServers();

  if (turnServers.length === 0) {
    return { iceServers: DEFAULT_STUN, ttlSec: 0 };
  }

  const hasHmac = turnServers.some((s) => resolveAuthMode(s) === 'hmac');
  const ttl = hasHmac ? (parseInt(process.env.TURN_TTL_SEC, 10) || 3600) : 0;
  let eph = null;

  if (hasHmac) {
    if (!process.env.TURN_SECRET) {
      console.error('[TURN] TURN_SECRET missing: hmac servers will be skipped');
    } else {
      eph = generateEphemeralCredentials(String(userId), ttl);
    }
  }

  const iceServers = [];
  for (const server of turnServers) {
    const auth = resolveAuthMode(server);
    if (auth === 'hmac') {
      if (!eph) continue;
      iceServers.push({
        urls: server.urls,
        username: eph.username,
        credential: eph.credential,
      });
    } else {
      iceServers.push({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
      });
    }
  }

  return {
    iceServers: [...DEFAULT_STUN, ...iceServers],
    ttlSec: eph ? ttl : 0,
  };
};

/**
 * Nos serveurs d'abord. Cloudflare ne s'ajoute à la liste que s'ils sont tous
 * muets, et sans les retirer : une sonde peut se tromper, et WebRTC garde alors
 * le chemin qui fonctionne.
 */
const buildIceServersWithFallback = async (
  userId,
  { health = turnHealth, cloudflare = cloudflareTurn } = {},
) => {
  const { iceServers } = buildIceServers(userId);
  const available = await health.isAnyAvailable(probeTargets(parseTurnServers()));
  const fallback = available ? [] : await cloudflare.getIceServers();
  return {
    iceServers: [...iceServers, ...fallback],
    ttlSec: CLIENT_LIST_TTL_SEC,
  };
};

module.exports = { buildIceServers, buildIceServersWithFallback };
