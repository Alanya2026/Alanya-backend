/**
 * Pipeline d'upload d'un sticker — identique pour l'administration, le script
 * de chargement des packs et (V1b) les utilisateurs. Plan §4.
 *
 *   1. entrée : multer dédié `uploadSticker` (mémoire, PNG/WebP, ≤ 1 Mo) ;
 *   2. décodage `sharp` : format réel, dimensions, alpha, pages ;
 *   3. ré-encodage WebP côté serveur (métadonnées retirées, qualité en
 *      boucle descendante vers ≤ 100 Ko) ;
 *   4. empreinte SHA-256 du fichier ré-encodé, liste de blocage, quotas ;
 *   5. stockage + ligne `sticker_asset` (voir services/stickerAssetService).
 *
 * Ce module ne touche ni la base ni le stockage : les étapes 1 à 4 sont des
 * fonctions pures (ou reçoivent leurs dépendances), donc testables sans
 * MySQL ni Redis. Rejet explicite avec un code, jamais de correction
 * silencieuse.
 *
 * ── Ce que le `Content-Type` ne prouve pas ──
 *
 * Le type MIME déclaré par le client n'est qu'un filtre de courtoisie (multer).
 * Ce qui décide, c'est le format que `sharp` lit dans les octets : un GIF
 * renommé en `.png` est refusé ici, quel que soit son en-tête.
 *
 * ── V1a / V1c ──
 *
 * `reencoder` (le STATIQUE) refuse toujours un fichier animé (plusieurs pages)
 * et le SVG : un SVG est un document, pas une image. L'animé (V1c) a son propre
 * module, `utils/stickerAnime` : la création utilisateur y passe directement, et
 * le dépôt ADMIN d'un WebP animé y est aiguillé par `preparerAsset` quand l'appelant
 * l'autorise (`animeAutorise`) ET que l'en-tête du fichier annonce une animation.
 * Un fichier statique suit exactement le chemin d'avant.
 */

const crypto = require('crypto');
const sharp = require('sharp');

const LIMITES = Object.freeze({
  /** Poids maximal du fichier reçu. */
  ENTREE_MAX_OCTETS: 1024 * 1024,
  /** Côté exigé, en pixels (1:1). */
  COTE: 512,
  /** Côté de la vignette. */
  VIGNETTE: 96,
  /** Budget du WebP statique en sortie. */
  SORTIE_MAX_OCTETS: 100 * 1024,
  /** Qualités essayées dans l'ordre : on s'arrête à la première qui tient. */
  QUALITES: Object.freeze([90, 80, 70, 60, 50, 40, 30]),
  /** Quotas personnels (plan §4). L'officiel (owner 0) n'en a pas. */
  ASSETS_PAR_COMPTE: 200,
  UPLOADS_PAR_HEURE: 30,
});

const FORMATS_ACCEPTES = Object.freeze(['png', 'webp']);
const MIME_ACCEPTES = Object.freeze(['image/png', 'image/webp']);

/** Erreur de pipeline : porte le code d'API et le statut HTTP du contrat. */
class StickerAssetError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'StickerAssetError';
    this.code = code;
    this.status = status;
  }
}

const invalide = (message) => new StickerAssetError('STICKER_ASSET_INVALID', message, 422);

/** Filtre multer : type déclaré PNG ou WebP. Voir middleware/upload.js. */
function mimeAccepte(mimetype) {
  return MIME_ACCEPTES.includes(String(mimetype || '').toLowerCase());
}

/**
 * Étapes 2 et 3 : contrôle réel puis ré-encodage.
 *
 * @param {Buffer} buffer  octets reçus
 * @returns {Promise<{webp: Buffer, thumb: Buffer, sha256: string,
 *   width: number, height: number, bytes: number, animated: boolean,
 *   qualite: number}>}
 */
