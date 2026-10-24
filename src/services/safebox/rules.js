/**
 * Règles du coffre-fort sans base ni réseau : noms, extensions, familles,
 * tailles, blocs, ascendance des dossiers. Tout ce qui se décide ici se teste
 * dans `rules.test.js` sans rien installer.
 */

const {
  FAMILIES,
  OPEN_ROOTS,
  DEFAULT_EXTENSIONS,
  BLOCK_BYTES,
  MAX_PREVIEW_BYTES,
  CIPHER_OVERHEAD_RATIO,
  CIPHER_OVERHEAD_FLOOR,
  NOTE_TEXT_MAX,
  NOTE_AUDIO_MAX_MS,
  NOTE_AUDIO_MAX_BYTES,
} = require('../../constants/safebox');
const { SafeboxError } = require('./errors');

// Caractères de contrôle (dont le retour à la ligne) et séparateurs de chemin.
const INTERDITS = /[\u0000-\u001f\u007f/\\]/;

/**
 * Nom de dossier ou de fichier, nettoyé : espaces de bord retirés, forme
 * Unicode normalisée (un « é » tapé sur deux téléphones donne le même nom).
 */
function normalizeName(raw, max) {
  const nom = typeof raw === 'string' ? raw.normalize('NFC').trim() : '';
  if (!nom || nom === '.' || nom === '..' || INTERDITS.test(nom)) {
    throw new SafeboxError('SAFEBOX_INVALID_NAME', 400, 'Nom invalide');
  }
  if ([...nom].length > max) {
    throw new SafeboxError('SAFEBOX_INVALID_NAME', 400, `Nom trop long (${max} caractères au plus)`, { max });
  }
  return nom;
}

/**
 * Extension en minuscules, sans le point ; chaîne vide s'il n'y en a pas.
 * Un fichier caché (« .profil ») n'a pas d'extension. Une « extension » de
 * plus de 10 caractères ou hors [a-z0-9] n'en est pas une.
 */
function extensionOf(nom) {
  const point = nom.lastIndexOf('.');
  if (point <= 0 || point === nom.length - 1) return '';
  const ext = nom.slice(point + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

/**
 * Listes d'extensions effectives : celles du code, remplacées famille par
 * famille par celles réglées dans l'admin (`safebox_settings.extensions`).
 * Une famille mal réglée garde la liste du code.
 */
function extensionsFrom(reglage) {
  let surcharge = reglage;
  if (typeof surcharge === 'string') {
    try { surcharge = JSON.parse(surcharge); } catch { surcharge = null; }
  }
  const out = {};
  for (const famille of FAMILIES) {
    const liste = surcharge && Array.isArray(surcharge[famille]) ? surcharge[famille] : null;
    const propre = liste
      ? liste.map((e) => String(e).toLowerCase().replace(/^\./, '')).filter((e) => /^[a-z0-9]{1,10}$/.test(e))
      : null;
    out[famille] = propre && propre.length ? [...new Set(propre)] : [...DEFAULT_EXTENSIONS[famille]];
  }
  return out;
}

/** Famille d'une extension : la première liste qui la contient, sinon « documents ». */
function familyOf(ext, extensions) {
  for (const famille of ['photos', 'videos', 'audios']) {
    if (ext && extensions[famille].includes(ext)) return famille;
  }
  return 'documents';
}

/**
 * Vrai si un dossier de cette racine accepte un fichier de cette famille :
 * Albums et Partager acceptent tout, les quatre autres seulement la leur.
 */
function acceptsFamily(root, famille) {
  return OPEN_ROOTS.includes(root) || root === famille;
}

/**
 * Famille d'un nom de fichier, refusée si le dossier n'en veut pas. Sert
 * aussi à garder sa famille à un fichier renommé : `root` est alors la
 * famille actuelle du fichier.
 */
function assertFamily(root, nom, extensions) {
  const ext = extensionOf(nom);
  const famille = familyOf(ext, extensions);
  if (!acceptsFamily(root, famille)) {
    throw new SafeboxError(
      'SAFEBOX_WRONG_FAMILY',
      400,
      `Un fichier .${ext || '?'} va dans « ${famille} », pas dans « ${root} »`,
      { expectedRoot: famille },
    );
  }
  return { ext, famille };
}

const entier = (v) => (Number.isSafeInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN));

/**
 * Tailles annoncées d'un envoi.
 *
 * - `size` : octets stockés chez MEGA, chiffrés — c'est ce qui compte dans l'espace ;
 * - `plainSize` : octets en clair après compression éventuelle — c'est ce que
 *   borne la taille maximale d'un fichier ;
 * - `originalSize` : avant compression, pour afficher le gain (facultatif) ;
 * - `previewSize` : aperçu chiffré, 0 s'il n'y en a pas.
 */
function validateSizes(body, { maxFileBytes }) {
  const size = entier(body.size);
  const plainSize = entier(body.plainSize);
  const previewSize = body.previewSize == null ? 0 : entier(body.previewSize);
  const originalSize = body.originalSize == null ? null : entier(body.originalSize);
  if (!(size >= 1) || !(plainSize >= 1) || !(previewSize >= 0)
      || (originalSize !== null && !(originalSize >= 1))) {
    throw new SafeboxError('SAFEBOX_INVALID_SIZE', 400, 'Tailles manquantes ou invalides');
  }
  if (plainSize > maxFileBytes) {
    throw new SafeboxError('SAFEBOX_FILE_TOO_LARGE', 413, 'Fichier trop volumineux', { maxBytes: maxFileBytes });
  }
  const plafond = plainSize + Math.max(CIPHER_OVERHEAD_FLOOR, Math.ceil(plainSize * CIPHER_OVERHEAD_RATIO));
  if (size < plainSize || size > plafond) {
    throw new SafeboxError('SAFEBOX_INVALID_SIZE', 400, 'Taille chiffrée incohérente avec la taille en clair');
  }
  if (previewSize > MAX_PREVIEW_BYTES) {
    throw new SafeboxError('SAFEBOX_INVALID_SIZE', 400, 'Aperçu trop lourd', { maxPreviewBytes: MAX_PREVIEW_BYTES });
  }
  return { size, plainSize, previewSize, originalSize };
}

/** Format de chiffrement annoncé par l'application (ex. « E2C1 »). */
function validateCipherFormat(raw) {
  const f = typeof raw === 'string' ? raw.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(f)) {
    throw new SafeboxError('SAFEBOX_INVALID_CIPHER', 400, 'Format de chiffrement manquant ou invalide');
  }
  return f;
}

