/**
 * Galerie des médias et documents sensibles (migration 110) —
 * `node src/controllers/profileMediaSensible.test.js`.
 *
 * Un push sur main part en production sans appliquer les migrations : la
 * galerie ne doit pas tomber si la colonne `isSensitive` manque encore.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const requetes = [];
let colonnePresente = true;
require.cache[resolu('../config/db')] = {
  id: resolu('../config/db'),
  filename: resolu('../config/db'),
  loaded: true,
  exports: {
    query: async (sql) => {
      requetes.push(sql);
      if (!colonnePresente && /isSensitive/.test(sql)) {
        throw Object.assign(new Error("Unknown column 'm.isSensitive'"), { code: 'ER_BAD_FIELD_ERROR' });
      }
      return [[{ msgID: 3, conversationID: 1, senderID: 7, type: 1, mediaUrl: 'u' }]];
    },
  },
};

const { getMyMedia } = require('./profileMediaController');

const appel = async () => {
  let corps;
  let statut = 200;
  await getMyMedia(
    { user: { alanyaID: 7 }, query: {} },
    { json: (c) => { corps = c; }, status(s) { statut = s; return this; } },
  );
  return { statut, corps };
};

(async () => {
  // Migration appliquée : le filtre est là.
  let r = await appel();
  assert.strictEqual(r.statut, 200);
  assert.strictEqual(requetes.length, 1);
  assert.match(requetes[0], /AND m\.isSensitive = 0/);

  // Migration pas encore appliquée : rejouée sans le filtre, pas de 500.
  requetes.length = 0;
  colonnePresente = false;
  r = await appel();
  assert.strictEqual(r.statut, 200);
  assert.strictEqual(r.corps.items.length, 1);
  assert.strictEqual(requetes.length, 2);
  assert.doesNotMatch(requetes[1], /isSensitive/);

  console.log('profileMediaSensible.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
