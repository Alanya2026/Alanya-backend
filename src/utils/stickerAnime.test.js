/**
 * Pipeline des stickers ANIMÉS (V1c) — `node src/utils/stickerAnime.test.js`.
 * Pur : ni base, ni Redis, ni stockage. Les GIF viennent de
 * `src/testUtils/stickers/anime/` (Pillow, `generer.py`) ; les WebP animés sont
 * fabriqués ici par `sharp` à partir de ces GIF.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const anime = require('./stickerAnime');
const asset = require('./stickerAsset');
const { creerSemaphore, SlotOccupe } = require('./stickerSemaphore');

const { LIMITES_ANIME, FORMES } = anime;

const DOSSIER = path.join(__dirname, '..', 'testUtils', 'stickers', 'anime');
const gif = (nom) => fs.readFileSync(path.join(DOSSIER, nom));

let nb = 0;
const mesures = [];
const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);

async function refuse(promesse, code, motif) {
  try {
    await promesse;
  } catch (e) {
    assert.strictEqual(e.code, code, `${motif} : code ${e.code} (${e.message})`);
    // Jamais le message de libvips ni un chemin dans la réponse.
    assert.ok(!/vips|sharp|libwebp|\/home\/|node_modules|Error:/i.test(e.message), `${motif} : fuite « ${e.message} »`);
    return e;
  }
  assert.fail(`${motif} : accepté à tort`);
  return null;
}

/** WebP animé 512×512 (ou `cote`) fabriqué depuis un GIF : alpha posé, boucle infinie. */
async function webpAnime(nomGif, { images = 20, delai = 100, cote = 512, exif = false } = {}) {
  const src = gif(nomGif);
  const m = await sharp(src).metadata();
  let img = sharp(src, { animated: true, pages: images, limitInputPixels: m.width * m.height * images + 1 })
    .resize(cote, cote, { fit: 'cover' })
    .ensureAlpha();
  if (exif) img = img.withExif({ IFD0: { Copyright: 'SECRET-GPS-42' } });
  return img.webp({ quality: 80, effort: 3, loop: 0, delay: Array(images).fill(delai) }).toBuffer();
}

