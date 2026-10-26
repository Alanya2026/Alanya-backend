const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const c = require('../controllers/safeboxController');

const router = express.Router();

/**
 * Coffre-fort — conception : docs/conception/coffre-fort.html.
 *
 * Les octets des fichiers ne passent jamais par ici : le téléphone envoie et
 * télécharge directement chez MEGA S4 avec les adresses signées que rendent
 * ces routes. Tout est réservé au propriétaire du coffre (le partage arrive
 * au lot 3).
 *
 * Limites par compte, et non par IP (une classe ou un réseau mobile partagent
 * une adresse). Un album de 200 photos fait 200 réservations et autant de
 * fins d'envoi : la limite d'écriture le laisse passer en une minute.
 */
const parCompte = (req) => `u${req.user?.alanyaID ?? 'anonyme'}`;
const limite = (max) => rateLimit({
  windowMs: 60 * 1000,
  max,
  keyGenerator: parCompte,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de demandes au coffre-fort, patientez un instant', code: 'RATE_LIMITED' },
});
const lecture = limite(240);
const ecriture = limite(600);

/**
 * @swagger
 * /api/safebox:
 *   get:
 *     summary: Ouvre le coffre (création des six dossiers racines à la première visite) — espace, racines, limites
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ quota: { quotaBytes, usedBytes, pendingBytes, trashBytes, byRoot }, roots: [{ id, root }], limits }"
 *       503:
 *         description: SAFEBOX_UNAVAILABLE — MEGA S4 ou SAFEBOX_KEY non configurés
 */
router.get('/', auth, lecture, c.overview);

/**
 * @swagger
 * /api/safebox/folders/{id}:
 *   get:
 *     summary: Contenu d'un dossier — sous-dossiers, puis fichiers par pages de 100 (`?cursor=`)
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ folder, breadcrumbs, folders, files: [{ …, key, previewUrl }], nextCursor }"
 *       404:
 *         description: SAFEBOX_NOT_FOUND
 *   patch:
 *     summary: Renommer (`name`) et/ou déplacer (`parentId`, même famille) un sous-dossier
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     summary: Mettre un sous-dossier à la corbeille, avec son contenu
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/folders:
 *   post:
 *     summary: "Créer un sous-dossier — { parentId, name }"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Le dossier créé
 *       409:
 *         description: SAFEBOX_NAME_TAKEN, SAFEBOX_TOO_DEEP ou SAFEBOX_FOLDER_LIMIT
 * /api/safebox/folders/{id}/files:
 *   post:
 *     summary: "Ajouter des fichiers du coffre à un album, sans copie — { fileIds: [...] } (100 au plus)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "Les exemplaires dans l'album ({ files }) ; un fichier déjà présent n'est pas ajouté deux fois"
 *       400:
 *         description: "SAFEBOX_INVALID_MOVE (dossier hors d'Albums, liste vide ou trop longue)"
 */
router.get('/folders/:id', auth, lecture, c.listFolder);
router.post('/folders', auth, ecriture, c.createFolder);
router.patch('/folders/:id', auth, ecriture, c.updateFolder);
router.delete('/folders/:id', auth, ecriture, c.trashFolder);
router.post('/folders/:id/restore', auth, ecriture, c.restoreFolder);
router.post('/folders/:id/files', auth, ecriture, c.addToFolder);

