/**
 * Tests du repli TURN — `node src/utils/turnFallback.test.js`.
 *
 * L'enjeu : Cloudflare ne doit figurer dans la liste que si tous nos serveurs
 * sont muets. WebRTC utilise tout ce qu'on lui donne : une liste trop généreuse
 * se paie à chaque appel, sans que rien ne le signale.
 */

const assert = require('assert');
const dgram = require('dgram');
const { createCloudflareTurn } = require('./cloudflareTurn');
const { createTurnHealth, probeStun, probeTargets } = require('./turnHealth');
const { buildIceServersWithFallback } = require('./turnCredentials');

let ok = 0;
const test = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

/** Serveur STUN local : répond comme coturn à une demande de liaison. */
const serveurStun = async ({ typeReponse = 0x0101, ignorer = 0 } = {}) => {
  const socket = dgram.createSocket('udp4');
  let reste = ignorer;
  socket.on('message', (message, from) => {
    if (reste > 0) {
      reste -= 1;
      return;
    }
    const reponse = Buffer.from(message);
    reponse.writeUInt16BE(typeReponse, 0);
    socket.send(reponse, from.port, from.address);
  });
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { socket, port: socket.address().port };
};

const CLOUDFLARE = [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }];

const repondre = (corps, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => corps,
});

const configCloudflare = {
  CLOUDFLARE_TURN_KEY_ID: 'cle',
  CLOUDFLARE_TURN_API_TOKEN: 'jeton',
};

