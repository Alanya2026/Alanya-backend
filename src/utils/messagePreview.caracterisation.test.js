/**
 * Caractérisation de `messagePreview` pour les types 0-9, écrite AVANT
 * l'ajout du type 10 (stickers). Elle fige le comportement actuel : si un
 * libellé change ici, c'est une régression, pas une amélioration.
 */
const assert = require('assert');
const { messagePreview } = require('./messagePreview');

const p = (o) => messagePreview(o);

// 0 — texte
assert.strictEqual(p({ type: 0, content: 'salut' }), 'salut');
assert.strictEqual(p({ type: 0, content: 'a'.repeat(300) }).length, 200);
// 1 — photo, 2 — vidéo
assert.strictEqual(p({ type: 1, content: '' }), '📷 Photo');
assert.strictEqual(p({ type: 1, content: '', isViewOnce: true }), '📷 Photo · Vue unique');
assert.strictEqual(p({ type: 2, content: '' }), '🎥 Vidéo');
assert.strictEqual(p({ type: 2, content: '', isViewOnce: 1 }), '🎥 Vidéo · Vue unique');
// 3 — vocal / musique
assert.strictEqual(p({ type: 3, content: '', mediaName: 'Message vocal' }), '🎤 Message vocal');
assert.strictEqual(p({ type: 3, content: '', mediaName: 'chanson.mp3' }), '🎵 chanson');
assert.strictEqual(p({ type: 3, content: '', isViewOnce: true }), '🎵 Audio · Vue unique');
// 4 — fichier
assert.strictEqual(p({ type: 4, content: '', mediaName: 'cv.pdf' }), '📎 cv.pdf');
assert.strictEqual(p({ type: 4, content: '' }), '📎 Fichier');
// 5 — position : jamais le JSON brut
const pos = p({ type: 5, content: '{"lat":3.8,"lng":11.5}' });
assert.ok(!pos.includes('{'), `position expose le JSON : ${pos}`);
assert.strictEqual(p({ type: 5, content: 'n\'importe quoi' }), '📍 Position');
// 6 — système de groupe : jamais le JSON brut
assert.strictEqual(p({ type: 6, content: '{cassé' }), 'Le groupe a été mis à jour');
// 7 — contact
assert.strictEqual(p({ type: 7, content: '{cassé' }), '👤 Contact');
assert.ok(!p({ type: 7, content: '{"nom":"Ada","pseudo":"ada"}' }).includes('{'));
// 8 — bienvenue
assert.strictEqual(p({ type: 8, content: '{cassé' }), 'Message de bienvenue');
assert.strictEqual(p({ type: 8, content: '{"buttons":[{"label":"A"},{"label":"B"}]}' }), 'A · B');
// 9 — trajet
assert.strictEqual(p({ type: 9, content: '{"state":"sos"}' }), '🆘 SOS');
assert.strictEqual(p({ type: 9, content: '{"state":"active"}' }), '🧭 Trajet en cours');
assert.strictEqual(p({ type: 9, content: '{cassé' }), '🧭 Trajet de confiance');
assert.strictEqual(p({ type: 9, content: '{"state":"closed_cancelled","closeReason":"false_alarm"}' }), '✅ Fausse alerte');
// 6 — capture d'écran (discussion à deux) : l'aperçu nomme l'auteur, jamais le JSON
assert.strictEqual(p({ type: 6, content: '{"e":"screenshot","by":7,"byName":"Ada"}' }), '📸 Ada a fait une capture d\'écran');
assert.strictEqual(p({ type: 6, content: '{"e":"screenshot","by":7}' }), '📸 Quelqu\'un a fait une capture d\'écran');
assert.strictEqual(p({ type: 6, content: '{"e":"screen_recording","by":7,"byName":"Ada"}' }), '🎥 Ada a enregistré l\'écran');
// Chiffré : prioritaire sur tout
assert.strictEqual(p({ type: 1, content: 'x', isEncrypted: true }), '🔒 Message chiffré');
// 10 — sticker (T1) : plus jamais le JSON brut, qui fuyait avant la branche dédiée
assert.strictEqual(p({ type: 10, content: '{"v":1}', mediaName: 'Sticker 😂' }), '😀 Sticker');

console.log('messagePreview.caracterisation.test.js : OK');
