/**
 * Suppression POUR TOUS par le contrôleur réel (unitaire et par lot) —
 * `node src/controllers/messageControllerSuppression.test.js`.
 *
 * `src/config/db` est remplacé par une petite base EN MÉMOIRE qui comprend les
 * requêtes que ce chemin émet (lecture des messages et des rôles, mise à jour du
 * drapeau et du compteur) et qui sait annuler une transaction. Ce que le test
 * vérifie n'est donc pas « une requête a été émise » mais l'ÉTAT FINAL : qui est
 * supprimé, de combien le compteur baisse, ce que le retour arrière rend, quels
 * événements partent, et qu'aucune connexion ne reste prise.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

const H = 3600 * 1000;
const ilYa = (ms) => new Date(Date.now() - ms);

/* ── Base en mémoire ───────────────────────────────────────────────────── */

let etat;
let connexions; // { prises, rendues, annulations, validations }

function neuf() {
  etat = {
    messages: new Map(),
    participants: [], // { conversID, alanyaID, role }
    conversations: new Map(), // id → { isGroup, message_count }
    tombes: [], // pierres tombales (message_deletion) : { msgID, conversationID, deletedByID }
    tableTombesAbsente: false, // migration 099 pas encore appliquée
  };
  connexions = { prises: 0, rendues: 0, annulations: 0, validations: 0 };
}

function ajoute({ msgID, senderID, conversationID = 1, sendAt = ilYa(H), type = 0, isDeleted = 0 }) {
  etat.messages.set(msgID, { msgID, senderID, conversationID, sendAt, type, isDeleted, deletedForID: null });
}
function conv(id, isGroup, nombre, membres) {
  etat.conversations.set(id, { isGroup: isGroup ? 1 : 0, message_count: nombre });
  for (const [alanyaID, role] of membres) etat.participants.push({ conversID: id, alanyaID, role });
}

const copie = () => ({
  messages: new Map([...etat.messages].map(([k, v]) => [k, { ...v }])),
  conversations: new Map([...etat.conversations].map(([k, v]) => [k, { ...v }])),
  tombes: etat.tombes.map((t) => ({ ...t })),
});