/** Alpha de chaque pixel demandé, image par image (un seul décodage de la pile). */
async function alphas(webp, points) {
  const m = await sharp(webp, { animated: true, pages: -1 }).metadata();
  const { data, info } = await sharp(webp, { animated: true, pages: -1 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.strictEqual(info.height, m.pages * 512, 'pile de hauteur 512 × images');
  const sorties = [];
  for (let p = 0; p < m.pages; p += 1) {
    sorties.push(points.map(([x, y]) => data[((p * 512 + y) * info.width + x) * 4 + 3]));
  }
  return sorties;
}

const COINS_ET_CENTRE = [[0, 0], [511, 0], [0, 511], [511, 511], [256, 256]];

// ── Octets magiques ─────────────────────────────────────────────────────────

test('typeParOctets : GIF87a, GIF89a, RIFF…WEBP ; tout le reste est refusé', async () => {
  assert.strictEqual(anime.typeParOctets(Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00')), 'gif');
  assert.strictEqual(anime.typeParOctets(Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00\x00\x00')), 'gif');
  assert.strictEqual(anime.typeParOctets(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8X')), 'webp');
  assert.strictEqual(anime.typeParOctets(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ')), null, 'RIFF non WebP');
  assert.strictEqual(anime.typeParOctets(Buffer.from('GIF90a\x00\x00\x00\x00\x00\x00')), null);
  assert.strictEqual(anime.typeParOctets(null), null);
  assert.strictEqual(anime.typeParOctets(Buffer.from('GIF89a')), null, 'trop court');
});

test('formats refusés sans être décodés : APNG, PNG, AVIF, SVG, TIFF, JPEG, HEIC', async () => {
  const base = sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } });
  const png = await base.clone().png().toBuffer();
  // APNG : un PNG avec un bloc `acTL` (animation) — la signature suffit à le refuser.
  const apng = Buffer.concat([png.subarray(0, 33), Buffer.from('\x00\x00\x00\x08acTL\x00\x00\x00\x02\x00\x00\x00\x00', 'latin1'), png.subarray(33)]);
  const entrees = {
    png, apng,
    avif: await base.clone().avif().toBuffer(),
    tiff: await base.clone().tiff().toBuffer(),
    jpeg: await base.clone().jpeg().toBuffer(),
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512"/></svg>'),
    html: Buffer.from('<html><script>alert(1)</script></html> et assez de texte pour passer 12 octets'),
  };
  for (const [nom, buf] of Object.entries(entrees)) {
    const e = await refuse(anime.convertirAnime(buf), 'STICKER_ASSET_INVALID', nom);
    assert.match(e.message, /format refusé/, `${nom} : refus par les octets, pas par sharp`);
  }
});

test('faux GIF (octets magiques seuls) et fichiers vides/tronqués : refus uniforme', async () => {
  await refuse(anime.convertirAnime(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(200, 7)])), 'STICKER_ASSET_INVALID', 'faux GIF');
  await refuse(anime.convertirAnime(Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8X'), Buffer.alloc(40, 1)])), 'STICKER_ASSET_INVALID', 'faux WebP');
  await refuse(anime.convertirAnime(Buffer.alloc(0)), 'STICKER_ASSET_INVALID', 'vide');
  await refuse(anime.convertirAnime(null), 'STICKER_ASSET_INVALID', 'pas un tampon');
  await refuse(anime.convertirAnime(gif('gif-30-carre.gif').subarray(0, 400)), 'STICKER_ASSET_INVALID', 'GIF tronqué');
  const abime = Buffer.from(gif('gif-30-carre.gif'));
  abime.fill(0xff, 800, 3000);
  await refuse(anime.convertirAnime(abime), 'STICKER_ASSET_INVALID', 'GIF corrompu');
});

// ── Conversion : formes, dimensions, boucle, durée ─────────────────────────

test('GIF carré 30 images : WebP animé 512×512, 30 images, 3 000 ms, boucle infinie, < 300 Ko', async () => {
  const t0 = Date.now();
  const r = await anime.convertirAnime(gif('gif-30-carre.gif'), { forme: 'carre-arrondi' });
  const ms = Date.now() - t0;
  const m = await sharp(r.webp, { animated: true, pages: -1 }).metadata();
  assert.strictEqual(m.format, 'webp');
  assert.strictEqual(m.width, 512);
  assert.strictEqual(m.pageHeight, 512);
  assert.strictEqual(m.pages, 30);
  assert.strictEqual(m.loop, 0, 'boucle infinie dans le fichier');
  assert.strictEqual(m.delay.reduce((a, b) => a + b, 0), 3000);
  assert.ok(m.hasAlpha);
  assert.ok(r.bytes <= LIMITES_ANIME.SORTIE_MAX_OCTETS, `${r.bytes} o`);
  assert.strictEqual(r.animated, true);
  assert.strictEqual(r.frames, 30);
  assert.strictEqual(r.durationMs, 3000);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(r.bytes, r.webp.length);
  mesures.push(`GIF 30 images 320×320 → ${r.bytes} o, q=${r.qualite}, ${ms} ms`);
});

test('GIF non carré 60 images : cover 512×512, tronqué à 45 images', async () => {
  const t0 = Date.now();
  const r = await anime.convertirAnime(gif('gif-60-non-carre.gif'), { forme: 'carre' });
  const ms = Date.now() - t0;
  const m = await sharp(r.webp, { animated: true, pages: -1 }).metadata();
  assert.strictEqual(m.pages, 45, '60 images → 45');
  assert.strictEqual(`${m.width}x${m.pageHeight}`, '512x512');
  assert.ok(m.delay.reduce((a, b) => a + b, 0) <= 3000);
  assert.ok(r.bytes <= LIMITES_ANIME.SORTIE_MAX_OCTETS);
  mesures.push(`GIF 60 images 320×240 → ${r.frames} images, ${r.bytes} o, q=${r.qualite}, ${ms} ms`);
});

test('troncature à 3 s : un GIF de 4 s (40 × 100 ms) donne 30 images', async () => {
  const r = await anime.convertirAnime(gif('gif-40-lent.gif'), { forme: 'carre' });
  const m = await sharp(r.webp, { animated: true, pages: -1 }).metadata();
  assert.strictEqual(m.pages, 30);
  assert.strictEqual(m.delay.reduce((a, b) => a + b, 0), 3000);
  assert.strictEqual(r.durationMs, 3000);
});

test('tronquer : 45 images, 3 000 ms cumulées, délai minimal 20 ms', () => {
  let r = anime.tronquer(Array(60).fill(100), 60);
  assert.strictEqual(r.delais.length, 30);
  assert.strictEqual(r.dureeMs, 3000);
  r = anime.tronquer(Array(100).fill(10), 100);
  assert.strictEqual(r.delais.length, 45, 'plafond de 45 images');
  assert.ok(r.delais.every((d) => d === 20), 'plancher de 20 ms');
  assert.strictEqual(r.dureeMs, 900);
  r = anime.tronquer([0, 0, 0], 3);
  assert.deepStrictEqual(r.delais, [20, 20, 20], 'un délai de 0 vaut 20 ms');
  r = anime.tronquer([5000, 5000], 2);
  assert.deepStrictEqual(r.delais, [3000], 'un délai géant est borné, la suivante ne tient plus');
  r = anime.tronquer(undefined, 5);
  assert.strictEqual(r.delais.length, 5, 'sans délais lisibles : 100 ms par image');
  r = anime.tronquer([2900, 150], 2);
  assert.deepStrictEqual(r.delais, [2900], "l'image qui ferait dépasser est abandonnée, pas coupée");
});

test('formes : cercle, carré arrondi et carré — alpha des coins ET du centre, image par image', async () => {
  const attendus = {
    cercle: { coin: 0, centre: 255 },
    'carre-arrondi': { coin: 0, centre: 255 },
    carre: { coin: 255, centre: 255 },
  };
  const sorties = {};
  for (const forme of FORMES) {
    const r = await anime.convertirAnime(gif('gif-30-carre.gif'), { forme });
    sorties[forme] = r;
    const par = await alphas(r.webp, COINS_ET_CENTRE);
    assert.strictEqual(par.length, 30, `${forme} : 30 images`);
    par.forEach((a, i) => {
      const attendu = attendus[forme];
      assert.deepStrictEqual(a, [attendu.coin, attendu.coin, attendu.coin, attendu.coin, attendu.centre],
        `${forme} image ${i} : coins/centre ${a}`);
    });
  }
  assert.strictEqual(new Set(FORMES.map((f) => sorties[f].sha256)).size, 3, 'trois formes, trois fichiers');
  // Le milieu d'un bord reste plein dans les trois formes ; le carré arrondi garde
  // ses côtés (rayon 96) là où le cercle les entame déjà.
  const [pa] = await alphas(sorties['carre-arrondi'].webp, [[256, 0], [15, 15], [20, 256]]);
  const [pc] = await alphas(sorties.cercle.webp, [[256, 0], [15, 15], [20, 256]]);
  assert.deepStrictEqual(pa, [255, 0, 255], 'carré arrondi : bord plein, coin entamé');
  assert.strictEqual(pc[1], 0, 'cercle : (15, 15) hors du disque');
  assert.strictEqual(pc[2], 255, 'cercle : le milieu du bord gauche (20, 256) est dans le disque');
});

test('forme par défaut et forme inconnue', async () => {
  assert.strictEqual(anime.FORME_DEFAUT, 'carre-arrondi');
  await refuse(anime.convertirAnime(gif('gif-30-carre.gif'), { forme: 'triangle' }), 'STICKER_ASSET_INVALID', 'forme inconnue');
  const r = await anime.convertirAnime(gif('gif-30-carre.gif'));
  const [a] = await alphas(r.webp, [[0, 0]]);
  assert.strictEqual(a[0], 0, 'sans forme : carré arrondi (coin transparent)');
});

test('vignette : première image, 96×96, statique ; métadonnées absentes ; déterministe', async () => {
  const r = await anime.convertirAnime(gif('gif-30-carre.gif'), { forme: 'cercle' });
  const t = await sharp(r.thumb).metadata();
  assert.strictEqual(`${t.width}x${t.height}`, '96x96');
  assert.ok((t.pages || 1) === 1, 'vignette statique');
  const m = await sharp(r.webp, { animated: true, pages: -1 }).metadata();
  assert.ok(!m.exif && !m.xmp && !m.icc, 'ni EXIF, ni XMP, ni ICC');
  const encore = await anime.convertirAnime(gif('gif-30-carre.gif'), { forme: 'cercle' });
  assert.strictEqual(encore.sha256, r.sha256, 'même entrée, même empreinte (idempotence)');
});

test('WebP animé en entrée utilisateur : accepté, mis en forme ; WebP statique refusé', async () => {
  const entree = await webpAnime('gif-40-lent.gif', { images: 40, delai: 100, cote: 400 });
  const r = await anime.convertirAnime(entree, { forme: 'cercle' });
  assert.strictEqual(r.frames, 30);
  assert.strictEqual(`${(await sharp(r.webp).metadata()).width}`, '512');
  const statique = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).webp().toBuffer();
  await refuse(anime.convertirAnime(statique), 'STICKER_ASSET_INVALID', 'WebP statique');
  const gifFixe = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).gif().toBuffer();
  await refuse(anime.convertirAnime(gifFixe), 'STICKER_ASSET_INVALID', 'GIF à une image');
});

// ── Poids et délai ──────────────────────────────────────────────────────────

test('budget 300 Ko : un GIF de bruit est refusé « trop lourd » (boucle 70 → 20 épuisée)', async () => {
  const entree = gif('gif-bruite-lourd.gif');
  assert.ok(entree.length < LIMITES_ANIME.ENTREE_MAX_OCTETS, `précondition : ${entree.length} o < 3 Mo`);
  const t0 = Date.now();
  const e = await refuse(anime.convertirAnime(entree), 'STICKER_ASSET_INVALID', 'bruit');
  assert.match(e.message, /lourde/);
  mesures.push(`GIF de bruit ${entree.length} o → refus « trop lourd » en ${Date.now() - t0} ms`);
});

test('budget : la boucle descend jusqu\'à ce que ça tienne, puis rejette', async () => {
  const entree = gif('gif-30-carre.gif');
  const libre = await anime.convertirAnime(entree, { forme: 'carre' });
  assert.strictEqual(libre.qualite, 70, 'budget confortable : qualité 70 du premier coup');
  // Un budget entre q20 et q70 : une qualité plus basse est retenue.
  const serre = await anime.convertirAnime(entree, { forme: 'carre', budgetOctets: Math.floor(libre.bytes * 0.9) });
  assert.ok(serre.qualite < 70 && serre.qualite >= 20, `qualité ${serre.qualite}`);
  assert.ok(serre.bytes <= Math.floor(libre.bytes * 0.9));
  // Un budget hors d'atteinte mais < 2× le premier essai : les six qualités sont
  // essayées (pas d'abandon anticipé), puis le rejet.
  await refuse(anime.convertirAnime(entree, { forme: 'carre', budgetOctets: Math.ceil(libre.bytes / 1.8) }), 'STICKER_ASSET_INVALID', 'budget hors d\'atteinte');
  // Un budget dérisoire : abandon anticipé après le premier essai (même code).
  const t0 = Date.now();
  await refuse(anime.convertirAnime(entree, { forme: 'carre', budgetOctets: 1024 }), 'STICKER_ASSET_INVALID', 'budget dérisoire');
  assert.ok(Date.now() - t0 < 5000);
});

test('échéance de conversion : dépassée, rejet, et le créneau est rendu', async () => {
  const sem = creerSemaphore({ max: 1, fileMax: 0 });
  const e = await refuse(anime.convertirAnime(gif('gif-30-carre.gif'), { conversionMaxMs: 0 }, { semaphore: sem }), 'STICKER_ASSET_INVALID', 'échéance');
  assert.match(e.message, /trop longue/);
  assert.strictEqual(sem.stats().actifs, 0, 'le créneau est rendu après un rejet');
});

// ── Bombes ──────────────────────────────────────────────────────────────────

test('bombes : GIF 6000×6000, 20 images 2000×2000 (80 Mpx), 301 pages, dimensions trompeuses', async () => {
  for (const [nom, motif] of [
    ['gif-6000x6000.gif', '6000×6000'],
    ['gif-2000x2000-20.gif', '2000×2000×20 = 80 Mpx > borne'],
    ['gif-301-pages.gif', '301 pages'],
  ]) {
    const entree = gif(nom);
    assert.ok(entree.length < LIMITES_ANIME.ENTREE_MAX_OCTETS, `${motif} : précondition, petit fichier`);
    const t0 = Date.now();
    await refuse(anime.convertirAnime(entree), 'STICKER_ASSET_INVALID', motif);
    assert.ok(Date.now() - t0 < 1000, `${motif} : refusé sans décodage (${Date.now() - t0} ms)`);
  }
  // Dimensions trompeuses : le descripteur d'image de la première trame (octets
  // 5-8 après le 0x2C) réécrit pour annoncer une trame géante dans un petit fichier.
  // (L'écran logique de l'en-tête, lui, est ignoré par libvips : sans effet.)
  const petit = gif('gif-30-carre.gif');
  const gce = petit.indexOf(Buffer.from([0x21, 0xf9, 0x04]));
  const desc = gce + 8;
  assert.strictEqual(petit[desc], 0x2c, 'précondition : descripteur d\'image trouvé');
  for (const [w, h, motif] of [[60000, 60000, '60 000×60 000 (limite d\'une image)'], [4096, 4096, '4096×4096 × 30 images (borne de pile)']]) {
    const menteur = Buffer.from(petit);
    menteur.writeUInt16LE(w, desc + 5);
    menteur.writeUInt16LE(h, desc + 7);
    const t1 = Date.now();
    await refuse(anime.convertirAnime(menteur), 'STICKER_ASSET_INVALID', `dimensions trompeuses ${motif}`);
    assert.ok(Date.now() - t1 < 2000, `${motif} refusé vite (${Date.now() - t1} ms)`);
  }
  // Fichier > 3 Mo : refus avant sharp.
  await refuse(anime.convertirAnime(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(LIMITES_ANIME.ENTREE_MAX_OCTETS)])), 'STICKER_ASSET_INVALID', '> 3 Mo');
});

test('borne de pile : largeur × hauteur × min(images, 45) ≤ 50 Mpx, au pixel près', async () => {
  // 1 000×1 000 sur 45 images = 45 Mpx : passe la borne. On ne convertit pas (long) :
  // on vérifie l'arithmétique de la borne et que 2 000×2 000×20 la dépasse.
  assert.ok(1000 * 1000 * 45 <= LIMITES_ANIME.PIXELS_MAX);
  assert.ok(2000 * 2000 * 20 > LIMITES_ANIME.PIXELS_MAX);
  assert.ok(1100 * 1100 * 45 > LIMITES_ANIME.PIXELS_MAX);
  assert.ok(4096 * 4096 === LIMITES_ANIME.PIXELS_IMAGE_MAX);
  assert.strictEqual(LIMITES_ANIME.PAGES_MAX, 300);
});

// ── Sémaphore ───────────────────────────────────────────────────────────────

test('sémaphore : un à la fois, la file d\'attente est courte, délai borné', async () => {
  const sem = creerSemaphore({ max: 1, fileMax: 1, attenteMs: 60 });
  const r1 = await sem.acquerir();
  assert.deepStrictEqual({ a: sem.stats().actifs, f: sem.stats().enAttente }, { a: 1, f: 0 });
  const attente = sem.acquerir(); // file : 1 place
  assert.strictEqual(sem.stats().enAttente, 1);
  await assert.rejects(sem.acquerir(), (e) => e instanceof SlotOccupe && e.code === 'SERVICE_UNAVAILABLE' && e.status === 503 && e.raison === 'file_pleine');
  await assert.rejects(attente, (e) => e.raison === 'delai' && e.status === 503, 'délai d\'attente dépassé');
  assert.strictEqual(sem.stats().enAttente, 0, 'le délai sort de la file');
  r1();
  r1(); // idempotent
  assert.strictEqual(sem.stats().actifs, 0);
  const r2 = await sem.acquerir();
  const suivant = sem.acquerir();
  r2();
  const r3 = await suivant;
  assert.strictEqual(sem.stats().actifs, 1, 'le créneau passe au suivant');
  r3();
  assert.strictEqual(sem.stats().actifs, 0);
});

test('2 conversions simultanées : la seconde attend (jamais en parallèle) ou reçoit 503', async () => {
  // Capteur : nombre maximal de conversions réellement simultanées.
  let en = 0;
  let max = 0;
  const base = creerSemaphore({ max: 1, fileMax: 2, attenteMs: 30_000 });
  const sem = {
    ...base,
    executer: (fn) => base.executer(async () => {
      en += 1;
      max = Math.max(max, en);
      try { return await fn(); } finally { en -= 1; }
    }),
  };
  const a = gif('gif-30-carre.gif');
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    anime.convertirAnime(a, { forme: 'cercle' }, { semaphore: sem }),
    anime.convertirAnime(a, { forme: 'carre' }, { semaphore: sem }),
  ]);
  assert.strictEqual(max, 1, `jamais 2 encodages à la fois (max observé ${max})`);
  assert.ok(r1.bytes > 0 && r2.bytes > 0, 'les deux aboutissent, l\'une après l\'autre');
  assert.strictEqual(base.stats().actifs, 0);
  mesures.push(`2 conversions simultanées en série : ${Date.now() - t0} ms au total`);

  // File de 0 : la seconde est refusée tout de suite, la première aboutit.
  const serre = creerSemaphore({ max: 1, fileMax: 0 });
  const res = await Promise.allSettled([
    anime.convertirAnime(a, { forme: 'cercle' }, { semaphore: serre }),
    anime.convertirAnime(a, { forme: 'carre' }, { semaphore: serre }),
  ]);
  const refus = res.filter((x) => x.status === 'rejected');
  assert.strictEqual(refus.length, 1, 'une seule est refusée');
  assert.strictEqual(refus[0].reason.code, 'SERVICE_UNAVAILABLE');
  assert.strictEqual(refus[0].reason.status, 503);
  assert.strictEqual(res.filter((x) => x.status === 'fulfilled').length, 1);
});

test('le sémaphore par défaut est partagé par le dépôt admin et la création utilisateur', () => {
  assert.strictEqual(anime.semaphoreAnime.stats().max, 1);
  assert.strictEqual(anime.semaphoreAnime.stats().fileMax, LIMITES_ANIME.FILE_MAX);
  assert.strictEqual(anime.semaphoreAnime.stats().attenteMs, LIMITES_ANIME.ATTENTE_MAX_MS);
});

// ── Dépôt admin d'un WebP animé final ──────────────────────────────────────

test('admin : WebP animé 512×512 ≤ 45 images ≤ 3 s : ré-encodé, vignette, métadonnées retirées', async () => {
  const entree = await webpAnime('gif-30-carre.gif', { images: 20, delai: 100, exif: true });
  const piege = await sharp(entree).metadata();
  const r = await anime.reencoderAnimeWebp(entree);
  const m = await sharp(r.webp, { animated: true, pages: -1 }).metadata();
  assert.strictEqual(m.pages, 20);
  assert.strictEqual(`${m.width}x${m.pageHeight}`, '512x512');
  assert.strictEqual(m.loop, 0);
  assert.strictEqual(r.durationMs, 2000);
  assert.ok(r.bytes <= LIMITES_ANIME.SORTIE_MAX_OCTETS);
  assert.ok(!r.webp.includes(Buffer.from('SECRET-GPS-42')), `l'EXIF a disparu (précondition : entrée avec exif=${!!piege.exif})`);
  assert.ok(!m.exif && !m.xmp && !m.icc);
  assert.strictEqual((await sharp(r.thumb).metadata()).width, 96);
  assert.strictEqual(r.animated, true);
});

test('admin : hors limites refusé (46 images, 256×256, 3,5 s, statique, PNG déguisé)', async () => {
  await refuse(anime.reencoderAnimeWebp(await webpAnime('gif-60-non-carre.gif', { images: 46, delai: 50 })), 'STICKER_ASSET_INVALID', '46 images');
  await refuse(anime.reencoderAnimeWebp(await webpAnime('gif-30-carre.gif', { images: 10, cote: 256 })), 'STICKER_ASSET_INVALID', '256×256');
  await refuse(anime.reencoderAnimeWebp(await webpAnime('gif-40-lent.gif', { images: 35, delai: 100 })), 'STICKER_ASSET_INVALID', '3 500 ms');
  await refuse(anime.reencoderAnimeWebp(await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0.5 } } }).webp().toBuffer()), 'STICKER_ASSET_INVALID', 'statique');
  await refuse(anime.reencoderAnimeWebp(gif('gif-30-carre.gif')), 'STICKER_ASSET_INVALID', 'GIF');
  await refuse(anime.reencoderAnimeWebp(Buffer.alloc(1024 * 1024 + 1, 1)), 'STICKER_ASSET_INVALID', '> 1 Mo');
});

