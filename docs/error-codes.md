# Codes d'erreur — contrat serveur ↔ application

Toute réponse HTTP 4xx/5xx porte un `code` machine stable. **C'est lui le
contrat.** Le champ `error` reste une prose lisible destinée aux journaux et aux
clients anciens : il peut être reformulé librement.

```json
{ "error": "Votre cercle de confiance est vide", "code": "TRUST_LIST_EMPTY" }
```

## Pourquoi

Avant l'audit de 09/2026, 604 réponses d'erreur existaient et 135 seulement
portaient un `code`. L'application affichait donc `error` faute de mieux : une
prose française jamais traduite, que lisaient aussi les utilisateurs en anglais
et en chinois, et où filtrait parfois un `ER_NO_SUCH_TABLE`.

## Règles

1. **Un code ne se renomme jamais.** Les clients déployés ne se mettent pas à
   jour d'un bloc ; un renommage casse ceux qui restent. Pour changer de sens,
   ajouter un code et laisser l'ancien vivre.
2. **La prose n'est pas un contrat.** Ne jamais la lire côté client pour décider
   quoi afficher — c'était précisément le défaut corrigé.
3. **Aucun message de driver ne sort.** `src/utils/apiError.js` filtre les
   `ER_*`, les traces de pile et les chemins absolus vers `INTERNAL`.
4. **Un code inconnu de l'application n'est pas une panne.** Le client retombe
   sur le statut HTTP. Le serveur peut donc ajouter des codes à son rythme.

## Usage

```js
const { fail, failInternal } = require('../utils/apiError');

if (!liste.length) {
  return fail(res, 409, 'TRUST_LIST_EMPTY', 'Cercle de confiance vide');
}

try { /* … */ } catch (e) {
  console.error('[trips] création échouée', e);   // le détail va au journal
  return failInternal(res);                        // et non à l'utilisateur
}
```

## Codes traduits par l'application

Ceux-ci ont une phrase dédiée dans
`lib/core/errors/error_presenter.dart` (application Flutter). Les autres codes
sont valides mais rendus par le repli lié au statut HTTP.

### Session et compte
| Code | Statut | Sens |
|---|---|---|
| `TOKEN_EXPIRED` | 401 | Jeton d'accès expiré |
| `TOKEN_INVALID` | 401 | Jeton illisible ou falsifié |
| `TOKEN_REQUIRED` | 401 | Aucun jeton fourni |
| `REFRESH_EXPIRED` | 401 | Jeton de rafraîchissement expiré |
| `DEVICE_REVOKED` | 401 | Appareil déconnecté à distance |
| `ACCOUNT_DELETION_PENDING` | 403 | Compte en cours de suppression |
| `REGISTER_RATE_LIMITED` | 429 | Trop de créations de compte |

### QR et appairage
| Code | Statut | Sens |
|---|---|---|
| `QR_SESSION_EXPIRED` | 410 | Code QR périmé |
| `DEVICE_NOT_TRUSTED` | 403 | Appareil non enrôlé : passer par le QR, ou par la réinitialisation du mot de passe si le téléphone connu est perdu |
| `DEVICE_NOT_OWNER` | 403 | Appareil non autorisé pour l'action |
| `ADD_ALREADY_USED` | 409 | Ajout à un appel refusé : une invitation est déjà en cours, ou l'appel est déjà à trois (socket, voir plus bas) |
| `ADD_ME_POLICY_DENIED` | 403 | La cible refuse l'ajout par code |

### Réunions
| Code | Statut | Sens |
|---|---|---|
| `MEETING_EXPIRED` | 410 | Heure de fin dépassée |
| `MEETING_ENDED` | 410 | Terminée par l'organisateur |
| `MEETING_ORGANISER_REQUIRED` | 403 | Réservé à l'organisateur |
| `ACCOUNT_ALREADY_IN_MEETING` | 409 | Déjà présent sur un autre appareil |
| `SESSION_BUSY` | 409 | Un appel tient la session média |
| `MAX_DURATION_REACHED` | 403 | Durée maximale atteinte |

