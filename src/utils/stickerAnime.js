/**
 * Stickers ANIMÉS (V1c, contrat §4c) — conversion côté serveur, avec `sharp`
 * seul (spike T5.0, DECISIONS A15/A16).
 *
 * Deux entrées, une même sortie (WebP animé 512×512, boucle infinie, métadonnées
 * retirées, vignette 96×96 statique de la première image) :
 *
 *   - `convertirAnime`      : création par l'UTILISATEUR. Reçoit un GIF ou un
 *                             WebP animé quelconque, le recadre en `cover`
 *                             512×512, applique une forme par image, tronque à
 *                             3 s / 45 images, encode ≤ 300 Ko par boucle de
 *                             qualité 70 → 20.
 *   - `reencoderAnimeWebp`  : dépôt ADMIN d'un WebP animé « final » (512×512,
 *                             ≤ 45 images, ≤ 3 s). Rien n'est tronqué ni recadré :
 *                             le fichier est refusé s'il sort des limites, puis
 *                             ré-encodé (métadonnées retirées).
 *
 * ── Ce que `sharp` 0.33.5 sait et ne sait pas (mesuré, ticket T5.0) ──
 *
 *   - `pages: -1` + `animated: true` : toutes les images, empilées en une image
 *     haute (largeur × hauteur·n). Un nombre supérieur au réel fait échouer.
 *   - Le masque de forme se pose PAR IMAGE : un SVG haut (une forme par image,
 *     hauteur 512·n) en `composite` `dest-in`. `tile: true` ne marche pas.
 *   - Il ne sait PAS assembler une animation depuis des images brutes
 *     (`raw.pageHeight` absent) : on transforme donc l'animation d'origine, et la
 *     boucle de qualité REJOUE tout le traitement à chaque essai.
 *
 * ── Garde-fous (rien de ce qui suit ne dépend du client) ──
 *
 *   - le format se lit dans les OCTETS (GIF87a/GIF89a, RIFF…WEBP) avant tout appel
 *     à `sharp` : APNG, AVIF, SVG, TIFF, JPEG, PNG… sont refusés sans être décodés ;
 *   - `limitInputPixels` borne UNE image (4096², comme le spike) ; ≤ 300 images ;
 *     largeur × hauteur × min(images, 45) ≤ `PIXELS_MAX` (voir plus bas) ;
 *   - un seul encodage à la fois par processus (`stickerSemaphore`), échéance de
 *     conversion, jamais de message de libvips dans la réponse ;
 *   - aucune clé ni chemin ne vient d'ici : le stockage est décidé par le service.
 *
 * Ce module ne touche ni la base ni le stockage : testable sans MySQL ni Redis.
 */

const crypto = require('crypto');
const sharp = require('sharp');
const stickerAsset = require('./stickerAsset');
const { creerSemaphore } = require('./stickerSemaphore');

const KO = 1024;

