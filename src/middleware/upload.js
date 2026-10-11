const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

const { LIMITES: LIMITES_STICKER, mimeAccepte: stickerMimeAccepte } = require('../utils/stickerAsset');
const { LIMITES_VIDEO: LIMITES_VIDEO_STICKER } = require('../utils/stickerVideo');
const {
  newMediaKey,
  newImageKey,
  newVoicemailGreetingKey,
  newOfficialKey,
  safeExt,
} = require('../services/mediaStorage');

/** Plafonds d'envoi, partagés avec la route de ticket (envoi direct). */
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB

const MEDIA_MAX_BYTES_PAID = 200 * 1024 * 1024; // 200 MB

const MEDIA_MAX_BYTES  = 100 * 1024 * 1024; // 100 MB — mesuré après compression côté app

const GREETING_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — dix secondes de voix
const RINGTONE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — une sonnerie, pas un album

/**
 * Dossier de transit : multer y écrit, le contrôleur dépose le fichier chez
 * Backblaze puis le supprime. Rien n'y reste.
 */
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), 'alanya-uploads');

// Créer les dossiers si nécessaire
const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

/**
 * Supprime les fichiers de transit abandonnés — un processus arrêté en plein
 * envoi ne passe jamais par le `finally` qui les efface. Appelé au démarrage ;
 * ne touche qu'aux fichiers vieux de plus d'une heure.
 */
async function cleanStaleUploadTmp({
  dir = UPLOAD_TMP_DIR,
  maxAgeMs = 60 * 60 * 1000,
  now = Date.now(),
} = {}) {
  let noms;
  try {
    noms = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let supprimes = 0;
  for (const nom of noms) {
    const chemin = path.join(dir, nom);
    try {
      const st = await fs.promises.stat(chemin);
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        await fs.promises.unlink(chemin);
        supprimes += 1;
      }
    } catch {
      // Déjà supprimé par un autre processus : le but est atteint.
    }
  }
  return supprimes;
}

/**
 * Stockage de transit commun : la clé Backblaze est décidée À L'OUVERTURE du
 * flux, par `cleDe(req, file)`, et portée par `file.storageKey` ; le fichier
 * ne fait que passer par `UPLOAD_TMP_DIR`, que le contrôleur vide après le
 * dépôt. Aucun fichier n'est plus rangé dans `uploads/`.
 *
 * Décider la clé ici, et non dans le contrôleur, ferme une fenêtre à minuit :
 * un média commencé à 23:59:59 est rangé dans la partition du jour J, et une
 * clé recalculée à 00:00:00 désignerait J+1.
 */
const stockageDeTransit = (cleDe) => multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      file.storageKey = cleDe(req, file);
      ensureDir(UPLOAD_TMP_DIR);
      return cb(null, UPLOAD_TMP_DIR);
    } catch (e) {
      return cb(e);
    }
  },
  filename: (req, file, cb) => cb(null, path.basename(file.storageKey)),
});

// Images : avatars, photos de groupe (`images/`, bucket public alanyaprofile).
const imageStorage = stockageDeTransit((req, file) => newImageKey({
  alanyaID: req.user.alanyaID,
  ext: safeExt(file.originalname),
}));

/**
 * Sous-dossier d'un média d'après son type MIME.
 * Exporté pour que le contrôleur n'en tienne pas une seconde copie.
 */
const mediaSubDir = (mimetype = '') => {
  if (mimetype.startsWith('image/')) return 'images';
  if (mimetype.startsWith('audio/')) return 'audio';
  if (mimetype.startsWith('video/')) return 'video';
  return 'files';
};

// Médias de message : images, vidéos, audio, fichiers (`media/<jour>/<type>/`,
// bucket privé alanyaprivate).
const mediaStorage = stockageDeTransit((req, file) => newMediaKey({
  kind: mediaSubDir(file.mimetype),
  alanyaID: req.user.alanyaID,
  ext: safeExt(file.originalname),
}));

