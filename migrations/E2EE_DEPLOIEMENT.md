# Chiffrement de bout en bout — déploiement des migrations 091 à 094, puis 104

`main` se déploie à chaque push. Ces migrations s'appliquent **à la main, avant
de pousser** le code qui les suit sur `main`. Elles sont réexécutables.

## 0. Avant toute chose : ce que la base contient déjà

Les migrations 091 à 093 viennent de la branche `feat/chiffrement-e2e`, où elles
portaient les numéros 090 à 092. Si quelqu'un les a jouées sous ces numéros, les
tables existent déjà, et `CREATE TABLE IF NOT EXISTS` les laissera telles
quelles.

```sql
SHOW TABLES LIKE 'e2ee_%';                       -- e2ee_device_keys, e2ee_one_time_prekeys, e2ee_settings
SHOW TABLES LIKE 'message_e2ee';
SHOW TABLES LIKE 'message_envelope';
SHOW COLUMNS FROM message LIKE 'enc_version';
SHOW COLUMNS FROM report LIKE 'target_excerpt';
SELECT COUNT(*) FROM message_crypto;            -- lignes de l'ancienne branche, illisibles
SELECT VERSION();                               -- MySQL 8.0.29+ : ajout de colonne instantané partout
```

Noter les résultats avant de continuer.

### Si `e2ee_device_keys` existe déjà avec l'ancien schéma

La première version de 091 prévoyait deux clés d'identité (`identity_key_dh`,
`identity_key_sign`, 32 octets). La version actuelle suit le format Signal :
une seule `identity_key` de 33 octets, plus `capacite` et `claimed_by`.

```sql
SHOW COLUMNS FROM e2ee_device_keys LIKE 'identity_key_dh';   -- une ligne = ancien schéma
SELECT COUNT(*) FROM e2ee_device_keys;                       -- doit valoir 0
SELECT COUNT(*) FROM e2ee_one_time_prekeys;                  -- doit valoir 0
```

Aucun client n'a jamais publié dans l'ancien format : les deux tables doivent
être vides. Si c'est bien le cas, les supprimer avant de jouer 091 :

```sql
DROP TABLE e2ee_one_time_prekeys;
DROP TABLE e2ee_device_keys;
```

Si elles ne sont pas vides, s'arrêter et en parler : quelqu'un a publié des
clés que le code actuel ne sait pas lire.

## 1. Ordre d'application

```bash
mysql -u USER -p DATABASE < migrations/091_e2ee_cles.sql
mysql -u USER -p DATABASE < migrations/092_e2ee_enveloppes.sql
mysql -u USER -p DATABASE < migrations/093_report_extrait.sql
mysql -u USER -p DATABASE < migrations/094_e2ee_settings.sql
# Étape 2 (texte chiffré) — après les migrations 095 à 103 déjà en place :
mysql -u USER -p DATABASE < migrations/104_e2ee_conversation.sql
```

104 ajoute `conversation.e2ee_since` (même conduite que 092 si
`ALGORITHM=INSTANT` est refusé) et élargit `message_envelope.wrapped_key` à
512 octets : un message Signal d'amorçage en fait 184, l'ancienne limite de
128 aurait refusé le premier message de chaque conversation.

### Si 092 refuse avec `ER_ALTER_OPERATION_NOT_SUPPORTED`

L'ajout de `message.enc_version` est demandé en `ALGORITHM=INSTANT`, exprès :
`message` est la table la plus chaude du schéma, et une recopie complète la
verrouillerait. Le refus ne touche rien. Dans ce cas :

1. ne PAS retirer `ALGORITHM=INSTANT` pour forcer le passage ;
2. planifier une fenêtre de maintenance, et y jouer l'ajout en
   `ALGORITHM=INPLACE, LOCK=NONE` (ou avec `pt-online-schema-change`) ;
3. puis rejouer 092 : la garde `information_schema` saute l'`ALTER` déjà fait
   et crée les tables restantes.

## 2. Ce qui dépend de quoi

| Code | Exige | Sans la migration |
|---|---|---|
| Envoi d'un message **en clair** (socket, HTTP) | rien | — (indépendant, voir `src/utils/messageInsert.js`) |
| Envoi d'un message **chiffré** | 092 | impossible de toute façon : l'interrupteur (094) est fermé |
| Historique et delta | rien | `attacheChiffre` ne lit les tables que pour `enc_version = 1` |
| Routes `/api/e2ee/*` | 091, 094 | 094 absente ⇒ `E2EE_INACTIF` (fermé) |
| **Création d'un signalement** | **092 et 093** | **échec** (`enc_version`, `target_excerpt`) |
| **Liste des signalements (admin)** | **093** | **échec** (`r.target_excerpt`) |
| Purge `e2ee_envelope` (nocturne) | 091, 092 | échec isolé, journalisé ; les autres purges continuent |
| Envoi, modification, transfert : garde « fil chiffré » | 104 | 104 absente ⇒ aucun fil n'est chiffré, tout passe comme avant |
| Activation d'une conversation (`GET /api/e2ee/devices`) | 104 | 104 absente ⇒ rien ne s'active |

Les deux lignes en gras sont la raison de la règle : **091 à 094 d'abord, push
ensuite.**

## 3. Après le push

```sql
SELECT * FROM e2ee_settings;   -- enrol_enabled = 0, activate_enabled = 0 : rien n'est ouvert
```

- Envoyer un message en clair depuis l'application actuelle : il part et arrive
  comme avant.
- Ouvrir la liste des signalements dans l'admin : elle s'affiche.
- `GET /api/e2ee/keys/state` avec un compte quelconque : `404 E2EE_INACTIF`.

## 4. Ouvrir, palier par palier

Depuis `PUT /api/admin/e2ee-settings` (super-admin), jamais en SQL : la route
journalise qui a ouvert quoi.

1. `{"cohortIds": [<comptes internes>], "enrolEnabled": true}` : les appareils
   internes publient leurs clés. Rien ne change pour les autres. Une
   application de l'étape 1 publie `capacite = 0` : elle ne déchiffre encore
   rien, et aucune conversation ne doit s'activer avec elle.

   Vérifier : `SELECT appareil_id, alanyaID, capacite, LENGTH(identity_key)
   FROM e2ee_device_keys;` (33 octets attendus), et le stock de chaque appareil
   (`SELECT appareil_id, COUNT(*) FROM e2ee_one_time_prekeys WHERE claimed_at
   IS NULL GROUP BY appareil_id;`, 100 attendus après la première ouverture).
2. `{"activateEnabled": true}` : seulement quand l'application qui sait
   chiffrer est installée sur tous les appareils internes.
3. `{"cohortPercent": 1}`, puis 10, 50, 100 : une semaine au moins par palier.

Refermer `activateEnabled` arrête les nouvelles activations. Une conversation
déjà chiffrée le reste.
