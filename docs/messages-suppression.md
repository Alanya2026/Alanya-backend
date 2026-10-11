# Suppression d'un message pour tous

Deux règles, une seule fonction de décision (`src/utils/messageDeletion.js`), appliquée par
`DELETE /api/messages/:id?all=true` **et** `POST /api/messages/batch-delete` (`all: true`).
L'application en reflète la règle (`lib/core/utils/message_deletion_policy.dart`) ; **le serveur
tranche**. Les deux lisent la même table de 780 cas (`src/testUtils/messageDeletionCases.json`).

## Règles
1. **72 heures** après l'envoi (`message.sendAt`, posé par le serveur), plus de suppression pour
   tous, pour l'expéditeur comme pour un administrateur. À 72 h pile : encore permis.
2. **Qui** :
   - l'expéditeur, pour ses messages ;
   - dans un **groupe**, un administrateur (`conv_participants.role = 1`) supprime le message d'un
     **membre** ; le propriétaire (`role = 2`) celui d'un membre ou d'un administrateur. Un
     administrateur ne touche ni au message d'un autre administrateur ni à celui du propriétaire ;
   - jamais dans une conversation à deux ;
   - un administrateur ne retire pas un message système (6), de bienvenue (8) ou une carte de
     trajet (9). Leur auteur le peut toujours (comportement antérieur conservé).
3. Il faut être **participant** de la conversation : sinon `404 MESSAGE_NOT_FOUND` (jamais un 403
   qui confirmerait l'existence du message). Un ex-membre ne supprime donc plus ses anciens
   messages pour tous.
4. **Idempotent** : un message déjà supprimé répond `200`, même après 72 h ; le compteur
   `conversation.message_count` ne baisse que des messages réellement supprimés par l'appel
   (le chemin par lot décrémentait avant une fois par ligne trouvée, même déjà supprimée).

## Réponses
| Cas | Statut | Code |
|---|---|---|
| Plus de 72 h | 403 | `DELETE_WINDOW_EXPIRED` |
| Pas le droit (membre, admin contre admin/propriétaire, conversation à deux, type protégé) | 403 | `FORBIDDEN` |
| Message inconnu ou conversation dont on ne fait pas partie | 404 | `MESSAGE_NOT_FOUND` |

Le lot est **tout ou rien** (une transaction) : un seul refus annule tout, y compris le compteur.

## Événements socket
`message:deleted` : `{ msgID, conversationID, all, deletedForID, deletedBy, byAdmin }`
`messages:deleted` : `{ conversationID, msgIDs, all, deletedForID, deletedBy, byAdminMsgIDs }`
(`deletedBy` / `byAdmin` / `byAdminMsgIDs` sont additifs : une application ancienne les ignore).

## Inchangé
« Supprimer pour moi » (`all` absent ou faux) : expéditeur seulement, sans fenêtre.

## Limites connues (non traitées ici)
- **Appareils hors ligne** : la synchronisation par curseur (`POST /messages/sync`) ne renvoie que
  les messages `isDeleted = 0` plus récents que le curseur. Un appareil hors ligne au moment d'une
  suppression ne l'apprend jamais (`message:deleted` est un événement en direct). Il faudrait une
  colonne `deletedAt` et une liste de suppressions dans la synchronisation (migration sur
  `message`, table partitionnée).
- « Supprimer pour moi » d'un message **reçu** n'est jamais enregistré côté serveur (la requête
  exige d'être l'expéditeur) : il réapparaît après réinstallation. `deletedForID` est de plus une
  seule colonne : elle ne saurait pas porter deux personnes.
- Qui a supprimé n'est connu que de l'événement en direct, pas conservé en base : pas de trace
  d'audit d'une modération par un administrateur sans la colonne ci-dessus.
- Le texte cité dans une **réponse** (`replyToContent`) et le fichier d'un média restent après
  suppression du message d'origine.
- `conversation.lastMessage` côté serveur n'est pas recalculé ; l'application le réaligne
  localement.

## Déploiement
Aucune migration. Serveur d'abord, application ensuite : une application ancienne continue
d'afficher « Supprimer pour tous » sur de vieux messages ; son erreur est avalée, le message
disparaît chez elle seulement, alors qu'il reste chez les autres.