// Médias officiels : diffusions, messages d'accueil (`official/<type>/…`,
// bucket public profilemedia). Jamais datés : ils n'expirent pas, et un même
// fichier est partagé par autant de messages qu'il y a de destinataires.
const officialStorage = stockageDeTransit((req, file) => newOfficialKey({
  kind: mediaSubDir(file.mimetype),
  ext: safeExt(file.originalname),
}));

// Types acceptés — exportés pour la route de ticket, qui applique les mêmes
// règles avant d'autoriser un envoi direct.
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const MEDIA_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  // Audio — inclure les variantes `x-` : le package `mime` côté Flutter
  // renvoie audio/x-wav pour .wav, audio/x-flac pour .flac, etc.
  'audio/mpeg', 'audio/mp3', 'audio/x-mpeg',
  'audio/ogg', 'audio/vorbis', 'audio/opus',
  'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave',
  'audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm',
  'audio/flac', 'audio/x-flac',
  'audio/x-ms-wma',
  'audio/aiff', 'audio/x-aiff',
  'audio/midi', 'audio/x-midi',
  'audio/x-caf', 'audio/amr',
  'video/mp4', 'video/webm', 'video/quicktime', 'video/3gpp',
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
  'application/zip',
  'application/x-7z-compressed',
  'application/vnd.rar',
  'application/x-rar-compressed',
  'application/vnd.android.package-archive',
  'text/plain',
];

// Filtres de fichiers
/**
 * Annonces de répondeur (`voicemail/`, bucket public profilemedia).
 *
 * Préfixe à part : une annonce n'est pas un message, elle ne doit pas être
 * purgée comme un média de discussion. Le suffixe aléatoire du nom fait
 * office d'empreinte : le cache de l'application indexe par nom de fichier,
 * donc réenregistrer DOIT produire un autre nom.
 */
const greetingStorage = stockageDeTransit((req, file) => newVoicemailGreetingKey({
  alanyaID: req.user.alanyaID,
  ext: safeExt(file.originalname) || '.m4a',
}));

const imageFilter = (req, file, cb) => {
  if (IMAGE_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
  cb(new Error('Seuls les formats d\'image suivants sont autorisés (jpeg, png, webp, gif)'), false);
};

const mediaFilter = (req, file, cb) => {
  if (MEDIA_MIME_TYPES.includes(file.mimetype)) return cb(null, true);
  cb(new Error(`Type de fichier ${file.mimetype} non autorisé`), false);
};

/**
 * Sticker : PNG ou WebP seulement, en MÉMOIRE (≤ 1 Mo) — le pipeline
 * `utils/stickerAsset` décode puis ré-encode, et rien du fichier d'origine
 * n'est conservé. Ce filtre n'est qu'un premier tri sur le type déclaré ; le
 * format réel est contrôlé sur les octets. Surtout pas `uploadOfficial` : son
 * filtre accepte zip, apk et documents, avec le plafond des médias.
 */
const stickerFilter = (req, file, cb) => {
  if (stickerMimeAccepte(file.mimetype)) return cb(null, true);
  cb(new Error('Seuls les formats PNG et WebP sont autorisés pour un sticker'), false);
};

// Multer middleware
const uploadAvatar = multer({
  storage: imageStorage,
  limits:  { fileSize: AVATAR_MAX_BYTES },
  fileFilter: imageFilter,
});

const uploadMedia = multer({
  storage: mediaStorage,
  limits:  { fileSize: MEDIA_MAX_BYTES_PAID },
  fileFilter: mediaFilter,
});

/** Médias officiels : mêmes types et même plafond qu'un média de discussion. */
const uploadOfficial = multer({
  storage: officialStorage,
  limits:  { fileSize: MEDIA_MAX_BYTES },
  fileFilter: mediaFilter,
});

/**
 * Types d'une sonnerie importée : l'audio des médias, plus `video/mp4` que
 * certains `.m4a` annoncent.
 */
const RINGTONE_MIME_TYPES = [
  ...MEDIA_MIME_TYPES.filter((t) => t.startsWith('audio/')),
  'video/mp4',
];

/**
 * Annonce de répondeur : dix secondes de voix, deux mégaoctets de plafond.
 *
 * Le plafond est volontairement écrasant pour la durée visée — dix secondes en
 * mono à débit réduit pèsent une quarantaine de kilooctets. Il n'est là que
 * pour refuser un envoi manifestement absurde, pas pour arbitrer la qualité.
 */
const uploadVoicemailGreeting = multer({
  storage: greetingStorage,
  limits:  { fileSize: GREETING_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (String(file.mimetype || '').startsWith('audio/')
      || file.mimetype === 'video/mp4' /* certains .m4a se déclarent ainsi */) {
      return cb(null, true);
    }
    cb(new Error('L\'annonce doit être un fichier audio'), false);
  },
});

// Middleware de gestion des erreurs Multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Fichier trop volumineux', code: 'FILE_TOO_LARGE' });
    }
    // Les messages de Multer sont en anglais et parlent de champs de formulaire
    // (« Unexpected field ») : ils n'apprennent rien à l'utilisateur.
    console.error('[Upload] MulterError:', err.code, err.message);
    return res.status(400).json({ error: 'Envoi refusé', code: 'UPLOAD_REJECTED' });
  }
  if (err) {
    // Seul `mediaFilter` / `avatarFilter` lève ici, et toujours pour un type de
    // fichier refusé : la prose reste, le code la rend traduisible.
    return res.status(400).json({ error: err.message, code: 'INVALID_EXTENSION' });
  }
  next();
};