### Conversations, groupes et listes
| Code | Statut | Sens |
|---|---|---|
| `BLOCKED_BY_SENDER` | 403 | Blocage entre les deux comptes |
| `NOT_A_MEMBER` | 403 | Plus membre du groupe |
| `GROUP_ADMINS_ONLY` | 403 | Réservé aux administrateurs |
| `GROUP_OWNER_REQUIRED` | 403 | Réservé au propriétaire |
| `CONVERSATION_NOT_FOUND` | 404 | Conversation absente |
| `DELETE_WINDOW_EXPIRED` | 403 | Suppression pour tous refusée : plus de 72 heures depuis l'envoi (expéditeur comme administrateur) |
| `OFFICIAL_READONLY` | 403 | Compte officiel sans réponse |
| `LIST_MEMBER_LIMIT` | 409 | Liste pleine |
| `SYSTEM_LIST_READONLY` | 403 | Liste système non modifiable |
| `INVITE_BLOCKED` | 403 | Invitation refusée |
| `BUSINESS_ONLY` | 403 | Réservé aux comptes professionnels |

### Trajets
| Code | Statut | Sens |
|---|---|---|
| `TRUST_LIST_EMPTY` | 409 | Cercle de confiance vide |
| `TRIP_ALREADY_ACTIVE` | 409 | Un trajet est déjà en cours |
| `TRIP_TERMINAL` | 409 | Trajet déjà terminé |
| `TRIP_STILL_OPEN` | 409 | Trajet en cours à clore d'abord |
| `SOS_RATE_LIMITED` | 429 | Alerte déjà envoyée |
| `INVALID_ETA` | 400 | Heure d'arrivée invalide |
| `INVALID_DESTINATION` | 400 | Destination invalide |

### Médias
| Code | Statut | Sens |
|---|---|---|
| `MEDIA_EXPIRED` | 410 | Média purgé par rétention |
| `INVALID_EXTENSION` | 400 | Type de fichier refusé |

