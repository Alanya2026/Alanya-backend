/**
 * `node src/utils/conversationDevices.test.js`
 *
 * Ce fichier garde la règle de bascule d'une flotte mixte. Elle n'est pas
 * symétrique, et c'est délibéré :
 *
 *  - un appareil TIERS sans bundle rend la conversation non chiffrable (lui
 *    envoyer du chiffré, c'est lui envoyer un message qu'il ne lira jamais) ;
 *  - un de MES appareils sans bundle ne bloque rien (il manquera ce message,
 *    le destinataire l'aura quand même).
 *
 * Inverser l'une des deux donne une panne discrète : soit des messages
 * illisibles chez le correspondant, soit une messagerie qui refuse de
 * chiffrer pour toujours parce qu'une vieille tablette traîne dans
 * `appareils`.
 */

const assert = require('assert');
const { evalueCibles, ecartCouverture } = require('./conversationDevices');

const MOI = 1;
const MON_APPAREIL = 10;
const AUTRE = 2;

// Conversation directe, chacun un appareil, les deux à jour.
let r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 20, alanyaID: AUTRE },
  ],
  avecCles: [10, 20],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.strictEqual(r.chiffrable, true);
assert.deepStrictEqual(
  r.cibles, [{ appareilId: 20, alanyaID: AUTRE, estMoi: false }],
  'l\'appareil appelant ne doit jamais figurer dans ses propres cibles',
);

// Mes deux appareils + le sien : la copie pour mon autre appareil est une
// cible, sinon mon second téléphone ne voit pas ce que j'écris du premier.
r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 11, alanyaID: MOI },
    { id: 20, alanyaID: AUTRE },
  ],
  avecCles: [10, 11, 20],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.strictEqual(r.chiffrable, true);
assert.deepStrictEqual(
  r.cibles.map((c) => c.appareilId).sort(), [11, 20],
  'mon autre appareil doit être une cible',
);
assert.strictEqual(
  r.cibles.find((c) => c.appareilId === 11).estMoi, true,
  'mes propres appareils doivent être marqués comme tels',
);

// ── L'asymétrie, cas par cas ────────────────────────────────────────────

// Un appareil TIERS sans bundle : on renonce pour toute la conversation.
r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 20, alanyaID: AUTRE },
    { id: 21, alanyaID: AUTRE },
  ],
  avecCles: [10, 20],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.strictEqual(
  r.chiffrable, false,
  'un seul appareil tiers sans bundle suffit à renoncer au chiffrement',
);
assert.deepStrictEqual(r.autresSansCles, [21]);

// Un de MES appareils sans bundle : on chiffre quand même.
r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 11, alanyaID: MOI },
    { id: 20, alanyaID: AUTRE },
  ],
  avecCles: [10, 20],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.strictEqual(
  r.chiffrable, true,
  'ma propre tablette en retard ne doit pas désarmer le chiffrement du fil',
);
assert.deepStrictEqual(
  r.mesAppareilsSansCles, [11],
  'elle doit tout de même être signalée, pour que l\'application le dise',
);
assert.ok(
  !r.cibles.some((c) => c.appareilId === 11),
  'un appareil sans bundle n\'est pas une cible : il n\'y a rien à sceller pour lui',
);

// ── Cas limites ─────────────────────────────────────────────────────────

// Plus aucun appareil tiers actif : rien à chiffrer, donc pas de cadenas.
// Sans cette garde, une conversation avec un correspondant qui a révoqué
// tous ses appareils s'afficherait comme chiffrée.
r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 11, alanyaID: MOI },
  ],
  avecCles: [10, 11],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.strictEqual(
  r.chiffrable, false,
  'sans aucune cible tierce, la conversation n\'est pas chiffrable',
);
assert.deepStrictEqual(r.cibles.map((c) => c.appareilId), [11]);

