/**
 * Parité serveur / application de la règle de suppression pour tous —
 * `node src/utils/messageDeletion.parite.test.js`.
 *
 * `src/testUtils/messageDeletionCases.json` est une table de cas (rôles, type,
 * âge, état), calculée par un oracle INDÉPENDANT écrit d'après la spécification ;
 * la même table, octet pour octet, est lue par le test de l'application
 * (`test/message_deletion_policy_test.dart`). Si le serveur et l'application
 * s'écartent, l'un des deux tests tombe.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const del = require('./messageDeletion');

const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'testUtils', 'messageDeletionCases.json'), 'utf8'));
assert.deepStrictEqual(table.colonnes, ['isGroup', 'roleActeur', 'roleAuteur', 'acteurEstAuteur', 'type', 'ageMs', 'dejaSupprime', 'attendu']);
assert.ok(table.cas.length >= 700, `table trop courte : ${table.cas.length}`);

const MAINTENANT = Date.UTC(2026, 9, 11, 12, 0, 0);
let ok = 0;
for (const [isGroup, roleActeur, roleAuteur, acteurEstAuteur, type, ageMs, dejaSupprime, attendu] of table.cas) {
  const acteurID = 10;
  const r = del.decider({
    acteurID,
    message: { senderID: acteurEstAuteur ? acteurID : 11, sendAt: new Date(MAINTENANT - ageMs), type, isDeleted: dejaSupprime },
    contexte: { isGroup: Boolean(isGroup), roleActeur, roleAuteur },
    maintenant: MAINTENANT,
  });
  const obtenu = r.ok ? (r.parAdmin ? 'OK_ADMIN' : 'OK_SELF') : r.code;
  assert.strictEqual(obtenu, attendu, `cas ${JSON.stringify([isGroup, roleActeur, roleAuteur, acteurEstAuteur, type, ageMs, dejaSupprime])} : attendu ${attendu}, obtenu ${obtenu}`);
  ok += 1;
}
console.log(`messageDeletion.parite.test.js : ${ok} cas OK`);