### Documents sensibles
Plan : `PLAN-DOCUMENTS-SENSIBLES.md` (app). Un envoi sensible mal formé (`isSensitive` sur un message sans fichier, `mediaProtection` qui n'est pas un objet, de plus de 2 Ko, sans `isSensitive` ou dans un message chiffré) répond `400 INVALID_PAYLOAD`, aussi par `message:send_failed`.

| Code | Statut | Sens |
|---|---|---|
| `SENSITIVE_NO_FORWARD` | 403 | Transfert d'un document sensible (`/api/messages/batch-forward`) : seule une copie signée sort, par « Enregistrer » |
| `NOT_SENSITIVE` | 400 | Trace demandée pour un message qui n'est pas un document sensible |
| `INVALID_FINGERPRINT` | 422 | Empreinte mal formée : il faut 32 caractères hexadécimaux (espaces et casse indifférents) |
| `FINGERPRINT_NOT_FOUND` | 404 | Empreinte inconnue, ou copie d'un document que le demandeur ne pouvait pas voir (même réponse) |
| `FINGERPRINT_EXISTS` | 409 | Empreinte déjà enregistrée : rejeu, ou tentative d'écraser la trace d'un autre |

### Abonnement
| Code | Statut | Sens |
|---|---|---|
| `SUBSCRIPTION_REQUIRED` | 403 | Fonctionnalité Alanya Plus (`feature` joint) — l'application ouvre le panneau de l'offre. `feature: "outgoing"` : essai fini sans abonnement, le compte ne peut ni envoyer ni appeler (aussi sur `message:send_failed`, `call_failed`, `call_error`, `call_add_rejected` et `error`) |
| `BILLING_NOT_ACTIVE` | 409 | Payant éteint : rien à payer |
| `PAYMENT_PENDING` | 409 | Un paiement attend déjà (`paymentId` joint) — l'application reprend son attente |
| `INVALID_MSISDN` | 400 | Numéro mobile money invalide |
| `INVALID_CHANNEL` | 400 | Moyen de paiement non proposé |
| `PLAN_NOT_FOUND` | 404 | Plan inconnu ou retiré |
| `PAYMENT_PROVIDER_ERROR` | 502 | Fournisseur de paiement injoignable |
| `INVALID_CODE_FORMAT` | 400 | Code d'activation mal saisi (faute de frappe, ne compte pas comme un essai) |
| `INVALID_CODE` | 404 | Code d'activation inconnu (compte comme un essai) |
| `CODE_ALREADY_USED` | 409 | Code déjà utilisé par un autre compte |
| `CODE_EXPIRED` | 410 | Code expiré |
| `CODE_REVOKED` | 410 | Code annulé |
| `CODE_LOCKED` | 429 | Cinq échecs en quinze minutes (`retryAfterSeconds` joint) |

### Stickers
Contrat : `CONTRAT-STICKERS.md` §5 et §9. Aussi émis par `message:send_failed` (socket) pour les quatre premiers. Fonctionnalité fermée (`sticker_settings.enabled`, cohorte) : les routes `/api/stickers/*` répondent `404 NOT_FOUND` générique, et l'envoi d'un type 10 `400 STICKER_INVALID_PAYLOAD` — rien n'est révélé.

| Code | Statut | Sens |
|---|---|---|
| `STICKER_NOT_FOUND` | 404 | Sticker inconnu, ou fichier retiré (suppression par l'auteur, retrait admin) |
| `STICKER_PACK_UNAVAILABLE` | 404 | Pack officiel brouillon ou archivé (installé ou non : archivé = indisponible, A14 ; à l'envoi, au transfert, en lecture et à l'installation), ou non officiel (V1a). V1b : pack perso d'un autre compte (jamais « interdit » : même réponse qu'un pack inexistant), pack perso archivé, lien de partage mal formé, inconnu, révoqué ou d'un pack archivé (réponse identique pour les quatre) |
| `STICKER_INVALID_PAYLOAD` | 400 | `content` du type 10 illisible, version inconnue, `sid` invalide ou plus de 512 octets ; aussi stickers fermés pour ce compte. V1b : corps de requête mal formé (`PATCH /packs/:id`, `PUT /packs/:id/order`, `POST /packs/:id/stickers`), nom vide, partage d'un pack vide |
| `STICKER_ASSET_INVALID` | 422 | Upload refusé : format réel ni PNG ni WebP, pas 512×512, sans alpha, animé, trop lourd, corrompu (V1b, administration). V1c, animé : format réel ni GIF ni WebP animé (lu dans les octets : APNG, AVIF, SVG, TIFF… refusés), fichier non animé, > 300 images, image ou pile de pixels hors bornes, animation « trop lourde » (> 300 Ko même à la qualité 20), conversion trop longue, forme impossible à poser. Le message est uniforme : jamais le texte de libvips |
| `STICKER_ASSET_BLOCKED` | 422 | Empreinte du fichier présente dans `sticker_blocklist` |
| `STICKER_QUOTA_EXCEEDED` | 429 | Quota de stickers personnels (200) ou d'uploads (30 par heure) atteint (V1b) ; aussi à l'installation d'un pack partagé qui dépasserait les 200 (seules les images que le compte n'a pas déjà comptent) |
| `STICKER_PACK_LIMIT` | 409 | Limite de packs installés (50), de packs personnels (20, archivés exclus) ou de stickers par pack (40) atteinte ; aussi à l'installation d'un pack partagé quand les 20 packs perso sont pris |
| `STICKER_EDIT_FORBIDDEN` | 409 | Éditer (`PUT /messages/:id`) un message de type 10 est refusé : son `content` est un JSON canonisé dont l'édition remplacerait tout par du texte affiché en brut |
| `STICKER_PACK_INCOMPLETE` | 422 | Publication refusée par la liste de contrôle (nom FR+EN, icône, ≥ 8 stickers) ; `missing` liste ce qui manque. Admin seulement |
| `STICKER_PACK_PUBLISHED` | 409 | Modifier ou supprimer un sticker d'un pack publié/archivé ; on archive, on ne réécrit pas. Admin seulement |
| `STICKER_SETTINGS_UNAVAILABLE` | 503 | Réglages stickers illisibles côté admin (migration 097 non jouée, base injoignable) |
| `NOT_FOUND` | 404 | Générique, sans sens métier : `/api/stickers/*` fermé pour ce compte. Nouveau pour ce lot ; le client retombe sur le statut HTTP |

`SUBSCRIPTION_REQUIRED` avec `feature: "stickers_premium"` : pack Plus installé ou envoyé sans le droit. Il ne se déclenche que sur un « non » explicite des droits ; droits indisponibles = on laisse passer.

Création de packs et partage (V1b) : aucun code nouveau. `RATE_LIMITED` (429, par compte) sur `GET /share/:token` (30/min), `POST /share/:token/add` (10/min) et `POST|DELETE /packs/:id/share` (20/min). Ces routes sont derrière `creation_enabled` : fermé, `404 NOT_FOUND` générique, avant le limiteur.

Stickers animés (V1c) : aucun code nouveau. `animated_enabled` fermé : un sticker animé reste invisible (omis de `GET /packs/:code` et des listes), son envoi répond `404 STICKER_NOT_FOUND` (comme un fichier retiré), la copie d'un sticker animé reçu aussi, et `POST /api/stickers/assets/animated` répond `404 NOT_FOUND` générique, avant multer et avant le limiteur. `RATE_LIMITED` (429, par compte) : 10 créations animées par heure. `503 SERVICE_UNAVAILABLE` (retryable, en-tête `Retry-After`) : un seul encodage animé à la fois par processus, la file d'attente est courte (3 demandes, 8 s) ; le client rejoue, ce n'est ni un échec définitif ni un refus métier. Les quotas (`STICKER_QUOTA_EXCEEDED`) et la liste de blocage (`STICKER_ASSET_BLOCKED`) s'appliquent comme pour un sticker statique. Champ `shape` inconnu : `400 STICKER_INVALID_PAYLOAD`.