async function executer(sql, p) {
  const s = sql.replace(/\s+/g, ' ').trim();
  // Lecture des messages d'un lot (suppression pour tous).
  if (/^SELECT msgID, senderID, conversationID, sendAt, type, isDeleted FROM message WHERE msgID IN/.test(s)) {
    return [p.map((id) => etat.messages.get(id)).filter(Boolean).map((m) => ({ ...m })), []];
  }
  // Lecture des rôles : conversations puis personnes (voir `chargerContextes`).
  if (/FROM conversation c JOIN conv_participants cp/.test(s)) {
    const n = (s.match(/c\.conversID IN \(([?,]+)\)/)[1].match(/\?/g) || []).length;
    const convs = p.slice(0, n);
    const gens = p.slice(n);
    const rows = etat.participants
      .filter((r) => convs.includes(r.conversID) && gens.includes(r.alanyaID))
      .map((r) => ({ conversID: r.conversID, isGroup: etat.conversations.get(r.conversID).isGroup, alanyaID: r.alanyaID, role: r.role }));
    return [rows, []];
  }
  if (/^INSERT IGNORE INTO message_deletion/.test(s)) {
    if (etat.tableTombesAbsente) throw Object.assign(new Error('no such table'), { code: 'ER_NO_SUCH_TABLE', errno: 1146 });
    for (let i = 0; i < p.length; i += 3) {
      if (!etat.tombes.some((t) => t.msgID === p[i])) {
        etat.tombes.push({ msgID: p[i], conversationID: p[i + 1], deletedByID: p[i + 2] });
      }
    }
    return [{ affectedRows: p.length / 3 }, []];
  }
  if (/^UPDATE message SET isDeleted = 1, deletedForID = NULL WHERE msgID IN/.test(s)) {
    let n = 0;
    for (const id of p) {
      const m = etat.messages.get(id);
      if (m && !m.isDeleted) { m.isDeleted = 1; m.deletedForID = null; n += 1; }
    }
    return [{ affectedRows: n }, []];
  }
  if (/^UPDATE conversation SET message_count = GREATEST\(0, message_count - \?\) WHERE conversID = \?/.test(s)) {
    const c = etat.conversations.get(p[1]);
    c.message_count = Math.max(0, c.message_count - p[0]);
    return [{ affectedRows: 1 }, []];
  }
  // « Pour moi » (chemins existants, inchangés).
  if (/^SELECT \* FROM message WHERE msgID = \? AND senderID = \?/.test(s)) {
    const m = etat.messages.get(Number(p[0]));
    return [m && m.senderID === p[1] ? [{ ...m }] : [], []];
  }
  if (/^UPDATE message SET deletedForID = \? WHERE msgID = \?/.test(s)) {
    const m = etat.messages.get(Number(p[1]));
    if (m) m.deletedForID = p[0];
    return [{ affectedRows: m ? 1 : 0 }, []];
  }
  if (/^SELECT msgID, conversationID, senderID FROM message WHERE msgID IN/.test(s)) {
    return [p.map((id) => etat.messages.get(id)).filter(Boolean).map((m) => ({ msgID: m.msgID, conversationID: m.conversationID, senderID: m.senderID })), []];
  }
  if (/^UPDATE message SET deletedForID = \? WHERE msgID IN/.test(s)) {
    const [uid, ...ids] = p;
    for (const id of ids) { const m = etat.messages.get(id); if (m) m.deletedForID = uid; }
    return [{ affectedRows: ids.length }, []];
  }
  throw new Error(`requête non prévue par le test : ${s.slice(0, 120)}`);
}

function fabriquerConnexion() {
  connexions.prises += 1;
  let instantane = null;
  let rendue = false;
  return {
    execute: executer,
    beginTransaction: async () => { instantane = copie(); },
    commit: async () => { connexions.validations += 1; instantane = null; },
    rollback: async () => {
      connexions.annulations += 1;
      if (instantane) { etat.messages = instantane.messages; etat.conversations = instantane.conversations; etat.tombes = instantane.tombes; }
      instantane = null;
    },
    release: () => { if (!rendue) { rendue = true; connexions.rendues += 1; } else throw new Error('connexion rendue deux fois'); },
  };
}

remplace('../config/db', { execute: executer, getConnection: async () => fabriquerConnexion() });
const ctrl = require('./messageController');

/* ── Appels ────────────────────────────────────────────────────────────── */

const evenements = [];
const io = { to: (room) => ({ emit: (nom, charge) => evenements.push([room, nom, charge]) }) };

async function appeler(fn, { params = {}, query = {}, body = {}, acteur }) {
  evenements.length = 0;
  return new Promise((resoudre) => {
    const req = { params, query, body, user: { alanyaID: acteur }, app: { get: (k) => (k === 'io' ? io : null) } };
    const res = {
      status: (s) => ({ json: (j) => resoudre({ statut: s, corps: j }) }),
      json: (j) => resoudre({ statut: 200, corps: j }),
    };
    fn(req, res).catch((e) => resoudre({ erreur: e }));
  });
}
const unitaire = (acteur, id, all = 'true') => appeler(ctrl.deleteMessage, { params: { id: String(id) }, query: { all }, acteur });
const lot = (acteur, msgIDs, all = true) => appeler(ctrl.batchDeleteMessages, { body: { msgIDs, all }, acteur });

const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);
const compteur = (id = 1) => etat.conversations.get(id).message_count;
const supprime = (id) => Boolean(etat.messages.get(id).isDeleted);

/** Un groupe (conversation 1) : 10 = propriétaire, 20 = admin, 21 = autre admin, 30 et 31 = membres. */
function groupeStandard() {
  conv(1, true, 10, [[10, 2], [20, 1], [21, 1], [30, 0], [31, 0]]);
}

