-- Migration 099 : pierres tombales des messages supprimés POUR TOUS.
--
-- FICHIER SEULEMENT : à appliquer à la main par le propriétaire, AVANT le push du
-- backend qui lit cette table. Aucune migration n'est jouée par le code.
-- Réexécutable (`CREATE TABLE IF NOT EXISTS`).
--
-- ── À quoi elle sert ──
--
-- `POST /messages/sync` repart du dernier `msgID` connu et ne renvoie que les
-- messages NON supprimés : un téléphone éteint ou hors ligne au moment d'une
-- suppression pour tous n'a aucun moyen de l'apprendre — il garde le message à
-- vie. Chaque suppression pour tous laisse maintenant une ligne ici, et
-- `POST /messages/deletions` la rejoue au téléphone qui revient.
--
-- Pas de table `message` touchée (elle est partitionnée : pas d'ALTER). `id` est
-- le curseur du client (monotone, sans ambiguïté d'horodatage). `msgID` est
-- UNIQUE : redemander une suppression ne duplique rien. Aucune clé étrangère : la
-- ligne doit survivre à la purge du message.
--
-- Ordre de déploiement : avant le push. Sans la table, le serveur continue de
-- supprimer comme avant (l'écriture de la pierre tombale est tolérante) et la
-- route de rattrapage répond une liste vide.

CREATE TABLE IF NOT EXISTS message_deletion (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  msgID          BIGINT          NOT NULL,
  conversationID BIGINT          NOT NULL,
  deletedByID    INT             NULL,
  deletedAt      DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_msgdel_msg (msgID),
  KEY idx_msgdel_conv (conversationID, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
