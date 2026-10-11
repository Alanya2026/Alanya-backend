/**
 * Sticker animé depuis une VIDÉO — test avec un VRAI ffmpeg
 * (`node src/utils/stickerVideo.ffmpeg.test.js`).
 *
 * HORS CI : le test se SAUTE (code 0) quand ffmpeg ou ffprobe est absent. Pour le
 * lancer :
 *
 *   FFMPEG_PATH=/chemin/ffmpeg FFPROBE_PATH=/chemin/ffprobe node src/utils/stickerVideo.ffmpeg.test.js
 *
 * (ou avec les paquets `ffmpeg` du système). Il fabrique ses vidéos avec ffmpeg
 * lui-même (sources `lavfi`), les convertit, mesure temps et mémoire, puis vérifie
 * qu'aucun fichier piégé ne plante le serveur ni ne laisse de fichier ou de
 * processus derrière lui.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const video = require('./stickerVideo');
const anime = require('./stickerAnime');
const { creerSemaphore } = require('./stickerSemaphore');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function disponibleSync() {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' });
    execFileSync(process.env.FFPROBE_PATH || 'ffprobe', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return /libwebp_anim/.test(execFileSync(FFMPEG, ['-hide_banner', '-encoders']).toString());
  } catch (e) {
    return false;
  }
}

if (!disponibleSync()) {
  console.log('stickerVideo.ffmpeg.test.js : ffmpeg / ffprobe / libwebp_anim absents : sauté');
  process.exit(0);
}

const travail = fs.mkdtempSync(path.join(os.tmpdir(), 'test-stk-ffmpeg-'));
const racineTemp = path.join(travail, 'temp');
fs.mkdirSync(racineTemp);

/** Fabrique une vidéo de test avec ffmpeg. */
function fabriquer(nom, { taille = '1280x720', fps = 30, duree = 2, audio = true, codec = 'libx264', ext = 'mp4', extra = [] } = {}) {
  const sortie = path.join(travail, `${nom}.${ext}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=${taille}:rate=${fps}:duration=${duree}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${duree}`);
  args.push('-c:v', codec);
  if (codec === 'libx264') args.push('-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', ext === 'webm' ? 'libvorbis' : 'aac', '-shortest');
  args.push(...extra, sortie);
  execFileSync(FFMPEG, args, { stdio: 'pipe' });
  return fs.readFileSync(sortie);
}

const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);
const mesures = [];

/** Compte les processus ffmpeg lancés sur NOS dossiers temporaires. */
function orphelins() {
  try {
    return execFileSync('pgrep', ['-f', 'stk-video-']).toString().trim().split('\n').filter(Boolean).length;
  } catch (e) {
    return 0; // pgrep sort en erreur quand rien ne correspond
  }
}

const dossierVide = () => fs.readdirSync(racineTemp).length === 0;

async function verifierSortie(r, { cercle = false } = {}) {
  assert.strictEqual(r.animated, true);
  assert.ok(Buffer.isBuffer(r.webp), 'webp');
  assert.ok(r.webp.length <= 300 * 1024, `poids ${r.webp.length}`);
  assert.strictEqual(r.bytes, r.webp.length);
  assert.ok(r.frames >= 2 && r.frames <= 45, `images ${r.frames}`);
  assert.ok(r.durationMs > 0 && r.durationMs <= 3000, `durée ${r.durationMs}`);
  const m = await sharp(r.webp, { animated: true, pages: -1 }).metadata();
  assert.strictEqual(m.format, 'webp');
  assert.strictEqual(m.width, 512);
  assert.strictEqual(m.pageHeight || m.height, 512);
  assert.strictEqual(m.pages, r.frames);
  assert.strictEqual(m.loop, 0, 'boucle infinie');
  if (cercle) {
    for (const page of [0, m.pages - 1]) {
      const px = await sharp(r.webp, { page }).ensureAlpha().raw().toBuffer();
      assert.strictEqual(px[3], 0, `coin transparent, image ${page}`);
      assert.strictEqual(px[((256 * 512) + 256) * 4 + 3], 255, `centre opaque, image ${page}`);
    }
  }
  return m;
}

async function convertir(buffer, opts = {}, deps = {}) {
  const t0 = Date.now();
  const r = await video.convertirVideo(buffer, opts, { dossierTemp: racineTemp, ...deps });
  return { r, ms: Date.now() - t0 };
}

