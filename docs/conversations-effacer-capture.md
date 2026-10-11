# Effacer la discussion, capture d'écran, suppressions hors ligne

Trois ajouts de la branche `feat/effacer-capture`. Aucun nouveau code d'erreur.

## 1. Effacer la discussion — `POST /api/conversations/:id/clear`

Différent de « Supprimer la discussion » (`DELETE /conversations/:id`), qui fait
**quitter** la conversation. Ici le participant reste membre, la conversation
reste dans sa liste, mais il repart d'une page blanche. **Les autres ne voient
rien.**

- Mécanisme : `conv_participants.historyCutoffAt = NOW()` pour l'appelant seul
  (curseur de la migration 028, déjà appliqué par `getMessages`, `POST
  /messages/sync` et la galerie média). Aucune ligne `message` n'est touchée ;
  **pas de migration**.
- `unreadCount` de l'appelant remis à 0.
- Les messages reçus après (`sendAt >= curseur`) s'affichent normalement.
- `NOW()` est tronqué à la seconde : un message de la même seconde, juste avant,
  peut réapparaître à une resynchronisation ; jamais l'inverse.
- L'aperçu de la liste (`lastMessage*`, commun à tous) est masqué pour l'appelant
  quand le dernier message est antérieur au curseur
  (`masquerDernierMessageEfface`) ; `lastMessageAt` reste (ordre de la liste).
- Réponse : `{ conversationID, historyCutoffAt }`. Événement socket
  `conversation:cleared` (même charge) vers `user_<appelant>` : ses autres
  appareils vident leur copie locale.
- « Fichiers médias uniquement » est purement local (l'app supprime les fichiers
  téléchargés, garde les messages) : rien à faire côté serveur.

## 2. Capture d'écran — `POST /api/conversations/:id/screenshot`

Le téléphone détecte la capture et le dit au serveur, qui écrit un message
système `{"e":"screenshot","by":<id>,"byName":"…"}` (type 6) visible des deux
participants. Pas de push ni de non-lu (comme les autres messages système).

Le serveur ne peut pas vérifier la capture : l'événement informe, il ne prouve
rien et ne contrôle aucun accès. Garde-fous :

- discussion **à deux** seulement (ni groupe, ni conversation avec soi-même) ;
- même politique que l'envoi d'un message (`evaluateDirectMessageSend`) : bloqué,
  ayant bloqué, compte officiel → rien d'écrit ;
- au plus **une ligne par minute et par auteur** (lecture en base, valable avec
  plusieurs processus).

Réponse 200 : `{ posted: true, msgID }` ou `{ posted: false, reason }` avec
`not_direct`, `not_allowed`, `throttled`, `failed`.

Une app qui ne connaît pas l'événement n'affiche rien (`tryParse` → null) ; son
aperçu de liste, calculé côté serveur, dit « 📸 X a fait une capture d'écran ».

## 3. Suppressions pour tous manquées hors ligne — `POST /api/messages/deletions`

`POST /messages/sync` repart du dernier `msgID` et ne renvoie jamais les messages
supprimés : un téléphone éteint pendant une suppression pour tous gardait le
message à vie. Désormais :

- **Migration 099** (`message_deletion`) à appliquer **avant le push**. Sans elle,
  les suppressions fonctionnent comme avant (écriture tolérante) et la route
  répond une liste vide.
- Chaque suppression pour tous (unitaire, lot, administrateur) écrit une ligne
  dans la même transaction ; `msgID` UNIQUE, rien pour un refus ni pour un
  message déjà supprimé.
- `POST /messages/deletions { after?, limit? }` → `{ deletions:[{msgID,
  conversationID, deletedBy}], cursor, hasMore }`. Sans `after` : rien rejoué, le
  client mémorise `cursor`. Filtré sur les conversations de l'appelant.
- Le curseur ne dépasse jamais les lignes de plus de 30 s : deux transactions
  peuvent valider dans l'ordre inverse de leurs `id`.
- Hors périmètre : les retraits par l'administration (`admin/media.js`) et la
  purge des anciennes lignes (la table reste petite : un identifiant par message
  supprimé).