/** Nombre de blocs d'un fichier de `size` octets. */
function blockCount(size, blockSize = BLOCK_BYTES) {
  return Math.max(1, Math.ceil(size / blockSize));
}

/** Taille exacte du bloc `n` (numéroté à partir de 1). */
function blockSizeOf(n, { size, blockSize, count }) {
  if (n < 1 || n > count) throw new RangeError(`bloc ${n} hors de 1..${count}`);
  return n < count ? blockSize : size - (count - 1) * blockSize;
}

/** Nom d'un bloc chez MEGA : `<préfixe>00001`, `<préfixe>00002`… */
function blockKey(prefix, n) {
  return `${prefix}${String(n).padStart(5, '0')}`;
}

function previewKey(prefix) {
  return `${prefix}apercu`;
}

/** Numéro de bloc d'un nom d'objet, ou null s'il n'en est pas un. */
function blockNumberOf(prefix, key) {
  if (!key.startsWith(prefix)) return null;
  const reste = key.slice(prefix.length);
  return /^\d{5}$/.test(reste) ? Number(reste) : null;
}

/**
 * Compare ce qui est chez MEGA à ce qui est attendu. Un bloc d'une autre taille
 * que la sienne compte comme manquant : il sera renvoyé et remplacé.
 */
function compareBlocks(objets, { prefix, size, blockSize, count, previewSize }) {
  const recus = new Set();
  let apercu = false;
  for (const o of objets) {
    const n = blockNumberOf(prefix, o.key);
    if (n !== null && n >= 1 && n <= count && o.size === blockSizeOf(n, { size, blockSize, count })) {
      recus.add(n);
    } else if (o.key === previewKey(prefix) && o.size === previewSize) {
      apercu = true;
    }
  }
  const manquants = [];
  for (let n = 1; n <= count; n += 1) if (!recus.has(n)) manquants.push(n);
  return {
    recus: [...recus].sort((a, b) => a - b),
    manquants,
    apercuManquant: previewSize > 0 && !apercu,
  };
}

/** Ascendance d'un dossier : `/<id racine>/…/<id>/`. */
function childPath(parentPath, id) {
  return `${parentPath}${id}/`;
}

/** Vrai si `path` est `ancetre` lui-même ou l'un de ses descendants. */
function isWithin(path, ancetre) {
  return path.startsWith(ancetre);
}

/**
 * Nom libre parmi des frères : « Mariage », puis « Mariage (2) »… L'extension
 * d'un fichier reste à la fin : « photo (2).jpg ».
 */
function freeName(nom, pris, max) {
  const prisMin = new Set([...pris].map((p) => p.toLowerCase()));
  if (!prisMin.has(nom.toLowerCase())) return nom;
  const ext = extensionOf(nom);
  const base = ext ? nom.slice(0, -(ext.length + 1)) : nom;
  for (let i = 2; i < 1000; i += 1) {
    const suffixe = ` (${i})${ext ? `.${ext}` : ''}`;
    const candidat = `${[...base].slice(0, max - [...suffixe].length).join('')}${suffixe}`;
    if (!prisMin.has(candidat.toLowerCase())) return candidat;
  }
  throw new SafeboxError('SAFEBOX_NAME_TAKEN', 409, 'Nom déjà pris');
}

