/**
 * `node src/utils/safeboxShareMessage.test.js` — message « fichier du coffre »
 * (type 11), sans base : la base est remplacée par un faux.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const M = require('./safeboxShareMessage');
const { messagePreview } = require('./messagePreview');

let ok = 0;
const etapes = [];
const test = (nom, fn) => etapes.push([nom, fn]);

/** Faux pool : un seul partage, n° 7, de l'inscrit 3 dans la discussion 50. */
const fauxDb = {
  async query(sql, [id, sender, conv]) {
    if (id === 7 && sender === 3 && conv === 50) {
      return [[{ id: 7, name: 'Mariage.mp4', mime: 'video/mp4', family: 'videos', plain_bytes: 880803840 }]];
    }
    return [[]];
  },
};
const resoudre = (champs) => M.resolveSafeboxShareFields({ type: 11, senderID: 3, conversationID: 50, ...champs }, { db: fauxDb });

test('un autre type ne passe pas par ici', async () => {
  assert.strictEqual(await M.resolveSafeboxShareFields({ type: 1, content: 'x' }, { db: fauxDb }), null);
});

test('contenu réécrit par le serveur, repli lisible pour les anciennes applications', async () => {
  const r = await resoudre({ content: JSON.stringify({ v: 1, share: 7, name: 'menteur.exe', size: 1 }) });
  const c = JSON.parse(r.content);
  assert.deepStrictEqual(c, { v: 1, share: 7, name: 'Mariage.mp4', size: 880803840, mime: 'video/mp4', family: 'videos' });
  assert.strictEqual(r.mediaUrl, null);
  assert.strictEqual(r.mediaName, '📦 Mariage.mp4 · 840 Mo');
});

test('mini-image floue gardée si raisonnable, jetée sinon', async () => {
  const b = Buffer.alloc(300, 1).toString('base64');
  assert.strictEqual(JSON.parse((await resoudre({ content: JSON.stringify({ v: 1, share: 7, b }) })).content).b, b);
  // Trop lourde : c'est tout le message qui est refusé, pas seulement l'image.
  await assert.rejects(resoudre({ content: JSON.stringify({ v: 1, share: 7, b: 'A'.repeat(7000) }) }), /invalide/);
  const pasBase64 = JSON.parse((await resoudre({ content: JSON.stringify({ v: 1, share: 7, b: '<script>' }) })).content);
  assert.ok(!('b' in pasBase64));
});

test('partage d\'un autre inscrit, d\'une autre discussion ou inconnu : refusé', async () => {
  for (const champs of [
    { content: JSON.stringify({ v: 1, share: 7 }), senderID: 4 },
    { content: JSON.stringify({ v: 1, share: 7 }), conversationID: 51 },
    { content: JSON.stringify({ v: 1, share: 8 }) },
    { content: 'pas du json' },
    { content: JSON.stringify({ v: 1, share: '7' }) },
    { content: null },
  ]) {
    await assert.rejects(resoudre(champs), (e) => e instanceof M.SafeboxShareMessageError && e.code === 'SAFEBOX_SHARE_INVALID' && e.status === 400);
  }
});

test('conversation chiffrée : rien n\'est gardé en clair', async () => {
  assert.deepStrictEqual(await resoudre({ content: 'scellé', chiffre: { body: 'x' } }), { content: null, mediaUrl: null, mediaName: null });
});

test('aperçu et citation : le nom, jamais le JSON', () => {
  const contenu = JSON.stringify({ v: 1, share: 7, name: 'Acte.pdf', size: 10 });
  assert.strictEqual(messagePreview({ type: 11, content: contenu }), '📦 Acte.pdf');
  assert.strictEqual(messagePreview({ type: 11, content: null }), '📦 Fichier');
  assert.strictEqual(M.sanitizeShareReply(contenu, 11), '📦 Acte.pdf');
  assert.strictEqual(M.sanitizeShareReply('bonjour', 0), 'bonjour');
});

test('tailles lisibles', () => {
  assert.strictEqual(M.tailleLisible(500), '1 Ko');
  assert.strictEqual(M.tailleLisible(5 * 1024 * 1024), '5 Mo');
  assert.strictEqual(M.tailleLisible(1.5 * 1024 ** 3), '1,5 Go');
});

test('les deux chemins d\'envoi appliquent la règle (socket et HTTP)', () => {
  for (const f of ['../socket/handlers/chat/messageSend.js', '../controllers/messageController.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.ok(src.includes('resolveSafeboxShareFields('), `${f} doit appeler resolveSafeboxShareFields`);
    assert.ok(src.includes('sanitizeShareReply('), `${f} doit nettoyer les citations de type 11`);
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
  console.log(`safeboxShareMessage : ${ok}/${etapes.length} tests passés`);
})();