const LIMITES_ANIME = Object.freeze({
  /** Fichier source d'un utilisateur (GIF ou WebP animé). */
  ENTREE_MAX_OCTETS: 3 * 1024 * KO,
  /** Côté de la sortie, en pixels (1:1). */
  COTE: 512,
  /** Côté de la vignette statique. */
  VIGNETTE: 96,
  /** Budget du WebP animé en sortie. */
  SORTIE_MAX_OCTETS: 300 * KO,
  /** Images conservées au plus, durée conservée au plus. */
  IMAGES_MAX: 45,
  DUREE_MAX_MS: 3000,
  /** Un GIF peut déclarer 0 ou 10 ms : on ne descend jamais sous 20 ms. */
  DELAI_MIN_MS: 20,
  /** Bombe de pages : au-delà, refus avant tout décodage. */
  PAGES_MAX: 300,
  /** Plafond d'UNE image source (4096², la valeur éprouvée par le spike). */
  PIXELS_IMAGE_MAX: 4096 * 4096,
  /**
   * Borne de la pile : largeur × hauteur × min(images, 45).
   *
   * Pourquoi 50 Mpx. libvips décode les images à la demande, et la mémoire
   * mesurée reste plate (≈ 130 Mo de RSS de pointe de 20 à 80 Mpx), mais le
   * TEMPS de décodage, lui, croît avec les pixels et il est REJOUÉ à chaque essai
   * de qualité (pas de `raw.pageHeight` en 0.33.5) : mesuré sur 4 cœurs, ≈ 3,9 s
   * de traitement à 60 Mpx pour un contenu uni, bien plus sur un contenu dense.
   * 50 Mpx laisse passer un GIF carré de 1 050 px sur 45 images (la grande
   * majorité des GIF de galerie) et garde le pire cas sous l'échéance
   * `CONVERSION_MAX_MS`.
   */
  PIXELS_MAX: 50_000_000,
  /** Essais de qualité, dans l'ordre : on s'arrête au premier qui tient. */
  QUALITES: Object.freeze([70, 60, 50, 40, 30, 20]),
  /** Dépôt admin (fichier déjà « final », on ne le dégrade qu'au besoin). */
  QUALITES_ADMIN: Object.freeze([90, 80, 70, 60, 50, 40, 30, 20]),
  /**
   * Abandon anticipé : si le PREMIER essai (q = 70) dépasse deux fois le budget,
   * les suivants ne le feront pas tenir (rapport q70/q20 mesuré : 1,57 sur un
   * contenu simple, 1,65 sur du bruit pur) : on refuse sans brûler cinq essais.
   */
  FACTEUR_ABANDON: 2,
  /** Échéance de l'ensemble de la conversion (vérifiée entre deux essais). */
  CONVERSION_MAX_MS: 30_000,
  /** File d'attente du sémaphore : courte, puis 503 retryable. */
  FILE_MAX: 3,
  ATTENTE_MAX_MS: 8000,
  /** Limite par compte (middleware/rateLimiter). */
  CREATIONS_PAR_HEURE: 10,
});

const FORMES = Object.freeze(['cercle', 'carre-arrondi', 'carre']);
const FORME_DEFAUT = 'carre-arrondi';
/** Rayon du carré arrondi, en pixels de la sortie 512×512. */
const RAYON_CARRE_ARRONDI = 96;

/** Un seul encodage animé à la fois par processus (partagé admin + utilisateurs). */
const semaphoreAnime = creerSemaphore({
  max: 1,
  fileMax: LIMITES_ANIME.FILE_MAX,
  attenteMs: LIMITES_ANIME.ATTENTE_MAX_MS,
});

const invalide = (message) => new stickerAsset.StickerAssetError('STICKER_ASSET_INVALID', message, 422);