/* ── Vraies vidéos ─────────────────────────────────────────────────────── */

test('MP4 H.264 + AAC 1280×720, 2 s : conversion complète, forme cercle', async () => {
  const src = fabriquer('mp4-audio');
  const { r, ms } = await convertir(src, { start: 0, duration: 2000, forme: 'cercle' });
  await verifierSortie(r, { cercle: true });
  mesures.push(`MP4 720p 2 s → ${r.frames} images, ${r.durationMs} ms, ${r.bytes} o, ${ms} ms de traitement`);
  assert.ok(dossierVide(), 'dossier de travail vidé');
});

test('MP4 sans piste audio', async () => {
  const { r } = await convertir(fabriquer('mp4-muet', { audio: false }), { duration: 1500 });
  await verifierSortie(r);
});

test('WebM VP8 / VP9', async () => {
  for (const [codec, nom] of [['libvpx', 'vp8'], ['libvpx-vp9', 'vp9']]) {
    let src;
    try {
      src = fabriquer(`webm-${nom}`, { codec, ext: 'webm', duration: 2, extra: codec === 'libvpx-vp9' ? ['-b:v', '1M'] : [] });
    } catch (e) {
      console.log(`  (encodeur ${codec} absent de ce ffmpeg : cas sauté)`);
      continue;
    }
    const { r } = await convertir(src, { duration: 2000, forme: 'carre' });
    await verifierSortie(r);
  }
});

test('MOV (conteneur QuickTime)', async () => {
  const { r } = await convertir(fabriquer('mov', { ext: 'mov', duration: 2 }), { duration: 1000, forme: 'carre-arrondi' });
  await verifierSortie(r);
});

test('Full HD 1920×1080 à 60 images/s', async () => {
  const { r, ms } = await convertir(fabriquer('fullhd60', { taille: '1920x1080', fps: 60, duree: 3 }), { start: 500, duration: 3000 });
  await verifierSortie(r);
  mesures.push(`MP4 1080p 60 i/s 3 s → ${r.frames} images, ${r.bytes} o, ${ms} ms`);
});

test('portrait 1080×1920 : recadrage cover 512×512', async () => {
  const { r } = await convertir(fabriquer('portrait', { taille: '1080x1920', duree: 2 }), { duration: 2000 });
  await verifierSortie(r);
});

test('vidéo très courte (0,3 s) : au moins 2 images', async () => {
  const { r } = await convertir(fabriquer('courte', { duree: 0.3, audio: false }), { start: 0, duration: 500 });
  await verifierSortie(r);
});

test('fenêtre : le début décale vraiment le contenu', async () => {
  const src = fabriquer('decalage', { duree: 4, audio: false });
  const a = (await convertir(src, { start: 0, duration: 500 })).r;
  const b = (await convertir(src, { start: 3000, duration: 500 })).r;
  const pa = await sharp(a.webp, { page: 0 }).removeAlpha().raw().toBuffer();
  const pb = await sharp(b.webp, { page: 0 }).removeAlpha().raw().toBuffer();
  assert.notDeepStrictEqual(pa, pb, 'deux fenêtres différentes donnent des images différentes');
});

test('début au-delà de la fin → 422 sans lancer ffmpeg', async () => {
  const src = fabriquer('hors-fenetre', { duree: 2, audio: false });
  await assert.rejects(video.convertirVideo(src, { start: 2500 }, { dossierTemp: racineTemp }), (e) => e.code === 'STICKER_ASSET_INVALID' && e.status === 422);
  assert.ok(dossierVide());
});

test('4096×2304 à 60 images/s (limite de taille et de cadence)', async () => {
  const { r, ms } = await convertir(fabriquer('uhd', { taille: '4096x2304', fps: 60, duree: 2, audio: false }), { duration: 2000 });
  await verifierSortie(r);
  mesures.push(`MP4 4096×2304 60 i/s → ${r.bytes} o en ${ms} ms`);
});

test('largeur 4098 : refusée par la sonde', async () => {
  const src = fabriquer('trop-large', { taille: '4098x64', duree: 1, audio: false });
  await assert.rejects(video.convertirVideo(src, {}, { dossierTemp: racineTemp }), (e) => e.code === 'STICKER_ASSET_INVALID' && e.message === 'vidéo trop grande (4096 px maximum)');
});

/* ── Fichiers piégés ───────────────────────────────────────────────────── */

