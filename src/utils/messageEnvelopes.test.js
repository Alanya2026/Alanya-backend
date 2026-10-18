/**
 * `node src/utils/messageEnvelopes.test.js`
 *
 * Pourquoi ces vérifications, et pas d'autres : un message chiffré dont les
 * enveloppes sont mal formées est PERDU SANS RECOURS. L'émetteur reçoit son
 * accusé et affiche son ✓, le clair n'existe plus que sur son téléphone, et
 * aucun destinataire ne verra jamais rien. Il n'y a pas de rattrapage
 * possible côté serveur — il n'a aucune clé.
 *
 * Tout ce fichier garde donc une seule propriété : un envoi mal formé est
 * refusé AVANT l'INSERT, avec un code qui nomme le défaut.
 */

const assert = require('assert');
const {
  NONCE_OCTETS,
  TYPE_SIGNAL_AMORCAGE,
  TYPE_SIGNAL_CLIQUET,
  TYPE_SIGNAL_CHAINE_GROUPE,
  CLE_SCELLEE_MAX_OCTETS,
  ENVELOPPES_MAX,
  CORPS_MAX_OCTETS,
  EnveloppeInvalide,
  normaliseChiffre,
  chiffrePourClient,
  ecritChiffre,
  chargeChiffrePourAppareil,
  marqueRemises,
  attacheChiffre,
} = require('./messageEnvelopes');

const b64 = (n, r = 7) => Buffer.alloc(n, r).toString('base64');
const MON_APPAREIL = 10;

const envoiValide = () => ({
  body: { ct: b64(64), nonce: b64(NONCE_OCTETS) },
  envelopes: [
    { appareilId: 20, header: '{"n":0}', envType: TYPE_SIGNAL_CLIQUET, wrappedKey: b64(48) },
    { appareilId: 11, header: '{"n":0}', envType: TYPE_SIGNAL_AMORCAGE, wrappedKey: b64(48) },
  ],
});

function refuse(entree, code, propos, emetteur = MON_APPAREIL) {
  try {
    normaliseChiffre(entree, emetteur);
  } catch (e) {
    assert.ok(e instanceof EnveloppeInvalide, `${propos} : EnveloppeInvalide attendue, reçu ${e}`);
    assert.strictEqual(e.code, code, `${propos} : code ${code} attendu, reçu ${e.code}`);
    return;
  }
  assert.fail(`${propos} : aurait dû être refusé`);
}

// ── Message en clair : rien de chiffré, et ce n'est pas une erreur ────────

assert.strictEqual(
  normaliseChiffre({ content: 'salut' }, MON_APPAREIL), null,
  'un message en clair ne porte ni corps ni enveloppes : null, pas une erreur',
);
assert.strictEqual(normaliseChiffre({}, MON_APPAREIL), null);

// ── Le cas nominal ───────────────────────────────────────────────────────

const c = normaliseChiffre(envoiValide(), MON_APPAREIL);
assert.strictEqual(c.body.length, 64);
assert.strictEqual(c.nonce.length, NONCE_OCTETS);
assert.strictEqual(c.enveloppes.length, 2);
assert.ok(Buffer.isBuffer(c.enveloppes[0].wrappedKey));

// ── Le corps ─────────────────────────────────────────────────────────────

refuse(
  { envelopes: envoiValide().envelopes },
  'E2EE_CORPS_MANQUANT', 'enveloppes sans corps',
);
refuse(
  { body: { ct: '', nonce: b64(NONCE_OCTETS) }, envelopes: envoiValide().envelopes },
  'E2EE_CORPS_MANQUANT', 'corps vide',
);
refuse(
  {
    body: { ct: b64(CORPS_MAX_OCTETS + 1), nonce: b64(NONCE_OCTETS) },
    envelopes: envoiValide().envelopes,
  },
  'E2EE_CORPS_TROP_GROS', 'corps au-delà du plafond',
);

