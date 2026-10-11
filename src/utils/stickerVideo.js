/**
 * Sticker ANIMÉ créé depuis une VIDÉO (V1c, contrat §4d).
 *
 * Le client envoie la vidéo entière (≤ 20 Mo) avec une fenêtre `start` / `duration`
 * (≤ 3 s). Le serveur la découpe avec ffmpeg en un WebP animé INTERMÉDIAIRE
 * (512×512 `cover`, 15 images/s, sans son), puis le confie au code qui sert déjà
 * le GIF et le WebP animé (`stickerAnime.convertirAnime`) : forme par image, boucle
 * de qualité 70 → 20, budget de 300 Ko, empreinte. Une seule chaîne durcie.
 *
 * ── Ce que ce module protège ──
 *
 *   - `execFile` avec des arguments FIXES : jamais de shell, jamais un nom, un
 *     chemin ou une option venant du client ;
 *   - le format se lit dans les OCTETS (ftyp ISO BMFF, EBML Matroska/WebM) ; le
 *     démuxeur est IMPOSÉ à ffmpeg et à ffprobe (`-f`), donc ni playlist, ni concat,
 *     ni HLS, ni lecture réseau (`-protocol_whitelist file`) ;
 *   - ffprobe d'abord : un flux vidéo exigé, dimensions et durée bornées ;
 *   - dossier de travail unique, supprimé dans TOUS les cas ; nom d'entrée aléatoire
 *     sans extension ;
 *   - délai maximal par processus (tué), sortie bornée, environnement minimal (aucun
 *     secret du serveur n'est transmis à ffmpeg) ;
 *   - un seul traitement à la fois par processus : le MÊME sémaphore que la
 *     conversion GIF / WebP (ffmpeg et sharp partagent une seule section critique) ;
 *   - jamais la sortie brute de ffmpeg dans une erreur renvoyée : le journal serveur
 *     seulement.
 *
 * Disponibilité : si ffmpeg, ffprobe ou l'encodeur `libwebp_anim` manquent, la
 * fonctionnalité est simplement ABSENTE (`features.video` faux, 422 neutre si une
 * vidéo arrive quand même). Rien ne plante au démarrage.
 *
 * Aucune base, aucun stockage ici : testable sans MySQL ni Redis (les binaires sont
 * injectables).
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const stickerAsset = require('./stickerAsset');
const stickerAnime = require('./stickerAnime');

const { LIMITES_ANIME, semaphoreAnime } = stickerAnime;

const MO = 1024 * 1024;

const LIMITES_VIDEO = Object.freeze({
  /** Vidéo source d'un utilisateur. */
  ENTREE_MAX_OCTETS: 20 * MO,
  /** Fenêtre demandée : 500 ms à 3 s. */
  DUREE_MIN_MS: 500,
  DUREE_MAX_MS: LIMITES_ANIME.DUREE_MAX_MS,
  /** Début le plus tardif accepté (une heure) : borne grossière avant la sonde. */
  DEBUT_MAX_MS: 3_600_000,
  /** Durée maximale de la vidéo source, lue par ffprobe. */
  SOURCE_DUREE_MAX_S: 120,
  /** Côté maximal de la source. */
  SOURCE_COTE_MAX: 4096,
  /** Flux au plus dans le conteneur (vidéo, audio, sous-titres, données…). */
  FLUX_MAX: 8,
  FPS: 15,
  /** Qualité du WebP intermédiaire : la boucle finale reste celle de sharp. */
  QUALITE_INTERMEDIAIRE: 85,
  /** Le WebP intermédiaire ne dépasse jamais cette taille. */
  INTERMEDIAIRE_MAX_OCTETS: 16 * MO,
  FFPROBE_MAX_MS: 10_000,
  FFMPEG_MAX_MS: 25_000,
  /** Sondes : on ne lit qu'un début de fichier pour reconnaître un flux. */
  PROBESIZE: 10_000_000,
  ANALYZE_US: 5_000_000,
  THREADS: 2,
  /** Pour la disponibilité mise en cache : on retente après un échec. */
  RETENTE_MS: 60_000,
});

/** Démuxeurs imposés, d'après les octets magiques (jamais l'extension). */
const DEMUXEURS = Object.freeze({
  mp4: 'mov,mp4,m4a,3gp,3g2,mj2',
  webm: 'matroska,webm',
});