Réglages des stickers illisibles à l'ENVOI (base injoignable, migration non jouée) : `503 SERVICE_UNAVAILABLE` (code général, retryable — l'outbox rejoue), jamais un `STICKER_*` terminal. Les routes `/api/stickers/*`, elles, ferment en `404 NOT_FOUND`.

### Numéro Alanya choisi
| Code | Statut | Sens |
|---|---|---|
| `PHONE_PURCHASE_UNAVAILABLE` | 403 | Le choix du numéro n'est pas proposé à ce compte (simulateur en production, hors testeurs) |
| `OFFICIAL_PHONE_FIXED` | 403 | Le compte officiel garde son numéro |
| `PHONE_NOT_PURCHASABLE` | 400 | Seuls les numéros à 8 chiffres se choisissent |
| `PHONE_UNAVAILABLE` | 409 | Numéro pas à vendre (`reason` joint : `same`, `taken`, `set_aside`, `held`, `quarantine`) |
| `PHONE_HOLD_EXPIRED` | 409 | La mise de côté de 15 minutes a expiré avant le paiement |
| `PHONE_ORDER_NOT_FOUND` | 404 | Commande de numéro inconnue |
| `PHONE_ORDER_PENDING` | 409 | Un paiement de numéro attend déjà sa réponse (`orderId`, `paymentId` joints) |

### Vérification d'identité
| Code | Statut | Sens |
|---|---|---|
| `VERIFICATION_UNAVAILABLE` | 503 | Coffre à pièces non configuré : la vérification n'est pas encore ouverte |
| `DOCUMENTS_REQUIRED` | 400 | Pièce d'identité et selfie requis |
| `NAME_REQUIRED` | 400 | Aucun nom à vérifier sur le profil |
| `VERIFICATION_ALREADY_OPEN` | 409 | Une demande est déjà en cours (`requestId` joint) |
| `VERIFICATION_ALREADY_APPROVED` | 409 | Identité déjà vérifiée sous ce nom |
| `REQUEST_NOT_PENDING` | 409 | Le dossier n'est pas dans un état qui permet ce geste |

### Chiffrement de bout en bout
| Code | Statut | Sens |
|---|---|---|
| `E2EE_INACTIF` | 404 | Chiffrement fermé pour ce compte (interrupteur `e2ee_settings`, ou compte hors cohorte) : l'application ne publie rien et reste en clair, sans erreur à l'écran ni nouvel essai. Aussi refus d'un envoi chiffré, par `message:send_failed` et en 404 sur `POST /conversations/:id/messages` |
| `E2EE_APPAREIL_INCONNU` | 409 | Session trop ancienne pour porter une identité de chiffrement : il faut se reconnecter |
| `E2EE_CLE_MANQUANTE` | 400 | Une clé publique attendue est absente du bundle (`champ` joint) |
| `E2EE_CLE_TAILLE` | 400 | Clé publique ou signature de taille inattendue (`champ` joint) |
| `E2EE_CLE_TYPE` | 400 | Clé publique de 33 octets qui ne commence pas par l'octet de type Curve25519 (0x05) : elle ne vient pas de la bibliothèque Signal (`champ` joint) |
| `E2EE_CAPACITE_INVALIDE` | 400 | `capacite` absente ou hors de 0 à 3 : l'application doit dire ce qu'elle sait lire |
| `E2EE_ID_INVALIDE` | 400 | `keyId` ou `registrationId` hors bornes (`champ` joint) |
| `E2EE_OTPK_INVALIDE` | 400 | Liste de clés à usage unique mal formée |
| `E2EE_OTPK_DOUBLON` | 400 | Deux clés à usage unique portent le même `keyId` |
| `E2EE_OTPK_TROP` | 400 | Plus de 100 clés à usage unique en un seul envoi |
| `E2EE_APPAREILS_INVALIDE` | 400 | `appareilIds` absent, vide ou sans aucun identifiant exploitable |
| `E2EE_APPAREILS_TROP` | 400 | Plus de 200 appareils demandés en une requête : découper le lot |

