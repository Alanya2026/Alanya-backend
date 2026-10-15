/**
 * Coffre-fort (`safebox`) — constantes et valeurs par défaut.
 *
 * Conception : docs/conception/coffre-fort.html. Les valeurs réglables par
 * l'admin vivent dans `safebox_settings` (migration 101) ; celles-ci servent
 * quand la ligne manque, et de bornes.
 */

const Kio = 1024;
const Mio = 1024 * Kio;
const Gio = 1024 * Mio;

/** Les quatre dossiers racines, dans l'ordre d'affichage. */
const ROOTS = Object.freeze(['albums', 'videos', 'audios', 'documents']);

/**
 * Extensions acceptées par famille (décision du 15/10/2026 : la famille se
 * décide par l'extension). « documents » accepte en plus toute extension
 * absente des trois premières listes, et les fichiers sans extension.
 */
const DEFAULT_EXTENSIONS = Object.freeze({
  albums: Object.freeze(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif']),
  videos: Object.freeze(['mp4', 'mov', 'm4v', 'mkv', '3gp', 'webm', 'avi']),
  audios: Object.freeze(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'amr']),
  documents: Object.freeze([
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
    'txt', 'csv', 'rtf', 'zip', 'rar', '7z', 'apk', 'tif', 'tiff', 'bmp', 'svg',
  ]),
});

/** Valeurs de la migration 101, si la ligne `safebox_settings` manque. */
const DEFAULT_SETTINGS = Object.freeze({
  base_quota_bytes: 10 * Gio,
  max_file_bytes: 1 * Gio,
  max_file_bytes_plus: 1 * Gio,
  max_depth: 5,
  max_folders: 500,
  extensions: null,
});

/**
 * Taille d'un bloc chez MEGA. Le lot 0 (15/10/2026) a écarté l'envoi en
 * morceaux de S3 : une coupure y fait parfois abandonner l'envoi entier. Un
 * fichier est donc rangé en blocs indépendants, un objet S4 chacun ; une
 * coupure ne coûte que le bloc en cours.
 */
const BLOCK_BYTES = 8 * Mio;

/** Plus gros aperçu chiffré accepté (une image d'environ 480 px). */
const MAX_PREVIEW_BYTES = 256 * Kio;

/**
 * Surcoût toléré entre la taille d'origine et la taille stockée : le
 * chiffrement par blocs ajoute 16 octets par bloc chiffré et un en-tête.
 */
const CIPHER_OVERHEAD_RATIO = 0.01;
const CIPHER_OVERHEAD_FLOOR = 64 * Kio;

/** Durée de validité des adresses signées. */
const UPLOAD_URL_TTL_S = 24 * 60 * 60;
const DOWNLOAD_URL_TTL_S = 15 * 60;
const PREVIEW_URL_TTL_S = 60 * 60;

/** Adresses d'envoi rendues en une réponse ; les suivantes se demandent. */
const BLOCK_URLS_PER_CALL = 64;

const FOLDER_NAME_MAX = 80;
const FILE_NAME_MAX = 180;
const PAGE_SIZE = 100;

module.exports = {
  Kio,
  Mio,
  Gio,
  ROOTS,
  DEFAULT_EXTENSIONS,
  DEFAULT_SETTINGS,
  BLOCK_BYTES,
  MAX_PREVIEW_BYTES,
  CIPHER_OVERHEAD_RATIO,
  CIPHER_OVERHEAD_FLOOR,
  UPLOAD_URL_TTL_S,
  DOWNLOAD_URL_TTL_S,
  PREVIEW_URL_TTL_S,
  BLOCK_URLS_PER_CALL,
  FOLDER_NAME_MAX,
  FILE_NAME_MAX,
  PAGE_SIZE,
};