// Seul avec un seul appareil : aucune cible, rien ne casse.
r = evalueCibles({
  appareils: [{ id: 10, alanyaID: MOI }],
  avecCles: [10],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.deepStrictEqual(r.cibles, []);
assert.strictEqual(r.chiffrable, false);

// Groupe à trois, tous à jour : deux comptes tiers, trois appareils cibles.
r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 20, alanyaID: AUTRE },
    { id: 21, alanyaID: AUTRE },
    { id: 30, alanyaID: 3 },
  ],
  avecCles: [10, 20, 21, 30],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.strictEqual(r.chiffrable, true);
assert.strictEqual(r.cibles.length, 3);

// Identifiants en chaînes : mysql2 rend parfois les BIGINT ainsi selon la
// configuration du pool. La comparaison avec `monAppareilId` doit tenir.
r = evalueCibles({
  appareils: [
    { id: '10', alanyaID: '1' },
    { id: '20', alanyaID: '2' },
  ],
  avecCles: ['10', '20'],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
});
assert.deepStrictEqual(
  r.cibles, [{ appareilId: 20, alanyaID: AUTRE, estMoi: false }],
  'des identifiants en chaînes ne doivent pas faire de l\'appelant sa propre cible',
);

// Clé d'identité et capacité recopiées sur les cibles quand elles sont
// fournies : c'est ce qui permet au client de détecter une réinstallation
// sans demander de bundle, donc sans consommer de clé à usage unique.
r = evalueCibles({
  appareils: [
    { id: 10, alanyaID: MOI },
    { id: 20, alanyaID: AUTRE },
  ],
  avecCles: [10, 20],
  moiId: MOI,
  monAppareilId: MON_APPAREIL,
  details: new Map([[20, { identityKey: 'BQcH', capacite: 2 }]]),
});
assert.deepStrictEqual(
  r.cibles,
  [{ appareilId: 20, alanyaID: AUTRE, estMoi: false, identityKey: 'BQcH', capacite: 2 }],
);

// ── Couverture d'un envoi chiffré ──
//
// Le client ne redemande plus la liste avant chaque message : c'est ce
// contrôle qui rattrape une liste vieillie. Un appareil oublié ne recevrait
// rien sans le savoir ; une enveloppe pour un appareil révoqué dit que la
// liste du client est périmée.
const cibles = [
  { appareilId: 20, alanyaID: AUTRE, estMoi: false },
  { appareilId: 11, alanyaID: MOI, estMoi: true },
];

// Exactement couvert : rien à redire, l'ordre ne compte pas.
assert.deepStrictEqual(
  ecartCouverture({ cibles, enveloppes: [{ appareilId: 11 }, { appareilId: 20 }] }),
  { manquants: [], enTrop: [] },
);

// Nouvel appareil du correspondant (21), absent de la liste du client.
assert.deepStrictEqual(
  ecartCouverture({
    cibles: [...cibles, { appareilId: 21, alanyaID: AUTRE, estMoi: false }],
    enveloppes: [{ appareilId: 11 }, { appareilId: 20 }],
  }),
  { manquants: [21], enTrop: [] },
);

// Mon autre appareil oublié : manquant aussi — sans lui, il ne verrait pas
// ce que j'écris depuis celui-ci.
assert.deepStrictEqual(
  ecartCouverture({ cibles, enveloppes: [{ appareilId: 20 }] }),
  { manquants: [11], enTrop: [] },
);

// Appareil révoqué (30) encore dans la liste du client.
assert.deepStrictEqual(
  ecartCouverture({
    cibles,
    enveloppes: [{ appareilId: 11 }, { appareilId: 20 }, { appareilId: 30 }],
  }),
  { manquants: [], enTrop: [30] },
);

// Identifiants en chaîne (JSON) : comparés comme des nombres.
assert.deepStrictEqual(
  ecartCouverture({ cibles, enveloppes: [{ appareilId: '11' }, { appareilId: '20' }] }),
  { manquants: [], enTrop: [] },
);

console.log('conversationDevices.test.js OK');
