/**
 * `node src/socket/handlers/chat/envelopeRouting.test.js`
 *
 * Trois propriétés, dont deux ne se voient pas en test manuel :
 *
 * 1. **Chaque appareil ne reçoit QUE son enveloppe.** À l'écran, diffuser
 *    toutes les enveloppes à tout le monde marcherait très bien — chacun
 *    trierait et trouverait la sienne. Mais cela dirait à chacun combien
 *    d'appareils ont ses correspondants, et c'est précisément le genre de
 *    métadonnée que le chiffrement de bout en bout est censé ne pas livrer.
 *
 * 2. **Le serveur seul décide de l'événement.** `message:sent` vers mes
 *    autres appareils, `message:received` vers ceux des destinataires. Laisser
 *    le client l'étiqueter permettrait de faire afficher un message entrant
 *    comme un message qu'on aurait soi-même écrit, du mauvais côté du fil, et
 *    rien chez le destinataire ne le trahirait.
 *
 * 3. **L'appareil émetteur n'est jamais destinataire.** Il a déjà son accusé,
 *    et il détient le clair.
 */

const assert = require('assert');
const { planRoutage, emetEnveloppes } = require('./envelopeRouting');

const MON_APPAREIL = 10;
const MES_APPAREILS = new Set([10, 11]);

const enveloppes = [
  { appareilId: 11, header: '{"n":0}', envType: 2, wrappedKey: Buffer.alloc(48, 1) },
  { appareilId: 20, header: '{"n":1}', envType: 3, wrappedKey: Buffer.alloc(48, 2) },
  { appareilId: 21, header: '{"c":3}', envType: 4, wrappedKey: null },
];

// ── Le plan : une entrée par appareil, l'événement choisi par propriété ───

const plan = planRoutage({
  enveloppes,
  mesAppareils: MES_APPAREILS,
  monAppareilId: MON_APPAREIL,
});

assert.strictEqual(plan.length, 3);
assert.deepStrictEqual(
  plan.find((p) => p.appareilId === 11),
  { appareilId: 11, room: 'appareil_11', event: 'message:sent' },
  'mon autre appareil reçoit message:sent — c\'est mon propre message',
);
assert.deepStrictEqual(
  plan.find((p) => p.appareilId === 20),
  { appareilId: 20, room: 'appareil_20', event: 'message:received' },
  'l\'appareil d\'un destinataire reçoit message:received',
);

// L'appareil émetteur est écarté même si le client l'a listé.
assert.ok(
  !planRoutage({
    enveloppes: [...enveloppes, { appareilId: MON_APPAREIL, header: '{}', envType: 2 }],
    mesAppareils: MES_APPAREILS,
    monAppareilId: MON_APPAREIL,
  }).some((p) => p.appareilId === MON_APPAREIL),
  'l\'appareil émetteur ne doit jamais figurer dans le plan',
);

// Sans `monAppareilId` (jeton d'avant la migration 026), on route tout le
// reste plutôt que de ne rien router.
assert.strictEqual(
  planRoutage({ enveloppes, mesAppareils: MES_APPAREILS, monAppareilId: null }).length,
  3,
);

// Identifiants en chaînes : la comparaison d'appartenance doit tenir.
assert.strictEqual(
  planRoutage({
    enveloppes: [{ appareilId: '11', header: '{}', envType: 2 }],
    mesAppareils: [11],
    monAppareilId: '10',
  })[0].event,
  'message:sent',
);

// Liste de mes appareils vide : tout est « reçu ». C'est le repli correct —
// un message affiché comme entrant chez soi se corrige à la resynchronisation,
// alors que l'inverse attribuerait un message entrant au lecteur.
assert.strictEqual(
  planRoutage({ enveloppes, mesAppareils: new Set(), monAppareilId: MON_APPAREIL })
    .every((p) => p.event === 'message:received'),
  true,
);

assert.deepStrictEqual(planRoutage({ enveloppes: [], mesAppareils: MES_APPAREILS }), []);
assert.deepStrictEqual(planRoutage({ mesAppareils: MES_APPAREILS }), []);

// ── L'émission : une par appareil, et chacun n'a que la sienne ────────────

const chiffre = {
  body: Buffer.alloc(64, 9),
  nonce: Buffer.alloc(12, 8),
  enveloppes,
};

const emissions = [];
const io = {
  to(room) {
    return {
      emit(event, payload) { emissions.push({ room, event, payload }); },
    };
  },
};

const emis = emetEnveloppes(io, { payload: { msgID: 42 }, chiffre, plan });
assert.strictEqual(emis, 3);
assert.strictEqual(emissions.length, 3, 'une émission par appareil cible');

const vers20 = emissions.find((e) => e.room === 'appareil_20');
assert.strictEqual(vers20.event, 'message:received');
assert.strictEqual(vers20.payload.msgID, 42, 'le payload du message est conservé');
assert.strictEqual(vers20.payload.body.ct, Buffer.alloc(64, 9).toString('base64'));
assert.strictEqual(vers20.payload.envelope.appareilId, 20);
assert.strictEqual(vers20.payload.envelope.header, '{"n":1}');

// LA vérification qui compte : un seul objet `envelope`, le sien, et aucune
// trace des autres. Si un jour quelqu'un remplace `envelope` par une liste,
// ce test doit tomber.
assert.ok(
  !Array.isArray(vers20.payload.envelope),
  'chaque appareil reçoit UNE enveloppe, pas la liste de toutes',
);
assert.ok(
  !JSON.stringify(vers20.payload).includes('"appareilId":21'),
  'le payload d\'un appareil ne doit mentionner aucun autre appareil : sinon '
  + 'chacun apprend combien d\'appareils ont ses correspondants',
);
assert.ok(!JSON.stringify(vers20.payload).includes('"appareilId":11'));

// Enveloppe de chaîne de groupe : `wrappedKey` à null, jamais absente.
const vers21 = emissions.find((e) => e.room === 'appareil_21');
assert.strictEqual(vers21.payload.envelope.wrappedKey, null);
assert.strictEqual(vers21.payload.envelope.envType, 4);

// Un plan qui nomme un appareil sans enveloppe n'émet rien pour lui : mieux
// vaut un message qui arrive par la synchronisation qu'un payload tronqué.
assert.strictEqual(
  emetEnveloppes({ to: () => ({ emit: () => assert.fail('aucune émission attendue') }) }, {
    payload: {}, chiffre, plan: [{ appareilId: 99, room: 'appareil_99', event: 'message:received' }],
  }),
  0,
);

console.log('envelopeRouting.test.js OK');