async function reencoder(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalide('fichier vide');
  if (buffer.length > LIMITES.ENTREE_MAX_OCTETS) throw invalide('fichier trop lourd (1 Mo maximum)');

  let meta;
  try {
    // `limitInputPixels` borné au carré exigé : une « bombe » de décompression
    // est refusée avant tout décodage.
    // Sans `animated: true` : les dimensions sont celles d'UNE page, et `pages`
    // dit combien il y en a (avec `animated`, sharp empile les pages et le
    // plafond de pixels refuserait un 512x512 animé pour la mauvaise raison).
    meta = await sharp(buffer, { limitInputPixels: LIMITES.COTE * LIMITES.COTE }).metadata();
  } catch (_) {
    throw invalide('image illisible');
  }

  if (!FORMATS_ACCEPTES.includes(meta.format)) throw invalide('format refusé (PNG ou WebP)');
  if ((meta.pages || 1) > 1) throw invalide('image animée refusée');
  if (meta.width !== LIMITES.COTE || meta.height !== LIMITES.COTE) {
    throw invalide(`dimensions ${meta.width}x${meta.height} : 512x512 exigé`);
  }
  if (!meta.hasAlpha) throw invalide('canal alpha (transparence) obligatoire');

  let webp = null;
  let qualite = null;
  try {
    for (const q of LIMITES.QUALITES) {
      // Pas de `.withMetadata()` : EXIF, GPS, XMP et profil ICC ne sont pas
      // recopiés dans la sortie.
      const sortie = await sharp(buffer, { limitInputPixels: LIMITES.COTE * LIMITES.COTE })
        .webp({ quality: q, alphaQuality: 100, effort: 4 })
        .toBuffer();
      if (sortie.length <= LIMITES.SORTIE_MAX_OCTETS) {
        webp = sortie;
        qualite = q;
        break;
      }
    }
  } catch (_) {
    throw invalide('image illisible');
  }
  if (!webp) throw invalide('image trop lourde même à qualité minimale (100 Ko)');

  let thumb;
  try {
    thumb = await sharp(webp)
      .resize(LIMITES.VIGNETTE, LIMITES.VIGNETTE, { fit: 'fill' })
      .webp({ quality: 75, alphaQuality: 90, effort: 4 })
      .toBuffer();
  } catch (_) {
    throw invalide('image illisible');
  }

  return {
    webp,
    thumb,
    sha256: crypto.createHash('sha256').update(webp).digest('hex'),
    width: LIMITES.COTE,
    height: LIMITES.COTE,
    bytes: webp.length,
    animated: false,
    qualite,
  };
}

/**
 * Étapes 2 à 4 : tout ce qui précède le stockage.
 *
 * `deps` (toutes asynchrones, injectées pour les tests et par le service) :
 *   - `estBloque(sha256)`  → vrai si l'empreinte est dans `sticker_blocklist` ;
 *   - `usage(ownerId)`     → `{ assets, uploadsDerniereHeure }` du compte.
 *
 * La liste de blocage porte sur l'empreinte du fichier RÉ-ENCODÉ : la même
 * image renvoyée par un autre compte donne le même WebP, donc le même refus.
 * Les quotas ne s'appliquent pas à l'officiel (`ownerId = 0`).
 * `animeAutorise` : accepte un WebP animé (dépôt admin, V1c) ; par défaut, refusé.
 */
async function preparerAsset(buffer, { ownerId = 0, animeAutorise = false } = {}, deps = {}) {
  // Aiguillage V1c : seul un WebP dont l'en-tête annonce une animation quitte le
  // chemin statique, et seulement pour un appelant qui l'a demandé (l'admin).
  const anime = animeAutorise && require('./stickerAnime').estWebpAnime(buffer);
  const pret = anime
    ? await require('./stickerAnime').reencoderAnimeWebp(buffer)
    : await reencoder(buffer);

  if (deps.estBloque && await deps.estBloque(pret.sha256)) {
    throw new StickerAssetError('STICKER_ASSET_BLOCKED', 'Image bloquée', 422);
  }

  if (Number(ownerId) !== 0 && deps.usage) {
    const u = await deps.usage(ownerId);
    if (u.assets >= LIMITES.ASSETS_PAR_COMPTE || u.uploadsDerniereHeure >= LIMITES.UPLOADS_PAR_HEURE) {
      throw new StickerAssetError('STICKER_QUOTA_EXCEEDED', 'Quota de stickers atteint', 429);
    }
  }
  return pret;
}

module.exports = {
  LIMITES,
  FORMATS_ACCEPTES,
  MIME_ACCEPTES,
  StickerAssetError,
  mimeAccepte,
  reencoder,
  preparerAsset,
};
