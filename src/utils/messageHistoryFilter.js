/**
 * Filtre d'historique de groupe par participant.
 *
 * `conv_participants.historyCutoffAt` est NULL pour un historique complet
 * (défaut, et tous les membres antérieurs à la migration 028). Quand un
 * admin a activé `hideHistoryForNewMembers` au moment de l'ajout, le cutoff
 * est posé à NOW() et seuls les messages `sendAt >= cutoff` sont exposés.
 *
 * `>=` et non `>` : le message système `member_added` écrit à l'ajout doit
 * rester visible pour le nouvel arrivant.
 */

/** Fragment SQL à AND-er. Prérequis : alias `m` (message) et `cp` (participants). */
const HISTORY_CUTOFF_SQL =
  '(cp.historyCutoffAt IS NULL OR m.sendAt >= cp.historyCutoffAt)';

/**
 * « Effacer la discussion » pose ce même curseur (`historyCutoffAt = NOW()`) sur
 * le seul participant qui efface : ses requêtes ne voient plus rien d'antérieur,
 * celles des autres ne changent pas. Pas de nouvelle colonne, pas de migration.
 *
 * L'aperçu de la liste vient de `conversation.lastMessage*`, commun à tous les
 * membres : pour celui qui a effacé, un dernier message antérieur au curseur est
 * masqué (`lastMessageAt` reste, il ordonne la liste comme chez WhatsApp).
 * Retourne l'objet reçu, modifié sur place.
 */
function masquerDernierMessageEfface(conv) {
  const coupure = conv && conv.myHistoryCutoffAt;
  if (!coupure || !conv.lastMessageAt) return conv;
  const coupureMs = new Date(coupure).getTime();
  const dernierMs = new Date(conv.lastMessageAt).getTime();
  if (!Number.isFinite(coupureMs) || !Number.isFinite(dernierMs)) return conv;
  if (dernierMs < coupureMs) {
    conv.lastMessage = null;
    conv.lastMessageSenderID = null;
    conv.lastMessageType = 0;
    conv.lastMessageStatus = 0;
  }
  return conv;
}

module.exports = { HISTORY_CUTOFF_SQL, masquerDernierMessageEfface };
