-- Coffre-fort — finitions du lot 3 (conception : docs/conception/coffre-fort.html,
-- section 07).
--
-- 1. `safebox_blob.meta` : ce que la carte d'un fichier partagé affiche en plus
--    de l'image — durée et définition d'une vidéo, nombre de pages d'un PDF,
--    titre, artiste et durée d'un audio. Relevé par le téléphone de
--    l'expéditeur au dépôt (le serveur n'a jamais le fichier en clair). Sur le
--    blob et non sur le fichier : « Enregistrer dans mon coffre » partage le
--    blob, donc ces informations aussi.
--
-- 2. `safebox_share_recipient` : qui a reçu un fichier partagé (téléchargé ou
--    enregistré dans son coffre), une ligne par destinataire et pour toujours.
--    Le journal des téléchargements, lui, est purgé après 31 jours : il ne
--    suffit pas au badge « reçu par 3 destinataires sur 4 » de l'expéditeur.
--
-- Réexécutable : colonne testée dans information_schema, CREATE TABLE IF NOT
-- EXISTS, INSERT IGNORE. Le code tolère l'absence de cette migration (pas de
-- durée ni de badge), mais elle s'applique AVANT de déployer.

SET @col := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_blob' AND COLUMN_NAME = 'meta');
SET @sql := IF(@col = 0,
  'ALTER TABLE safebox_blob ADD COLUMN meta JSON NULL
     COMMENT ''Durée, définition, pages, titre, artiste : relevés par le téléphone au dépôt''',
  'DO 0');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

CREATE TABLE IF NOT EXISTS safebox_share_recipient (
  share_id    BIGINT   NOT NULL,
  alanyaID    INT      NOT NULL,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (share_id, alanyaID),
  KEY idx_safebox_recipient_user (alanyaID),
  CONSTRAINT fk_safebox_recipient_share FOREIGN KEY (share_id)
    REFERENCES safebox_share(id) ON DELETE CASCADE,
  CONSTRAINT fk_safebox_recipient_user FOREIGN KEY (alanyaID)
    REFERENCES users(alanyaID) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ce que le journal des téléchargements sait déjà (31 derniers jours).
INSERT IGNORE INTO safebox_share_recipient (share_id, alanyaID, received_at)
SELECT d.share_id, d.alanyaID, MIN(d.created_at)
  FROM safebox_share_download d
  JOIN safebox_share s ON s.id = d.share_id
 WHERE d.alanyaID <> s.sender_id
 GROUP BY d.share_id, d.alanyaID;
