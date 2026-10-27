/**
 * Parité socket / HTTP — `node src/utils/stickerParite.test.js`.
 *
 * `message:send` et `POST /api/conversations/:id/messages` doivent appliquer
 * LA MÊME règle sur un type 10 : même fonction, mêmes refus, mêmes champs
 * réécrits. Le test fait deux choses : il vérifie dans les sources que les
 * deux chemins appellent `resolveStickerFields`, et il rejoue les fixtures du
 * contrat en traduisant chaque résultat dans la forme propre à chaque chemin.
 * (Les chemins eux-mêmes ont besoin d'une base : ils sont couverts par la
 * lecture des sources, pas exécutés ici.)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  resolveStickerFields, StickerMessageError, toSocketError,
} = require('./stickerMessage');

const lire = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const socketSrc = lire('../socket/handlers/chat/messageSend.js');
const httpSrc = lire('../controllers/messageController.js');

// ── 1. Les deux chemins appellent la même fonction, au même endroit ────────
for (const [nom, src] of [['socket', socketSrc], ['http', httpSrc]]) {
  assert.ok(/require\('(?:\.\.\/)+utils\/stickerMessage'\)/.test(src), `${nom} : importe utils/stickerMessage`);
  assert.strictEqual((src.match(/resolveStickerFields\(/g) || []).length, 1, `${nom} : un seul appel`);
  assert.ok(/resolveStickerFields\(\{\s*type, content, senderID, chiffre,?\s*\}\)/.test(src), `${nom} : mêmes arguments`);
}
// Après la politique d'envoi (appartenance, blocage), avant l'INSERT
const ordre = (src, a, b) => src.indexOf(a) < src.indexOf(b) && src.indexOf(a) !== -1;
assert.ok(ordre(socketSrc, 'resolveSendPolicy(', 'resolveStickerFields('), 'socket : politique avant sticker');
assert.ok(ordre(socketSrc, 'resolveStickerFields(', 'messageInsertParams({'), 'socket : sticker avant INSERT');
assert.ok(ordre(httpSrc, 'evaluateDirectMessageSend(conversationID', 'resolveStickerFields('), 'http : politique avant sticker');
assert.ok(ordre(httpSrc, 'resolveStickerFields(', 'messageInsertSql(chiffre'), 'http : sticker avant INSERT');
// Le chemin HTTP rend le feature du refus Plus ; le socket aussi (toSocketError)
assert.ok(/feature: error\.feature/.test(httpSrc), 'http : feature dans la réponse');
assert.ok(socketSrc.includes('toSocketError(e)'), 'socket : feature dans send_failed');
// Transfert : par référence, jamais de copie de fichier pour un sticker
assert.ok(/!copie\s*\?\s*null\s*:\s*await copyForForward/.test(httpSrc), 'transfert : copyForForward court-circuité');

// ── 2. Mêmes entrées, mêmes verdicts ───────────────────────────────────────
const ROW = {
  sid: 4812, emoji: '😂', pack_code: 'mboa', is_premium: 0, visibility: 0, pack_status: 1,
  asset_status: 0, storage_key: 'official/stickers/mboa/4812_ab12cd34.webp',
  width: 512, height: 512, animated: 0, installed: 0,
};
const mkDeps = (over = {}) => ({
  ouvert: async () => true,
  chargeSticker: async (sid) => (sid === 4812 ? { ...ROW, ...(over.row || {}) } : null),
  droits: async () => null,
  urlDe: (k) => `https://<bucket>/${k}`,
  ...over,
});

/** Ce que reçoit le client : le même verdict, deux emballages. */
async function viaSocket(entree, deps) {
  try {
    const r = await resolveStickerFields({ ...entree, chiffre: null }, deps);
    return { ok: true, champs: r };
  } catch (e) {
    if (!(e instanceof StickerMessageError)) throw e;
    return { ok: false, ...toSocketError(e) };
  }
}
async function viaHttp(entree, deps) {
  try {
    const r = await resolveStickerFields({ ...entree, chiffre: null }, deps);
    return { ok: true, champs: r };
  } catch (e) {
    if (!(e instanceof StickerMessageError)) throw e;
    // forme du `catch` de sendMessage : status + { error, code, feature? }
    return { ok: false, status: e.status, corps: { error: e.message, code: e.code, ...(e.feature ? { feature: e.feature } : {}) } };
  }
}

(async () => {
  const valide = require('../testUtils/stickers/message-sticker-valide.json');
  const hostile = require('../testUtils/stickers/message-sticker-hostile.json');
  const futur = require('../testUtils/stickers/message-sticker-version-future.json');
  const erreurs = require('../testUtils/stickers/erreurs.json');

  const scenarios = [
    ['valide', { type: 10, content: valide.entree_client.content }, mkDeps()],
    ['version future', { type: 10, content: futur.content }, mkDeps()],
    ['inconnu', { type: 10, content: '{"v":1,"sid":1}' }, mkDeps()],
    ['fermé', { type: 10, content: valide.entree_client.content }, mkDeps({ ouvert: async () => false })],
    ['Plus refusé', { type: 10, content: valide.entree_client.content },
      mkDeps({ row: { is_premium: 1 }, droits: async () => ({ features: { stickers_premium: false } }) })],
    ['Plus, droits illisibles', { type: 10, content: valide.entree_client.content },
      mkDeps({ row: { is_premium: 1 }, droits: async () => { throw new Error('boom'); } })],
    ['texte', { type: 0, content: 'salut' }, mkDeps()],
    ...hostile.cas.filter((c) => c.nom !== 'proto').map((c) => [
      `hostile ${c.nom}`,
      { type: 10, content: c.content_longueur ? 'x'.repeat(c.content_longueur) : c.content },
      mkDeps(),
    ]),
  ];

  for (const [nom, entree, deps] of scenarios) {
    const s = await viaSocket({ ...entree, senderID: 7 }, deps);
    const h = await viaHttp({ ...entree, senderID: 7 }, deps);
    assert.strictEqual(s.ok, h.ok, `${nom} : même verdict`);
    if (s.ok) {
      assert.deepStrictEqual(s.champs, h.champs, `${nom} : mêmes champs réécrits`);
    } else {
      assert.strictEqual(s.code, h.corps.code, `${nom} : même code`);
      assert.strictEqual(s.feature, h.corps.feature, `${nom} : même feature`);
      assert.strictEqual(h.status, erreurs[h.corps.code].status, `${nom} : statut du contrat`);
    }
  }

  console.log('stickerParite.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