// Le nonce : 12 octets, pas 11, pas 16. Un nonce de mauvaise taille fait
// échouer le déchiffrement chez TOUS les destinataires, et l'échec arrive
// bien après l'accusé d'envoi.
refuse(
  { body: { ct: b64(64), nonce: b64(16) }, envelopes: envoiValide().envelopes },
  'E2EE_NONCE_TAILLE', 'nonce de 16 octets',
);
refuse(
  { body: { ct: b64(64), nonce: '' }, envelopes: envoiValide().envelopes },
  'E2EE_NONCE_TAILLE', 'nonce absent',
);

// ── Les enveloppes ───────────────────────────────────────────────────────

// Un corps chiffré sans destinataire : personne ne pourra jamais l'ouvrir.
// C'est le défaut le plus coûteux de tous, et le plus facile à produire (un
// client qui échoue à récupérer les bundles et envoie quand même).
refuse(
  { body: envoiValide().body, envelopes: [] },
  'E2EE_ENVELOPPES_MANQUANTES', 'corps chiffré sans aucune enveloppe',
);
refuse(
  { body: envoiValide().body, envelopes: 'non' },
  'E2EE_ENVELOPPES_MANQUANTES', 'enveloppes qui ne sont pas une liste',
);
refuse(
  {
    body: envoiValide().body,
    envelopes: Array.from({ length: ENVELOPPES_MAX + 1 }, (_, i) => ({
      appareilId: i + 100, header: '{}', envType: TYPE_SIGNAL_CLIQUET, wrappedKey: b64(48),
    })),
  },
  'E2EE_ENVELOPPES_TROP', 'lot au-delà du plafond',
);

// Deux enveloppes pour le même appareil : la seconde écraserait la première
// sous la clé primaire, et c'est le hasard qui dirait laquelle survit.
refuse(
  {
    body: envoiValide().body,
    envelopes: [
      { appareilId: 20, header: '{"n":0}', envType: TYPE_SIGNAL_CLIQUET, wrappedKey: b64(48) },
      { appareilId: 20, header: '{"n":1}', envType: TYPE_SIGNAL_CLIQUET, wrappedKey: b64(48) },
    ],
  },
  'E2EE_ENVELOPPE_DOUBLON', 'deux enveloppes pour un même appareil',
);

// L'émetteur ne s'adresse pas d'enveloppe : il détient déjà le clair. En
// accepter une lui ferait consommer un pas de cliquet contre lui-même.
refuse(
  {
    body: envoiValide().body,
    envelopes: [{
      appareilId: MON_APPAREIL, header: '{}', envType: TYPE_SIGNAL_CLIQUET, wrappedKey: b64(48),
    }],
  },
  'E2EE_ENVELOPPE_EMETTEUR', 'enveloppe adressée à l\'émetteur lui-même',
);

refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 0, header: '{}', envType: 2, wrappedKey: b64(48) }] },
  'E2EE_ENVELOPPE_INVALIDE', 'appareilId nul',
);
// En-tête facultatif : un message Signal porte déjà le sien dans `wrappedKey`.
assert.strictEqual(
  normaliseChiffre({
    body: envoiValide().body,
    envelopes: [{ appareilId: 20, envType: TYPE_SIGNAL_AMORCAGE, wrappedKey: b64(184) }],
  }, MON_APPAREIL).enveloppes[0].header,
  '',
  'sans en-tête : chaîne vide, la colonne est NOT NULL',
);
refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 20, header: { n: 0 }, envType: 2, wrappedKey: b64(48) }] },
  'E2EE_ENVELOPPE_INVALIDE', 'en-tête qui n\'est pas une chaîne',
);

