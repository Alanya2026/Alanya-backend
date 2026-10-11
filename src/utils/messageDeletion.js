/**
 * Suppression d'un message POUR TOUS : qui peut le faire, et jusqu'à quand.
 *
 * Deux règles, une seule fonction de décision (`decider`) pour que le chemin
 * unitaire (`DELETE /messages/:id?all=true`) et le chemin par lot
 * (`POST /messages/batch-delete`) ne puissent pas diverger — la moitié des
 * correctifs de messages sont des oublis d'un des deux chemins.
 *
 *   1. FENÊTRE : 72 heures après l'envoi, la suppression pour tous est refusée,
 *      pour l'expéditeur comme pour un administrateur.
 *   2. AUTORITÉ :
 *        - l'expéditeur supprime ses propres messages ;
 *        - dans un GROUPE, un administrateur supprime le message d'un membre, et
 *          le propriétaire celui d'un membre ou d'un administrateur. Un admin ne
 *          touche ni au message d'un autre admin ni à celui du propriétaire ;
 *        - jamais dans une conversation à deux, et jamais sur un message système
 *          (type 6), une carte de trajet (9) ou un message de bienvenue (8) : ce
 *          sont des traces que personne ne « modère ».
 *
 * `message.sendAt` est posé par le SERVEUR (`new Date()` sur les chemins socket
 * et HTTP) ; l'horloge du téléphone n'entre que dans `clickSentAt`. Un client ne
 * peut donc pas repousser la fenêtre en trichant sur l'heure d'envoi.
 *
 * Module pur : aucune base ici (la lecture des rôles est `chargerContextes`,
 * qui reçoit sa connexion). Testable sans MySQL.
 */

const FENETRE_HEURES = 72;
const FENETRE_MS = FENETRE_HEURES * 3600 * 1000;

/** `conv_participants.role` (migration 024). */
const ROLE = Object.freeze({ MEMBRE: 0, ADMIN: 1, PROPRIETAIRE: 2 });

/** Messages que même un administrateur ne retire pas : système, bienvenue, trajet. */
const TYPES_NON_MODERABLES = Object.freeze([6, 8, 9]);

class SuppressionRefusee extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'SuppressionRefusee';
    this.status = status;
    this.code = code;
  }
}

/** Âge en ms ; `null` si la date est illisible. */
function ageMs(sendAt, maintenant = Date.now()) {
  const t = sendAt instanceof Date ? sendAt.getTime() : new Date(sendAt).getTime();
  return Number.isFinite(t) ? maintenant - t : null;
}

/**
 * La fenêtre est-elle encore ouverte ? Une date illisible FERME la fenêtre (on ne
 * supprime pas pour tous sur une donnée qu'on ne comprend pas). Un âge négatif
 * (horloge du serveur qui recule) reste ouvert : le message est tout récent.
 */
function fenetreOuverte(sendAt, maintenant = Date.now()) {
  const age = ageMs(sendAt, maintenant);
  return age !== null && age <= FENETRE_MS;
}

const refus = (status, code, message) => ({ ok: false, status, code, message });

/**
 * @param {object} p
 * @param {number} p.acteurID
 * @param {{senderID:number, sendAt:Date|string, type:number, isDeleted:number|boolean}} p.message
 * @param {{isGroup:boolean, roleActeur:number|null, roleAuteur:number|null}} p.contexte
 *        `roleActeur` null : l'acteur n'est pas (ou plus) participant.
 *        `roleAuteur` null : l'auteur n'est plus participant (compte comme membre).
 * @param {number} [p.maintenant]
 * @returns {{ok:true, parAdmin:boolean, dejaSupprime:boolean}
 *          |{ok:false, status:number, code:string, message:string}}
 */
