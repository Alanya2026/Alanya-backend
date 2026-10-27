/**
 * `node src/utils/documentSensible.test.js` — champs d'envoi d'un document
 * sensible et formes d'INSERT (migration 110).
 */
const assert = require('assert');
const {
  normaliseSensible,
  normaliseEmpreinte,
  DocumentSensibleInvalide,
  PROTECTION_MAX_OCTETS,
} = require('./documentSensible');
const {
  MESSAGE_INSERT_SQL,
  MESSAGE_INSERT_SENSIBLE_SQL,
  MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL,
  messageInsertSql,
  messageInsertParams,
} = require('./messageInsert');

const refuse = (champs, motif) => assert.throws(
  () => normaliseSensible(champs),
  (e) => e instanceof DocumentSensibleInvalide && e.code === 'INVALID_PAYLOAD' && e.status === 400,
  motif,
);

// ── Message ordinaire : rien ne change ──────────────────────────────────────
assert.deepStrictEqual(normaliseSensible({ type: 4 }), { isSensitive: false, mediaProtection: null });
assert.deepStrictEqual(normaliseSensible({ type: 0, isSensitive: 0 }), { isSensitive: false, mediaProtection: null });
refuse({ type: 4, mediaProtection: { sensible: true } }, 'descripteur sans drapeau');

// ── Drapeau : seulement sur un fichier ──────────────────────────────────────
for (const t of [1, 2, 3, 4, '4']) {
  assert.deepStrictEqual(normaliseSensible({ type: t, isSensitive: true }), { isSensitive: true, mediaProtection: null });
}
for (const v of [1, '1', 'true']) assert.strictEqual(normaliseSensible({ type: 1, isSensitive: v }).isSensitive, true);
for (const t of [0, 5, 7, 10, 11]) refuse({ type: t, isSensitive: true }, `type ${t}`);

// ── Descripteur : objet borné, sérialisé, jamais interprété ─────────────────
const d = { sensible: true, protection: { imprimer: false, ouverture: 'abcd', proprietaire: 'wxyz' } };
assert.deepStrictEqual(
  JSON.parse(normaliseSensible({ type: 4, isSensitive: true, mediaProtection: d }).mediaProtection), d,
);
assert.deepStrictEqual(
  JSON.parse(normaliseSensible({ type: 4, isSensitive: true, mediaProtection: JSON.stringify(d) }).mediaProtection), d,
  'chaîne JSON acceptée',
);
refuse({ type: 4, isSensitive: true, mediaProtection: '{pas du json' }, 'illisible');
refuse({ type: 4, isSensitive: true, mediaProtection: [1] }, 'tableau');
refuse({ type: 4, isSensitive: true, mediaProtection: 'true' }, 'scalaire');
refuse({ type: 4, isSensitive: true, mediaProtection: { x: 'a'.repeat(PROTECTION_MAX_OCTETS) } }, 'trop gros');
refuse({ type: 4, isSensitive: true, mediaProtection: d, chiffre: {} }, 'chiffré : dans l\'enveloppe');
assert.strictEqual(normaliseSensible({ type: 4, isSensitive: true, chiffre: {} }).isSensitive, true, 'chiffré : le drapeau reste');

// ── Empreinte ───────────────────────────────────────────────────────────────
assert.strictEqual(normaliseEmpreinte(null), null);
assert.strictEqual(normaliseEmpreinte(''), null);
assert.strictEqual(
  normaliseEmpreinte('3F9A 0C1E 5B7D 0000 1111 2222 3333 ABCD'),
  '3f9a0c1e5b7d0000111122223333abcd',
  'blocs lisibles et majuscules acceptés',
);
for (const mauvais of ['xyz', '3f9a', 'g'.repeat(32), 'a'.repeat(33)]) {
  assert.throws(() => normaliseEmpreinte(mauvais), DocumentSensibleInvalide, mauvais);
}

// ── INSERT : les colonnes ne sont nommées que pour un message sensible ──────
assert.strictEqual(messageInsertSql(null, false), MESSAGE_INSERT_SQL);
assert.ok(!/isSensitive/.test(MESSAGE_INSERT_SQL), 'chemin ordinaire inchangé');
assert.strictEqual(messageInsertSql(null, true), MESSAGE_INSERT_SENSIBLE_SQL);
assert.strictEqual(messageInsertSql({}, true), MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL);

const base = {
  senderID: 1, conversationID: 2, clientId: 'c', content: null, type: 4,
  clickSentAt: null, mediaUrl: 'u', mediaName: 'a.pdf', mediaDuration: null,
  mediaSize: 10, mediaPageCount: 1, replyToID: null, replyToContent: null,
  isStatusReply: 0, isForwarded: 0, isViewOnce: 0, mentionsSerialized: null,
};
const compte = (sql) => (sql.match(/\?/g) || []).length;
const colonnes = (sql) => sql.split('(')[1].split(')')[0].split(',').map((c) => c.trim());

assert.strictEqual(messageInsertParams(base).length, compte(MESSAGE_INSERT_SQL));
const p = messageInsertParams({ ...base, isSensitive: true, mediaProtection: '{"sensible":true}' });
assert.strictEqual(p.length, compte(MESSAGE_INSERT_SENSIBLE_SQL));
assert.strictEqual(p.length, compte(MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL));
// Les deux valeurs sont à la place de leurs colonnes (status est un littéral).
for (const sql of [MESSAGE_INSERT_SENSIBLE_SQL, MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL]) {
  const cols = colonnes(sql).filter((c) => c !== 'status' && c !== 'enc_version');
  assert.strictEqual(p[cols.indexOf('isSensitive')], 1);
  assert.strictEqual(p[cols.indexOf('mediaProtection')], '{"sensible":true}');
  assert.strictEqual(p[cols.indexOf('mentions')], null);
}

console.log('documentSensible.test.js OK');