// Taille de la clé scellée : 184 octets mesurés pour un amorçage, 512 au plus.
assert.strictEqual(
  normaliseChiffre({
    body: envoiValide().body,
    envelopes: [{ appareilId: 20, envType: TYPE_SIGNAL_AMORCAGE, wrappedKey: b64(CLE_SCELLEE_MAX_OCTETS) }],
  }, MON_APPAREIL).enveloppes[0].wrappedKey.length,
  CLE_SCELLEE_MAX_OCTETS,
  'le plafond lui-même passe',
);
refuse(
  {
    body: envoiValide().body,
    envelopes: [{ appareilId: 20, envType: TYPE_SIGNAL_AMORCAGE, wrappedKey: b64(CLE_SCELLEE_MAX_OCTETS + 1) }],
  },
  'E2EE_ENVELOPPE_INVALIDE', 'clé scellée au-delà de 512 octets',
);

// Les valeurs, pas seulement les noms : ce sont celles de libsignal_protocol_dart
// (`CiphertextMessage.whisperType` = 2, `prekeyType` = 3, `senderKeyType` = 4).
assert.deepStrictEqual(
  [TYPE_SIGNAL_CLIQUET, TYPE_SIGNAL_AMORCAGE, TYPE_SIGNAL_CHAINE_GROUPE],
  [2, 3, 4],
);
refuse(
  { body: envoiValide().body, envelopes: [null] },
  'E2EE_ENVELOPPE_INVALIDE', 'enveloppe nulle',
);

// ── L'asymétrie des types : la clé scellée ───────────────────────────────
//
// Deux-à-deux (3, 2) : la clé de contenu est scellée par la session, donc
// `wrappedKey` est obligatoire — sans elle, rien ne s'ouvre.
// Chaîne de groupe (4) : la clé se DÉRIVE de la chaîne que le destinataire
// détient déjà, donc `wrappedKey` n'a pas lieu d'être — sa présence signale
// une confusion de chemin côté client, pas une variante acceptable.

refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 20, header: '{}', envType: TYPE_SIGNAL_CLIQUET }] },
  'E2EE_ENVELOPPE_TYPE', 'cliquet sans clé scellée',
);
refuse(
  {
    body: envoiValide().body,
    envelopes: [{
      appareilId: 20, header: '{}', envType: TYPE_SIGNAL_CHAINE_GROUPE, wrappedKey: b64(48),
    }],
  },
  'E2EE_ENVELOPPE_TYPE', 'chaîne de groupe AVEC clé scellée',
);
refuse(
  { body: envoiValide().body, envelopes: [{ appareilId: 20, header: '{}', envType: 9, wrappedKey: b64(48) }] },
  'E2EE_ENVELOPPE_TYPE', 'type d\'enveloppe inconnu',
);

// Une chaîne de groupe sans clé scellée : c'est la forme correcte.
const groupe = normaliseChiffre({
  body: envoiValide().body,
  envelopes: [{ appareilId: 20, header: '{"c":4}', envType: TYPE_SIGNAL_CHAINE_GROUPE }],
}, MON_APPAREIL);
assert.strictEqual(groupe.enveloppes[0].wrappedKey, null);
assert.strictEqual(groupe.enveloppes[0].envType, TYPE_SIGNAL_CHAINE_GROUPE);

// ── Ce qui part vers le client ───────────────────────────────────────────

const corpsLigne = { msgID: 5, body: Buffer.alloc(32, 3), nonce: Buffer.alloc(12, 4) };
const envLigne = {
  msgID: 5, appareil_id: 20, header: '{"n":2}', env_type: 2,
  wrapped_key: Buffer.alloc(48, 6),
};
const sortie = chiffrePourClient(corpsLigne, envLigne);
assert.strictEqual(sortie.body.ct, b64(32, 3));
assert.strictEqual(sortie.envelope.header, '{"n":2}');
assert.strictEqual(sortie.envelope.wrappedKey, b64(48, 6));

// Pas d'enveloppe pour cet appareil : rien n'est rendu. Le client affichera
// « illisible sur cet appareil » plutôt qu'une bulle vide — c'est le cas
// normal d'un appareil enrôlé après coup, ou d'une enveloppe purgée.
assert.strictEqual(
  chiffrePourClient(corpsLigne, undefined), null,
  'sans enveloppe pour cet appareil, aucun paquet n\'est rendu',
);
assert.strictEqual(chiffrePourClient(null, envLigne), null);