/**
 * @swagger
 * /api/safebox/uploads:
 *   post:
 *     summary: Réserver l'espace d'un fichier et obtenir les adresses d'envoi de ses blocs
 *     description: >
 *       Corps : `{ folderId, name, mime, size, plainSize, originalSize?, compressed?, previewSize?, cipherFormat, meta? }`.
 *       `meta` (facultatif, migration 104) : `{ durationMs?, width?, height?, pages?, title?, artist? }`,
 *       relevé par le téléphone et affiché par la carte d'un fichier partagé ; un champ hors bornes est ignoré.
 *       `size` est la taille chiffrée, découpée en blocs de 8 Mio ; chaque adresse signée impose la taille de son bloc.
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: "{ fileId, blockSize, blockCount, size, blocks: [{ n, size, url }], preview, urlTtlSeconds }"
 *       409:
 *         description: SAFEBOX_QUOTA_EXCEEDED (usedBytes, quotaBytes, neededBytes joints)
 *       413:
 *         description: SAFEBOX_FILE_TOO_LARGE (maxBytes joint)
 * /api/safebox/uploads/{id}/blocks:
 *   get:
 *     summary: Blocs déjà reçus chez MEGA, pour reprendre un envoi
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *   post:
 *     summary: "Adresses d'envoi de blocs choisis — { blocks: [n…], preview? }, 64 au plus"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/uploads/{id}/complete:
 *   post:
 *     summary: "Terminer l'envoi — { key }, la clé du fichier en base64 (32 octets)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Le fichier, désormais visible dans son dossier
 *       409:
 *         description: SAFEBOX_UPLOAD_INCOMPLETE (missing, previewMissing joints)
 * /api/safebox/uploads/{id}:
 *   delete:
 *     summary: Abandonner un envoi et libérer l'espace réservé
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 */
router.post('/uploads', auth, ecriture, c.reserveUpload);
router.get('/uploads/:id/blocks', auth, ecriture, c.uploadStatus);
router.post('/uploads/:id/blocks', auth, ecriture, c.uploadUrls);
router.post('/uploads/:id/complete', auth, ecriture, c.completeUpload);
router.delete('/uploads/:id', auth, ecriture, c.cancelUpload);

/**
 * @swagger
 * /api/safebox/files/{id}:
 *   patch:
 *     summary: "Renommer (`name`, même famille) et/ou déplacer (`folderId` : le dossier de sa famille, Albums ou Partager)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     summary: "Mettre à la corbeille cet exemplaire ; avec `?everywhere=1`, tous les exemplaires du même contenu (Photos et albums)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/files/{id}/download:
 *   get:
 *     summary: Clé du fichier et adresses de lecture de tous ses blocs (15 minutes)
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 */
router.patch('/files/:id', auth, ecriture, c.updateFile);
router.delete('/files/:id', auth, ecriture, c.trashFile);

/**
 * @swagger
 * /api/safebox/files/{id}/note:
 *   put:
 *     summary: "Texte du commentaire d'une photo (200 caractères au plus ; null ou vide : effacé). Privé"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/files/{id}/note/audio:
 *   post:
 *     summary: "Réserver l'audio du commentaire (5 minutes au plus) : corps { size, plainSize, durationMs }, rend l'adresse d'envoi"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     summary: "Supprimer l'audio du commentaire (le texte reste)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/files/{id}/note/audio/complete:
 *   post:
 *     summary: "Terminer l'envoi de l'audio : corps { key }, vérifié chez MEGA"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 */
router.put('/files/:id/note', auth, ecriture, c.setNoteText);
router.post('/files/:id/note/audio', auth, ecriture, c.reserveNoteAudio);
router.post('/files/:id/note/audio/complete', auth, ecriture, c.completeNoteAudio);
router.delete('/files/:id/note/audio', auth, ecriture, c.deleteNoteAudio);
router.post('/files/:id/restore', auth, ecriture, c.restoreFile);
router.get('/files/:id/download', auth, lecture, c.downloadFile);

/**
 * @swagger
 * /api/safebox/largest:
 *   get:
 *     summary: "Les plus gros fichiers du coffre (?limit=50, 200 au plus) et le poids de la corbeille — écran « Libérer de l'espace »"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ trashBytes, files: [{ …, folderName }] }"
 */
router.get('/largest', auth, lecture, c.largestFiles);

