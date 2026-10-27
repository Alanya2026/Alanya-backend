const assert = require('assert');
const { buildSentPayload } = require('./sentMessagePayload');

/**
 * Le payload `message:sent` n'est plus relu en base : il est reconstruit en
 * mémoire. Ces tests figent le contrat pour que la reconstruction ne puisse pas
 * dériver de ce que rendait `toClientMsg(loadMessageById(...))`.
 */

// Ligne telle que `MSG_SELECT` la rend : les colonnes de `message` (le
// `mediaThumb` de la table étant écrasé par l'alias `MEDIA_THUMB_SELECT`),
// plus l'identité de l'expéditeur, plus la clé `clientId` ajoutée par
// `toClientMsg`. Fixture figée : la faire évoluer suppose d'avoir vérifié que
// le client sait lire la nouvelle forme.
const MSG_SELECT_KEYS = [
  'msgID', 'senderID', 'conversationID', 'clientID', 'content', 'type', 'status',
  // `enc_version` (migration 092). La graphie est celle de la colonne, pas du
  // camelCase : `MSG_SELECT` fait `m.*`, donc le client doit lire la même clé
  // qu'il reçoive ce payload construit en mémoire ou une ligne relue.
  'enc_version',
  'sendAt', 'readAt', 'deliveredAt', 'clickSentAt',
  'mediaUrl', 'mediaName', 'mediaDuration', 'mediaSize', 'mediaPageCount', 'mediaThumb',
  'isDeleted', 'deletedForID', 'isEdited', 'editedAt',
  'replyToID', 'replyToContent', 'isStatusReply',
  'has_reactions', 'reactions', 'isForwarded', 'isPinned', 'pinnedAt', 'pinnedBy',
  'isViewOnce', 'viewedAt', 'mentions',
  // Document sensible (migration 110).
  'isSensitive', 'mediaProtection',
  'sender_nom', 'sender_pseudo', 'sender_avatar', 'messageTz', 'messageTzOffset',
  'sender_account_type', 'sender_verification_status',
  'clientId',
];

const sendAt = new Date('2026-09-01T12:00:00.000Z');
const clickSentAt = '2026-09-01T11:59:59.500Z';

const payload = buildSentPayload({
  msgID: 4242,
  senderID: 7,
  conversationID: 99,
  clientId: 'c_7_1756728000000_12345',
  sendAt,
  clickSentAt,
  content: 'salut',
  type: 0,
  mediaUrl: null,
  mediaName: null,
  mediaDuration: null,
  mediaSize: null,
  mediaPageCount: null,
  mediaThumb: null,
  replyToID: null,
  replyToContent: null,
  isStatusReply: 0,
  isForwarded: false,
  isViewOnce: false,
  mentions: null,
  senderIdentity: {
    sender_nom: 'Chris',
    sender_pseudo: 'chris237',
    sender_avatar: 'https://example.test/a.jpg',
    messageTz: 'Africa/Douala',
    messageTzOffset: 1,
  },
});

// ── enc_version : strictement 1 ou 0 ──────────────────────────────────────
//
// Un message annoncé chiffré sans corps dans `message_e2ee` est illisible
// pour tout le monde, définitivement. Le drapeau ne doit donc jamais passer à
// 1 par la grâce d'un test de véracité sur une valeur inattendue.
assert.strictEqual(payload.enc_version, 0, 'encVersion omis doit valoir 0');
const chiffre = buildSentPayload({ msgID: 1, type: 0, encVersion: 1 });
assert.strictEqual(chiffre.enc_version, 1);
assert.strictEqual(buildSentPayload({ msgID: 1, encVersion: '1' }).enc_version, 0);
assert.strictEqual(buildSentPayload({ msgID: 1, encVersion: true }).enc_version, 0);
assert.strictEqual(buildSentPayload({ msgID: 1, encVersion: 2 }).enc_version, 0);

// ── Contrat de clés ────────────────────────────────────────────────────────
const keys = Object.keys(payload).sort();
const expected = [...MSG_SELECT_KEYS].sort();
assert.deepStrictEqual(
  keys,
  expected,
  `payload et MSG_SELECT doivent porter les mêmes clés.\n` +
  `manquantes: ${expected.filter((k) => !keys.includes(k))}\n` +
  `en trop:    ${keys.filter((k) => !expected.includes(k))}`,
);

// Champs réellement lus par le client Dart (`_msgJsonToCompanion` et
// `Message.fromJson`) : aucun ne doit disparaître du payload.
for (const k of [
  'msgID', 'conversationID', 'senderID', 'content', 'type', 'status', 'sendAt',
  'clickSentAt', 'messageTz', 'messageTzOffset', 'deliveredAt', 'readAt',
  'mediaUrl', 'mediaName', 'mediaDuration', 'mediaSize', 'mediaPageCount',
  'mediaThumb', 'replyToID', 'replyToContent', 'isEdited', 'editedAt',
  'isDeleted', 'deletedForID', 'isStatusReply', 'isForwarded', 'isPinned',
  'isViewOnce', 'mentions', 'sender_nom', 'sender_pseudo', 'sender_avatar',
]) {
  assert.ok(k in payload, `clé consommée par le client absente du payload : ${k}`);
}