/* ── Unitaire ──────────────────────────────────────────────────────────── */

test('expéditeur dans la fenêtre : supprimé, compteur −1, événement avec auteur et sans « parAdmin »', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30 });
  const r = await unitaire(30, 100);
  assert.deepStrictEqual([r.statut, r.corps], [200, { message: 'Message supprimé', all: true }]);
  assert.ok(supprime(100));
  assert.strictEqual(compteur(), 9);
  assert.deepStrictEqual(evenements, [['conversation_1', 'message:deleted', {
    msgID: 100, conversationID: 1, all: true, deletedForID: null, deletedBy: 30, byAdmin: false,
  }]]);
});

test('pierre tombale écrite pour un message supprimé pour tous (rattrapage hors ligne)', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30 }); ajoute({ msgID: 101, senderID: 30 });
  await unitaire(30, 100);
  await lot(20, [101]);
  assert.deepStrictEqual(etat.tombes, [
    { msgID: 100, conversationID: 1, deletedByID: 30 },
    { msgID: 101, conversationID: 1, deletedByID: 20 },
  ]);
});

test('aucune pierre tombale pour un refus, un message déjà supprimé ou « pour moi »', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 30, sendAt: ilYa(80 * H) }); ajoute({ msgID: 2, senderID: 30, isDeleted: 1 }); ajoute({ msgID: 3, senderID: 30 });
  await unitaire(30, 1);
  await unitaire(30, 2);
  await unitaire(30, 3, 'false');
  assert.deepStrictEqual(etat.tombes, []);
});

test('un lot refusé en cours de route n\'en laisse aucune (retour arrière)', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 30 }); ajoute({ msgID: 2, senderID: 30, sendAt: ilYa(80 * H) });
  const r = await lot(30, [1, 2]);
  assert.strictEqual(r.statut, 403);
  assert.deepStrictEqual(etat.tombes, []);
  assert.strictEqual(supprime(1), false);
});

test('table de pierres tombales absente (migration 099 non appliquée) : la suppression réussit quand même', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30 });
  etat.tableTombesAbsente = true;
  const r = await unitaire(30, 100);
  assert.strictEqual(r.statut, 200);
  assert.ok(supprime(100));
  assert.strictEqual(compteur(), 9);
});

test('expéditeur après 72 h : 403 DELETE_WINDOW_EXPIRED, rien ne change, pas d\'événement', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30, sendAt: ilYa(72 * H + 60000) });
  const r = await unitaire(30, 100);
  assert.deepStrictEqual([r.statut, r.corps.code], [403, 'DELETE_WINDOW_EXPIRED']);
  assert.ok(/72 heures/.test(r.corps.error));
  assert.strictEqual(supprime(100), false);
  assert.strictEqual(compteur(), 10);
  assert.strictEqual(evenements.length, 0);
});

test('juste avant 72 h : accepté ; juste après : refusé', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 30, sendAt: ilYa(72 * H - 30000) });
  ajoute({ msgID: 2, senderID: 30, sendAt: ilYa(72 * H + 30000) });
  assert.strictEqual((await unitaire(30, 1)).statut, 200);
  assert.strictEqual((await unitaire(30, 2)).corps.code, 'DELETE_WINDOW_EXPIRED');
});

test('admin supprime le message d\'un membre : « byAdmin » vrai, compteur −1', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30 });
  const r = await unitaire(20, 100);
  assert.strictEqual(r.statut, 200);
  assert.ok(supprime(100));
  assert.strictEqual(compteur(), 9);
  assert.strictEqual(evenements[0][2].byAdmin, true);
  assert.strictEqual(evenements[0][2].deletedBy, 20);
});

