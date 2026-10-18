/**
 * Corps chiffré et enveloppes : validation, écriture, lecture.
 *
 * Le serveur ne regarde jamais dedans. Son travail se résume à trois gestes :
 * ranger un blob, ranger N petites enveloppes, et ne servir à chaque appareil
 * que la sienne. Tout ce qui ressemble à de la cryptographie est côté client.
 *
 * ── Ce qui est vérifié ici, et pourquoi ──
 *
 * Rien de cryptographique : le serveur n'a aucune clé et ne peut rien
 * authentifier. Ce qui est vérifié, c'est la FORME — le corps existe, le
 * nonce fait 12 octets, chaque enveloppe nomme un appareil et porte un type
 * Signal connu, aucune enveloppe n'est adressée deux fois au même appareil.
 *
 * Un corps chiffré sans enveloppe, ou dont les enveloppes n'atteignent pas
 * les bons appareils, est un message perdu pour tout le monde : l'émetteur
 * l'a mis en file et verra son ✓, les destinataires ne verront jamais rien.
 * Aucune reprise n'est possible, puisque le clair n'existe plus que sur le
 * téléphone de l'émetteur. C'est pour ça que l'envoi est refusé AVANT
 * l'INSERT plutôt que réparé après.
 */

const NONCE_OCTETS = 12;

// Types d'enveloppe : ceux de libsignal_protocol_dart (`CiphertextMessage`),
// tels quels. Les noms ne doivent jamais faire oublier les valeurs : la
// bibliothèque JavaScript historique numérote autrement (1 = cliquet), et
// un client qui déchiffre avec la mauvaise méthode obtient une erreur qui
// parle d'autre chose (docs/e2ee, chapitre 1).
//
// 3 et 2 portent la clé de contenu scellée par la session deux-à-deux ; 4
// n'en porte pas (la clé se dérive de la chaîne d'expéditeur du groupe, que
// le destinataire détient déjà).
const TYPE_SIGNAL_CLIQUET = 2; // SignalMessage
const TYPE_SIGNAL_AMORCAGE = 3; // PreKeySignalMessage : le premier d'une session
const TYPE_SIGNAL_CHAINE_GROUPE = 4; // SenderKeyMessage
const ENV_TYPES = new Set([
  TYPE_SIGNAL_CLIQUET, TYPE_SIGNAL_AMORCAGE, TYPE_SIGNAL_CHAINE_GROUPE,
]);

// Taille de la clé scellée. Un message d'amorçage qui transporte 32 octets en
// fait 184 (mesuré) ; la colonne en accepte 512 (migration 104).
const CLE_SCELLEE_MAX_OCTETS = 512;

// Même borne que le lot de bundles : au-delà, le client découpe. Une
// enveloppe pèse quelques centaines d'octets, mais 400 enveloppes dans une
// seule requête socket, c'est 400 lignes à écrire avant l'accusé d'envoi.
const ENVELOPPES_MAX = 400;

// Plafond du corps. Un message texte fait quelques centaines d'octets ; la
// vignette d'un média chiffrée dans la charge utile peut en faire quelques
// dizaines de milliers. 512 Ko laisse dix fois la marge nécessaire et reste
// très en dessous du MEDIUMBLOB (16 Mo) — un client qui dépasse a un défaut,
// pas un gros message.
const CORPS_MAX_OCTETS = 512 * 1024;

/** Erreur de forme : porte le code d'API renvoyé au client. */
class EnveloppeInvalide extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Valide et normalise la partie chiffrée d'un `message:send`.
 *
 * Rend `null` si le client n'envoie rien de chiffré — c'est le cas normal
 * d'un message en clair, pas une erreur.
 *
 * @param {object} data        la charge utile reçue
 * @param {number} emetteurId  appareil de l'émetteur, qui ne peut pas être
 *                             sa propre cible (il détient déjà le clair)
 */
