-- Nom personnalisé d'un contact préféré : le nom sous lequel JE l'enregistre
-- (« Maman », « Plombier Akwa »). Il appartient à la RELATION, comme
-- added_note (migration 027) : privé, jamais visible par l'autre, et il
-- disparaît avec le lien. NULL = pas de nom personnalisé, on affiche users.nom.
--
-- ⚠ ORDRE DE DÉPLOIEMENT — APPLIQUER AVANT DE DÉPLOYER LE CODE : le SELECT de
-- getPreferredContacts nomme la colonne. MySQL 8 ne supporte pas ADD COLUMN IF
-- NOT EXISTS (cf. migration 008) : en cas de relance, ignorer l'erreur 1060.

ALTER TABLE preferredContact
  ADD COLUMN custom_name VARCHAR(60) NULL;