test('admin : la fenêtre de 72 h s\'applique aussi', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30, sendAt: ilYa(80 * H) });
  const r = await unitaire(20, 100);
  assert.deepStrictEqual([r.statut, r.corps.code], [403, 'DELETE_WINDOW_EXPIRED']);
  assert.strictEqual(supprime(100), false);
});

test('admin ne supprime ni un autre admin ni le propriétaire ; le propriétaire supprime un admin', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 21 }); ajoute({ msgID: 2, senderID: 10 }); ajoute({ msgID: 3, senderID: 20 });
  assert.deepStrictEqual([(await unitaire(20, 1)).statut, (await unitaire(20, 1)).corps.code], [403, 'FORBIDDEN']);
  assert.strictEqual((await unitaire(20, 2)).corps.code, 'FORBIDDEN');
  assert.strictEqual((await unitaire(10, 3)).statut, 200, 'propriétaire → admin');
  assert.ok(!supprime(1) && !supprime(2) && supprime(3));
});

test('membre simple : ne supprime pas le message d\'un autre membre (403 FORBIDDEN)', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 31 });
  const r = await unitaire(30, 100);
  assert.deepStrictEqual([r.statut, r.corps.code], [403, 'FORBIDDEN']);
  assert.strictEqual(supprime(100), false);
});

test('conversation à deux : l\'autre ne peut pas supprimer pour tous', async () => {
  neuf(); conv(2, false, 5, [[40, 0], [41, 0]]); ajoute({ msgID: 100, senderID: 40, conversationID: 2 });
  assert.strictEqual((await unitaire(41, 100)).corps.code, 'FORBIDDEN');
  assert.strictEqual((await unitaire(40, 100)).statut, 200);
  assert.strictEqual(compteur(2), 4);
});

test('non participant : 404 (pas de 403 qui confirmerait l\'existence)', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30 });
  const r = await unitaire(99, 100);
  assert.deepStrictEqual([r.statut, r.corps.code], [404, 'MESSAGE_NOT_FOUND']);
});

test('auteur qui a quitté le groupe : un admin peut encore retirer son message', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 77 }); // 77 n'est plus participant
  assert.strictEqual((await unitaire(20, 100)).statut, 200);
  // … et lui-même, n'étant plus dans la conversation, ne le peut plus.
  neuf(); groupeStandard(); ajoute({ msgID: 101, senderID: 77 });
  assert.strictEqual((await unitaire(77, 101)).statut, 404);
});

test('message système, bienvenue, trajet : un admin ne les retire pas ; leur auteur le peut (comportement existant)', async () => {
  neuf(); groupeStandard();
  for (const [id, type] of [[1, 6], [2, 8], [3, 9]]) ajoute({ msgID: id, senderID: 30, type });
  for (const id of [1, 2, 3]) assert.strictEqual((await unitaire(20, id)).corps.code, 'FORBIDDEN', `type du message ${id}`);
  assert.strictEqual((await unitaire(30, 1)).statut, 200);
});

test('identifiants invalides ou absents : 404 MESSAGE_NOT_FOUND', async () => {
  neuf(); groupeStandard();
  for (const id of ['abc', '0', '-4', '', '1;DROP', '99999']) {
    const r = await unitaire(30, id);
    assert.deepStrictEqual([r.statut, r.corps.code], [404, 'MESSAGE_NOT_FOUND'], `id « ${id} »`);
  }
});

test('suppression répétée : idempotente, le compteur ne baisse qu\'une fois', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30 });
  assert.strictEqual((await unitaire(30, 100)).statut, 200);
  assert.strictEqual((await unitaire(30, 100)).statut, 200);
  assert.strictEqual((await unitaire(20, 100)).statut, 200, 'un admin aussi');
  assert.strictEqual(compteur(), 9, 'une seule décrémentation');
});

test('redemander la suppression d\'un message déjà supprimé après 72 h : toujours 200', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30, isDeleted: 1, sendAt: ilYa(300 * H) });
  assert.strictEqual((await unitaire(30, 100)).statut, 200);
  assert.strictEqual(compteur(), 10);
});