function normaliseChiffre(data = {}, emetteurId = null) {
  const corps = data.body;
  const enveloppes = data.envelopes;

  // Ni corps ni enveloppes : message en clair, rien à faire.
  if (corps == null && enveloppes == null) return null;

  if (corps == null || typeof corps !== 'object') {
    throw new EnveloppeInvalide(
      'E2EE_CORPS_MANQUANT',
      'body requis dès que des enveloppes sont fournies',
    );
  }

  const octets = Buffer.from(String(corps.ct || ''), 'base64');
  if (octets.length === 0) {
    throw new EnveloppeInvalide('E2EE_CORPS_MANQUANT', 'body.ct vide ou illisible');
  }
  if (octets.length > CORPS_MAX_OCTETS) {
    throw new EnveloppeInvalide(
      'E2EE_CORPS_TROP_GROS',
      `body.ct limité à ${CORPS_MAX_OCTETS} octets, ${octets.length} reçus`,
    );
  }

  const nonce = Buffer.from(String(corps.nonce || ''), 'base64');
  if (nonce.length !== NONCE_OCTETS) {
    throw new EnveloppeInvalide(
      'E2EE_NONCE_TAILLE',
      `body.nonce doit faire ${NONCE_OCTETS} octets, ${nonce.length} reçus`,
    );
  }

  if (!Array.isArray(enveloppes) || enveloppes.length === 0) {
    // Un corps chiffré sans destinataire : personne ne pourra jamais l'ouvrir.
    throw new EnveloppeInvalide(
      'E2EE_ENVELOPPES_MANQUANTES',
      'un corps chiffré exige au moins une enveloppe',
    );
  }
  if (enveloppes.length > ENVELOPPES_MAX) {
    throw new EnveloppeInvalide(
      'E2EE_ENVELOPPES_TROP',
      `envelopes limité à ${ENVELOPPES_MAX}, ${enveloppes.length} reçues`,
    );
  }

  const vus = new Set();
  const propres = enveloppes.map((e, i) => {
    if (!e || typeof e !== 'object') {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_INVALIDE', `envelopes[${i}] doit être un objet`,
      );
    }
    const appareilId = Number(e.appareilId);
    if (!Number.isInteger(appareilId) || appareilId < 1) {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_INVALIDE', `envelopes[${i}].appareilId invalide`,
      );
    }
    if (emetteurId != null && appareilId === Number(emetteurId)) {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_EMETTEUR',
        'un appareil ne s\'adresse pas d\'enveloppe à lui-même',
      );
    }
    // Deux enveloppes pour le même appareil : la seconde écraserait la
    // première sous la clé primaire, et c'est un pur coup de chance de savoir
    // laquelle survit. Refuser nomme le défaut au lieu de le trancher au sort.
    if (vus.has(appareilId)) {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_DOUBLON',
        `deux enveloppes pour l'appareil ${appareilId}`,
      );
    }
    vus.add(appareilId);

    // L'en-tête est facultatif : un message Signal porte déjà le sien (clé
    // de cliquet, compteurs) dans `wrappedKey`. S'il est fourni, ce doit être
    // une chaîne — un objet glissé là par erreur finirait en « [object
    // Object] » en base.
    if (e.header != null && typeof e.header !== 'string') {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_INVALIDE', `envelopes[${i}].header doit être une chaîne`,
      );
    }
    const header = e.header || '';

    const envType = Number(e.envType);
    if (!ENV_TYPES.has(envType)) {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_TYPE',
        `envelopes[${i}].envType doit valoir 2, 3 ou 4 (types Signal)`,
      );
    }

    const scellee = e.wrappedKey
      ? Buffer.from(String(e.wrappedKey), 'base64') : null;
    // Un type deux-à-deux sans clé scellée ne s'ouvre pas ; une chaîne de
    // groupe avec clé scellée révèle une confusion de chemin côté client.
    // Les deux sont des défauts, pas des variantes.
    if (scellee && scellee.length > CLE_SCELLEE_MAX_OCTETS) {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_INVALIDE',
        `envelopes[${i}].wrappedKey limité à ${CLE_SCELLEE_MAX_OCTETS} octets, ${scellee.length} reçus`,
      );
    }
    if (envType === TYPE_SIGNAL_CHAINE_GROUPE) {
      if (scellee) {
        throw new EnveloppeInvalide(
          'E2EE_ENVELOPPE_TYPE',
          `envelopes[${i}] : une chaîne de groupe ne porte pas de wrappedKey`,
        );
      }
    } else if (!scellee || scellee.length === 0) {
      throw new EnveloppeInvalide(
        'E2EE_ENVELOPPE_TYPE',
        `envelopes[${i}] : wrappedKey requis pour une enveloppe deux-à-deux`,
      );
    }

    return { appareilId, header, envType, wrappedKey: scellee };
  });

  // L'appareil émetteur vient de la socket ou du jeton, jamais du corps de
  // la requête. Le destinataire en a besoin pour choisir la session qui
  // déchiffre : un compte a plusieurs appareils, chacun sa session.
  return {
    body: octets,
    nonce,
    enveloppes: propres,
    emetteurAppareilId: emetteurId != null ? Number(emetteurId) : null,
  };
}

