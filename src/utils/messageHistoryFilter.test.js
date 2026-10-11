/**
 * Aperçu de liste après « Effacer la discussion » —
 * `node src/utils/messageHistoryFilter.test.js`.
 */
const assert = require('assert');
const { HISTORY_CUTOFF_SQL, masquerDernierMessageEfface } = require('./messageHistoryFilter');

const conv = (extra = {}) => ({
  conversID: 1,
  lastMessage: 'salut',
  lastMessageAt: new Date('2026-10-10T10:00:00Z'),
  lastMessageSenderID: 7,
  lastMessageType: 1,
  lastMessageStatus: 2,
  myHistoryCutoffAt: null,
  ...extra,
});

let n = 0;
const ok = (nom, fn) => { fn(); n += 1; };

ok('sans curseur : l\'aperçu reste', () => {
  const c = masquerDernierMessageEfface(conv());
  assert.strictEqual(c.lastMessage, 'salut');
  assert.strictEqual(c.lastMessageType, 1);
});

ok('dernier message antérieur au curseur : aperçu masqué, date conservée', () => {
  const c = masquerDernierMessageEfface(conv({ myHistoryCutoffAt: new Date('2026-10-10T12:00:00Z') }));
  assert.strictEqual(c.lastMessage, null);
  assert.strictEqual(c.lastMessageSenderID, null);
  assert.strictEqual(c.lastMessageType, 0);
  assert.strictEqual(c.lastMessageStatus, 0);
  assert.ok(c.lastMessageAt, 'lastMessageAt ordonne la liste, il reste');
});

ok('dernier message postérieur au curseur : aperçu intact', () => {
  const c = masquerDernierMessageEfface(conv({ myHistoryCutoffAt: new Date('2026-10-10T09:00:00Z') }));
  assert.strictEqual(c.lastMessage, 'salut');
});

ok('même seconde : le message est visible (>=, comme HISTORY_CUTOFF_SQL)', () => {
  const t = new Date('2026-10-10T10:00:00Z');
  const c = masquerDernierMessageEfface(conv({ myHistoryCutoffAt: t, lastMessageAt: t }));
  assert.strictEqual(c.lastMessage, 'salut');
  assert.match(HISTORY_CUTOFF_SQL, />=/);
});

ok('dates en chaîne ou illisibles : jamais d\'exception, rien de masqué à tort', () => {
  const c1 = masquerDernierMessageEfface(conv({ myHistoryCutoffAt: '2026-10-10T12:00:00.000Z', lastMessageAt: '2026-10-10T10:00:00.000Z' }));
  assert.strictEqual(c1.lastMessage, null);
  const c2 = masquerDernierMessageEfface(conv({ myHistoryCutoffAt: 'n\'importe quoi' }));
  assert.strictEqual(c2.lastMessage, 'salut');
  const c3 = masquerDernierMessageEfface(conv({ myHistoryCutoffAt: new Date(), lastMessageAt: null }));
  assert.strictEqual(c3.lastMessage, 'salut');
  assert.strictEqual(masquerDernierMessageEfface(null), null);
});

console.log(`messageHistoryFilter : ${n} cas OK`);
