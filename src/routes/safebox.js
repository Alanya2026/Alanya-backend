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
 *     summary: Ouvre le coffre (création des quatre dossiers racines à la première visite) — espace, racines, limites
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
 *     summary: Créer un sous-dossier — `{ parentId, name }`
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Le dossier créé
 *       409:
 *         description: SAFEBOX_NAME_TAKEN, SAFEBOX_TOO_DEEP ou SAFEBOX_FOLDER_LIMIT
 */
router.get('/folders/:id', auth, lecture, c.listFolder);
router.post('/folders', auth, ecriture, c.createFolder);
router.patch('/folders/:id', auth, ecriture, c.updateFolder);
router.delete('/folders/:id', auth, ecriture, c.trashFolder);
router.post('/folders/:id/restore', auth, ecriture, c.restoreFolder);

/**
 * @swagger
 * /api/safebox/uploads:
 *   post:
 *     summary: Réserver l'espace d'un fichier et obtenir les adresses d'envoi de ses blocs
 *     description: >
 *       Corps : `{ folderId, name, mime, size, plainSize, originalSize?, compressed?, previewSize?, cipherFormat }`.
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
 *     summary: Adresses d'envoi de blocs choisis — `{ blocks: [n…], preview? }`, 64 au plus
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 * /api/safebox/uploads/{id}/complete:
 *   post:
 *     summary: Terminer l'envoi — `{ key }`, la clé du fichier en base64 (32 octets)
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
 *     summary: Renommer (`name`, même famille) et/ou déplacer (`folderId`, même famille) un fichier
 *     tags: [Safebox]
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     summary: Mettre un fichier à la corbeille
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
router.post('/files/:id/restore', auth, ecriture, c.restoreFile);
router.get('/files/:id/download', auth, lecture, c.downloadFile);

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
