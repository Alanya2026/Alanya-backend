/**
 * `node src/utils/e2eePolicy.test.js`
 *
 * Chaque refus a son témoin : le même geste, dans le cas où il doit passer,
 * passe. Une garde qui refuse tout n'est pas une garde, c'est une panne
 * (docs/e2ee, chapitre 5).
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let colonneAbsente = false;
let e2eeSince = null;
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, paths: [], children: [],
  exports: {
    execute: async () => {
      if (colonneAbsente) {
        const e = new Error("Unknown column 'e2ee_since'");
        e.code = 'ER_BAD_FIELD_ERROR';
        throw e;
      }
      return [[{ e2ee_since: e2eeSince }], []];
    },
  },
};

const {
  CONVERSATION_CHIFFREE,
  CONVERSATION_NON_CHIFFREE,
  SOURCE_CHIFFREE,
  refusEnvoi,
  refusModification,
  refusTransfert,
  filChiffre,
  erreurRefus,
} = require('./e2eePolicy');

const CORPS = { body: Buffer.from('x') };

// ── Envoi ─────────────────────────────────────────────────────────────────

// Fil chiffré : le texte en clair est refusé…
assert.strictEqual(refusEnvoi({ filChiffre: true, content: 'bonjour' }), CONVERSATION_CHIFFREE);
// …et passe dans un fil ordinaire (témoin).
assert.strictEqual(refusEnvoi({ filChiffre: false, content: 'bonjour' }), null);

// La légende d'un média, une fiche de contact ou de position sont du texte.
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 1, content: 'légende' }), CONVERSATION_CHIFFREE);
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 5, content: '{"lat":3.8}' }), CONVERSATION_CHIFFREE);
// Une citation en clair aussi : le texte cité est lisible par le serveur.
assert.strictEqual(
  refusEnvoi({ filChiffre: true, type: 1, content: null, replyToContent: 'cité' }),
  CONVERSATION_CHIFFREE,
);

// Un média SANS texte passe : le fichier n'est pas encore chiffré (étape 4).
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 1, content: null }), null);
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 1, content: '   ' }), null, 'espaces seuls');

// Autocollant et partage du coffre : contenu réécrit par le serveur.
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 10, content: '{"sid":4}' }), null);
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 11, content: '{"fid":4}' }), null);
// Témoin : le même contenu sous un autre type est refusé.
assert.strictEqual(refusEnvoi({ filChiffre: true, type: 0, content: '{"sid":4}' }), CONVERSATION_CHIFFREE);

// Corps chiffré : accepté dans un fil chiffré, refusé ailleurs.
assert.strictEqual(refusEnvoi({ filChiffre: true, chiffre: CORPS }), null);
assert.strictEqual(refusEnvoi({ filChiffre: false, chiffre: CORPS }), CONVERSATION_NON_CHIFFREE);

// ── Modification ──────────────────────────────────────────────────────────

assert.strictEqual(refusModification({ filChiffre: true }), CONVERSATION_CHIFFREE);
assert.strictEqual(refusModification({ filChiffre: false }), null);

// ── Transfert par le serveur ──────────────────────────────────────────────

assert.strictEqual(refusTransfert({ sourceChiffree: true, cibleChiffree: false }), SOURCE_CHIFFREE);
assert.strictEqual(refusTransfert({ cibleChiffree: true, content: 'texte' }), CONVERSATION_CHIFFREE);
assert.strictEqual(refusTransfert({ cibleChiffree: true, type: 1, content: null }), null, 'média sans texte');
assert.strictEqual(refusTransfert({ cibleChiffree: false, content: 'texte' }), null, 'témoin');

// ── Erreur rendue ─────────────────────────────────────────────────────────

const err = erreurRefus(CONVERSATION_CHIFFREE);
assert.strictEqual(err.status, 409);
assert.strictEqual(err.code, CONVERSATION_CHIFFREE);

// ── Lecture en base ───────────────────────────────────────────────────────

(async () => {
  e2eeSince = null;
  assert.strictEqual(await filChiffre(5), false);
  e2eeSince = new Date();
  assert.strictEqual(await filChiffre(5), true);
  // Migration 104 absente : rien n'est chiffré, et rien ne casse.
  colonneAbsente = true;
  assert.strictEqual(await filChiffre(5), false);
  console.log('e2eePolicy.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