/** Marques `ftyp` d'IMAGES fixes (HEIC, AVIF…) : ce ne sont pas des vidéos. */
const MARQUES_IMAGE = Object.freeze(['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'miaf']);

const invalide = (message) => new stickerAsset.StickerAssetError('STICKER_ASSET_INVALID', message, 422);
const payloadInvalide = (message) => new stickerAsset.StickerAssetError('STICKER_INVALID_PAYLOAD', message, 400);

const binaires = () => ({
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || 'ffprobe',
});

/* ── Format ───────────────────────────────────────────────────────────── */

/**
 * Format RÉEL d'après les octets magiques : `'mp4'` (MP4, MOV, 3GP), `'webm'`
 * (WebM, Matroska) ou `null`. Une image HEIC / AVIF (conteneur `ftyp` aussi) est
 * refusée.
 */
function typeVideoParOctets(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('latin1', 4, 8) === 'ftyp') {
    const marque = buffer.toString('latin1', 8, 12).toLowerCase();
    if (MARQUES_IMAGE.includes(marque)) return null;
    return 'mp4';
  }
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  return null;
}

/* ── Fenêtre demandée ─────────────────────────────────────────────────── */

function entier(valeur, nom) {
  if (typeof valeur === 'number' && Number.isInteger(valeur)) return valeur;
  if (typeof valeur === 'string' && /^\d{1,9}$/.test(valeur)) return Number.parseInt(valeur, 10);
  throw payloadInvalide(`${nom} : entier (millisecondes) attendu`);
}

/**
 * `start` et `duration` (ms) du corps de la requête. Absents : 0 et 3 000.
 * Invalides : `400 STICKER_INVALID_PAYLOAD`, jamais corrigés en silence.
 */
function lireFenetre({ start, duration } = {}) {
  const vide = (v) => v === undefined || v === null || v === '';
  const startMs = vide(start) ? 0 : entier(start, 'start');
  const dureeMs = vide(duration) ? LIMITES_VIDEO.DUREE_MAX_MS : entier(duration, 'duration');
  if (startMs < 0 || startMs > LIMITES_VIDEO.DEBUT_MAX_MS) throw payloadInvalide('start hors bornes');
  if (dureeMs < LIMITES_VIDEO.DUREE_MIN_MS || dureeMs > LIMITES_VIDEO.DUREE_MAX_MS) {
    throw payloadInvalide(`duration : ${LIMITES_VIDEO.DUREE_MIN_MS} à ${LIMITES_VIDEO.DUREE_MAX_MS} ms`);
  }
  return { startMs, dureeMs };
}

/* ── Lignes de commande (pures, testées à l'identique) ───────────────── */

const secondes = (ms) => (ms / 1000).toFixed(3);

const FILTRE = `fps=${LIMITES_VIDEO.FPS},`
  + `scale=${LIMITES_ANIME.COTE}:${LIMITES_ANIME.COTE}:force_original_aspect_ratio=increase,`
  + `crop=${LIMITES_ANIME.COTE}:${LIMITES_ANIME.COTE},setsar=1`;

function argsFfprobe({ entree, demuxeur }) {
  return [
    '-v', 'error',
    '-protocol_whitelist', 'file',
    '-probesize', String(LIMITES_VIDEO.PROBESIZE),
    '-analyzeduration', String(LIMITES_VIDEO.ANALYZE_US),
    '-f', demuxeur,
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    entree,
  ];
}

function argsFfmpeg({
  entree, sortie, demuxeur, startMs, dureeMs,
}) {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    '-probesize', String(LIMITES_VIDEO.PROBESIZE),
    '-analyzeduration', String(LIMITES_VIDEO.ANALYZE_US),
    '-f', demuxeur,
    // `-ss` AVANT `-i` : recherche rapide ; `-t` borne ce qui est décodé.
    '-ss', secondes(startMs),
    '-t', secondes(dureeMs),
    '-i', entree,
    '-map', '0:v:0',
    '-an', '-sn', '-dn',
    '-vf', FILTRE,
    '-frames:v', String(LIMITES_ANIME.IMAGES_MAX),
    '-c:v', 'libwebp_anim',
    '-quality', String(LIMITES_VIDEO.QUALITE_INTERMEDIAIRE),
    '-loop', '0',
    '-threads', String(LIMITES_VIDEO.THREADS),
    '-f', 'webp',
    '-y',
    sortie,
  ];
}

/* ── Exécution ────────────────────────────────────────────────────────── */

/**
 * `execFile` promis : arguments fixes, pas de shell, délai maximal (processus tué),
 * sortie bornée, environnement MINIMAL (ni clé d'API ni mot de passe du serveur).
 * ffmpeg ne crée pas de processus enfant : tuer le processus suffit.
 */