(async () => {
  await test('seules les adresses UDP sont sondées, sans doublon', () => {
    assert.deepStrictEqual(
      probeTargets([
        {
          urls: [
            'stun:a.test:3478',
            'turn:a.test:3478?transport=udp',
            'turn:a.test:3478?transport=tcp',
            'turns:a.test:5349?transport=tcp',
            'turn:b.test',
          ],
        },
      ]),
      [
        { host: 'a.test', port: 3478 },
        { host: 'b.test', port: 3478 },
      ],
    );
  });

  await test('la sonde reconnaît un serveur qui répond', async () => {
    const { socket, port } = await serveurStun();
    assert.strictEqual(await probeStun({ host: '127.0.0.1', port }), true);
    socket.close();
  });

  await test('une erreur STUN prouve aussi que le serveur est debout', async () => {
    const { socket, port } = await serveurStun({ typeReponse: 0x0111 });
    assert.strictEqual(await probeStun({ host: '127.0.0.1', port }), true);
    socket.close();
  });

  await test('un paquet perdu ne déclare pas le serveur mort', async () => {
    const { socket, port } = await serveurStun({ ignorer: 1 });
    assert.strictEqual(
      await probeStun({ host: '127.0.0.1', port }, { timeoutMs: 500, resendMs: 50 }),
      true,
    );
    socket.close();
  });

  await test('un serveur muet est déclaré indisponible', async () => {
    const socket = dgram.createSocket('udp4');
    await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
    assert.strictEqual(
      await probeStun(
        { host: '127.0.0.1', port: socket.address().port },
        { timeoutMs: 100, resendMs: 40 },
      ),
      false,
    );
    socket.close();
  });

  await test('un seul serveur debout suffit', async () => {
    const health = createTurnHealth({ probe: async ({ host }) => host === 'b' });
    assert.strictEqual(
      await health.isAnyAvailable([{ host: 'a' }, { host: 'b' }]),
      true,
    );
  });

  await test('sans serveur configuré, rien n\'est disponible', async () => {
    assert.strictEqual(await createTurnHealth().isAnyAvailable([]), false);
  });

  await test('la sonde n\'est pas rejouée à chaque requête', async () => {
    let sondes = 0;
    let t = 0;
    const health = createTurnHealth({
      now: () => t,
      maxAgeMs: 1000,
      probe: async () => {
        sondes += 1;
        return sondes === 1;
      },
    });
    const cibles = [{ host: 'a' }];
    assert.strictEqual(await health.isAnyAvailable(cibles), true);
    t = 999;
    assert.strictEqual(await health.isAnyAvailable(cibles), true);
    assert.strictEqual(sondes, 1);
    t = 1000;
    assert.strictEqual(
      await health.isAnyAvailable(cibles),
      false,
      'une panne doit se voir dès que la mesure a expiré',
    );
  });

  await test('des requêtes simultanées partagent la même sonde', async () => {
    let sondes = 0;
    const health = createTurnHealth({
      probe: async () => {
        sondes += 1;
        return true;
      },
    });
    const cibles = [{ host: 'a' }];
    await Promise.all([health.isAnyAvailable(cibles), health.isAnyAvailable(cibles)]);
    assert.strictEqual(sondes, 1);
  });

  await test('sans clé Cloudflare, aucune requête ne part', async () => {
    let appels = 0;
    const cloudflare = createCloudflareTurn({
      env: {},
      fetchImpl: async () => {
        appels += 1;
      },
    });
    assert.deepStrictEqual(await cloudflare.getIceServers(), []);
    assert.strictEqual(appels, 0);
  });

  await test('les identifiants Cloudflare sont gardés en cache', async () => {
    let appels = 0;
    let t = 0;
    const cloudflare = createCloudflareTurn({
      env: configCloudflare,
      now: () => t,
      fetchImpl: async () => {
        appels += 1;
        return repondre({ iceServers: CLOUDFLARE });
      },
    });
    await cloudflare.getIceServers();
    t = 49 * 60 * 1000;
    await cloudflare.getIceServers();
    assert.strictEqual(appels, 1);
    t = 51 * 60 * 1000;
    await cloudflare.getIceServers();
    assert.strictEqual(appels, 2, 'à renouveler avant leur expiration');
  });

  await test('la réponse de Cloudflare est acceptée sous ses deux formes', async () => {
    for (const iceServers of [CLOUDFLARE, CLOUDFLARE[0]]) {
      const cloudflare = createCloudflareTurn({
        env: configCloudflare,
        fetchImpl: async () => repondre({ iceServers }),
      });
      assert.deepStrictEqual(await cloudflare.getIceServers(), CLOUDFLARE);
    }
  });

  await test('une panne de Cloudflare ne casse rien et garde le cache', async () => {
    let t = 0;
    let panne = false;
    const cloudflare = createCloudflareTurn({
      env: configCloudflare,
      now: () => t,
      fetchImpl: async () => {
        if (panne) return repondre({}, 500);
        return repondre({ iceServers: CLOUDFLARE });
      },
    });
    await cloudflare.getIceServers();
    panne = true;
    t = 60 * 60 * 1000;
    assert.deepStrictEqual(await cloudflare.getIceServers(), CLOUDFLARE);
  });

  const AVANT = process.env.TURN_SERVERS;
  process.env.TURN_SERVERS = JSON.stringify([
    {
      urls: ['turn:turn.kemita.test:3478'],
      username: 'nous',
      credential: 'secret',
      auth: 'static',
    },
  ]);
  const relais = (iceServers) => iceServers.filter((s) => s.username).map((s) => s.username);
  const cloudflareActif = { getIceServers: async () => CLOUDFLARE };

  await test('serveurs disponibles : Cloudflare n\'apparaît pas', async () => {
    let demande = false;
    const { iceServers } = await buildIceServersWithFallback(1, {
      health: { isAnyAvailable: async () => true },
      cloudflare: {
        getIceServers: async () => {
          demande = true;
          return CLOUDFLARE;
        },
      },
    });
    assert.deepStrictEqual(relais(iceServers), ['nous']);
    assert.strictEqual(demande, false);
  });

  await test('serveurs muets : Cloudflare passe après eux, sans les retirer', async () => {
    const { iceServers } = await buildIceServersWithFallback(1, {
      health: { isAnyAvailable: async () => false },
      cloudflare: cloudflareActif,
    });
    assert.deepStrictEqual(
      relais(iceServers),
      ['nous', 'u'],
      'une sonde peut se tromper : nos serveurs restent essayés',
    );
  });

  await test('Cloudflare en panne aussi : on rend quand même nos serveurs', async () => {
    const { iceServers } = await buildIceServersWithFallback(1, {
      health: { isAnyAvailable: async () => false },
      cloudflare: { getIceServers: async () => [] },
    });
    assert.deepStrictEqual(relais(iceServers), ['nous']);
  });

  await test('les téléphones redemandent la liste assez vite pour voir une panne', async () => {
    const { ttlSec } = await buildIceServersWithFallback(1, {
      health: { isAnyAvailable: async () => true },
      cloudflare: cloudflareActif,
    });
    // L'application garde la liste `ttlSec - 600` secondes.
    assert.strictEqual(ttlSec - 600, 300);
  });

  if (AVANT === undefined) delete process.env.TURN_SERVERS;
  else process.env.TURN_SERVERS = AVANT;

  console.log(`${ok} tests OK`);
})();