/**
 * Sticker ANIMÉ créé par un utilisateur (V1c, contrat §4c) : GIF ou WebP animé,
 * en MÉMOIRE, ≤ 3 Mo, UN seul fichier (champ `file`). Le type déclaré n'est qu'un
 * premier tri : le format réel est lu dans les octets par `utils/stickerAnime`
 * (GIF87a/GIF89a, RIFF…WEBP) avant tout appel à `sharp`. Les champs texte
 * (`shape`, `packId`, `emoji`, `nom`) sont bornés : quelques octets chacun.
 */
const MIME_ANIME_ACCEPTES = Object.freeze([
  'image/gif', 'image/webp',
  // Vidéo (V1c, contrat §4d). Le type déclaré n'est qu'un premier tri : un client
  // peut le mentir, d'où la lecture des octets magiques (ftyp, EBML) par le service.
  'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'video/3gpp',
]);
const stickerAnimeFilter = (req, file, cb) => {
  if (MIME_ANIME_ACCEPTES.includes(String(file.mimetype || '').toLowerCase())) return cb(null, true);
  cb(new Error('Seuls les formats GIF, WebP animé et vidéo (MP4, MOV, WebM) sont autorisés'), false);
};
const uploadStickerAnime = multer({
  storage: multer.memoryStorage(),
  // 20 Mo pour une vidéo. Un GIF / WebP animé reste limité à 3 Mo : le contrôle est
  // refait sur le format RÉEL par `stickerAnime.convertirAnime` (422 « trop lourd »).
  limits: {
    // +1 : multer refuse un fichier qui ATTEINT la limite, pas seulement qui la dépasse ;
    // sans cet octet, une vidéo de exactement 20 Mo serait rejetée alors qu'elle est permise.
    fileSize: LIMITES_VIDEO_STICKER.ENTREE_MAX_OCTETS + 1, files: 1, fields: 8, fieldSize: 1024, parts: 12,
  },
  fileFilter: stickerAnimeFilter,
});

/** Un sticker par envoi, champ `file` ; plusieurs, champ `files` (admin). */
const uploadSticker = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITES_STICKER.ENTREE_MAX_OCTETS, files: 40 },
  fileFilter: stickerFilter,
});

module.exports = {
  uploadSticker,
  uploadStickerAnime,
  uploadAvatar,
  uploadMedia,
  uploadVoicemailGreeting,
  uploadOfficial,
  handleMulterError,
  mediaSubDir,
  IMAGE_MIME_TYPES,
  MEDIA_MIME_TYPES,
  AVATAR_MAX_BYTES,
  MEDIA_MAX_BYTES,
  GREETING_MAX_BYTES,
  RINGTONE_MIME_TYPES,
  RINGTONE_MAX_BYTES,
  UPLOAD_TMP_DIR,
  cleanStaleUploadTmp,
};
