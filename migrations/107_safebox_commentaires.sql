-- Coffre-fort : commentaire d'une photo (décision du 18/10/2026). Facultatif,
-- privé — il ne part pas avec la photo quand on l'envoie dans une discussion,
-- et une copie enregistrée par un destinataire n'en a pas. Un texte de 200
-- caractères au plus, un audio de 5 minutes au plus, ou les deux.
--
-- L'audio est un petit objet chiffré par le téléphone, avec sa propre clé,
-- sous son propre préfixe chez MEGA (`u/<empreinte>/<uuid>/00001`), envoyé
-- directement par une adresse signée comme les blocs d'un fichier. Il compte
-- dans l'espace du coffre. Supprimer la photo supprime la ligne (cascade) ; le
-- rapprochement hebdomadaire efface ensuite l'objet devenu orphelin chez MEGA.
--
-- Réexécutable : CREATE TABLE IF NOT EXISTS. Le code tolère son absence (pas
-- de commentaire), mais elle s'applique AVANT de déployer.

CREATE TABLE IF NOT EXISTS safebox_note (
  file_id           BIGINT       NOT NULL,
  text              VARCHAR(200) NULL COMMENT '200 caractères au plus',
  audio_prefix      VARCHAR(100) NULL COMMENT 'u/<empreinte>/<uuid>/ chez MEGA ; l''objet est <préfixe>00001',
  audio_bytes       INT          NULL COMMENT 'Taille chiffrée, comptée dans l''espace',
  audio_plain_bytes INT          NULL,
  audio_duration_ms INT          NULL,
  audio_wrapped_key VARBINARY(96) NULL COMMENT 'Clé de l''audio sous SAFEBOX_KEY',
  audio_status      ENUM('pending','ready') NULL,
  audio_activity_at DATETIME     NULL,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (file_id),
  UNIQUE KEY uq_safebox_note_prefix (audio_prefix),
  CONSTRAINT fk_safebox_note_file FOREIGN KEY (file_id)
    REFERENCES safebox_file(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