Les codes suivants refusent un envoi mal formé. Ils arrivent par
`message:send_failed` sur le socket, et en 400 sur `POST /conversations/:id/messages`.
Un envoi chiffré mal formé est **perdu sans recours** — l'émetteur a son accusé,
le clair n'existe plus que chez lui, et le serveur n'a aucune clé pour
rattraper. D'où un refus avant écriture plutôt qu'une réparation après.

| Code | Statut | Sens |
|---|---|---|
| `E2EE_CORPS_MANQUANT` | 400 | Des enveloppes sans corps chiffré, ou un corps vide |
| `E2EE_CORPS_TROP_GROS` | 400 | Corps chiffré au-delà de 512 Ko |
| `E2EE_NONCE_TAILLE` | 400 | Le nonce du corps ne fait pas 12 octets |
| `E2EE_ENVELOPPES_MANQUANTES` | 400 | Corps chiffré sans aucune enveloppe : personne ne pourrait l'ouvrir |
| `E2EE_ENVELOPPES_TROP` | 400 | Plus de 400 enveloppes en un envoi : découper |
| `E2EE_ENVELOPPE_INVALIDE` | 400 | Enveloppe sans appareil, sans en-tête, ou mal formée |
| `E2EE_ENVELOPPE_DOUBLON` | 400 | Deux enveloppes pour le même appareil |
| `E2EE_ENVELOPPE_EMETTEUR` | 400 | Enveloppe adressée à l'appareil émetteur, qui détient déjà le clair |
| `E2EE_ENVELOPPE_TYPE` | 400 | `envType` inconnu, ou clé scellée incohérente avec le type |
| `E2EE_ENVELOPPE_APPAREIL_INCONNU` | 400 | Un appareil destinataire a été révoqué entre-temps : rafraîchir `/api/e2ee/devices` et rejouer |
| `E2EE_EDITION_NON_PRISE_EN_CHARGE` | 409 | Modifier un message chiffré demande de rechiffrer et de resceller pour chaque appareil : pas encore implémenté, et refusé plutôt que de déposer le clair sur le serveur |

### Droits et divers
| Code | Statut | Sens |
|---|---|---|
| `INSUFFICIENT_ROLE` | 403 | Droits insuffisants |
| `FIELD_IMMUTABLE` | 409 | Champ non modifiable |
| `INTERNAL` | 500 | Erreur interne — aucun détail exposé |

## Coffre-fort

Routes `/api/safebox` (lots 1 à 4, conception : `docs/conception/coffre-fort.html`).
L'application les traduira au lot 2 ; d'ici là, le repli lié au statut s'applique.

