const assert = require('assert');
const { personnaliserNomContact } = require('./notificationContactName');

const run = async () => {
  // Maman = nom choisi par l'utilisateur 1 pour l'utilisateur 2.
  const noms = { '1>2': 'Maman' };
  const lire = async (dest, ami) => noms[`${dest}>${ami}`] || null;
  const p = (dest, data) => personnaliserNomContact(dest, data, lire);

  // Message 1-à-1 : titre et nom, jamais le texte écrit par l'expéditeur.
  assert.deepStrictEqual(
    await p(1, { msgID: '9', senderId: 2, senderName: 'Marie', title: 'Marie', body: 'Marie arrive' }),
    { msgID: '9', senderId: 2, senderName: 'Maman', title: 'Maman', body: 'Marie arrive' },
  );
  // Message de groupe : le titre est le groupe, seul le préfixe change.
  assert.deepStrictEqual(
    await p(1, { msgID: '9', senderId: 2, senderName: 'Marie', title: '3GI', body: 'Marie: Marie arrive' }),
    { msgID: '9', senderId: 2, senderName: 'Maman', title: '3GI', body: 'Maman: Marie arrive' },
  );
  // Appel : phrase du serveur.
  assert.deepStrictEqual(
    await p(1, { type: 'call', callerId: '2', callerName: 'Marie', title: 'Marie', body: 'Marie vous appelle' }),
    { type: 'call', callerId: '2', callerName: 'Maman', title: 'Maman', body: 'Maman vous appelle' },
  );
  // Indication interne : appliquée puis retirée de la charge utile.
  assert.deepStrictEqual(
    await p(1, { type: 'status_view', title: 'Nouveau spectateur', body: 'Marie a vu votre statut', aboutUserId: 2, aboutName: 'Marie' }),
    { type: 'status_view', title: 'Nouveau spectateur', body: 'Maman a vu votre statut' },
  );
  // Code QR : identité portée par byAlanyaID / byNom.
  const qr = await p(1, { type: 'qr_contact_scanned', title: 'Nouveau contact', body: 'Marie vous a ajouté', byAlanyaID: '2', byNom: 'Marie' });
  assert.strictEqual(qr.byNom, 'Maman');
  assert.strictEqual(qr.body, 'Maman vous a ajouté');

  // Le nom choisi par 1 ne part que vers 1 ; pas de nom → inchangé.
  const pour3 = { msgID: '9', senderId: 2, senderName: 'Marie', title: 'Marie', body: 'Salut' };
  assert.deepStrictEqual(await p(3, pour3), pour3);
  // Rien à personnaliser : même objet, aucune lecture.
  const neutre = { type: 'trip', title: 'Trajet', body: 'Arrivé' };
  assert.strictEqual(await personnaliserNomContact(1, neutre, async () => { throw new Error('inutile'); }), neutre);
  // Lecture en panne (migration absente) : la notification part telle quelle.
  const telQuel = { senderId: 2, senderName: 'Marie', title: 'Marie', body: 'Salut', aboutUserId: 2, aboutName: 'Marie' };
  const silence = console.warn; console.warn = () => {};
  const panne = await personnaliserNomContact(1, telQuel, async () => { throw new Error("Unknown column 'custom_name'"); });
  console.warn = silence;
  assert.deepStrictEqual(panne, { senderId: 2, senderName: 'Marie', title: 'Marie', body: 'Salut' });

  console.log('notificationContactName.test.js: OK');
};

run().catch((e) => { console.error(e); process.exit(1); });