function decider({ acteurID, message, contexte, maintenant = Date.now() }) {
  // Pas participant : 404, jamais 403 (un 403 confirmerait l'existence du message).
  if (!contexte || contexte.roleActeur === null || contexte.roleActeur === undefined) {
    return refus(404, 'MESSAGE_NOT_FOUND', 'Message introuvable ou non autorisé');
  }
  const estAuteur = Number(message.senderID) === Number(acteurID);

  if (!estAuteur) {
    const roleAuteur = contexte.roleAuteur ?? ROLE.MEMBRE;
    const modere = contexte.isGroup
      && contexte.roleActeur >= ROLE.ADMIN
      && contexte.roleActeur > roleAuteur
      && !TYPES_NON_MODERABLES.includes(Number(message.type));
    if (!modere) {
      return refus(403, 'FORBIDDEN', 'Non autorisé pour ce message');
    }
  }

  // Idempotent : un message déjà supprimé pour tous ne change plus rien, et le
  // refuser parce que 72 h sont passées n'aurait aucun sens.
  const dejaSupprime = Boolean(Number(message.isDeleted));
  if (!dejaSupprime && !fenetreOuverte(message.sendAt, maintenant)) {
    return refus(
      403,
      'DELETE_WINDOW_EXPIRED',
      `La suppression pour tous n'est possible que dans les ${FENETRE_HEURES} heures suivant l'envoi`,
    );
  }
  return { ok: true, parAdmin: !estAuteur, dejaSupprime };
}

/**
 * Lit, en UNE requête, ce qu'il faut pour décider : le caractère « groupe » de
 * chaque conversation concernée, le rôle de l'acteur et celui de chaque auteur.
 *
 * @param {{execute: Function}} db  connexion ou pool
 * @param {number} acteurID
 * @param {Array<{conversationID:number, senderID:number}>} lignes
 * @returns {Promise<Map<number, {isGroup:boolean, roleActeur:number|null, roles:Map<number,number>}>>}
 */
async function chargerContextes(db, acteurID, lignes) {
  const conversations = [...new Set(lignes.map((l) => Number(l.conversationID)))];
  const personnes = [...new Set([Number(acteurID), ...lignes.map((l) => Number(l.senderID))])];
  const contextes = new Map(conversations.map((id) => [id, { isGroup: false, roleActeur: null, roles: new Map() }]));
  if (conversations.length === 0) return contextes;

  const [rows] = await db.execute(
    `SELECT c.conversID, c.isGroup, cp.alanyaID, cp.role
       FROM conversation c
       JOIN conv_participants cp ON cp.conversID = c.conversID
      WHERE c.conversID IN (${conversations.map(() => '?').join(',')})
        AND cp.alanyaID IN (${personnes.map(() => '?').join(',')})`,
    [...conversations, ...personnes],
  );
  for (const r of rows) {
    const ctx = contextes.get(Number(r.conversID));
    if (!ctx) continue;
    ctx.isGroup = Boolean(Number(r.isGroup));
    const role = Number(r.role) || ROLE.MEMBRE;
    ctx.roles.set(Number(r.alanyaID), role);
    if (Number(r.alanyaID) === Number(acteurID)) ctx.roleActeur = role;
  }
  return contextes;
}

/** Contexte de décision d'une ligne `message`, tiré de `chargerContextes`. */
function contexteDe(contextes, ligne) {
  const ctx = contextes.get(Number(ligne.conversationID));
  if (!ctx) return { isGroup: false, roleActeur: null, roleAuteur: null };
  return {
    isGroup: ctx.isGroup,
    roleActeur: ctx.roleActeur,
    roleAuteur: ctx.roles.has(Number(ligne.senderID)) ? ctx.roles.get(Number(ligne.senderID)) : null,
  };
}

module.exports = {
  FENETRE_HEURES,
  FENETRE_MS,
  ROLE,
  TYPES_NON_MODERABLES,
  SuppressionRefusee,
  ageMs,
  fenetreOuverte,
  decider,
  chargerContextes,
  contexteDe,
};