// ── Valeurs de création ────────────────────────────────────────────────────
assert.strictEqual(payload.status, 1, 'un message acquitté est au statut 1 (envoyé)');
assert.strictEqual(payload.deliveredAt, null);
assert.strictEqual(payload.readAt, null);
assert.strictEqual(payload.isDeleted, 0);
assert.strictEqual(payload.isEdited, 0);
assert.strictEqual(payload.isPinned, 0);
assert.strictEqual(payload.viewedAt, null);

// Les deux graphies du clientId, sans quoi l'ack ne se rattache à aucune
// bulle optimiste et le message resterait en double.
assert.strictEqual(payload.clientId, 'c_7_1756728000000_12345');
assert.strictEqual(payload.clientID, payload.clientId);

// Dates : des objets Date, comme mysql2 les rend, pour que socket.io les
// sérialise en ISO exactement comme avant.
assert.ok(payload.sendAt instanceof Date, 'sendAt doit être un Date');
assert.strictEqual(payload.sendAt.toISOString(), '2026-09-01T12:00:00.000Z');
assert.ok(payload.clickSentAt instanceof Date, 'clickSentAt string doit être normalisé en Date');
assert.strictEqual(payload.clickSentAt.toISOString(), clickSentAt);

// ── Média, citation, mentions ──────────────────────────────────────────────
const media = buildSentPayload({
  msgID: 1, senderID: 7, conversationID: 99, clientId: 'c1',
  sendAt, clickSentAt: null,
  content: 'légende', type: 1,
  mediaUrl: 'https://example.test/m.jpg', mediaName: 'm.jpg',
  mediaDuration: null, mediaSize: 1024, mediaPageCount: null,
  mediaThumb: 'aGVsbG8=',
  replyToID: 12, replyToContent: 'cité', isStatusReply: 0,
  isForwarded: true, isViewOnce: true,
  mentions: [3, 5],
  senderIdentity: null,
});
// La vignette base64 est renvoyée telle quelle, d'un seul tenant : c'est la
// forme que le client sait décoder, et celle que rend désormais aussi la
// lecture en base. Le destinataire l'affiche sans rien télécharger.
assert.strictEqual(media.mediaThumb, 'aGVsbG8=');
assert.ok(
  !/[\r\n]/.test(media.mediaThumb),
  'aucun saut de ligne : base64Decode côté Dart lève une FormatException dessus',
);
assert.strictEqual(media.mediaSize, 1024);
assert.strictEqual(media.replyToID, 12);
assert.strictEqual(media.replyToContent, 'cité');
assert.deepStrictEqual(media.mentions, [3, 5], 'mentions déjà normalisées, transmises telles quelles');
assert.strictEqual(media.isForwarded, 1, 'les booléens sortent en 0/1 comme un TINYINT');
assert.strictEqual(media.isViewOnce, 1);
assert.strictEqual(media.clickSentAt, null);
// Identité absente : ne doit pas jeter, seulement laisser les champs à null.
assert.strictEqual(media.sender_nom, null);
assert.strictEqual(media.messageTzOffset, null);

// Marqueur @Tous : transmis tel quel, le fan-out le relit.
const all = buildSentPayload({
  msgID: 2, senderID: 7, conversationID: 99, clientId: 'c2',
  sendAt, mentions: 'all', type: 0, content: 'hello',
});
assert.strictEqual(all.mentions, 'all');

// sendAt manquant : jamais null, sinon le tri des bulles casse.
const noDate = buildSentPayload({
  msgID: 3, senderID: 7, conversationID: 99, clientId: 'c3', type: 0, content: 'x',
});
assert.ok(noDate.sendAt instanceof Date, 'sendAt omis doit retomber sur maintenant');

// Date invalide côté client : ne doit pas produire un `Invalid Date` sérialisé
// en null silencieux au milieu du payload.
const badClick = buildSentPayload({
  msgID: 4, senderID: 7, conversationID: 99, clientId: 'c4',
  sendAt, clickSentAt: 'pas-une-date', type: 0, content: 'x',
});
assert.strictEqual(badClick.clickSentAt, null);

console.log('sentMessagePayload.test.js OK');

// ── Document sensible : drapeau 0/1, descripteur en objet (colonne JSON) ──
assert.strictEqual(payload.isSensitive, 0, 'isSensitive omis doit valoir 0');
assert.strictEqual(payload.mediaProtection, null);
const sensible = buildSentPayload({
  msgID: 1, isSensitive: true, mediaProtection: '{"sensible":true}',
});
assert.strictEqual(sensible.isSensitive, 1);
assert.deepStrictEqual(sensible.mediaProtection, { sensible: true });

console.log('sentMessagePayload sensible OK');