/** Format RÉEL d'après les octets magiques : `'gif'`, `'webp'` ou `null`. */
function typeParOctets(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const tete = buffer.toString('latin1', 0, 6);
  if (tete === 'GIF87a' || tete === 'GIF89a') return 'gif';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** WebP dont l'en-tête VP8X annonce une animation (bit 1 des drapeaux). */
function estWebpAnime(buffer) {
  return typeParOctets(buffer) === 'webp'
    && buffer.length >= 21
    && buffer.toString('latin1', 12, 16) === 'VP8X'
    && (buffer[20] & 0x02) !== 0;
}

const bornerDelai = (d) => {
  const n = Number(d);
  const ms = Number.isFinite(n) ? Math.round(n) : 100;
  return Math.min(LIMITES_ANIME.DUREE_MAX_MS, Math.max(LIMITES_ANIME.DELAI_MIN_MS, ms));
};

/**
 * Troncature : garde les premières images tant qu'on reste dans 45 images et
 * 3 000 ms CUMULÉES (`metadata.delay`, plancher 20 ms). L'image qui ferait
 * dépasser n'est pas coupée en deux : elle est abandonnée.
 *
 * @param {number[]} delais  délais source, un par image (peut être plus court)
 * @param {number}   pages   nombre d'images de la source
 * @returns {{delais: number[], dureeMs: number}}
 */
function tronquer(delais, pages) {
  const gardes = [];
  let total = 0;
  for (let i = 0; i < pages && gardes.length < LIMITES_ANIME.IMAGES_MAX; i += 1) {
    const d = bornerDelai(Array.isArray(delais) ? delais[i] ?? 100 : 100);
    if (total + d > LIMITES_ANIME.DUREE_MAX_MS) break;
    gardes.push(d);
    total += d;
  }
  return { delais: gardes, dureeMs: total };
}

/**
 * Masque de forme : UNE forme par image, empilées sur la hauteur (512·n). Le SVG
 * est entièrement fabriqué ici, jamais avec une donnée du client.
 */
function masqueSvg(forme, n) {
  const c = LIMITES_ANIME.COTE;
  const formes = [];
  for (let i = 0; i < n; i += 1) {
    formes.push(forme === 'cercle'
      ? `<circle cx="${c / 2}" cy="${i * c + c / 2}" r="${c / 2}"/>`
      : `<rect y="${i * c}" width="${c}" height="${c}" rx="${RAYON_CARRE_ARRONDI}"/>`);
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${c}" height="${c * n}">${formes.join('')}</svg>`,
  );
}

/** Lecture des dimensions, du nombre d'images et des délais (sans décoder). */
async function lireMeta(buffer, limitePixels) {
  try {
    // Sans `animated` : dimensions d'UNE image, `pages` = total, `delay` = un
    // délai par image. `limitInputPixels` refuse une image géante dès l'en-tête.
    return await sharp(buffer, { limitInputPixels: limitePixels }).metadata();
  } catch (_) {
    throw invalide('image illisible ou trop grande');
  }
}

/** Vérifie la sortie (pages, dimensions) et fabrique la vignette. */
async function finaliser(webp, { images, dureeMs, qualite }) {
  let meta;
  let thumb;
  try {
    meta = await sharp(webp, { animated: true, pages: -1, limitInputPixels: false }).metadata();
    thumb = await sharp(webp, { page: 0 })
      .resize(LIMITES_ANIME.VIGNETTE, LIMITES_ANIME.VIGNETTE, { fit: 'fill' })
      .webp({ quality: 75, alphaQuality: 90, effort: 4 })
      .toBuffer();
  } catch (_) {
    throw invalide('image illisible');
  }
  if (meta.format !== 'webp' || meta.width !== LIMITES_ANIME.COTE
    || meta.pageHeight !== LIMITES_ANIME.COTE || meta.pages !== images) {
    throw invalide('conversion inattendue');
  }
  return {
    webp,
    thumb,
    sha256: crypto.createHash('sha256').update(webp).digest('hex'),
    width: LIMITES_ANIME.COTE,
    height: LIMITES_ANIME.COTE,
    bytes: webp.length,
    animated: true,
    qualite,
    frames: images,
    durationMs: dureeMs,
  };
}

/**
 * Un essai d'encodage : décode les `pages` premières images, recadre, pose la
 * forme, encode en WebP animé (boucle infinie, délais explicites).
 */
function encoderEssai(buffer, {
  pages, largeur, hauteur, forme, delais, qualite,
}) {
  let image = sharp(buffer, {
    animated: true,
    pages,
    limitInputPixels: largeur * hauteur * pages + 1,
  })
    .resize(LIMITES_ANIME.COTE, LIMITES_ANIME.COTE, { fit: 'cover' })
    .ensureAlpha();
  if (forme !== 'carre') {
    image = image.composite([{
      input: masqueSvg(forme, pages), blend: 'dest-in', top: 0, left: 0,
    }]);
  }
  // Pas de `.withMetadata()` : EXIF, XMP et ICC ne sont pas recopiés.
  return image.webp({
    quality: qualite, alphaQuality: 100, effort: 3, loop: 0, delay: delais,
  }).toBuffer();
}

/**
 * Création utilisateur : GIF ou WebP animé → WebP animé 512×512 en forme.
 *
 * @param {Buffer} buffer
 * @param {object} [o]
 * @param {string} [o.forme='carre-arrondi']  cercle | carre-arrondi | carre
 * @param {number} [o.budgetOctets]           défaut 300 Ko (tests)
 * @param {number} [o.conversionMaxMs]        défaut 30 s (tests)
 * @param {object} [deps]                     `semaphore` (tests)
 * @throws {StickerAssetError} STICKER_ASSET_INVALID (422) ;
 *         {SlotOccupe} 503 SERVICE_UNAVAILABLE (file pleine ou délai dépassé)
 */
async function convertirAnime(buffer, {
  forme = FORME_DEFAUT,
  budgetOctets = LIMITES_ANIME.SORTIE_MAX_OCTETS,
  conversionMaxMs = LIMITES_ANIME.CONVERSION_MAX_MS,
  // 3 Mo pour un fichier venu d'un utilisateur. Seule la conversion d'une VIDÉO
  // (`stickerVideo`) relève ce plafond : son WebP intermédiaire sort de ffmpeg,
  // pas du client, et fait quelques Mo à haute qualité.
  entreeMaxOctets = LIMITES_ANIME.ENTREE_MAX_OCTETS,
} = {}, deps = {}) {
  if (!FORMES.includes(forme)) throw invalide('forme inconnue');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalide('fichier vide');
  if (buffer.length > entreeMaxOctets) {
    throw invalide(`fichier trop lourd (${Math.round(entreeMaxOctets / (1024 * KO))} Mo maximum)`);
  }

  const type = typeParOctets(buffer);
  if (!type) throw invalide('format refusé (GIF ou WebP animé)');
  if (type === 'webp' && !estWebpAnime(buffer)) throw invalide('image non animée');

  const meta = await lireMeta(buffer, LIMITES_ANIME.PIXELS_IMAGE_MAX);
  if (meta.format !== type) throw invalide('format refusé (GIF ou WebP animé)');
  const pages = Number(meta.pages) || 1;
  const largeur = Number(meta.width) || 0;
  const hauteur = Number(meta.height) || 0;
  if (pages < 2) throw invalide('image non animée');
  if (pages > LIMITES_ANIME.PAGES_MAX) throw invalide(`trop d'images (${LIMITES_ANIME.PAGES_MAX} maximum)`);
  if (largeur < 1 || hauteur < 1) throw invalide('dimensions illisibles');
  if (largeur * hauteur * Math.min(pages, LIMITES_ANIME.IMAGES_MAX) > LIMITES_ANIME.PIXELS_MAX) {
    throw invalide('image animée trop grande');
  }

  const { delais, dureeMs } = tronquer(meta.delay, pages);
  if (delais.length < 2) throw invalide('animation trop courte (2 images minimum dans 3 s)');
  const images = delais.length;

  const semaphore = deps.semaphore || semaphoreAnime;
  return semaphore.executer(async () => {
    const echeance = Date.now() + conversionMaxMs;
    let webp = null;
    let qualite = null;
    try {
      for (const q of LIMITES_ANIME.QUALITES) {
        if (Date.now() >= echeance) throw invalide('conversion trop longue');
        const sortie = await encoderEssai(buffer, {
          pages: images, largeur, hauteur, forme, delais, qualite: q,
        });
        if (sortie.length <= budgetOctets) {
          webp = sortie;
          qualite = q;
          break;
        }
        if (q === LIMITES_ANIME.QUALITES[0]
          && sortie.length > budgetOctets * LIMITES_ANIME.FACTEUR_ABANDON) {
          break; // même au plus bas, ça ne tiendrait pas : inutile d'insister
        }
      }
    } catch (e) {
      if (e instanceof stickerAsset.StickerAssetError) throw e;
      console.warn('[stickerAnime] conversion en échec :', String(e && e.message).slice(0, 120));
      throw invalide('image illisible');
    }
    if (!webp) throw invalide('animation trop lourde (300 Ko maximum, même à qualité minimale)');
    return finaliser(webp, { images, dureeMs, qualite });
  });
}

/**
 * Dépôt ADMIN d'un WebP animé final : mêmes limites que la sortie (512×512,
 * ≤ 45 images, ≤ 3 000 ms, alpha, ≤ 300 Ko APRÈS ré-encodage). Rien n'est
 * tronqué : un fichier hors limites est refusé, jamais corrigé en silence.
 */
async function reencoderAnimeWebp(buffer, {
  budgetOctets = LIMITES_ANIME.SORTIE_MAX_OCTETS,
  conversionMaxMs = LIMITES_ANIME.CONVERSION_MAX_MS,
} = {}, deps = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalide('fichier vide');
  if (buffer.length > stickerAsset.LIMITES.ENTREE_MAX_OCTETS) throw invalide('fichier trop lourd (1 Mo maximum)');
  if (!estWebpAnime(buffer)) throw invalide('WebP animé exigé');

  // Une image doit faire 512×512 : la même borne que le statique.
  const meta = await lireMeta(buffer, LIMITES_ANIME.COTE * LIMITES_ANIME.COTE);
  const pages = Number(meta.pages) || 1;
  if (meta.format !== 'webp' || pages < 2) throw invalide('image non animée');
  if (meta.width !== LIMITES_ANIME.COTE || meta.height !== LIMITES_ANIME.COTE) {
    throw invalide(`dimensions ${meta.width}x${meta.height} : 512x512 exigé`);
  }
  if (pages > LIMITES_ANIME.IMAGES_MAX) throw invalide(`${pages} images : ${LIMITES_ANIME.IMAGES_MAX} maximum`);
  if (!meta.hasAlpha) throw invalide('canal alpha (transparence) obligatoire');
  if (!Array.isArray(meta.delay) || meta.delay.length !== pages) throw invalide('délais illisibles');
  const delais = meta.delay.map((d) => Math.max(0, Math.round(Number(d) || 0)));
  const dureeMs = delais.reduce((a, b) => a + b, 0);
  if (dureeMs > LIMITES_ANIME.DUREE_MAX_MS) {
    throw invalide(`durée ${dureeMs} ms : ${LIMITES_ANIME.DUREE_MAX_MS} ms maximum`);
  }

  const semaphore = deps.semaphore || semaphoreAnime;
  return semaphore.executer(async () => {
    const echeance = Date.now() + conversionMaxMs;
    let webp = null;
    let qualite = null;
    try {
      for (const q of LIMITES_ANIME.QUALITES_ADMIN) {
        if (Date.now() >= echeance) throw invalide('conversion trop longue');
        const sortie = await sharp(buffer, {
          animated: true,
          pages,
          limitInputPixels: LIMITES_ANIME.COTE * LIMITES_ANIME.COTE * pages + 1,
        })
          .webp({
            quality: q, alphaQuality: 100, effort: 3, loop: 0, delay: delais,
          })
          .toBuffer();
        if (sortie.length <= budgetOctets) {
          webp = sortie;
          qualite = q;
          break;
        }
      }
    } catch (e) {
      if (e instanceof stickerAsset.StickerAssetError) throw e;
      console.warn('[stickerAnime] ré-encodage en échec :', String(e && e.message).slice(0, 120));
      throw invalide('image illisible');
    }
    if (!webp) throw invalide('animation trop lourde (300 Ko maximum, même à qualité minimale)');
    return finaliser(webp, { images: pages, dureeMs, qualite });
  });
}

/**
 * Création utilisateur, de la lecture à la liste de blocage. Même contrat que
 * `stickerAsset.preparerAsset` : `deps.estBloque(sha256)`, `deps.usage(ownerId)`.
 *
 * Les QUOTAS sont lus AVANT la conversion (une lecture SQL, contre 3 à 15 s de
 * CPU) ; la liste de blocage, elle, porte sur l'empreinte du fichier FINAL.
 */
async function preparerAssetAnime(buffer, { ownerId, forme } = {}, deps = {}) {
  if (Number(ownerId) !== 0 && deps.usage) {
    const u = await deps.usage(ownerId);
    if (u.assets >= stickerAsset.LIMITES.ASSETS_PAR_COMPTE
      || u.uploadsDerniereHeure >= stickerAsset.LIMITES.UPLOADS_PAR_HEURE) {
      throw new stickerAsset.StickerAssetError('STICKER_QUOTA_EXCEEDED', 'Quota de stickers atteint', 429);
    }
  }
  const pret = await convertirAnime(buffer, { forme }, deps);
  if (deps.estBloque && await deps.estBloque(pret.sha256)) {
    throw new stickerAsset.StickerAssetError('STICKER_ASSET_BLOCKED', 'Image bloquée', 422);
  }
  return pret;
}

module.exports = {
  LIMITES_ANIME,
  FORMES,
  FORME_DEFAUT,
  semaphoreAnime,
  invalide,
  typeParOctets,
  estWebpAnime,
  tronquer,
  masqueSvg,
  convertirAnime,
  reencoderAnimeWebp,
  preparerAssetAnime,
};
