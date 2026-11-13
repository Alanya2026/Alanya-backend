// Téléchargement de l'application de bureau du coffre-fort, à la racine du
// domaine, hors /api : alanya237.com/coffre (voir desktopDownloadController).

const express = require('express');
const router = express.Router();
const { showDesktopPage, showVersion, sendFile } = require('../controllers/desktopDownloadController');

router.get('/coffre', showDesktopPage);
router.get('/coffre/version.json', showVersion);
router.get('/coffre/files/:nom', sendFile);

module.exports = router;