test('le compteur ne devient jamais négatif', async () => {
  neuf(); conv(1, true, 0, [[30, 0]]); ajoute({ msgID: 100, senderID: 30 });
  assert.strictEqual((await unitaire(30, 100)).statut, 200);
  assert.strictEqual(compteur(), 0);
});

/* ── « Pour moi » : inchangé ───────────────────────────────────────────── */

test('« pour moi » : l\'expéditeur seulement, sans fenêtre, sans toucher au drapeau ni au compteur', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 100, senderID: 30, sendAt: ilYa(500 * H) });
  const r = await unitaire(30, 100, 'false');
  assert.deepStrictEqual([r.statut, r.corps], [200, { message: 'Message supprimé', all: false }]);
  assert.strictEqual(etat.messages.get(100).deletedForID, 30);
  assert.strictEqual(supprime(100), false);
  assert.strictEqual(compteur(), 10);
  assert.deepStrictEqual(evenements[0][2], { msgID: 100, conversationID: 1, all: false, deletedForID: 30 });
  // Un autre que l'expéditeur : toujours 404 (comportement existant).
  assert.strictEqual((await unitaire(31, 100, 'false')).statut, 404);
});

/* ── Lot ───────────────────────────────────────────────────────────────── */

test('lot : messages propres et de membres par un admin, un seul événement par conversation', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 20 }); ajoute({ msgID: 2, senderID: 30 }); ajoute({ msgID: 3, senderID: 31 });
  const r = await lot(20, [1, 2, 3]);
  assert.deepStrictEqual([r.statut, r.corps], [200, { deleted: 3, all: true }]);
  assert.ok(supprime(1) && supprime(2) && supprime(3));
  assert.strictEqual(compteur(), 7);
  assert.strictEqual(evenements.length, 1);
  assert.deepStrictEqual(evenements[0][2], {
    conversationID: 1, msgIDs: [1, 2, 3], all: true, deletedForID: null, deletedBy: 20, byAdminMsgIDs: [2, 3],
  });
});

test('lot : un seul message hors fenêtre → tout est refusé, rien n\'est supprimé, retour arrière', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 30 }); ajoute({ msgID: 2, senderID: 30, sendAt: ilYa(100 * H) }); ajoute({ msgID: 3, senderID: 30 });
  const r = await lot(30, [1, 2, 3]);
  assert.deepStrictEqual([r.statut, r.corps.code], [403, 'DELETE_WINDOW_EXPIRED']);
  assert.ok(!supprime(1) && !supprime(2) && !supprime(3), 'tout ou rien');
  assert.strictEqual(compteur(), 10);
  assert.strictEqual(evenements.length, 0);
  assert.strictEqual(connexions.annulations, 1);
  assert.strictEqual(connexions.validations, 0);
});

test('lot : un message d\'un autre admin → 403 FORBIDDEN pour tout le lot', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 1, senderID: 30 }); ajoute({ msgID: 2, senderID: 21 });
  const r = await lot(20, [1, 2]);
  assert.deepStrictEqual([r.statut, r.corps.code], [403, 'FORBIDDEN']);
  assert.ok(!supprime(1));
});

test('lot : message introuvable → 404, rien ne change', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 1, senderID: 30 });
  const r = await lot(30, [1, 999]);
  assert.deepStrictEqual([r.statut, r.corps.code], [404, 'MESSAGE_NOT_FOUND']);
  assert.ok(!supprime(1));
});

test('lot : plusieurs conversations, compteur et événement par conversation', async () => {
  neuf(); groupeStandard(); conv(2, false, 4, [[30, 0], [50, 0]]);
  ajoute({ msgID: 1, senderID: 30 }); ajoute({ msgID: 2, senderID: 30 });
  ajoute({ msgID: 3, senderID: 30, conversationID: 2 });
  const r = await lot(30, [1, 2, 3]);
  assert.strictEqual(r.statut, 200);
  assert.deepStrictEqual([compteur(1), compteur(2)], [8, 3]);
  assert.deepStrictEqual(evenements.map((e) => [e[0], e[2].msgIDs]).sort(), [['conversation_1', [1, 2]], ['conversation_2', [3]]]);
});

