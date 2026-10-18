/**
 * Ce qu'un fil chiffré accepte, et ce qu'il refuse — écrit UNE fois.
 *
 * Tous les chemins qui écrivent un message d'utilisateur appellent ces
 * fonctions : `message:send` (socket), `POST /conversations/:id/messages`
 * (dont la réponse rapide native), la modification et le transfert. Une
 * règle recopiée dans quatre fichiers finit toujours par manquer dans le
 * cinquième (docs/e2ee, chapitres 3, 12 et 26).
 *
 * Les messages que compose le SERVEUR — système, bienvenue, diffusions,
 * trajets, traces d'appel, alerte d'enregistrement d'écran — ne passent pas
 * par ici, et c'est voulu : ils n'ont pas d'expéditeur pour tenir une clé, et
 * restent en clair (`enc_version = 0`).
 *
 * Module pur, plus `filChiffre` qui lit la base.
 */


/** Le texte en clair est refusé dans un fil chiffré. */
const CONVERSATION_CHIFFREE = 'CONVERSATION_CHIFFREE';
/** Un corps chiffré dans un fil qui ne l'est pas. */
const CONVERSATION_NON_CHIFFREE = 'E2EE_CONVERSATION_NON_CHIFFREE';
/** Un message chiffré ne se recopie pas : le serveur n'a pas son contenu. */
const SOURCE_CHIFFREE = 'SOURCE_CHIFFREE';

/**
 * Types dont le `content` est RÉÉCRIT par le serveur à partir de sa propre
 * base : autocollant (10, `stickerMessage`) et partage d'un fichier du coffre
 * (11, `safeboxShareMessage`). Ce qu'ils portent ne vient pas du client — un
 * identifiant de catalogue ou de fichier —, et les refuser dans un fil
 * chiffré supprimerait ces deux fonctions sans rien protéger.
 */
const TYPES_CONTENU_SERVEUR = new Set([10, 11]);

const nonVide = (v) => typeof v === 'string' ? v.trim() !== '' : v != null && v !== '';

/**
 * Un envoi peut-il entrer dans ce fil ?
 *
 * - fil chiffré, envoi en clair portant un texte (message, légende, fiche de
 *   contact ou de position) ou une citation en clair : refusé ;
 * - fil chiffré, média SANS texte : accepté — le fichier n'est pas encore
 *   chiffré (étape 4 du plan), et refuser couperait l'envoi de photos dans
 *   les fils chiffrés. L'application le dit au moment de choisir le fichier ;
 * - fil en clair, corps chiffré : refusé — il afficherait un cadenas sur un
 *   fil que certains appareils ne savent pas lire (docs/e2ee, chapitre 20).
 *
 * @returns {string|null} code de refus, ou null
 */
function refusEnvoi({ filChiffre, chiffre, type = 0, content, replyToContent }) {
  if (chiffre) {
    return filChiffre ? null : CONVERSATION_NON_CHIFFREE;
  }
  if (!filChiffre) return null;
  if (TYPES_CONTENU_SERVEUR.has(Number(type))) return null;
  if (nonVide(content) || nonVide(replyToContent)) return CONVERSATION_CHIFFREE;
  return null;
}

/**
 * Une modification en clair peut-elle s'appliquer ?
 *
 * Dans un fil chiffré, jamais : ni sur un message chiffré (il faudrait
 * rechiffrer pour chaque appareil, étape 5 du plan), ni sur un ancien message
 * écrit en clair avant l'activation (le modifier en clair ferait entrer du
 * texte lisible par le serveur dans un fil annoncé chiffré).
 */
function refusModification({ filChiffre }) {
  return filChiffre ? CONVERSATION_CHIFFREE : null;
}

/**
 * Un transfert par le serveur est-il possible ?
 *
 * Le serveur recopie la ligne : il ne peut pas recopier un message chiffré
 * (il n'en a pas le contenu), ni déposer du texte en clair dans un fil
 * chiffré. Dans ces cas, c'est l'APPAREIL qui transfère, en renvoyant
 * (docs/e2ee, chapitre 29).
 */
function refusTransfert({ sourceChiffree, cibleChiffree, type = 0, content }) {
  if (sourceChiffree) return SOURCE_CHIFFREE;
  if (cibleChiffree && !TYPES_CONTENU_SERVEUR.has(Number(type)) && nonVide(content)) {
    return CONVERSATION_CHIFFREE;
  }
  return null;
}

/**
 * Le fil est-il chiffré ? Lu en base à chaque écriture : c'est une lecture
 * par clé primaire, et c'est la seule source qui fait foi.
 *
 * Migration 104 absente (colonne inconnue) : rien n'est chiffré. Ce repli est
 * ce qui rend le code déployable avant la migration sans rien casser — la
 * même erreur sur `enc_version` aurait bloqué tous les envois.
 *
 * @param {object} [conn] connexion ou pool ; le pool par défaut, résolu à
 *   l'appel et non au chargement du module
 * @returns {Promise<boolean>}
 */
async function filChiffre(conversationID, conn = null) {
  const executeur = conn || require('../config/db');
  try {
    const [rows] = await executeur.execute(
      'SELECT e2ee_since FROM conversation WHERE conversID = ?',
      [conversationID],
    );
    return rows.length > 0 && rows[0].e2ee_since != null;
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR') return false;
    throw e;
  }
}

/** Erreur prête à rendre : `status` et `code`, comme le reste des refus. */
function erreurRefus(code) {
  const messages = {
    [CONVERSATION_CHIFFREE]: 'Cette conversation est chiffrée : le texte en clair est refusé',
    [CONVERSATION_NON_CHIFFREE]: 'Cette conversation n\'est pas chiffrée',
    [SOURCE_CHIFFREE]: 'Un message chiffré ne se transfère que depuis l\'appareil',
  };
  const err = new Error(messages[code] || code);
  err.status = 409;
  err.code = code;
  return err;
}

module.exports = {
  CONVERSATION_CHIFFREE,
  CONVERSATION_NON_CHIFFREE,
  SOURCE_CHIFFREE,
  TYPES_CONTENU_SERVEUR,
  refusEnvoi,
  refusModification,
  refusTransfert,
  filChiffre,
  erreurRefus,
};