| Code | Statut | Sens |
|---|---|---|
| `SAFEBOX_UNAVAILABLE` | 503 | Coffre-fort non configuré sur le serveur (MEGA S4 ou `SAFEBOX_KEY`) |
| `SAFEBOX_NOT_FOUND` | 404 | Dossier, fichier ou envoi introuvable — ou d'un autre compte : on ne dit jamais « interdit » |
| `SAFEBOX_INVALID_NAME` | 400 | Nom vide, trop long (`max` joint) ou avec `/`, `\` ou un caractère de contrôle |
| `SAFEBOX_NAME_TAKEN` | 409 | Un sous-dossier vivant porte déjà ce nom (casse ignorée) |
| `SAFEBOX_TOO_DEEP` | 409 | Trop de niveaux de sous-dossiers (`maxDepth` joint) |
| `SAFEBOX_FOLDER_LIMIT` | 409 | Trop de sous-dossiers pour ce compte, corbeille comprise (`maxFolders` joint) |
| `SAFEBOX_ROOT_LOCKED` | 400 | Les quatre dossiers racines ne se renomment, ne se déplacent ni ne se suppriment |
| `SAFEBOX_INVALID_MOVE` | 400 | Un dossier ne se range pas dans lui-même ni dans un de ses descendants |
| `SAFEBOX_WRONG_FAMILY` | 400 | Extension d'une autre famille que le dossier (`expectedRoot` joint : le bon dossier racine) |
| `SAFEBOX_INVALID_SIZE` | 400 | Tailles manquantes, incohérentes (chiffré / clair) ou aperçu trop lourd |
| `SAFEBOX_FILE_TOO_LARGE` | 413 | Fichier au-delà de la taille maximale (`maxBytes` joint) |
| `SAFEBOX_QUOTA_EXCEEDED` | 409 | Espace du coffre insuffisant (`usedBytes`, `quotaBytes`, `neededBytes` joints) — l'application propose Alanya Plus |
| `SAFEBOX_INVALID_CIPHER` | 400 | Format de chiffrement absent ou invalide |
| `SAFEBOX_INVALID_BLOCKS` | 400 | Numéros de blocs invalides (`blockCount`, `maxPerCall` joints) |
| `SAFEBOX_INVALID_KEY` | 400 | Clé du fichier absente ou pas de 32 octets |
| `SAFEBOX_UPLOAD_INCOMPLETE` | 409 | Des blocs manquent chez MEGA (`missing`, `missingCount`, `previewMissing` joints) : les renvoyer puis terminer |
| `SAFEBOX_SHARE_INVALID` | 400 | Message de type 11 dont le partage n'est pas à l'expéditeur ou pas à cette discussion (aussi sur `message:send_failed`) ; partage d'un album vide ou d'une liste de fichiers invalide |
| `SAFEBOX_INVALID_FINGERPRINT` | 400 | Empreinte de l'original mal formée (64 caractères hexadécimaux), ou plus de 500 empreintes par demande (`max` joint) — sauvegarde automatique |
| `SAFEBOX_SHARE_TOO_MANY` | 400 | Plus de 500 fichiers dans un même partage (`max` joint) : envoyer en plusieurs fois |
| `SAFEBOX_SHARE_ITEM_REQUIRED` | 400 | Téléchargement d'un lot (album, sélection) sans l'élément `?item=` — réponse des anciennes applications : « Mettez à jour Alanya » |
| `SAFEBOX_SHARE_REVOKED` | 410 | L'expéditeur a mis le fichier partagé à la corbeille, l'a supprimé ou a retiré le partage : la carte affiche « Fichier retiré par l'expéditeur » |
| `SAFEBOX_DOWNLOAD_LIMIT` | 429 | Trop de téléchargements de ce fichier partagé sur 24 h (`limit` joint) ; l'expéditeur n'est jamais limité |
| `SAFEBOX_NOTE_TOO_LONG` | 400 | Commentaire d'une photo trop long : `maxChars` (200) pour le texte, `maxDurationMs` (5 minutes) pour l'audio |
| `SAFEBOX_NOTE_UNAVAILABLE` | 400 | Les commentaires sont réservés aux photos (famille « albums ») |
| `SAFEBOX_INVALID_NOTE` | 400 | Texte de commentaire qui n'est pas une chaîne |
| `SAFEBOX_FILE_LOST` | 410 | Le contenu du fichier a disparu chez MEGA (rapprochement hebdomadaire, migration 106) : l'application affiche « Fichier endommagé », rien ne se récupère |

## Codes venus du socket, pas de HTTP

`SESSION_BUSY` et `ADD_ALREADY_USED` sont traduits par l'application mais
n'apparaissent dans aucune réponse HTTP : ils voyagent par `meeting:join_denied`
et par le refus d'ajout à un appel. Le garde de couverture ne les voit donc pas,
et c'est normal.

## Tous les codes HTTP émis

Le backend émet **286 codes** en réponse HTTP. 59 d'entre eux ont
une phrase dédiée dans l'application ; les 227 suivants sont valides et rendus par
le repli lié au statut. Leur donner une phrase est une amélioration, pas un
correctif — un code non traduit ne fait rien afficher de brut.

- `ACCOUNT_ALREADY_EXISTS` · `ACCOUNT_BANNED` · `ACCOUNT_REQUIRED`
- `ALREADY_EXISTS` · `APP_LINK_NOT_CONFIGURED` · `AUTH_FAILED`
- `AUTH_INTERNAL` · `AUTH_REJECTED` · `BACKUP_KEY_LAST_ACTIVE`
- `BACKUP_KEY_UNAVAILABLE` · `BILLING_ALREADY_ACTIVE` · `BILLING_CODE_SECRET_MISSING`
- `BILLING_MODEL_LOCKED` · `BILLING_NOT_CONFIGURED` · `BILLING_PROVIDER_SIMULATED`
- `BIO_LIMIT` · `BLOCKS_REQUIRED` · `BROADCAST_NOT_FOUND`
- `CALLER_BUSY` · `CALLER_ID_MISMATCH` · `CALLER_ID_REQUIRED`
- `CALL_ALREADY_JOINED_ON_OTHER_DEVICE` · `CALL_BLOCKED` · `CALL_ID_REQUIRED`
- `CALL_ID_UNAVAILABLE` · `CALL_INVITE_NOT_PENDING` · `CALL_NOT_RINGING`
- `CALL_REJOIN_INVALID` · `CALL_SELF` · `CANNOT_CHANGE_OWN_ROLE`
- `CANNOT_REMOVE_OWNER` · `CANNOT_TARGET_SELF` · `CANNOT_TARGET_SUPERADMIN`
- `CLIENT_ID_REQUIRED` · `CODE_NOT_FOUND` · `CONTACT_ALREADY_EXISTS`
- `CONTACT_NOT_FOUND` · `CONTENT_REQUIRED` · `CONVERSATION_FORBIDDEN`
- `CONVERSATION_ID_REQUIRED` · `CRITERIA_REQUIRED` · `DECISION_NOT_FOUND`
- `DELETE_WINDOW_EXPIRED` · `DEVICE_ID_REQUIRED` · `DEVICE_NOT_FOUND`
- `DOCUMENT_NOT_FOUND` · `DOCUMENT_PURGED` · `DUPLICATE_ENTRY`
- `EDIT_WINDOW_EXPIRED` · `EMAIL_REQUIRED` · `EMAIL_TAKEN`
- `EMOJI_REQUIRED` · `ESTIMATE_STALE` · `EXPORT_EXPIRED`
- `EXPORT_FAILED` · `EXPORT_NOT_FOUND` · `FCM_TOKEN_REQUIRED`
- `FEATURE_NOT_FOUND` · `FIELD_EMPTY` · `FILE_REQUIRED`
- `FILE_TOO_LARGE` · `FORBIDDEN` · `GROUP_ADD_MEMBERS_LOCKED`
- `GROUP_ADMIN_REQUIRED` · `GROUP_CALL_FULL` · `GROUP_CALL_TOO_MANY`
- `GROUP_INFO_LOCKED` · `GROUP_NOT_FOUND` · `ID_PAYS_REQUIRED`
- `ID_RECEIVER_REQUIRED` · `INSERT_LOST` · `INVALID`
- `INVALID_ACCOUNT` · `INVALID_ACCOUNT_TYPE` · `INVALID_AGE`
- `INVALID_ALANYA_ID` · `INVALID_BILLING_SETTING` · `INVALID_BLOCK_TYPE`
- `INVALID_CODE_BATCH` · `INVALID_CODE_FILTER` · `INVALID_CODE_ORDER`
- `INVALID_CONTACT` · `INVALID_CONVERSATION` · `INVALID_CONVERSATION_IDS`
- `INVALID_COUNTRY` · `INVALID_CREDENTIALS` · `INVALID_CRITERIA`
- `INVALID_DEVICE` · `INVALID_E2EE_SETTING` · `INVALID_EMAIL`
- `INVALID_FEATURE` · `INVALID_FORMAT` · `INVALID_GENDER`
- `INVALID_GIFT` · `INVALID_GRACE` · `INVALID_GROUP`
- `INVALID_IDS` · `INVALID_JOB` · `INVALID_KID`
- `INVALID_LIST` · `INVALID_MEDIA` · `INVALID_MEETING`
- `INVALID_MEMBER` · `INVALID_MESSAGE` · `INVALID_MSG_IDS`
- `INVALID_MUTED_UNTIL` · `INVALID_PARTICIPANT_ID` · `INVALID_PASSWORD`
- `INVALID_PAYLOAD` · `INVALID_PHONE` · `INVALID_PHONE_LENGTH`
- `INVALID_PLAN` · `INVALID_PREFERENCES` · `INVALID_QR`
- `INVALID_REFERENCE` · `INVALID_ROLE` · `INVALID_ROOM_ID`
- `INVALID_SECURITY_SETTING` · `INVALID_SIGNATURE` · `INVALID_TOKEN`
- `INVALID_TO_USER_ID` · `INVALID_TRIP_ID` · `INVALID_USER`
- `INVALID_VERIFICATION_STATUS` · `INVALID_VERIFIED_UNTIL` · `INVALID_VERSION`
- `JOB_NOT_FOUND` · `JOB_WORKER_DOWN` · `JOIN_ACK_INVALID`
- `JOIN_ACK_MISMATCH` · `LABEL_REQUIRED` · `LIMIT_REACHED`
- `LIST_ALREADY_EXISTS` · `LIST_NOT_FOUND` · `LIST_REQUIRED`
- `MEDIA_NOT_FOUND` · `MEDIA_REQUIRED` · `MEETING_FIELDS_REQUIRED`
- `MEETING_NOT_FOUND` · `MEMBER_NOT_FOUND` · `MESSAGE_NOT_FOUND`
- `METADATA_INCOMPLETE` · `MIGRATION_REQUIRED` · `MISSING_CLIENT_ID`
- `MSG_IDS_REQUIRED` · `NOM_REQUIRED` · `NOT_A_GROUP`
- `NO_DELETION_PENDING` · `NO_FIELDS_TO_UPDATE` · `OFFICIAL_ACCOUNT_MISSING`
- `OFFICIAL_ALREADY_EXISTS` · `OFFICIAL_AVATAR_MISSING` · `OFFICIAL_BUSY`
- `OFFICIAL_NOT_BLOCKABLE` · `OFFICIAL_NOT_CALLABLE` · `OFFICIAL_NOT_DELETABLE`
- `OFFICIAL_NOT_LOGGABLE` · `OFFICIAL_NOT_PROMOTABLE` · `OFFICIAL_PHONE_TAKEN`
- `OFFICIAL_SENDER_REQUIRED` · `OTP_EXPIRED` · `OTP_INVALID`
- `OTP_NOT_REQUESTED` · `PARTICIPANT_IDS_REQUIRED` · `PASSWORD_INCORRECT`
- `PASSWORD_REQUIRED` · `PAYMENT_NOT_FOUND` · `PAYMENT_PROVIDER_UNKNOWN`
- `PHONE_ALREADY_EXISTS` · `PHONE_HELD` · `PHONE_NOT_FOUND`
- `PHONE_NOT_NUMERIC` · `PHONE_NOT_RESERVABLE` · `PHONE_REQUIRED`
- `PLAN_CODE_TAKEN` · `PLUS_CHECKOUT_DISABLED` · `POLL_TOKEN_REQUIRED`
- `PROFILE_NOT_FOUND` · `PURGE_UNKNOWN` · `QR_UNKNOWN_OR_EXPIRED`
- `RATE_LIMITED` · `REASON_REQUIRED` · `RECIPIENT_NOT_FOUND`
- `REFRESH_INVALID` · `REFRESH_TOKEN_REQUIRED` · `REPORT_NOT_FOUND`
- `RESERVED_BRAND_NAME` · `ROOM_ENDED` · `SAFEBOX_DOWNLOAD_LIMIT`
- `SAFEBOX_FILE_LOST` · `SAFEBOX_FILE_TOO_LARGE` · `SAFEBOX_FOLDER_LIMIT` · `SAFEBOX_INVALID_BLOCKS`
- `SAFEBOX_INVALID_CIPHER` · `SAFEBOX_INVALID_FINGERPRINT` · `SAFEBOX_INVALID_KEY` · `SAFEBOX_INVALID_MOVE`
- `SAFEBOX_INVALID_NAME` · `SAFEBOX_INVALID_NOTE` · `SAFEBOX_INVALID_SIZE` · `SAFEBOX_NAME_TAKEN`
- `SAFEBOX_NOT_FOUND` · `SAFEBOX_NOTE_TOO_LONG` · `SAFEBOX_NOTE_UNAVAILABLE` · `SAFEBOX_QUOTA_EXCEEDED` · `SAFEBOX_ROOT_LOCKED`
- `SAFEBOX_SHARE_INVALID` · `SAFEBOX_SHARE_ITEM_REQUIRED` · `SAFEBOX_SHARE_REVOKED` · `SAFEBOX_SHARE_TOO_MANY` · `SAFEBOX_TOO_DEEP`
- `SAFEBOX_UNAVAILABLE` · `SAFEBOX_UPLOAD_INCOMPLETE` · `SAFEBOX_WRONG_FAMILY`
- `SCAN_SECRET_REQUIRED` · `SEARCH_QUERY_REQUIRED` · `SENDER_ID_REQUIRED`
- `SERVER_ERROR` · `SERVICE_UNAVAILABLE` · `SESSION_ALREADY_HANDLED`
- `SESSION_NOT_FOUND` · `SESSION_REJECTED` · `SOURCE_MSG_IDS_REQUIRED`
- `STATUS_NOT_FOUND` · `STORAGE_UNAVAILABLE` · `TARGET_CONVERSATION_IDS_REQUIRED`
- `TEXT_REQUIRED` · `TOKEN_TYPE_INVALID` · `TRIP_INCIDENT_LOCKED`
- `TRIP_NOT_FOUND` · `UNAUTHENTICATED` · `UNMUTE_REQUIRED`
- `UNSUPPORTED_FORMAT` · `UPLOAD_REJECTED` · `USER_ALREADY_EXISTS`
- `USER_ID_MISMATCH` · `USER_NOT_FOUND` · `USE_GROUP_ENDPOINT`
- `USE_LEAVE_ENDPOINT` · `USE_SOS_ENDPOINT` · `VALIDATION_FAILED`
- `VERIFICATION_NOT_FOUND` · `VERSION_NOT_FOUND`