test('preparerAsset : l\'animé n\'est accepté que si l\'appelant l\'autorise ; le statique ne change pas', async () => {
  const entree = await webpAnime('gif-30-carre.gif', { images: 12, delai: 100 });
  const e = await refuse(asset.preparerAsset(entree, { ownerId: 12 }, {}), 'STICKER_ASSET_INVALID', 'animé refusé par défaut');
  assert.match(e.message, /anim/);
  const pret = await asset.preparerAsset(entree, { ownerId: 0, animeAutorise: true }, { estBloque: async () => false });
  assert.strictEqual(pret.animated, true);
  assert.strictEqual(pret.frames, 12);
  // Statique, avec ou sans l'autorisation : exactement le même chemin.
  const png = await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const a = await asset.preparerAsset(png, { ownerId: 0 }, {});
  const b = await asset.preparerAsset(png, { ownerId: 0, animeAutorise: true }, {});
  assert.strictEqual(a.sha256, b.sha256);
  assert.strictEqual(a.animated, false);
  // Blocage sur l'empreinte du fichier FINAL.
  await refuse(asset.preparerAsset(entree, { ownerId: 0, animeAutorise: true }, { estBloque: async (h) => h === pret.sha256 }), 'STICKER_ASSET_BLOCKED', 'empreinte bloquée');
});

