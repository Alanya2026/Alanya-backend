/**
 * `node src/controllers/safeboxController.test.js` — traduction des erreurs du
 * coffre en réponses HTTP à code stable, sans base ni serveur.
 */

const assert = require('assert');
const { _sendError } = require('./safeboxController');
const { SafeboxError } = require('../services/safebox/errors');
const { SafeboxKeyUnavailable } = require('../services/safebox/keys');

let ok = 0;
const test = (nom, fn) => {
  try {
    fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.stack}`);
    process.exitCode = 1;
  }
};

function fausseReponse() {
  const r = { statut: null, corps: null };
  r.status = (s) => { r.statut = s; return r; };
  r.json = (c) => { r.corps = c; return r; };
  return r;
}

const silence = (fn) => {
  const avant = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = avant; }
};

test('refus métier : statut, code et champs joints', () => {
  const res = fausseReponse();
  _sendError(res, new SafeboxError('SAFEBOX_QUOTA_EXCEEDED', 409, 'Espace insuffisant', { quotaBytes: 10 }), 't');
  assert.strictEqual(res.statut, 409);
  assert.strictEqual(res.corps.code, 'SAFEBOX_QUOTA_EXCEEDED');
  assert.strictEqual(res.corps.quotaBytes, 10);
});

test('clé maîtresse indisponible : 503 SAFEBOX_UNAVAILABLE, sans détail', () => {
  const res = fausseReponse();
  silence(() => _sendError(res, new SafeboxKeyUnavailable('SAFEBOX_KEY doit faire 32 octets'), 't'));
  assert.strictEqual(res.statut, 503);
  assert.strictEqual(res.corps.code, 'SAFEBOX_UNAVAILABLE');
  assert.ok(!JSON.stringify(res.corps).includes('32 octets'));
});

test('erreur imprévue : 500 INTERNAL, le message de base ne sort pas', () => {
  const res = fausseReponse();
  silence(() => _sendError(res, Object.assign(new Error("ER_NO_SUCH_TABLE: Table 'talky.safebox_file'"), { code: 'ER_NO_SUCH_TABLE' }), 't'));
  assert.strictEqual(res.statut, 500);
  assert.strictEqual(res.corps.code, 'INTERNAL');
  assert.ok(!JSON.stringify(res.corps).includes('safebox_file'));
});

console.log(`safeboxController : ${ok} tests passés`);
