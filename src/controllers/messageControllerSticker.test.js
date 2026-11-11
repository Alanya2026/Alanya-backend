/**
 * Édition d'un message sticker — `node src/controllers/messageControllerSticker.test.js`.
 *
 * La faille MOYENNE/BASSE de l'audit sécurité : `PUT /api/messages/:id`
 * acceptait de remplacer le `content` d'un sticker (type 10) — un JSON canonisé
 * que le serveur a écrit à l'envoi — par du texte arbitraire, affiché en JSON
 * brut chez les destinataires (le JSON versionné est justement ce qu'on ne
 * doit jamais exposer, cf. `messagePreview`).
 *
 * Le test appelle le contrôleur réel, avec `src/config/db` doublé (même patron
 * que `stickerRoutes.test.js`). Seules les lignes `message` sont scriptées.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

let ok = 0;
const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

(async () => {
  /** Séquence de réponses SQL : chaîne = SELECT (rows), objet = ResultSetHeader. */
  const lance = async (script, params) => {
    const requetes = [];
    const fake = {
      execute: async (sql, p) => {
        requetes.push([sql, p]);
        const reponse = script.shift();
        if (typeof reponse === 'function') return reponse(sql, p, requetes);
        return Array.isArray(reponse) ? [reponse, []] : [reponse, []];
      },
    };
    remplace('../config/db', fake);
    delete require.cache[resolu('./messageController')];
    const ctrl = require('./messageController');

    const res = { statut: null, corps: null };
    const reponse = await new Promise((resoudre) => {
      ctrl.updateMessage(
        {
          params,
          body: { content: 'nouveau texte' },
          user: { alanyaID: 42 },
          app: { get: () => null },
        },
        {
          status: (s) => ({ json: (j) => resoudre({ statut: s, corps: j }) }),
          json: (j) => resoudre({ statut: 200, corps: j }),
        },
      ).catch((e) => resoudre({ erreur: e, requetes }));
    });
    return { reponse, requetes };
  };

  const ligne = (over = {}) => ({
    msgID: 7, senderID: 42, conversationID: 1, enc_version: 0,
    type: 0, content: 'ancien', sendAt: new Date(), isDeleted: 0, ...over,
  });

  test('éditer un sticker (type 10) est refusé en 409 STICKER_EDIT_FORBIDDEN', async () => {
    const { reponse, requetes } = await lance(
      [() => [[ligne({ type: 10, content: '{"v":1,"pack":"mboa","sid":4812}' })]]],
      { id: '7' },
    );
    assert.strictEqual(reponse.statut, 409);
    assert.strictEqual(reponse.corps.code, 'STICKER_EDIT_FORBIDDEN');
    // AUCUN UPDATE écrit : le contenu du sticker reste ce que le serveur a canonisé.
    assert.ok(!requetes.some(([sql]) => /UPDATE message/i.test(sql)), 'aucune écriture');
  });

  test("éditer un texte dans la fenêtre reste autorisé (régression des types 0-9)", async () => {
    const script = [
      () => [[ligne()]],
      () => [[{ e2ee_since: null }]], // le fil n'est pas chiffré
      () => ({}), // UPDATE → ResultSetHeader
      () => [[ligne({ content: 'nouveau texte', isEdited: 1 })]], // SELECT du message maj
    ];
    const { reponse, requetes } = await lance(script, { id: '7' });
    assert.strictEqual(reponse.statut, 200, JSON.stringify(reponse.erreur || ''));
    assert.strictEqual(reponse.corps.content, 'nouveau texte');
    assert.strictEqual(requetes.filter(([sql]) => /UPDATE message/i.test(sql)).length, 1);
  });

  test('éditer un ancien texte en clair d\'un fil passé en chiffré est refusé', async () => {
    // Témoin : le test précédent, même message, fil non chiffré, passe.
    const { reponse, requetes } = await lance(
      [() => [[ligne()]], () => [[{ e2ee_since: new Date() }]]],
      { id: '7' },
    );
    assert.strictEqual(reponse.statut, 409);
    assert.strictEqual(reponse.corps.code, 'CONVERSATION_CHIFFREE');
    assert.ok(!requetes.some(([sql]) => /UPDATE message/i.test(sql)), 'aucune écriture');
  });

  test("l'édition d'un texte chiffré garde son refus E2EE prioritaire", async () => {
    const { reponse } = await lance(
      [() => [[ligne({ type: 0, enc_version: 1 })]]],
      { id: '7' },
    );
    assert.strictEqual(reponse.statut, 409);
    assert.strictEqual(reponse.corps.code, 'E2EE_EDITION_NON_PRISE_EN_CHARGE');
  });

  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`messageControllerSticker.test.js : ${ok} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });