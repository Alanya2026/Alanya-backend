/**
 * Spike T5.0 — création d'un sticker ANIMÉ par le serveur, avec `sharp` seul.
 * Entrée : GIF ou WebP animé. Sortie : WebP animé 512×512, découpé en forme,
 * ≤ 3 s, ≤ 15 i/s, ≤ 300 Ko (boucle de qualité).
 */
const sharp = require('sharp');

const MAX_MS = 3000; const FPS = 15; const BUDGET = 300 * 1024;

async function fabriquerGif(n, w, h) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const buf = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = (x * 3 + i * 17) & 255; buf[o + 1] = (y * 2 + i * 9) & 255; buf[o + 2] = (i * 40) & 255; buf[o + 3] = 255;
    }
    frames.push(buf);
  }
  return sharp(Buffer.concat(frames), { raw: { width: w, height: h * n, channels: 4, pageHeight: h } })
    .gif({ delay: Array(n).fill(66), loop: 0 }).toBuffer();
}

async function convertir(entree, forme) {
  const src = sharp(entree, { animated: true, limitInputPixels: 4096 * 4096, pages: -1 });
  const m = await src.metadata();
  const delays = m.delay || [];
  // Découpe : durée cumulée ≤ 3 s ; sous-échantillonnage à 15 i/s.
  const garder = []; let t = 0; let dernierGarde = -1e9;
  for (let i = 0; i < (m.pages || 1); i++) {
    const d = Math.max(20, delays[i] ?? 100);
    if (t >= MAX_MS) break;
    if (t - dernierGarde >= 1000 / FPS - 1) { garder.push({ i, d }); dernierGarde = t; }
    else if (garder.length) garder[garder.length - 1].d += d;
    t += d;
  }
  const frames = [];
  for (const g of garder) {
    let f = sharp(entree, { page: g.i }).resize(512, 512, { fit: 'cover' });
    const masque = Buffer.from(forme === 'cercle'
      ? '<svg width="512" height="512"><circle cx="256" cy="256" r="256"/></svg>'
      : '<svg width="512" height="512"><rect width="512" height="512" rx="96"/></svg>');
    f = f.ensureAlpha().composite([{ input: masque, blend: 'dest-in' }]);
    frames.push({ buf: await f.raw().toBuffer(), d: g.d });
  }
  for (const q of [80, 65, 50, 40, 30, 20]) {
    const out = await sharp(Buffer.concat(frames.map((f) => f.buf)), {
      raw: { width: 512, height: 512 * frames.length, channels: 4, pageHeight: 512 },
    }).webp({ quality: q, effort: 3, loop: 0, delay: frames.map((f) => f.d) }).toBuffer();
    if (out.length <= BUDGET) return { out, q, frames: frames.length, ms: t };
  }
  throw new Error('budget 300 Ko inatteignable');
}

(async () => {
  const gif = require('fs').readFileSync(process.argv[2]); // GIF 60 images, 320×240, ~4 s, non carré
  console.log('GIF source :', gif.length, 'o');
  for (const forme of ['cercle', 'carre-arrondi']) {
    const t0 = Date.now();
    const r = await convertir(gif, forme);
    const m = await sharp(r.out, { animated: true }).metadata();
    const px = await sharp(r.out, { page: 0 }).ensureAlpha().raw().toBuffer();
    const coinHautGauche = px[3]; // alpha du pixel (0,0) : doit être 0 dans les formes arrondies
    console.log(forme, { octets: r.out.length, qualite: r.q, images: r.frames, pages: m.pages, w: m.width, h: m.pageHeight, alphaCoin: coinHautGauche, ms: Date.now() - t0 });
  }
  // Bombe : très grand GIF refusé par limitInputPixels
  try { const grand = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: '#fff' } }).gif().toBuffer(); await sharp(grand, { animated: true, limitInputPixels: 4096 * 4096 }).raw().toBuffer(); console.log('bombe: ACCEPTÉE'); }
  catch (e) { console.log('bombe: refusée —', e.message.slice(0, 70)); }
})().catch((e) => { console.error('ÉCHEC', e.message); process.exit(1); });
