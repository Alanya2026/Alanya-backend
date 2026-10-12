// Nom personnalisé dans les notifications — point d'entrée UNIQUE côté serveur.
//
// Un utilisateur peut enregistrer un contact préféré sous le nom de son choix
// (preferredContact.custom_name, migration 100). L'app applique ce nom à ce
// qu'elle affiche elle-même ; ce module l'applique au texte que le SERVEUR
// fabrique (titre et corps d'une notification système, nom porté par la
// charge utile). Il est appelé une fois par destinataire, juste avant l'envoi :
// aucun `notify*` ne refait ce choix.
//
// Règle : mon nom personnalisé s'il existe, sinon le nom du profil. Jamais
// l'inverse — le nom choisi par A pour B ne part que vers A.

// Paires « qui » / « sous quel nom » reconnues dans une charge utile.
const PAIRES = [
  ['senderId', 'senderName'],
  ['callerId', 'callerName'],
  ['byAlanyaID', 'byNom'],
  // Indication interne pour les notifications qui n'exposent pas d'identité
  // au client (spectateur d'un statut, répondeur, réunion). Retirée avant
  // l'envoi : voir `sansIndication`.
  ['aboutUserId', 'aboutName'],
];

const sansIndication = (data) => {
  if (!('aboutUserId' in data) && !('aboutName' in data)) return data;
  const { aboutUserId, aboutName, ...reste } = data;
  return reste;
};

/**
 * Remplace le nom du profil par [alias] dans le texte, sans toucher au
 * contenu écrit par les utilisateurs.
 *
 * - titre : seulement s'il EST le nom (titre d'un message 1-à-1, d'un appel) ;
 * - corps : seulement en tête. Pour un message (`msgID` présent), le corps est
 *   le texte de l'expéditeur : on n'y touche que derrière le préfixe de groupe
 *   « Nom: ». Ailleurs le corps est une phrase du serveur (« Nom vous
 *   appelle ») et le nom en tête se remplace.
 */
const reecrireTexte = (data, profil, alias) => {
  const out = { ...data };
  if (typeof out.title === 'string' && out.title === profil) out.title = alias;
  if (typeof out.body === 'string') {
    if (out.body.startsWith(`${profil}: `)) {
      out.body = alias + out.body.slice(profil.length);
    } else if (out.msgID == null && out.body.startsWith(`${profil} `)) {
      out.body = alias + out.body.slice(profil.length);
    }
  }
  return out;
};

/**
 * @param {number|string} recipientId destinataire de la notification
 * @param {object} data charge utile
 * @param {(recipientId: number, friendId: number) => Promise<string|null>} [lire]
 *   lecture du nom personnalisé — injectable pour les tests
 * @returns {Promise<object>} charge utile à envoyer (jamais d'exception)
 */
const personnaliserNomContact = async (recipientId, data = {}, lire = lireNomPersonnalise) => {
  let out = data;
  try {
    const dest = Number(recipientId);
    for (const [cleId, cleNom] of PAIRES) {
      const ami = Number(out[cleId]);
      const profil = typeof out[cleNom] === 'string' ? out[cleNom].trim() : '';
      if (!dest || !ami || ami === dest || !profil) continue;
      const alias = ((await lire(dest, ami)) || '').trim();
      if (!alias || alias === profil) continue;
      out = { ...reecrireTexte(out, profil, alias), [cleNom]: alias };
    }
  } catch (error) {
    // Une notification part avec le nom du profil plutôt que de ne pas partir
    // (colonne absente tant que la migration 100 n'est pas appliquée, base
    // indisponible…).
    console.warn('[NotifContactName] nom personnalisé ignoré:', error.message);
    out = data;
  }
  return sansIndication(out);
};

async function lireNomPersonnalise(recipientId, friendId) {
  const pool = require('../config/db');
  const [rows] = await pool.execute(
    'SELECT custom_name FROM preferredContact WHERE alanyaID = ? AND idFriend = ? LIMIT 1',
    [recipientId, friendId],
  );
  return rows[0]?.custom_name || null;
}

module.exports = { personnaliserNomContact };
