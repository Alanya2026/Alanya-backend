// Routes PUBLIQUES du volet QR : la page d'accueil d'un code d'identité, celle
// d'un lien de partage de pack de stickers (`/s/<jeton>`) et les deux fichiers
// d'association qui permettront aux liens https d'ouvrir directement l'app.
// Servies à la racine du domaine, hors /api.

const express = require('express');
const router = express.Router();
const { showIdentityLanding, showContactLanding } = require('../controllers/qrLandingController');
const { showStickerShareLanding } = require('../controllers/stickerLandingController');

const ANDROID_PACKAGE = process.env.QR_ANDROID_PACKAGE || 'com.alanya237.alanya';
const IOS_BUNDLE_ID = process.env.QR_IOS_BUNDLE_ID || 'com.alanya237.alanya';

// Empreintes SHA-256 du certificat de signature Android, séparées par des
// virgules. Tant qu'elles ne sont pas fournies, Android ne peut pas vérifier
// l'association et le lien https ouvre le navigateur (la page propose alors le
// bouton en schéma applicatif) — c'est une dégradation, pas une panne.
const ANDROID_SHA256 = (process.env.QR_ANDROID_SHA256 || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Team ID Apple (préfixe de l'App ID). Même logique que ci-dessus.
const IOS_TEAM_ID = process.env.QR_IOS_TEAM_ID || '';

/** Code contact éphémère (comptes personnels) — cible des QR `…/q/c/<jeton>`. */
router.get('/q/c/:token', showContactLanding);

/** Code permanent (futurs comptes business) — cible des QR `…/q/u/<jeton>`. */
router.get('/q/u/:token', showIdentityLanding);

/** Lien de partage d'un pack de stickers — cible des liens `…/s/<jeton>`. */
router.get('/s/:token', showStickerShareLanding);

/** Android App Links (aucune restriction de chemin : `/s/` et `/q/` sont couverts). */
router.get('/.well-known/assetlinks.json', (_req, res) => {
  if (ANDROID_SHA256.length === 0) {
    return res.status(404).json({ error: 'Association Android non configurée', code: 'APP_LINK_NOT_CONFIGURED' });
  }
  res.json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: ANDROID_SHA256,
      },
    },
  ]);
});

/** iOS Universal Links. Doit être servi en application/json, sans extension. */
router.get('/.well-known/apple-app-site-association', (_req, res) => {
  if (!IOS_TEAM_ID) {
    return res.status(404).json({ error: 'Association iOS non configurée', code: 'APP_LINK_NOT_CONFIGURED' });
  }
  res.type('application/json').json({
    applinks: {
      apps: [],
      details: [
        {
          appID: `${IOS_TEAM_ID}.${IOS_BUNDLE_ID}`,
          paths: ['/q/u/*', '/q/c/*', '/s/*'],
        },
      ],
    },
  });
});

module.exports = router;
