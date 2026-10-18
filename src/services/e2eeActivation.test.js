/**
 * `node src/services/e2eeActivation.test.js`
 *
 * La règle d'activation, et le chemin en base : une seule activation, à sens
 * unique, et chaque refus avec son témoin.
 */
const assert = require('assert');

const settingsPath = require.resolve('./e2eeSettingsService');
let cohorteOuverte = true;
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true, paths: [], children: [],
  exports: { peutActiver: async () => cohorteOuverte },
};

const dbPath = require.resolve('../config/db');
const etat = {};
function poser({ isGroup = 0, e2eeSince = null, participants, appareils, colonneAbsente = false }) {
  Object.assign(etat, { isGroup, e2eeSince, participants, appareils, colonneAbsente, updates: 0 });
}
const fakePool = {
  async execute(sql) {
    const s = sql.replace(/\s+/g, ' ');
    if (/^SELECT isGroup, e2ee_since/.test(s.trim())) {
      if (etat.colonneAbsente) {
        const e = new Error('Unknown column');
        e.code = 'ER_BAD_FIELD_ERROR';
        throw e;
      }
      return [[{ isGroup: etat.isGroup, e2ee_since: etat.e2eeSince }], []];
    }
    if (/FROM conv_participants/.test(s)) return [etat.participants, []];
    if (/^UPDATE conversation SET e2ee_since/.test(s.trim())) {
      if (etat.e2eeSince) return [{ affectedRows: 0 }, []];
      etat.e2eeSince = new Date('2026-10-18T10:00:00Z');
      etat.updates += 1;
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT e2ee_since FROM conversation/.test(s.trim())) {
      return [[{ e2ee_since: etat.e2eeSince }], []];
    }
    throw new Error(`requête inattendue : ${s}`);
  },
  async query(sql) {
    if (/FROM appareils/.test(sql)) return [etat.appareils, []];
    throw new Error(`requête inattendue : ${sql}`);
  },
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, paths: [], children: [], exports: fakePool,
};

const { motifNonEligible, activerSiEligible } = require('./e2eeActivation');

const DEUX = [{ alanyaID: 1, accountType: 0 }, { alanyaID: 2, accountType: 0 }];
const PRETS = [
  { id: 10, alanyaID: 1, capacite: 1 },
  { id: 11, alanyaID: 1, capacite: 2 },
  { id: 20, alanyaID: 2, capacite: 1 },
];

// ── La règle ──────────────────────────────────────────────────────────────

assert.strictEqual(motifNonEligible({ isGroup: false, participants: DEUX, appareils: PRETS }), null, 'témoin : tout est prêt');
assert.strictEqual(motifNonEligible({ isGroup: true, participants: DEUX, appareils: PRETS }), 'GROUPE');
assert.strictEqual(
  motifNonEligible({ isGroup: false, participants: [DEUX[0]], appareils: PRETS }),
  'PAS_DEUX_COMPTES',
  'fil avec soi-même',
);
assert.strictEqual(
  motifNonEligible({ isGroup: false, participants: [DEUX[0], { alanyaID: 2, accountType: 2 }], appareils: PRETS }),
  'COMPTE_NON_PERSONNEL',
  'compte officiel',
);
assert.strictEqual(
  motifNonEligible({ isGroup: false, participants: DEUX, appareils: [...PRETS, { id: 21, alanyaID: 2, capacite: null }] }),
  'APPAREIL_SANS_CLES',
  'une tablette pas encore mise à jour suffit à attendre',
);
assert.strictEqual(
  motifNonEligible({ isGroup: false, participants: DEUX, appareils: [...PRETS, { id: 12, alanyaID: 1, capacite: 0 }] }),
  'CAPACITE_INSUFFISANTE',
  'une application de l\'étape 1 publie des clés mais ne lit rien',
);
assert.strictEqual(
  motifNonEligible({ isGroup: false, participants: DEUX, appareils: PRETS.filter((a) => a.alanyaID === 1) }),
  'AUCUN_APPAREIL',
);

// ── Le chemin en base ─────────────────────────────────────────────────────

(async () => {
  const emissions = [];
  const io = { to: (room) => ({ emit: (ev, charge) => emissions.push({ room, ev, charge }) }) };

  // Tout est prêt : activée, et les deux comptes sont prévenus.
  poser({ participants: DEUX, appareils: PRETS });
  let r = await activerSiEligible(7, { io });
  assert.ok(r.e2eeSince instanceof Date);
  assert.strictEqual(etat.updates, 1);
  assert.deepStrictEqual(emissions.map((e) => e.room).sort(), ['user_1', 'user_2']);
  assert.ok(emissions.every((e) => e.ev === 'conversation:e2ee' && e.charge.conversationID === 7));

  // Deuxième demande : la date est relue, rien n'est réécrit ni rediffusé.
  emissions.length = 0;
  r = await activerSiEligible(7, { io });
  assert.ok(r.e2eeSince);
  assert.strictEqual(etat.updates, 1);
  assert.strictEqual(emissions.length, 0);

  // Une fois activée, elle le reste — même si un appareil sans clés arrive
  // ensuite : l'activation ne se défait pas.
  etat.appareils = [...PRETS, { id: 22, alanyaID: 2, capacite: null }];
  r = await activerSiEligible(7, { io });
  assert.ok(r.e2eeSince, 'à sens unique');

  // Hors cohorte : rien ne s'active (témoin : même conversation, cohorte ouverte, plus haut).
  cohorteOuverte = false;
  poser({ participants: DEUX, appareils: PRETS });
  r = await activerSiEligible(8, { io });
  assert.strictEqual(r.e2eeSince, null);
  assert.strictEqual(r.motif, 'HORS_COHORTE');
  assert.strictEqual(etat.updates, 0);
  cohorteOuverte = true;

  // Appareil sans clés : rien ne s'active.
  poser({ participants: DEUX, appareils: [...PRETS, { id: 21, alanyaID: 2, capacite: null }] });
  r = await activerSiEligible(9, { io });
  assert.strictEqual(r.e2eeSince, null);
  assert.strictEqual(etat.updates, 0);

  // Migration 104 absente : tout reste en clair, sans erreur.
  poser({ participants: DEUX, appareils: PRETS, colonneAbsente: true });
  r = await activerSiEligible(10, { io });
  assert.strictEqual(r.e2eeSince, null);
  assert.strictEqual(r.motif, 'MIGRATION_ABSENTE');

  console.log('e2eeActivation.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