// ── preparerAssetAnime : quotas, blocage ───────────────────────────────────

test('preparerAssetAnime : quotas lus AVANT la conversion, blocage sur le fichier final', async () => {
  const a = gif('gif-30-carre.gif');
  const sem = { executer: async () => { throw new Error('conversion lancée malgré le quota'); } };
  const quota = (assets, h) => ({ usage: async () => ({ assets, uploadsDerniereHeure: h }), semaphore: sem });
  await refuse(anime.preparerAssetAnime(a, { ownerId: 12 }, quota(asset.LIMITES.ASSETS_PAR_COMPTE, 0)), 'STICKER_QUOTA_EXCEEDED', 'quota 200');
  await refuse(anime.preparerAssetAnime(a, { ownerId: 12 }, quota(0, asset.LIMITES.UPLOADS_PAR_HEURE)), 'STICKER_QUOTA_EXCEEDED', 'quota horaire');

  const pret = await anime.preparerAssetAnime(a, { ownerId: 12, forme: 'cercle' }, { usage: async () => ({ assets: 3, uploadsDerniereHeure: 1 }) });
  assert.strictEqual(pret.animated, true);
  const bloque = new Set([pret.sha256]);
  await refuse(anime.preparerAssetAnime(a, { ownerId: 99, forme: 'cercle' }, { estBloque: async (h) => bloque.has(h) }), 'STICKER_ASSET_BLOCKED', 'empreinte bloquée (autre compte)');
});

(async () => {
  for (const [nom, fn] of tests) {
    try {
      const t0 = Date.now();
      await fn();
      if (process.env.TEST_DUREES) console.log(`  ${Date.now() - t0} ms : ${nom}`);
      nb += 1;
    } catch (e) {
      console.error(`ÉCHEC : ${nom}`);
      console.error(e);
      process.exit(1);
    }
  }
  for (const m of mesures) console.log(`  mesure : ${m}`);
  console.log(`stickerAnime.test.js : ${nb} tests OK`);
})();