function executerBinaire(commande, args, { timeoutMs, maxBuffer = 4 * MO } = {}) {
  return new Promise((resolve, reject) => {
    execFile(commande, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer,
      windowsHide: true,
      shell: false,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    }, (err, stdout, stderr) => {
      if (err) {
        const e = err;
        e.stderr = String(stderr || '').slice(0, 300);
        return reject(e);
      }
      return resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/* ── Disponibilité ────────────────────────────────────────────────────── */

let cacheDispo = null; // { ok, at }

async function verifierDisponibilite(exec = executerBinaire) {
  const bin = binaires();
  try {
    await exec(bin.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 5000 });
    await exec(bin.ffprobe, ['-hide_banner', '-version'], { timeoutMs: 5000 });
    const { stdout } = await exec(bin.ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 5000 });
    if (!/\blibwebp_anim\b/.test(String(stdout))) return false;
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * ffmpeg + ffprobe + encodeur `libwebp_anim` présents ? Testé UNE fois puis gardé
 * en mémoire ; un échec est retenté après `RETENTE_MS` (on installe ffmpeg sans
 * redémarrer le serveur).
 */
async function disponible({ exec, maintenant = Date.now() } = {}) {
  if (cacheDispo && (cacheDispo.ok || maintenant - cacheDispo.at < LIMITES_VIDEO.RETENTE_MS)) {
    return cacheDispo.ok;
  }
  const ok = await verifierDisponibilite(exec);
  cacheDispo = { ok, at: maintenant };
  return ok;
}

/** Pour les tests : oublie le résultat gardé en mémoire. */
function reinitialiserDisponibilite() {
  cacheDispo = null;
}

/* ── Sonde ────────────────────────────────────────────────────────────── */

/**
 * Valide la sortie JSON de ffprobe (fonction PURE, testée sans binaire).
 * @returns {{dureeSourceMs: number|null, largeur: number, hauteur: number}}
 */
function verifierSonde(json, { startMs, demuxeur }) {
  if (!json || typeof json !== 'object') throw invalide('vidéo illisible');
  const flux = Array.isArray(json.streams) ? json.streams : [];
  if (flux.length === 0 || flux.length > LIMITES_VIDEO.FLUX_MAX) throw invalide('vidéo non prise en charge');

  const formats = String(json.format?.format_name || '').split(',');
  const attendus = demuxeur.split(',');
  if (!formats.some((f) => attendus.includes(f))) throw invalide('vidéo non prise en charge');

  const video = flux.find((f) => f.codec_type === 'video' && Number(f.disposition?.attached_pic) !== 1);
  if (!video) throw invalide('aucune piste vidéo');
  const largeur = Number(video.width);
  const hauteur = Number(video.height);
  if (!Number.isInteger(largeur) || !Number.isInteger(hauteur) || largeur < 1 || hauteur < 1) {
    throw invalide('dimensions illisibles');
  }
  if (largeur > LIMITES_VIDEO.SOURCE_COTE_MAX || hauteur > LIMITES_VIDEO.SOURCE_COTE_MAX) {
    throw invalide('vidéo trop grande (4096 px maximum)');
  }

  // Durée : le conteneur, sinon la piste. Un WebM enregistré peut ne pas la porter.
  const brute = [json.format?.duration, video.duration]
    .map((d) => Number.parseFloat(d))
    .find((d) => Number.isFinite(d) && d > 0);
  let dureeSourceMs = null;
  if (brute !== undefined) {
    if (brute > LIMITES_VIDEO.SOURCE_DUREE_MAX_S) throw invalide('vidéo trop longue (2 minutes maximum)');
    dureeSourceMs = Math.round(brute * 1000);
    if (startMs >= dureeSourceMs) throw invalide('début au-delà de la fin de la vidéo');
  }
  return { dureeSourceMs, largeur, hauteur };
}

/* ── Conversion ───────────────────────────────────────────────────────── */

/** Section critique unique : le sémaphore est déjà tenu, `convertirAnime` n'attend plus. */
const dejaTenu = Object.freeze({ executer: (fn) => fn() });

/**
 * Vidéo → WebP animé final, en forme (même sortie que `stickerAnime.convertirAnime`).
 *
 * @param {Buffer} buffer
 * @param {object} [o]
 * @param {number} [o.start=0]       début (ms)
 * @param {number} [o.duration=3000] durée (ms)
 * @param {string} [o.forme]         cercle | carre-arrondi | carre
 * @param {object} [deps]            `exec`, `semaphore`, `dossierTemp` (tests)
 * @throws {StickerAssetError} STICKER_ASSET_INVALID (422), STICKER_INVALID_PAYLOAD (400) ;
 *         {SlotOccupe} 503 SERVICE_UNAVAILABLE (file pleine ou délai dépassé)
 */
async function convertirVideo(buffer, {
  start, duration, forme = stickerAnime.FORME_DEFAUT,
} = {}, deps = {}) {
  const { startMs, dureeMs } = lireFenetre({ start, duration });
  if (!stickerAnime.FORMES.includes(forme)) throw invalide('forme inconnue');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw invalide('fichier vide');
  if (buffer.length > LIMITES_VIDEO.ENTREE_MAX_OCTETS) throw invalide('vidéo trop lourde (20 Mo maximum)');

  const type = typeVideoParOctets(buffer);
  if (!type) throw invalide('format refusé (MP4, MOV ou WebM)');
  if (!(await disponible({ exec: deps.exec }))) throw invalide('vidéo non prise en charge');

  const demuxeur = DEMUXEURS[type];
  const exec = deps.exec || executerBinaire;
  const bin = binaires();
  const semaphore = deps.semaphore || semaphoreAnime;

  return semaphore.executer(async () => {
    const racine = deps.dossierTemp || os.tmpdir();
    const dossier = await fs.mkdtemp(path.join(racine, 'stk-video-'));
    const entree = path.join(dossier, crypto.randomBytes(12).toString('hex'));
    const sortie = path.join(dossier, 'sortie.webp');
    try {
      await fs.writeFile(entree, buffer, { mode: 0o600 });

      let sonde;
      try {
        const r = await exec(bin.ffprobe, argsFfprobe({ entree, demuxeur }), { timeoutMs: LIMITES_VIDEO.FFPROBE_MAX_MS });
        sonde = JSON.parse(r.stdout);
      } catch (e) {
        if (e instanceof stickerAsset.StickerAssetError) throw e;
        journaliser('sonde', e);
        throw invalide('vidéo illisible');
      }
      verifierSonde(sonde, { startMs, demuxeur });

      try {
        await exec(bin.ffmpeg, argsFfmpeg({
          entree, sortie, demuxeur, startMs, dureeMs,
        }), { timeoutMs: LIMITES_VIDEO.FFMPEG_MAX_MS });
      } catch (e) {
        journaliser('ffmpeg', e);
        throw invalide(e && e.killed ? 'conversion trop longue' : 'vidéo illisible');
      }

      const infos = await fs.stat(sortie).catch(() => null);
      if (!infos || infos.size === 0) throw invalide('aucune image exploitable dans cette fenêtre');
      if (infos.size > LIMITES_VIDEO.INTERMEDIAIRE_MAX_OCTETS) throw invalide('vidéo trop détaillée');
      const intermediaire = await fs.readFile(sortie);

      // Même code que le GIF / WebP animé : forme, budget, empreinte.
      return await stickerAnime.convertirAnime(intermediaire, {
        forme,
        entreeMaxOctets: LIMITES_VIDEO.INTERMEDIAIRE_MAX_OCTETS,
      }, { semaphore: dejaTenu });
    } finally {
      await fs.rm(dossier, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/** Journal serveur : code et début de stderr, jamais renvoyés au client. */
function journaliser(etape, e) {
  console.warn(`[stickerVideo] ${etape} en échec :`, e && (e.code || e.signal || ''), String((e && e.stderr) || (e && e.message) || '').slice(0, 200));
}

/**
 * Création utilisateur depuis une vidéo, de la lecture à la liste de blocage. Même
 * contrat que `stickerAnime.preparerAssetAnime` : quotas lus AVANT la conversion,
 * blocage sur l'empreinte du fichier FINAL.
 */
async function preparerAssetVideo(buffer, {
  ownerId, forme, start, duration,
} = {}, deps = {}) {
  if (Number(ownerId) !== 0 && deps.usage) {
    const u = await deps.usage(ownerId);
    if (u.assets >= stickerAsset.LIMITES.ASSETS_PAR_COMPTE
      || u.uploadsDerniereHeure >= stickerAsset.LIMITES.UPLOADS_PAR_HEURE) {
      throw new stickerAsset.StickerAssetError('STICKER_QUOTA_EXCEEDED', 'Quota de stickers atteint', 429);
    }
  }
  const pret = await convertirVideo(buffer, { forme, start, duration }, deps);
  if (deps.estBloque && await deps.estBloque(pret.sha256)) {
    throw new stickerAsset.StickerAssetError('STICKER_ASSET_BLOCKED', 'Image bloquée', 422);
  }
  return pret;
}

module.exports = {
  LIMITES_VIDEO,
  DEMUXEURS,
  typeVideoParOctets,
  lireFenetre,
  argsFfmpeg,
  argsFfprobe,
  verifierSonde,
  disponible,
  reinitialiserDisponibilite,
  executerBinaire,
  convertirVideo,
  preparerAssetVideo,
};