test('lot : messages déjà supprimés dans la sélection → le compteur ne baisse que des nouveaux', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 30, isDeleted: 1 }); ajoute({ msgID: 2, senderID: 30 }); ajoute({ msgID: 3, senderID: 30, isDeleted: 1 });
  const r = await lot(30, [1, 2, 3]);
  assert.strictEqual(r.statut, 200);
  assert.strictEqual(compteur(), 9, 'avant : −3 pour 3 lignes trouvées, même déjà supprimées');
});

test('lot : validations d\'entrée inchangées (vide, doublons, trop grand, identifiants invalides)', async () => {
  neuf(); groupeStandard();
  assert.deepStrictEqual([(await lot(30, [])).corps.code], ['MSG_IDS_REQUIRED']);
  assert.strictEqual((await lot(30, 'nope')).corps.code, 'MSG_IDS_REQUIRED');
  assert.strictEqual((await lot(30, [1, 1])).corps.code, 'INVALID_MSG_IDS');
  assert.strictEqual((await lot(30, ['a'])).corps.code, 'INVALID_MSG_IDS');
  assert.deepStrictEqual((await lot(30, Array.from({ length: 51 }, (_, i) => i + 1))).corps.code, 'LIMIT_REACHED');
});

test('lot « pour moi » : inchangé (expéditeur seulement, 403 sinon)', async () => {
  neuf(); groupeStandard(); ajoute({ msgID: 1, senderID: 30 }); ajoute({ msgID: 2, senderID: 31 });
  assert.strictEqual((await lot(30, [1, 2], false)).corps.code, 'FORBIDDEN');
  assert.strictEqual(etat.messages.get(1).deletedForID, null);
  const ok = await lot(30, [1], false);
  assert.deepStrictEqual([ok.statut, ok.corps], [200, { deleted: 1, all: false }]);
  assert.strictEqual(etat.messages.get(1).deletedForID, 30);
  assert.strictEqual(compteur(), 10);
});

test('valeurs de « all » du lot : true, 1, "1", "true" suppriment pour tous', async () => {
  for (const all of [true, 1, '1', 'true']) {
    neuf(); groupeStandard(); ajoute({ msgID: 1, senderID: 30 });
    const r = await appeler(ctrl.batchDeleteMessages, { body: { msgIDs: [1], all }, acteur: 30 });
    assert.strictEqual(r.statut, 200, `all = ${JSON.stringify(all)}`);
    assert.ok(supprime(1));
  }
});

/* ── Connexions ────────────────────────────────────────────────────────── */

test('aucune connexion ne reste prise, quel que soit le chemin (succès, refus, 404, validation)', async () => {
  neuf(); groupeStandard();
  ajoute({ msgID: 1, senderID: 30 }); ajoute({ msgID: 2, senderID: 30, sendAt: ilYa(99 * H) }); ajoute({ msgID: 3, senderID: 31 });
  await unitaire(30, 1); await unitaire(30, 2); await unitaire(30, 3); await unitaire(30, 'x'); await unitaire(99, 3);
  await lot(30, [3]); await lot(30, [2]); await lot(30, [404]); await lot(30, []); await lot(30, [3], false);
  assert.strictEqual(connexions.prises, connexions.rendues, `prises ${connexions.prises} / rendues ${connexions.rendues}`);
});

(async () => {
  let ok = 0;
  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.stack.split('\n').slice(0, 5).join('\n  ')}`);
      process.exit(1);
    }
  }
  console.log(`messageControllerSuppression.test.js : ${ok} tests OK`);
  process.exit(0);
})();
