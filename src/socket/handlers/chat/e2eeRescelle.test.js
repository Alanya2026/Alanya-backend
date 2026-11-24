/**
 * `node src/socket/handlers/chat/e2eeRescelle.test.js`
 *
 * La règle du rescellement : seul l'auteur réécrit SON message chiffré, à
 * deux, et la modification reste dans la même fenêtre qu'un message en
 * clair. Le renvoi, lui, vaut pour trente jours.
 */

const assert = require('assert');
const {
  refusRescellement,
  FENETRE_MODIFICATION_MINUTES,
  RENVOI_MAX_JOURS,
  _demandeRecentePourTest: demandeRecente,
} = require('./e2eeRescelle');

const maintenant = new Date('2026-11-24T10:00:00Z');
const il = (minutes) => new Date(maintenant.getTime() - minutes * 60 * 1000);
const msg = (champs = {}) => ({
  senderID: 10, isDeleted: 0, enc_version: 1, isGroup: 0, type: 0, sendAt: il(1), ...champs,
});
const r = (message, { auteur = 10, edition = true } = {}) =>
  refusRescellement({ message, auteur, edition, maintenant });

// Cas nominal : modification et renvoi.
assert.strictEqual(r(msg()), null);
assert.strictEqual(r(msg(), { edition: false }), null);

// Pas le sien, absent, supprimé : indiscernables.
assert.strictEqual(r(null), 'MESSAGE_NOT_FOUND');
assert.strictEqual(r(msg(), { auteur: 255 }), 'MESSAGE_NOT_FOUND');
assert.strictEqual(r(msg({ isDeleted: 1 })), 'MESSAGE_NOT_FOUND');

// Un message en clair ne devient pas chiffré par ce chemin.
assert.strictEqual(r(msg({ enc_version: 0 })), 'E2EE_MESSAGE_CLAIR');
// Les groupes viendront avec les chaînes d'expéditeur.
assert.strictEqual(r(msg({ isGroup: 1 })), 'E2EE_GROUPE_NON_PRIS_EN_CHARGE');

// Modification : un texte seulement, dans la fenêtre.
assert.strictEqual(r(msg({ type: 1 })), 'EDIT_TYPE_NON_PRIS_EN_CHARGE');
assert.strictEqual(r(msg({ sendAt: il(FENETRE_MODIFICATION_MINUTES - 1) })), null);
assert.strictEqual(r(msg({ sendAt: il(FENETRE_MODIFICATION_MINUTES + 1) })), 'EDIT_WINDOW_EXPIRED');

// Renvoi : tout type (un média a sa légende), trente jours.
assert.strictEqual(r(msg({ type: 1, sendAt: il(60 * 24 * 3) }), { edition: false }), null);
assert.strictEqual(
  r(msg({ sendAt: il(60 * 24 * (RENVOI_MAX_JOURS + 1)) }), { edition: false }),
  'E2EE_RENVOI_TROP_ANCIEN',
);

// Une demande de renvoi n'est transmise qu'une fois par période.
const t0 = Date.now();
assert.strictEqual(demandeRecente('1:2', t0), false);
assert.strictEqual(demandeRecente('1:2', t0 + 1000), true);
assert.strictEqual(demandeRecente('1:3', t0 + 1000), false, 'autre appareil : transmise');
assert.strictEqual(demandeRecente('1:2', t0 + 11 * 60 * 1000), false, 'période écoulée');

console.log('e2eeRescelle.test.js OK');