/**
 * Écrit le corps et les enveloppes d'un message déjà inséré.
 *
 * `ON DUPLICATE KEY UPDATE` sur les deux : `message:send` est idempotent par
 * `clientID`, donc un rejeu retombe sur le même `msgID` et doit pouvoir
 * réécrire sans échouer. Le client rejoue avec le MÊME corps (il le garde en
 * file tant qu'il n'est pas acquitté), l'écriture est donc sans effet.
 *
 * `delivered_at` n'est jamais écrasé par un rejeu : une enveloppe déjà remise
 * le reste. Sans ce `COALESCE`, un rejeu la ferait repasser pour non remise
 * et la purge la garderait trente jours de plus.
 */
async function ecritChiffre(conn, msgID, chiffre) {
  await conn.execute(
    `INSERT INTO message_e2ee (msgID, body, nonce, sender_appareil_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE body = VALUES(body), nonce = VALUES(nonce)`,
    [msgID, chiffre.body, chiffre.nonce, chiffre.emetteurAppareilId ?? null],
  );

  const place = [];
  const params = [];
  for (const e of chiffre.enveloppes) {
    place.push('(?, ?, ?, ?, ?)');
    params.push(msgID, e.appareilId, e.header, e.wrappedKey, e.envType);
  }
  await conn.query(
    `INSERT INTO message_envelope
       (msgID, appareil_id, header, wrapped_key, env_type)
     VALUES ${place.join(', ')}
     ON DUPLICATE KEY UPDATE
       header       = VALUES(header),
       wrapped_key  = VALUES(wrapped_key),
       env_type     = VALUES(env_type),
       delivered_at = COALESCE(delivered_at, delivered_at)`,
    params,
  );
}

/**
 * Rend le corps et l'enveloppe d'un message pour UN appareil, prêts à être
 * joints au JSON du message.
 *
 * Forme choisie pour que le client reçoive exactement ce qu'il avait envoyé
 * (`body` + une seule `envelope`), et surtout pour qu'un appareil ne voie
 * jamais les enveloppes des autres. Elles ne lui apprendraient rien
 * d'exploitable, mais elles diraient combien d'appareils ont ses
 * correspondants — une métadonnée qu'il n'a pas à connaître.
 */
function chiffrePourClient(corpsLigne, enveloppeLigne) {
  if (!corpsLigne || !enveloppeLigne) return null;
  return {
    body: {
      ct: corpsLigne.body.toString('base64'),
      nonce: corpsLigne.nonce.toString('base64'),
      senderAppareilId: corpsLigne.sender_appareil_id != null
        ? Number(corpsLigne.sender_appareil_id) : null,
    },
    envelope: {
      appareilId: Number(enveloppeLigne.appareil_id),
      header: enveloppeLigne.header,
      envType: Number(enveloppeLigne.env_type),
      wrappedKey: enveloppeLigne.wrapped_key
        ? enveloppeLigne.wrapped_key.toString('base64')
        : null,
    },
  };
}

/**
 * Charge corps et enveloppes d'un lot de messages, pour un appareil.
 *
 * Deux requêtes pour tout le lot, quelle que soit sa taille : les chemins
 * d'historique et de delta ramènent 50 messages à la fois, et une lecture par
 * message rendrait 100 allers-retours là où deux suffisent.
 *
 * @returns {Promise<Map<number, object>>} msgID → `chiffrePourClient`
 */