/**
 * @swagger
 * /api/safebox/shares:
 *   post:
 *     summary: "Partager dans une discussion dont je suis membre — { conversationId, fileId | fileIds + title | folderId }"
 *     description: >
 *       Un fichier fait un partage simple ; plusieurs fichiers (500 au plus) ou un album font un lot, une
 *       seule carte. Rend `{ shareId, kind, name, family, plainBytes, count, families, meta, cover }` ;
 *       `cover` : mes fichiers des quatre premiers éléments. Le message de type 11 ne porte ensuite que
 *       `{ v: 1, share: shareId }` et les mini-images ; le serveur en réécrit le contenu
 *       (utils/safeboxShareMessage.js).
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       400:
 *         description: SAFEBOX_SHARE_TOO_MANY (max joint), SAFEBOX_SHARE_INVALID
 * /api/safebox/shares/received:
 *   get:
 *     summary: "Onglet Reçus — ce qu'on m'a envoyé par le coffre, du plus récent au plus ancien (?cursor=)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/shares/{id}:
 *   get:
 *     summary: "La carte du message : disponible ou retiré, expéditeur, aperçu, clé, téléchargements restants ; mosaïque d'un lot ; suivi pour l'expéditeur"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       404:
 *         description: SAFEBOX_NOT_FOUND — partage inconnu, ou plus membre de la discussion
 * /api/safebox/shares/{id}/items:
 *   get:
 *     summary: "Les éléments d'un lot avec aperçu et clé, par pages de 100 (?cursor=) ; un partage simple rend son fichier (élément 0)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/shares/{id}/download:
 *   get:
 *     summary: "Clé et adresses de tous les blocs (15 minutes), de l'élément ?item= pour un lot — 3 téléchargements par destinataire et par 24 h, un lot compté une fois par 2 h"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       400:
 *         description: SAFEBOX_SHARE_ITEM_REQUIRED — un lot se télécharge élément par élément
 *       410:
 *         description: SAFEBOX_SHARE_REVOKED — l'expéditeur a supprimé le fichier ou retiré le partage
 *       429:
 *         description: SAFEBOX_DOWNLOAD_LIMIT (limit joint)
 * /api/safebox/shares/{id}/save:
 *   post:
 *     summary: "Garder dans mon coffre — { itemId?, folderId? } ; un lot entier devient un album ; aucune copie chez MEGA, compté dans mon espace"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/shares/{id}/recipients:
 *   get:
 *     summary: "Le suivi, pour l'expéditeur : chaque membre (gardé, téléchargé, pas encore)"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/shares/{id}/revoke:
 *   post:
 *     summary: "Retirer le partage (expéditeur) : la carte dit « retiré par l'expéditeur », le fichier reste dans son coffre"
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 */
router.post('/shares', auth, ecriture, c.createShare);
// Avant /shares/:id, que « received » ne prenne pas la place d'un numéro.
router.get('/shares/received', auth, lecture, c.receivedShares);
router.get('/shares/:id', auth, lecture, c.shareInfo);
router.get('/shares/:id/items', auth, lecture, c.shareItems);
router.get('/shares/:id/download', auth, lecture, c.shareDownload);
router.post('/shares/:id/save', auth, ecriture, c.saveShare);
router.get('/shares/:id/recipients', auth, lecture, c.shareRecipients);
router.post('/shares/:id/revoke', auth, ecriture, c.revokeShare);

/**
 * @swagger
 * /api/safebox/trash:
 *   get:
 *     summary: Contenu de la corbeille, avec la date à laquelle chaque élément partira
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     summary: Vider la corbeille — supprimé tout de suite chez MEGA
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 */
router.get('/trash', auth, lecture, c.listTrash);
router.delete('/trash', auth, ecriture, c.emptyTrash);
router.delete('/trash/files/:id', auth, ecriture, c.deleteTrashedFile);
router.delete('/trash/folders/:id', auth, ecriture, c.deleteTrashedFolder);

module.exports = router;
