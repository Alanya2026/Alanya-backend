/**
 * `node src/controllers/admin/safeboxModeration.test.js` — le fichier d'un
 * signalement se retrouve depuis le message signalé, jamais depuis un numéro
 * que la console ou l'auteur du signalement pourrait choisir.
 */

const assert = require('assert');
const { partageDuSignalement, shareIdDe } = require('./safeboxModeration');

let ok = 0;
const etapes = [];
const test = (nom, fn) => etapes.push([nom, fn]);

/** Faux pool : le signalement 1 vise un message de type 11 de l'inscrit 3, discussion 50. */
function fauxDb(signalement) {
  return {
    async query(sql, params) {
      if (sql.includes('FROM report r')) return [[signalement].filter(Boolean)];
      const [id, conv, sender] = params;
      // Partages existants : 7 (inscrit 3, discussion 50), 8 (inscrit 4, discussion 50), 9 (inscrit 3, discussion 51).
      const partages = [{ id: 7, conv: 50, sender: 3 }, { id: 8, conv: 50, sender: 4 }, { id: 9, conv: 51, sender: 3 }];
      return [partages.filter((p) => p.id === id && p.conv === conv && p.sender === sender)];
    },
  };
}
const message = (extra) => ({ type: 11, conversationID: 50, senderID: 3, content: null, target_excerpt: null, ...extra });

test('numéro lu dans le contenu du message', async () => {
  assert.strictEqual(await partageDuSignalement(1, fauxDb(message({ content: '{"v":1,"share":7}' }))), 7);
});

test('discussion chiffrée : l\'extrait de l\'auteur du signalement, vérifié', async () => {
  assert.strictEqual(await partageDuSignalement(1, fauxDb(message({ target_excerpt: '{"share":7,"name":"x"}' }))), 7);
});

test('extrait qui vise le fichier d\'un autre, ou d\'une autre discussion : refusé', async () => {
  assert.strictEqual(await partageDuSignalement(1, fauxDb(message({ target_excerpt: '{"share":8}' }))), null);
  assert.strictEqual(await partageDuSignalement(1, fauxDb(message({ target_excerpt: '{"share":9}' }))), null);
});

test('autre type de message, signalement inconnu, numéro absurde : rien', async () => {
  assert.strictEqual(await partageDuSignalement(1, fauxDb(message({ type: 1, content: '{"share":7}' }))), null);
  assert.strictEqual(await partageDuSignalement(1, fauxDb(null)), null);
  assert.strictEqual(await partageDuSignalement('abc', fauxDb(message({ content: '{"share":7}' }))), null);
  for (const v of [null, '', 'texte', '{"share":"7"}', '{"share":-1}', '[7]']) assert.strictEqual(shareIdDe(v), null, String(v));
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
  console.log(`admin/safeboxModeration : ${ok}/${etapes.length} tests passés`);
})();