async function chargeChiffrePourAppareil(conn, msgIDs, appareilId) {
  const ids = [...new Set(msgIDs.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0 || !appareilId) return new Map();

  const [corps] = await conn.query(
    'SELECT msgID, body, nonce, sender_appareil_id FROM message_e2ee WHERE msgID IN (?)',
    [ids],
  );
  if (corps.length === 0) return new Map();

  const [enveloppes] = await conn.query(
    `SELECT msgID, appareil_id, header, env_type, wrapped_key
       FROM message_envelope
      WHERE msgID IN (?) AND appareil_id = ?`,
    [ids, appareilId],
  );

  const parMsg = new Map(enveloppes.map((e) => [Number(e.msgID), e]));
  const sortie = new Map();
  for (const c of corps) {
    const msgID = Number(c.msgID);
    const paquet = chiffrePourClient(c, parMsg.get(msgID));
    // Pas d'enveloppe pour cet appareil : il n'était pas destinataire, ou
    // l'enveloppe a été purgée. Rien n'est rendu — le client affichera
    // « message illisible sur cet appareil » plutôt qu'une bulle vide.
    if (paquet) sortie.set(msgID, paquet);
  }
  return sortie;
}

/**
 * Marque comme remises les enveloppes qu'un appareil vient de recevoir.
 *
 * Hors du chemin critique : c'est la purge qui s'en sert, pas l'affichage.
 * Un échec se journalise et s'oublie — l'enveloppe sera purgée par son âge.
 */
async function marqueRemises(conn, msgIDs, appareilId) {
  const ids = [...new Set(msgIDs.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0 || !appareilId) return 0;
  const [r] = await conn.query(
    `UPDATE message_envelope SET delivered_at = NOW()
      WHERE msgID IN (?) AND appareil_id = ? AND delivered_at IS NULL`,
    [ids, appareilId],
  );
  return r.affectedRows;
}

/**
 * Greffe `body` et `envelope` sur les lignes chiffrées d'une page de lecture.
 *
 * Appelée par les deux chemins de lecture — l'historique d'une conversation
 * et le delta de synchronisation — qui rendent tous deux des lignes `m.*`.
 * Sans elle, un message chiffré arriverait avec `enc_version = 1`, un
 * `content` NULL et rien pour l'ouvrir : une bulle vide, indiscernable d'un
 * message réellement vide.
 *
 * C'est aussi le filet du temps réel. Une émission socket peut se perdre — le
 * téléphone était éteint, la socket venait de tomber, l'enveloppe est partie
 * pendant une bascule d'instance. Ce chemin-ci rattrape, et c'est pour cela
 * que le rejeu d'envoi n'a pas à rediffuser aux autres appareils.
 *
 * Ne touche QUE les lignes chiffrées : une page sans message chiffré ne coûte
 * aucune requête. C'est ce qui permet de livrer ce chemin avant qu'un seul
 * client ne chiffre quoi que ce soit.
 *
 * Servir n'est PAS remettre : la lecture ne pose pas `delivered_at`.
 * L'appareil peut perdre la réponse, ou s'arrêter en plein déchiffrement ;
 * l'enveloppe doit rester servie jusqu'à son accusé explicite (`e2ee:ack`,
 * `socket/handlers/chat/e2eeAck.js`), envoyé une fois le message RANGÉ
 * (docs/e2ee, chapitres 1 et 11).
 */
async function attacheChiffre(conn, lignes, appareilId) {
  if (!Array.isArray(lignes) || lignes.length === 0 || !appareilId) return lignes;

  const ids = lignes
    .filter((l) => Number(l.enc_version) === 1)
    .map((l) => Number(l.msgID));
  if (ids.length === 0) return lignes;

  const paquets = await chargeChiffrePourAppareil(conn, ids, appareilId);
  if (paquets.size === 0) return lignes;

  for (const ligne of lignes) {
    const paquet = paquets.get(Number(ligne.msgID));
    if (!paquet) continue;
    ligne.body = paquet.body;
    ligne.envelope = paquet.envelope;
  }

  return lignes;
}

module.exports = {
  NONCE_OCTETS,
  TYPE_SIGNAL_CLIQUET,
  TYPE_SIGNAL_AMORCAGE,
  TYPE_SIGNAL_CHAINE_GROUPE,
  CLE_SCELLEE_MAX_OCTETS,
  ENVELOPPES_MAX,
  CORPS_MAX_OCTETS,
  EnveloppeInvalide,
  normaliseChiffre,
  ecritChiffre,
  chiffrePourClient,
  chargeChiffrePourAppareil,
  marqueRemises,
  attacheChiffre,
};
