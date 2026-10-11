/**
 * Pierres tombales des suppressions pour tous —
 * `node src/utils/messageTombstone.test.js`. Base en mémoire.
 */
const assert = require('assert');
const { enregistrerSuppressions, lireSuppressions } = require('./messageTombstone');

function baseEnMemoire({ tableAbsente = false } = {}) {
  const etat = { lignes: [], suivant: 1, participants: [] };
  const horizon = { ageSecondes: 120 }; // âge donné aux lignes insérées
  const erreur = () => Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
  return {
    etat,
    horizon,
    async execute(sql, p = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (tableAbsente) throw erreur();
      if (/^INSERT IGNORE INTO message_deletion/.test(s)) {
        for (let i = 0; i < p.length; i += 3) {
          if (etat.lignes.some((l) => l.msgID === p[i])) continue;
          etat.lignes.push({
            id: etat.suivant++, msgID: p[i], conversationID: p[i + 1], deletedByID: p[i + 2],
            age: horizon.ageSecondes,
          });
        }
        return [{ affectedRows: 1 }, []];
      }
      if (/SELECT COALESCE\(MAX\(id\), 0\) AS maxID FROM message_deletion WHERE deletedAt/.test(s)) {
        const ids = etat.lignes.filter((l) => l.age >= 30).map((l) => l.id);
        return [[{ maxID: ids.length ? Math.max(...ids) : 0 }], []];
      }
      if (/FROM message_deletion d JOIN conv_participants cp/.test(s)) {
        const [alanyaID, apres, limite] = p;
        const rows = etat.lignes
          .filter((l) => l.id > apres && etat.participants.some((q) => q.conversID === l.conversationID && q.alanyaID === alanyaID))
          .sort((a, b) => a.id - b.id)
          .slice(0, limite);
        return [rows.map((r) => ({ ...r })), []];
      }
      throw new Error(`SQL inattendu : ${s}`);
    },
  };
}

(async () => {
  let n = 0;
  const ok = async (nom, fn) => { await fn(); n += 1; };

  await ok('enregistre une ligne par message, sans doublon si on rejoue', async () => {
    const db = baseEnMemoire();
    await enregistrerSuppressions(db, 5, [{ msgID: 10, conversationID: 1 }, { msgID: 11, conversationID: 1 }]);
    await enregistrerSuppressions(db, 5, [{ msgID: 10, conversationID: 1 }]);
    assert.deepStrictEqual(db.etat.lignes.map((l) => l.msgID), [10, 11]);
    assert.strictEqual(db.etat.lignes[0].deletedByID, 5);
  });

  await ok('liste vide : aucune requête', async () => {
    const db = baseEnMemoire();
    db.execute = async () => { throw new Error('ne devrait pas être appelé'); };
    await enregistrerSuppressions(db, 5, []);
  });

  await ok('table absente : l\'écriture est tolérée, la lecture rend une liste vide', async () => {
    const db = baseEnMemoire({ tableAbsente: true });
    await enregistrerSuppressions(db, 5, [{ msgID: 1, conversationID: 1 }]);
    const r = await lireSuppressions(db, 5, { apres: 3 });
    assert.deepStrictEqual(r, { deletions: [], cursor: 0, hasMore: false });
  });

  await ok('autre erreur à l\'écriture : remontée (la transaction doit s\'annuler)', async () => {
    const db = baseEnMemoire();
    db.execute = async () => { throw Object.assign(new Error('boum'), { code: 'ER_LOCK_DEADLOCK' }); };
    await assert.rejects(() => enregistrerSuppressions(db, 5, [{ msgID: 1, conversationID: 1 }]), /boum/);
  });

  await ok('premier appel (sans curseur) : rien rejoué, position courante', async () => {
    const db = baseEnMemoire();
    db.etat.participants.push({ conversID: 1, alanyaID: 9 });
    await enregistrerSuppressions(db, 5, [{ msgID: 10, conversationID: 1 }, { msgID: 11, conversationID: 1 }]);
    const r = await lireSuppressions(db, 9, {});
    assert.deepStrictEqual(r, { deletions: [], cursor: 2, hasMore: false });
  });

  await ok('rattrapage : seulement mes conversations, après le curseur', async () => {
    const db = baseEnMemoire();
    db.etat.participants.push({ conversID: 1, alanyaID: 9 }, { conversID: 2, alanyaID: 8 });
    await enregistrerSuppressions(db, 5, [{ msgID: 10, conversationID: 1 }, { msgID: 20, conversationID: 2 }, { msgID: 11, conversationID: 1 }]);
    const r = await lireSuppressions(db, 9, { apres: 0 });
    assert.deepStrictEqual(r.deletions.map((d) => d.msgID), [10, 11]);
    assert.strictEqual(r.hasMore, false);
    assert.strictEqual(r.cursor, 3);
    const suite = await lireSuppressions(db, 9, { apres: r.cursor });
    assert.deepStrictEqual(suite.deletions, []);
  });

  await ok('pagination : hasMore, curseur = dernière ligne rendue', async () => {
    const db = baseEnMemoire();
    db.etat.participants.push({ conversID: 1, alanyaID: 9 });
    await enregistrerSuppressions(db, 5, [1, 2, 3, 4, 5].map((m) => ({ msgID: m, conversationID: 1 })));
    const p1 = await lireSuppressions(db, 9, { apres: 0, limite: 2 });
    assert.deepStrictEqual(p1.deletions.map((d) => d.msgID), [1, 2]);
    assert.strictEqual(p1.hasMore, true);
    assert.strictEqual(p1.cursor, 2);
    const p2 = await lireSuppressions(db, 9, { apres: p1.cursor, limite: 10 });
    assert.deepStrictEqual(p2.deletions.map((d) => d.msgID), [3, 4, 5]);
    assert.strictEqual(p2.hasMore, false);
  });

  await ok('le curseur ne dépasse pas une ligne récente (transaction pas encore visible)', async () => {
    const db = baseEnMemoire();
    db.etat.participants.push({ conversID: 1, alanyaID: 9 });
    db.horizon.ageSecondes = 1; // lignes toutes récentes
    await enregistrerSuppressions(db, 5, [{ msgID: 10, conversationID: 2 }, { msgID: 11, conversationID: 2 }]);
    const r = await lireSuppressions(db, 9, { apres: 0 });
    assert.deepStrictEqual(r.deletions, []);
    assert.strictEqual(r.cursor, 0, 'jamais plus loin que l\'horizon de 30 s');
  });

  await ok('plafond de page', async () => {
    const db = baseEnMemoire();
    db.etat.participants.push({ conversID: 1, alanyaID: 9 });
    await enregistrerSuppressions(db, 5, Array.from({ length: 700 }, (_, i) => ({ msgID: i + 1, conversationID: 1 })));
    const r = await lireSuppressions(db, 9, { apres: 0, limite: 100000 });
    assert.strictEqual(r.deletions.length, 500);
    assert.strictEqual(r.hasMore, true);
  });

  console.log(`messageTombstone : ${n} cas OK`);
})().catch((e) => { console.error(e); process.exit(1); });