// Une chaîne de groupe rend `wrappedKey: null`, jamais un champ absent.
assert.strictEqual(
  chiffrePourClient(corpsLigne, { ...envLigne, env_type: 3, wrapped_key: null })
    .envelope.wrappedKey,
  null,
);

// ── Écritures : rejeu et borne du lot ────────────────────────────────────

(async () => {
  const vues = [];
  const conn = {
    async execute(sql, params) { vues.push({ sql, params }); return [{ affectedRows: 1 }, []]; },
    async query(sql, params) { vues.push({ sql, params }); return [{ affectedRows: 1 }, []]; },
  };

  await ecritChiffre(conn, 42, normaliseChiffre(envoiValide(), MON_APPAREIL));

  assert.match(vues[0].sql, /INSERT INTO message_e2ee/);
  assert.match(
    vues[0].sql, /ON DUPLICATE KEY UPDATE/,
    'le corps doit se réécrire sans échouer : `message:send` est idempotent '
    + 'par clientID, un rejeu retombe sur le même msgID',
  );
  assert.match(vues[1].sql, /INSERT INTO message_envelope/);
  assert.match(
    vues[1].sql, /delivered_at = COALESCE\(delivered_at, delivered_at\)/,
    'un rejeu ne doit JAMAIS effacer delivered_at : sinon la purge garde '
    + 'l\'enveloppe trente jours de plus à chaque rejeu',
  );
  // Une seule requête pour toutes les enveloppes, pas une par ligne.
  assert.strictEqual(vues.length, 2, 'deux requêtes au total, quel que soit le nombre d\'enveloppes');
  assert.strictEqual(vues[1].params.length, 10, '5 paramètres par enveloppe, 2 enveloppes');

  // ── Lecture : rien à faire sans identifiants ni appareil ───────────────

  const vide = {
    async query() { assert.fail('aucune requête ne doit partir'); },
  };
  assert.strictEqual((await chargeChiffrePourAppareil(vide, [], 20)).size, 0);
  assert.strictEqual((await chargeChiffrePourAppareil(vide, [1, 2], null)).size, 0);
  assert.strictEqual((await chargeChiffrePourAppareil(vide, [0, -1, 'x'], 20)).size, 0);

  // Lecture nominale : deux requêtes pour tout le lot, et seule l'enveloppe
  // de CET appareil est jointe — un appareil n'a pas à savoir combien
  // d'appareils ont ses correspondants.
  let nbQuery = 0;
  const lecture = {
    async query(sql, params) {
      nbQuery += 1;
      if (/message_e2ee/.test(sql)) {
        return [[
          { msgID: 5, body: Buffer.alloc(8, 1), nonce: Buffer.alloc(12, 2) },
          { msgID: 6, body: Buffer.alloc(8, 3), nonce: Buffer.alloc(12, 4) },
        ], []];
      }
      assert.strictEqual(params[1], 20, 'la lecture doit filtrer sur l\'appareil demandé');
      return [[{
        msgID: 5, appareil_id: 20, header: '{}', env_type: 2,
        wrapped_key: Buffer.alloc(48, 5),
      }], []];
    },
  };
  const paquets = await chargeChiffrePourAppareil(lecture, [5, 6], 20);
  assert.strictEqual(nbQuery, 2, 'deux requêtes, quel que soit le nombre de messages');
  assert.strictEqual(paquets.size, 1, 'le message 6 n\'a pas d\'enveloppe pour cet appareil');
  assert.ok(paquets.has(5));
  assert.ok(!paquets.has(6));

  // ── Marquage de remise ────────────────────────────────────────────────

  const remise = [];
  const connRemise = {
    async query(sql, params) { remise.push({ sql, params }); return [{ affectedRows: 2 }, []]; },
  };
  assert.strictEqual(await marqueRemises(connRemise, [5, 6], 20), 2);
  assert.match(
    remise[0].sql, /delivered_at IS NULL/,
    'ne réécrire que ce qui n\'est pas déjà remis : une date de remise ne bouge pas',
  );
  assert.strictEqual(await marqueRemises(connRemise, [], 20), 0);

  // ── Greffe sur une page de lecture ────────────────────────────────────

  // Une page SANS message chiffré ne coûte aucune requête. C'est ce qui
  // permet de livrer ce chemin avant qu'un seul client ne chiffre quoi que
  // ce soit : tant que personne n'envoie de chiffré, il est inerte.
  const aucuneRequete = {
    async query() { assert.fail('aucune requête pour une page sans message chiffré'); },
  };
  const enClair = [{ msgID: 1, enc_version: 0 }, { msgID: 2, enc_version: 0 }];
  assert.strictEqual(await attacheChiffre(aucuneRequete, enClair, 20), enClair);
  assert.ok(!('body' in enClair[0]), 'une ligne en clair ne reçoit pas de corps');

  // Sans appareil sur le jeton (session d'avant la migration 026), on ne
  // greffe rien plutôt que de deviner : il n'y a pas d'enveloppe à servir.
  assert.strictEqual((await attacheChiffre(aucuneRequete, [{ msgID: 1, enc_version: 1 }], null))[0].body, undefined);
  await attacheChiffre(aucuneRequete, [], 20);

  // Page mixte : seules les lignes chiffrées sont lues et greffées.
  const lues = [];
  const connPage = {
    async query(sql, params) {
      lues.push({ sql, params });
      if (/message_e2ee/.test(sql)) {
        return [[{ msgID: 7, body: Buffer.alloc(8, 1), nonce: Buffer.alloc(12, 2) }], []];
      }
      if (/message_envelope/.test(sql) && /SELECT/.test(sql)) {
        return [[{
          msgID: 7, appareil_id: 20, header: '{"n":5}', env_type: 2,
          wrapped_key: Buffer.alloc(48, 3),
        }], []];
      }
      return [{ affectedRows: 1 }, []];
    },
  };
  const page = [
    { msgID: 6, enc_version: 0, content: 'en clair' },
    { msgID: 7, enc_version: 1, content: null },
    { msgID: 8, enc_version: 1, content: null },
  ];
  await attacheChiffre(connPage, page, 20);

  // Seuls les msgID chiffrés sont demandés : la ligne en clair n'a rien à
  // chercher, et l'inclure ferait lire des blobs pour rien.
  assert.deepStrictEqual(
    lues[0].params[0], [7, 8],
    'seuls les msgID à enc_version = 1 sont demandés',
  );
  assert.strictEqual(page[1].body.ct, Buffer.alloc(8, 1).toString('base64'));
  assert.strictEqual(page[1].envelope.header, '{"n":5}');
  assert.ok(!('body' in page[0]), 'la ligne en clair reste intacte');
  // Le message 8 est chiffré mais n'a ni corps ni enveloppe pour cet
  // appareil : rien n'est greffé. Le client affichera « illisible sur cet
  // appareil », ce qui est la vérité — et non une bulle vide.
  assert.ok(!('body' in page[2]));

  // Servir n'est pas remettre : la lecture n'écrit RIEN. `delivered_at` ne
  // se pose qu'à l'accusé explicite de l'appareil (`e2ee:ack`), une fois le
  // message rangé — sinon un téléphone qui s'arrête en plein déchiffrement
  // perdrait le message pour toujours (docs/e2ee, chapitre 11).
  await new Promise((r) => setImmediate(r));
  assert.ok(
    !lues.some((l) => /UPDATE/.test(l.sql)),
    'aucune écriture pendant une lecture d\'historique',
  );

  console.log('messageEnvelopes.test.js OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
