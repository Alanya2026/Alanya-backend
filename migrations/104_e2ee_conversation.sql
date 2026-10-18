-- Migration 104 : une conversation passe en chiffré, et les enveloppes Signal
-- y tiennent
--
-- Appliquer après 091 à 094 (chiffrement) et la dernière migration en place.
-- Application MANUELLE, réexécutable (gardes par information_schema). AVANT le
-- déploiement du code qui s'en sert — mais ce code tolère son absence : sans
-- `e2ee_since`, aucune conversation n'est chiffrée et tout reste en clair.
--
-- ── 1. `conversation.e2ee_since` ──
--
-- La date à laquelle la conversation est passée en chiffré, NULL tant qu'elle
-- ne l'est pas. Posée par le serveur, une seule fois (`e2eeActivation.js`),
-- quand tous les appareils des deux comptes savent déchiffrer.
--
-- À SENS UNIQUE, et c'est voulu : aucune route ne la remet à NULL. Les
-- messages déjà chiffrés ne sont lisibles que par les appareils ; un fil qui
-- redeviendrait « en clair » sur la parole du serveur est exactement ce qu'un
-- client correct doit refuser de croire (docs/e2ee, chapitre 21).
--
-- Elle part vers les applications sans code de plus : la liste des
-- conversations et `conversation:updated` font `SELECT c.*`.
--
-- ALGORITHM=INSTANT explicite, comme pour `message.enc_version` (092) :
-- refus immédiat plutôt qu'une recopie silencieuse de la table.
--
-- ── 2. `message_envelope.wrapped_key` : 128 → 512 octets ──
--
-- L'enveloppe porte la clé de contenu (32 octets) chiffrée par la session
-- Signal du destinataire. Mesuré avec libsignal_protocol_dart : un message
-- d'amorçage (PreKeySignalMessage, le PREMIER message de chaque session) fait
-- 184 octets — il embarque la clé de base, l'identité et les numéros de
-- pré-clés. À 128, le premier message de chaque conversation aurait été
-- refusé à l'écriture. 512 laisse la marge d'un futur message post-quantique
-- sans ouvrir la porte à des blocs arbitraires.
--
-- ── `env_type` : les numéros de Signal ──
--
-- Le commentaire posé par 092 (« 1=amorcage 2=cliquet 3=chaine de groupe »)
-- est caduc : la colonne porte désormais le type tel que la bibliothèque le
-- rend — 3 = amorçage (PreKeySignalMessage), 2 = cliquet (SignalMessage),
-- 4 = chaîne de groupe (SenderKeyMessage). Un nom parlant qui ment sur la
-- valeur derrière est la première erreur racontée par docs/e2ee (chapitre 1).

SET @has := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'conversation'
    AND COLUMN_NAME = 'e2ee_since');
SET @sql := IF(@has = 0, 'ALTER TABLE conversation
    ADD COLUMN e2ee_since DATETIME NULL
      COMMENT ''Passage en chiffré de bout en bout, à sens unique'',
    ALGORITHM=INSTANT', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @len := (SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message_envelope'
    AND COLUMN_NAME = 'wrapped_key');
SET @sql := IF(@len IS NOT NULL AND @len < 512, 'ALTER TABLE message_envelope
    MODIFY COLUMN wrapped_key VARBINARY(512) NULL,
    MODIFY COLUMN env_type TINYINT NOT NULL
      COMMENT ''Type Signal : 3=amorcage (PreKey) 2=cliquet 4=chaine de groupe''',
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
