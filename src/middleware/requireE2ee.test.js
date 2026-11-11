/**
 * Garde des routes `/api/e2ee/*` : refus en 404 `E2EE_INACTIF`, et son témoin.
 *
 * Le service de réglages est remplacé dans `require.cache` : ce test porte sur
 * la garde, la règle de cohorte a le sien (`e2eeSettingsService.test.js`).
 */
const assert = require('assert');

const servicePath = require.resolve('../services/e2eeSettingsService');
let autorises = new Set();
const appels = [];
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    peutPublier: async (alanyaID) => {
      appels.push(alanyaID);
      return autorises.has(alanyaID);
    },
  },
  paths: [],
  children: [],
};

const keyServicePath = require.resolve('../services/e2eeKeyService');
let publies = new Set();
require.cache[keyServicePath] = {
  id: keyServicePath,
  filename: keyServicePath,
  loaded: true,
  exports: { appareilPublie: async (appareilId) => publies.has(appareilId) },
  paths: [],
  children: [],
};

const requireE2ee = require('./requireE2ee');

function fauxRes() {
  const res = { statut: null, corps: null };
  res.status = (s) => { res.statut = s; return res; };
  res.json = (c) => { res.corps = c; return res; };
  return res;
}

async function passe(alanyaID, appareilId = null) {
  const res = fauxRes();
  let suivant = false;
  await requireE2ee({ user: { alanyaID, appareilId } }, res, () => { suivant = true; });
  return { res, suivant };
}

async function main() {
  autorises = new Set([7]);

  // Témoin : un compte de la cohorte passe, sans réponse écrite.
  const ok = await passe(7);
  assert.strictEqual(ok.suivant, true, 'un compte de la cohorte passe');
  assert.strictEqual(ok.res.statut, null);

  // Refus : 404 et le code que l'application sait taire.
  const refus = await passe(8);
  assert.strictEqual(refus.suivant, false, 'un compte hors cohorte ne passe pas');
  assert.strictEqual(refus.res.statut, 404);
  assert.strictEqual(refus.res.corps.code, 'E2EE_INACTIF');

  // La garde interroge bien le compte de la requête, pas un autre.
  assert.deepStrictEqual(appels, [7, 8]);

  // Un appareil qui a déjà publié passe même hors cohorte : ses conversations
  // déjà chiffrées doivent continuer de fonctionner si l'on referme le cran.
  publies = new Set([80]);
  assert.strictEqual((await passe(8, 80)).suivant, true, 'appareil déjà inscrit');
  // Témoin : un autre appareil du même compte, jamais inscrit, reste dehors.
  assert.strictEqual((await passe(8, 81)).suivant, false);

  console.log('requireE2ee.test.js OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
