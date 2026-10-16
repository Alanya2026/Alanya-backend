/**
 * `node src/services/safebox/plusSpace.test.js` — espace du coffre selon
 * Alanya Plus (lot 4), sans base : abonnement et base remplacés par des faux.
 */

const assert = require('assert');
const { createPlusSpace } = require('./plusSpace');

const Gio = 1024 ** 3;
const reglages = { baseQuotaBytes: 10 * Gio, maxFileBytes: Gio, maxFileBytesPlus: 2 * Gio };
const NOW = new Date('2026-10-16T10:00:00Z');
const payant = { paid_enabled: 1, grace_until: null };

let ok = 0;
const etapes = [];
const test = (nom, fn) => etapes.push([nom, fn]);

/** Faux pool : le compte demandé, et le plan le plus généreux en vente. */
function fauxDb(compte, { maxPlan = 50 * Gio, panne = false } = {}) {
  return {
    async query(sql) {
      if (panne) throw Object.assign(new Error('base injoignable'), { code: 'ECONNREFUSED' });
      if (sql.includes('FROM users')) return [[compte].filter(Boolean)];
      if (sql.includes('MAX(safebox_bytes)')) return [[{ b: maxPlan }]];
      throw new Error(`requête inattendue : ${sql}`);
    },
  };
}

const espace = (compte, { billing = payant, ...opts } = {}) => createPlusSpace({
  db: fauxDb(compte, opts),
  getBilling: async () => billing,
  clock: () => NOW,
  env: {},
}).spaceFor(5, reglages);

const base = { quotaBytes: 10 * Gio, maxFileBytes: Gio, plus: false };
const abonne = { type_compte: 0, account_type: 0, covered_until: new Date('2026-12-01'), plan_bytes: 50 * Gio };

test('payant éteint : l\'espace de base pour tout le monde, abonné compris', async () => {
  assert.deepStrictEqual(await espace(abonne, { billing: { paid_enabled: 0 } }), base);
});

test('période de grâce : l\'espace de base', async () => {
  assert.deepStrictEqual(await espace(abonne, { billing: { paid_enabled: 1, grace_until: new Date('2026-11-01') } }), base);
});

test('abonné couvert : l\'espace de son plan, et les gros fichiers de Plus', async () => {
  assert.deepStrictEqual(await espace(abonne), { quotaBytes: 50 * Gio, maxFileBytes: 2 * Gio, plus: true });
});

test('abonnement fini : l\'espace de base', async () => {
  assert.deepStrictEqual(await espace({ ...abonne, covered_until: null, plan_bytes: null }), base);
});

test('plan sans espace réglé : jamais moins que l\'espace de base', async () => {
  assert.strictEqual((await espace({ ...abonne, plan_bytes: null })).quotaBytes, 10 * Gio);
  assert.strictEqual((await espace({ ...abonne, plan_bytes: 2 * Gio })).quotaBytes, 10 * Gio);
});

test('compte de l\'équipe ou officiel : le plan le plus généreux en vente', async () => {
  const equipe = { type_compte: 1, account_type: 0, covered_until: null, plan_bytes: null };
  assert.deepStrictEqual(await espace(equipe), { quotaBytes: 50 * Gio, maxFileBytes: 2 * Gio, plus: true });
  const officiel = { type_compte: 0, account_type: 2, covered_until: null, plan_bytes: null };
  assert.strictEqual((await espace(officiel, { maxPlan: 200 * Gio })).quotaBytes, 200 * Gio);
});

test('panne : l\'espace de base, jamais une erreur', async () => {
  const avant = console.warn;
  console.warn = () => {};
  try {
    assert.deepStrictEqual(await espace(abonne, { panne: true }), base);
  } finally {
    console.warn = avant;
  }
});

(async () => {
  for (const [nom, fn] of etapes) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.stack}`);
      process.exitCode = 1;
    }
  }
  console.log(`safebox/plusSpace : ${ok}/${etapes.length} tests passés`);
})();