test('fichiers piégés : refusés proprement, aucun fichier ni processus laissé', async () => {
  const bon = fabriquer('base-piege', { duree: 2 });
  const aleatoire = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 2654435761) >>> 24; return b; };
  const cas = {
    'MP4 tronqué à 60 %': bon.subarray(0, Math.floor(bon.length * 0.6)),
    'MP4 tronqué à 2 Ko': bon.subarray(0, 2048),
    'en-tête ftyp puis hasard': Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), aleatoire(200_000)]),
    'EBML puis hasard': Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), aleatoire(200_000)]),
    'octets aléatoires nommés .mp4 (sans magie)': aleatoire(100_000),
    'playlist concat déguisée': Buffer.from("ffconcat version 1.0\nfile '/etc/passwd'\nfile 'http://127.0.0.1:1/x'\n"),
    'playlist HLS': Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:3,\nhttp://127.0.0.1:1/seg.ts\n'),
    'SDP / RTSP': Buffer.from('v=0\no=- 0 0 IN IP4 127.0.0.1\nm=video 5004 RTP/AVP 96\n'),
  };
  for (const [nom, octets] of Object.entries(cas)) {
    await assert.rejects(
      video.convertirVideo(octets, {}, { dossierTemp: racineTemp }),
      (e) => e.code === 'STICKER_ASSET_INVALID' && e.status === 422 && !/\/tmp|stk-video|ffmpeg|ffprobe|Invalid data|moov/i.test(e.message),
      nom,
    );
    assert.ok(dossierVide(), `${nom} : dossier de travail vidé`);
  }
  assert.strictEqual(orphelins(), 0, 'aucun ffmpeg orphelin');
});

test('image HEIC / AVIF (ftyp) : refusée avant tout binaire', async () => {
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(5000, 1)]);
  await assert.rejects(video.convertirVideo(heic, {}, { dossierTemp: racineTemp }), (e) => e.message === 'format refusé (MP4, MOV ou WebM)');
});

test('un GIF n\'est pas une vidéo (il suit l\'autre chemin)', async () => {
  const gif = fs.readFileSync(path.join(__dirname, '..', 'testUtils', 'stickers', 'anime', 'gif-30-carre.gif'));
  await assert.rejects(video.convertirVideo(gif, {}, { dossierTemp: racineTemp }), (e) => e.code === 'STICKER_ASSET_INVALID');
  const r = await anime.convertirAnime(gif, { forme: 'carre' });
  assert.strictEqual(r.animated, true);
});

/* ── Charge ────────────────────────────────────────────────────────────── */

test('3 conversions simultanées : un seul ffmpeg à la fois, mémoire mesurée', async () => {
  const src = fabriquer('charge', { duree: 2, audio: false });
  const semaphore = creerSemaphore({ max: 1, fileMax: 3, attenteMs: 60_000 });
  let actifs = 0;
  let maxActifs = 0;
  const exec = async (cmd, args, o) => {
    const ffmpeg = args.includes('-nostdin');
    if (ffmpeg) { actifs += 1; maxActifs = Math.max(maxActifs, actifs); }
    try { return await video.executerBinaire(cmd, args, o); } finally { if (ffmpeg) actifs -= 1; }
  };
  let pic = 0;
  const sonde = setInterval(() => { pic = Math.max(pic, process.memoryUsage().rss); }, 25);
  const t0 = Date.now();
  const rs = await Promise.all([1, 2, 3].map(() => video.convertirVideo(src, { forme: 'cercle' }, { dossierTemp: racineTemp, semaphore, exec })));
  clearInterval(sonde);
  assert.strictEqual(rs.length, 3);
  assert.strictEqual(maxActifs, 1, `ffmpeg simultanés : ${maxActifs}`);
  assert.ok(dossierVide());
  mesures.push(`3 conversions en série : ${Date.now() - t0} ms au total, pic RSS du processus de test ${(pic / 1048576).toFixed(0)} Mo`);
});

(async () => {
  let ok = 0;
  let echec = null;
  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      echec = `✗ ${nom}\n  ${e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n  ') : e}`;
      break;
    }
  }
  fs.rmSync(travail, { recursive: true, force: true });
  for (const m of mesures) console.log(`  mesure : ${m}`);
  if (echec) {
    console.error(echec);
    process.exit(1);
  }
  console.log(`stickerVideo.ffmpeg.test.js : ${ok} tests OK (ffmpeg réel)`);
})();