/** Identifiant positif tiré d'un paramètre d'URL ou d'un corps, sinon null. */
function parseId(raw) {
  const n = entier(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Clé d'un fichier envoyée par l'application : 32 octets en base64. */
function decodeFileKey(raw) {
  const key = typeof raw === 'string' && /^[A-Za-z0-9+/=_-]+$/.test(raw)
    ? Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    : null;
  if (!key || key.length !== 32) {
    throw new SafeboxError('SAFEBOX_INVALID_KEY', 400, 'Clé du fichier manquante ou invalide');
  }
  return key;
}

/**
 * Ce que la carte d'un fichier partagé affiche en plus de l'image (durée,
 * définition, pages, titre, artiste), relevé par le téléphone au dépôt. Tout
 * champ inattendu ou hors bornes est ignoré : ces informations décorent, elles
 * ne décident de rien.
 * @returns {object|null}
 */
function normalizeMeta(raw) {
  let src = raw;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { return null; }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const entier = (v, max) => (Number.isSafeInteger(v) && v > 0 && v <= max ? v : undefined);
  const texte = (v) => (typeof v === 'string'
    // eslint-disable-next-line no-control-regex
    ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || undefined
    : undefined);
  const out = {};
  const duree = entier(src.durationMs, 7 * 86_400_000);
  if (duree) out.durationMs = duree;
  const largeur = entier(src.width, 20_000);
  const hauteur = entier(src.height, 20_000);
  if (largeur && hauteur) {
    out.width = largeur;
    out.height = hauteur;
  }
  const pages = entier(src.pages, 100_000);
  if (pages) out.pages = pages;
  for (const k of ['title', 'artist']) {
    const t = texte(src[k]);
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Texte du commentaire d'une photo : null pour l'effacer, sinon 200
 * caractères au plus (comptés comme l'inscrit les voit, émojis compris).
 * Les sauts de ligne sont gardés, les autres caractères de contrôle retirés.
 */
function normalizeNoteText(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new SafeboxError('SAFEBOX_INVALID_NOTE', 400, 'Commentaire invalide');
  // eslint-disable-next-line no-control-regex
  const propre = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim();
  if (!propre) return null;
  if ([...propre].length > NOTE_TEXT_MAX) {
    throw new SafeboxError('SAFEBOX_NOTE_TOO_LONG', 400, `Commentaire de ${NOTE_TEXT_MAX} caractères au plus`, {
      maxChars: NOTE_TEXT_MAX,
    });
  }
  return propre;
}

/** Audio du commentaire d'une photo : 5 minutes au plus, tailles cohérentes. */
function validateNoteAudio(body) {
  const size = entier(body?.size);
  const plainSize = entier(body?.plainSize);
  const durationMs = entier(body?.durationMs);
  if (!(size >= 1) || !(plainSize >= 1) || !(durationMs >= 1)) {
    throw new SafeboxError('SAFEBOX_INVALID_SIZE', 400, 'Tailles ou durée manquantes');
  }
  if (durationMs > NOTE_AUDIO_MAX_MS + 1000 || plainSize > NOTE_AUDIO_MAX_BYTES) {
    throw new SafeboxError('SAFEBOX_NOTE_TOO_LONG', 400, 'Commentaire audio de 5 minutes au plus', {
      maxDurationMs: NOTE_AUDIO_MAX_MS,
    });
  }
  const plafond = plainSize + Math.max(CIPHER_OVERHEAD_FLOOR, Math.ceil(plainSize * CIPHER_OVERHEAD_RATIO));
  if (size < plainSize || size > plafond) {
    throw new SafeboxError('SAFEBOX_INVALID_SIZE', 400, 'Taille chiffrée incohérente avec la taille en clair');
  }
  return { size, plainSize, durationMs: Math.min(durationMs, NOTE_AUDIO_MAX_MS) };
}

/** Vrai si l'espace suffit pour `ajout` octets de plus. */
function fitsQuota({ usedBytes, quotaBytes, addBytes }) {
  return usedBytes + addBytes <= quotaBytes;
}

module.exports = {
  normalizeName,
  extensionOf,
  extensionsFrom,
  familyOf,
  acceptsFamily,
  assertFamily,
  validateSizes,
  validateCipherFormat,
  blockCount,
  blockSizeOf,
  blockKey,
  previewKey,
  blockNumberOf,
  compareBlocks,
  childPath,
  isWithin,
  freeName,
  parseId,
  decodeFileKey,
  fitsQuota,
  normalizeMeta,
  normalizeNoteText,
  validateNoteAudio,
};
