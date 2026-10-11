/**
 * Sticker animé depuis une VIDÉO (V1c, contrat §4d) — `node src/utils/stickerVideo.test.js`.
 *
 * PUR : aucun ffmpeg, aucune base, aucun stockage. Les binaires sont remplacés par un
 * exécuteur factice (`deps.exec`) qui enregistre les appels. Le test avec un VRAI
 * ffmpeg est dans `stickerVideo.ffmpeg.test.js` (hors CI, se saute si absent).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const video = require('./stickerVideo');
const anime = require('./stickerAnime');
const asset = require('./stickerAsset');
const { creerSemaphore, SlotOccupe } = require('./stickerSemaphore');

const { LIMITES_VIDEO } = video;

const GIF = fs.readFileSync(path.join(__dirname, '..', 'testUtils', 'stickers', 'anime', 'gif-30-carre.gif'));

/** Octets d'un MP4 (ftyp) ou d'un WebM (EBML), suivis de remplissage. */
const mp4 = (marque = 'isom', taille = 4096) => Buffer.concat([
  Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from(marque), Buffer.alloc(taille, 7),
]);
const webm = (taille = 4096) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(taille, 7)]);

const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);

async function refuse(promesse, code, motif, statut) {
  try {
    await promesse;
  } catch (e) {
    assert.strictEqual(e.code, code, `${motif} : code ${e.code} (${e.message})`);
    if (statut) assert.strictEqual(e.status, statut, `${motif} : statut`);
    // Jamais un chemin, une trace ou une ligne de ffmpeg dans ce qui sort vers le client.
    assert.ok(!/\/tmp|stk-video|ffmpeg|ffprobe|secret|Error:/i.test(e.message), `${motif} : message qui fuit : ${e.message}`);
    return e;
  }
  assert.fail(`${motif} : aurait dû être refusé`);
  return null;
}

/** Sonde ffprobe plausible, personnalisable. */
const sonde = (sur = {}) => ({
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '10.000000', ...sur.format },
  streams: sur.streams || [
    { codec_type: 'video', width: 1280, height: 720, duration: '10.0', disposition: { attached_pic: 0 } },
    { codec_type: 'audio' },
  ],
});

/**
 * Exécuteur factice : répond aux sondes de disponibilité, à ffprobe, et « encode » en
 * écrivant `contenuSortie` dans le fichier de sortie (dernier argument de ffmpeg).
 */
function fabriquerExec(opts = {}) {
  const appels = [];
  let actifs = 0;
  let maxActifs = 0;
  const exec = async (commande, args, o = {}) => {
    appels.push({ commande, args, timeoutMs: o.timeoutMs });
    if (args.includes('-version')) return { stdout: 'ffmpeg version 6.1.1', stderr: '' };
    if (args.includes('-encoders')) {
      return { stdout: opts.sansEncodeur ? ' V....D libwebp' : ' V....D libwebp_anim  libwebp WebP', stderr: '' };
    }
    if (args.includes('-show_streams')) {
      if (opts.sondeErreur) throw Object.assign(new Error('boom /tmp/secret'), { code: 1, stderr: '/tmp/secret/stk-video-xyz : Invalid data' });
      return { stdout: JSON.stringify(opts.sonde || sonde()), stderr: '' };
    }
    // ffmpeg proprement dit
    actifs += 1;
    maxActifs = Math.max(maxActifs, actifs);
    try {
      await new Promise((r) => setTimeout(r, opts.dureeMs || 5));
      if (opts.ffmpegErreur) throw Object.assign(new Error('Command failed /tmp/secret'), { code: 1, stderr: 'secret ffmpeg output' });
      if (opts.ffmpegTimeout) throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGKILL' });
      const sortie = args[args.length - 1];
      if (opts.sansSortie) return { stdout: '', stderr: '' };
      fs.writeFileSync(sortie, opts.contenuSortie || GIF);
      return { stdout: '', stderr: '' };
    } finally {
      actifs -= 1;
    }
  };
  exec.appels = appels;
  Object.defineProperty(exec, 'maxActifs', { get: () => maxActifs });
  return exec;
}

const racineTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'test-stk-video-'));
const vide = (dossier) => fs.readdirSync(dossier).length === 0;

/* ── Octets magiques ───────────────────────────────────────────────────── */

test('octets magiques : MP4, MOV, 3GP et WebM reconnus', () => {
  for (const marque of ['isom', 'mp42', 'qt  ', 'M4V ', '3gp4', 'avc1']) {
    assert.strictEqual(video.typeVideoParOctets(mp4(marque)), 'mp4', marque);
  }
  assert.strictEqual(video.typeVideoParOctets(webm()), 'webm');
});

test('octets magiques : images HEIC/AVIF (même conteneur ftyp), GIF, PNG, hasard : refusés', () => {
  for (const marque of ['heic', 'heix', 'avif', 'avis', 'mif1', 'msf1']) {
    assert.strictEqual(video.typeVideoParOctets(mp4(marque)), null, `image ${marque}`);
  }
  assert.strictEqual(video.typeVideoParOctets(GIF), null);
  assert.strictEqual(video.typeVideoParOctets(Buffer.from('\x89PNG\r\n\x1a\n........')), null);
  assert.strictEqual(video.typeVideoParOctets(Buffer.alloc(64, 0xab)), null);
  assert.strictEqual(video.typeVideoParOctets(Buffer.alloc(4)), null, 'trop court');
  assert.strictEqual(video.typeVideoParOctets(null), null);
  assert.strictEqual(video.typeVideoParOctets('ftyp'), null, 'pas un Buffer');
});

/* ── Fenêtre ───────────────────────────────────────────────────────────── */

test('fenêtre : valeurs par défaut, entiers, chaînes décimales', () => {
  assert.deepStrictEqual(video.lireFenetre({}), { startMs: 0, dureeMs: 3000 });
  assert.deepStrictEqual(video.lireFenetre(), { startMs: 0, dureeMs: 3000 });
  assert.deepStrictEqual(video.lireFenetre({ start: '', duration: null }), { startMs: 0, dureeMs: 3000 });
  assert.deepStrictEqual(video.lireFenetre({ start: '1500', duration: '2500' }), { startMs: 1500, dureeMs: 2500 });
  assert.deepStrictEqual(video.lireFenetre({ start: 0, duration: 500 }), { startMs: 0, dureeMs: 500 });
  assert.deepStrictEqual(video.lireFenetre({ start: 3_600_000, duration: 3000 }), { startMs: 3_600_000, dureeMs: 3000 });
});

test('fenêtre : valeurs absurdes → 400 STICKER_INVALID_PAYLOAD, jamais corrigées', () => {
  for (const mauvais of [
    { start: -1 }, { start: '-5' }, { start: 3_600_001 }, { start: '1e3' }, { start: '12abc' }, { start: 1.5 },
    { start: 'NaN' }, { start: {} }, { start: [] }, { start: '0x10' }, { start: '99999999999' },
    { duration: 499 }, { duration: 3001 }, { duration: 0 }, { duration: '2,5' }, { duration: Infinity },
    { duration: '3000; rm -rf /' },
  ]) {
    assert.throws(() => video.lireFenetre(mauvais), (e) => e.code === 'STICKER_INVALID_PAYLOAD' && e.status === 400, JSON.stringify(mauvais));
  }
});

/* ── Lignes de commande ────────────────────────────────────────────────── */

test('ffmpeg : arguments exacts, ordre -f / -ss / -t / -i, aucun shell', () => {
  const args = video.argsFfmpeg({
    entree: '/w/in', sortie: '/w/sortie.webp', demuxeur: video.DEMUXEURS.mp4, startMs: 1234, dureeMs: 2500,
  });
  assert.ok(args.every((a) => typeof a === 'string'), 'que des chaînes');
  const i = (x) => args.indexOf(x);
  assert.strictEqual(args[args.indexOf('-protocol_whitelist') + 1], 'file', 'aucun protocole réseau');
  assert.strictEqual(args[i('-f') + 1], 'mov,mp4,m4a,3gp,3g2,mj2', 'démuxeur imposé');
  assert.ok(i('-f') < i('-ss') && i('-ss') < i('-i'), '-f puis -ss AVANT -i');
  assert.strictEqual(args[i('-ss') + 1], '1.234');
  assert.strictEqual(args[i('-t') + 1], '2.500');
  assert.strictEqual(args[i('-i') + 1], '/w/in');
  assert.ok(i('-nostdin') >= 0 && i('-an') >= 0 && i('-sn') >= 0 && i('-dn') >= 0, 'sans stdin, ni audio, ni sous-titres, ni données');
  assert.strictEqual(args[i('-map') + 1], '0:v:0');
  assert.strictEqual(args[i('-frames:v') + 1], '45');
  assert.strictEqual(args[i('-c:v') + 1], 'libwebp_anim');
  assert.strictEqual(args[i('-loop') + 1], '0');
  assert.strictEqual(args[i('-threads') + 1], '2');
  assert.strictEqual(args[args.length - 1], '/w/sortie.webp', 'la sortie est le dernier argument');
  const filtre = args[i('-vf') + 1];
  assert.ok(/^fps=15,scale=512:512:force_original_aspect_ratio=increase,crop=512:512/.test(filtre), filtre);
  // Aucun argument ne vient du client : les seules valeurs variables sont des nombres et des chemins internes.
  assert.ok(!args.some((a) => /[;&|`$<>\n]/.test(a)), 'aucun métacaractère de shell');
});

test('ffmpeg : démuxeur WebM, début à 0', () => {
  const args = video.argsFfmpeg({
    entree: '/w/in', sortie: '/w/o', demuxeur: video.DEMUXEURS.webm, startMs: 0, dureeMs: 500,
  });
  assert.strictEqual(args[args.indexOf('-f') + 1], 'matroska,webm');
  assert.strictEqual(args[args.indexOf('-ss') + 1], '0.000');
  assert.strictEqual(args[args.indexOf('-t') + 1], '0.500');
});

test('ffprobe : démuxeur imposé, protocoles réseau coupés, fichier en dernier', () => {
  const args = video.argsFfprobe({ entree: '/w/in', demuxeur: video.DEMUXEURS.webm });
  assert.strictEqual(args[args.indexOf('-protocol_whitelist') + 1], 'file');
  assert.strictEqual(args[args.indexOf('-f') + 1], 'matroska,webm');
  assert.ok(args.includes('-show_streams') && args.includes('-show_format'));
  assert.strictEqual(args[args.length - 1], '/w/in');
});

/* ── Sonde ─────────────────────────────────────────────────────────────── */

test('sonde : vidéo valide, durée et dimensions lues', () => {
  const r = video.verifierSonde(sonde(), { startMs: 2000, demuxeur: video.DEMUXEURS.mp4 });
  assert.deepStrictEqual(r, { dureeSourceMs: 10000, largeur: 1280, hauteur: 720 });
});

test('sonde : refus (pas de vidéo, image attachée, trop de flux, trop grande, trop longue, début trop tardif)', () => {
  const mp = video.DEMUXEURS.mp4;
  const ko = (s, opts, motif) => assert.throws(
    () => video.verifierSonde(s, { startMs: 0, demuxeur: mp, ...opts }),
    (e) => e.code === 'STICKER_ASSET_INVALID' && e.status === 422 && !/\/|ffprobe/i.test(e.message),
    motif,
  );
  ko(null, {}, 'null');
  ko({}, {}, 'objet vide');
  ko(sonde({ streams: [] }), {}, 'aucun flux');
  ko(sonde({ streams: [{ codec_type: 'audio' }] }), {}, 'audio seul');
  ko(sonde({ streams: [{ codec_type: 'video', width: 600, height: 400, disposition: { attached_pic: 1 } }] }), {}, 'pochette seule');
  ko(sonde({ streams: Array.from({ length: 9 }, () => ({ codec_type: 'data' })).concat([{ codec_type: 'video', width: 10, height: 10 }]) }), {}, '10 flux');
  ko(sonde({ streams: [{ codec_type: 'video', width: 4097, height: 100 }] }), {}, 'largeur 4097');
  ko(sonde({ streams: [{ codec_type: 'video', width: 100, height: 4097 }] }), {}, 'hauteur 4097');
  ko(sonde({ streams: [{ codec_type: 'video', width: 0, height: 100 }] }), {}, 'largeur 0');
  ko(sonde({ streams: [{ codec_type: 'video', width: 'x', height: 100 }] }), {}, 'largeur texte');
  ko(sonde({ format: { format_name: 'hls,applehttp', duration: '10' } }), {}, 'autre conteneur (hls)');
  ko(sonde({ format: { format_name: 'concat', duration: '10' } }), {}, 'concat');
  ko(sonde({ format: { duration: '121' } }), {}, 'plus de 2 minutes');
  ko(sonde(), { startMs: 10000 }, 'début = fin');
  ko(sonde(), { startMs: 99999 }, 'début après la fin');
});

test('sonde : durée inconnue (WebM enregistré) → acceptée, sans contrôle du début', () => {
  const r = video.verifierSonde(
    { format: { format_name: 'matroska,webm', duration: 'N/A' }, streams: [{ codec_type: 'video', width: 640, height: 480 }] },
    { startMs: 5000, demuxeur: video.DEMUXEURS.webm },
  );
  assert.strictEqual(r.dureeSourceMs, null);
  assert.strictEqual(r.largeur, 640);
});

test('sonde : la durée de la piste prend le relais de celle du conteneur', () => {
  const r = video.verifierSonde(
    sonde({ format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: undefined }, streams: [{ codec_type: 'video', width: 10, height: 10, duration: '4.5' }] }),
    { startMs: 0, demuxeur: video.DEMUXEURS.mp4 },
  );
  assert.strictEqual(r.dureeSourceMs, 4500);
});

/* ── Disponibilité ─────────────────────────────────────────────────────── */

test('disponibilité : ffmpeg absent (ENOENT) → faux, sans exception', async () => {
  video.reinitialiserDisponibilite();
  const exec = async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); };
  assert.strictEqual(await video.disponible({ exec }), false);
});

test('disponibilité : encodeur libwebp_anim requis', async () => {
  video.reinitialiserDisponibilite();
  assert.strictEqual(await video.disponible({ exec: fabriquerExec({ sansEncodeur: true }) }), false, 'libwebp seul : refusé');
  video.reinitialiserDisponibilite();
  assert.strictEqual(await video.disponible({ exec: fabriquerExec() }), true);
});

test('disponibilité : vrai gardé en mémoire ; faux retenté après 60 s seulement', async () => {
  video.reinitialiserDisponibilite();
  const exec = fabriquerExec();
  assert.strictEqual(await video.disponible({ exec, maintenant: 1000 }), true);
  const n = exec.appels.length;
  assert.strictEqual(await video.disponible({ exec, maintenant: 999_999 }), true);
  assert.strictEqual(exec.appels.length, n, 'un succès n\'est pas re-testé');

  video.reinitialiserDisponibilite();
  const absent = async () => { throw new Error('ENOENT'); };
  assert.strictEqual(await video.disponible({ exec: absent, maintenant: 0 }), false);
  let appels = 0;
  const present = async (c, a) => { appels += 1; return fabriquerExec()(c, a); };
  assert.strictEqual(await video.disponible({ exec: present, maintenant: 30_000 }), false, 'avant 60 s : on garde le faux');
  assert.strictEqual(appels, 0);
  assert.strictEqual(await video.disponible({ exec: present, maintenant: 61_000 }), true, 'après 60 s : on retente');
});

/* ── Conversion (exécuteur factice) ────────────────────────────────────── */

test('conversion : succès, ffprobe puis ffmpeg, dossier temporaire vidé, sortie conforme', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const exec = fabriquerExec();
  const r = await video.convertirVideo(mp4(), { start: 1000, duration: 2000, forme: 'cercle' }, { exec, dossierTemp: racine });
  assert.strictEqual(r.animated, true);
  assert.ok(r.bytes <= anime.LIMITES_ANIME.SORTIE_MAX_OCTETS, `poids ${r.bytes}`);
  assert.ok(r.frames >= 2 && r.frames <= 45);
  assert.ok(r.durationMs <= 3000);
  const noms = exec.appels.map((a) => path.basename(a.commande));
  assert.deepStrictEqual(noms.slice(-2), ['ffprobe', 'ffmpeg'], 'ffprobe avant ffmpeg');
  const ff = exec.appels.at(-1);
  assert.strictEqual(ff.timeoutMs, LIMITES_VIDEO.FFMPEG_MAX_MS);
  assert.strictEqual(exec.appels.at(-2).timeoutMs, LIMITES_VIDEO.FFPROBE_MAX_MS);
  // Le fichier d'entrée a un nom aléatoire SANS extension fournie par le client.
  const entree = ff.args[ff.args.indexOf('-i') + 1];
  assert.ok(/^[0-9a-f]{24}$/.test(path.basename(entree)), path.basename(entree));
  assert.ok(vide(racine), 'dossier de travail supprimé');
  fs.rmdirSync(racine);
});

test('conversion : le dossier temporaire est vidé aussi sur échec (sonde, ffmpeg, délai, sortie vide)', async () => {
  for (const [opts, message, motif] of [
    [{ sondeErreur: true }, 'vidéo illisible', 'sonde en erreur'],
    [{ ffmpegErreur: true }, 'vidéo illisible', 'ffmpeg en erreur'],
    [{ ffmpegTimeout: true }, 'conversion trop longue', 'délai dépassé'],
    [{ sansSortie: true }, 'aucune image exploitable dans cette fenêtre', 'aucun fichier produit'],
    [{ sonde: sonde({ streams: [{ codec_type: 'audio' }] }) }, 'aucune piste vidéo', 'pas de piste vidéo'],
  ]) {
    video.reinitialiserDisponibilite();
    const racine = racineTemp();
    const e = await refuse(video.convertirVideo(mp4(), {}, { exec: fabriquerExec(opts), dossierTemp: racine }), 'STICKER_ASSET_INVALID', motif, 422);
    assert.strictEqual(e.message, message, motif);
    assert.ok(vide(racine), `${motif} : dossier temporaire vidé`);
    fs.rmdirSync(racine);
  }
});

test('conversion : jamais la sortie de ffmpeg / ffprobe, ni un chemin, dans une erreur', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  for (const opts of [{ sondeErreur: true }, { ffmpegErreur: true }]) {
    video.reinitialiserDisponibilite();
    await refuse(video.convertirVideo(mp4(), {}, { exec: fabriquerExec(opts), dossierTemp: racine }), 'STICKER_ASSET_INVALID', JSON.stringify(opts));
  }
  fs.rmSync(racine, { recursive: true, force: true });
});

test('conversion : refus d\'entrée (format, poids, fenêtre, forme, vide) sans appeler ffmpeg', async () => {
  video.reinitialiserDisponibilite();
  const exec = fabriquerExec();
  const racine = racineTemp();
  const d = { exec, dossierTemp: racine };
  await refuse(video.convertirVideo(GIF, {}, d), 'STICKER_ASSET_INVALID', 'un GIF n\'est pas une vidéo');
  await refuse(video.convertirVideo(mp4('heic'), {}, d), 'STICKER_ASSET_INVALID', 'image HEIC');
  await refuse(video.convertirVideo(Buffer.alloc(0), {}, d), 'STICKER_ASSET_INVALID', 'vide');
  await refuse(video.convertirVideo(null, {}, d), 'STICKER_ASSET_INVALID', 'null');
  await refuse(video.convertirVideo(mp4('isom', LIMITES_VIDEO.ENTREE_MAX_OCTETS), {}, d), 'STICKER_ASSET_INVALID', '20 Mo + 1');
  await refuse(video.convertirVideo(mp4(), { forme: 'triangle' }, d), 'STICKER_ASSET_INVALID', 'forme');
  await refuse(video.convertirVideo(mp4(), { start: -1 }, d), 'STICKER_INVALID_PAYLOAD', 'début négatif', 400);
  await refuse(video.convertirVideo(mp4(), { duration: 100 }, d), 'STICKER_INVALID_PAYLOAD', 'durée trop courte', 400);
  assert.strictEqual(exec.appels.length, 0, 'aucun binaire lancé');
  assert.ok(vide(racine));
  fs.rmdirSync(racine);
});

test('conversion : exactement 20 Mo est accepté, un octet de plus refusé', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const pile = Buffer.concat([mp4('isom', 0), Buffer.alloc(LIMITES_VIDEO.ENTREE_MAX_OCTETS - 12, 7)]);
  assert.strictEqual(pile.length, LIMITES_VIDEO.ENTREE_MAX_OCTETS);
  const r = await video.convertirVideo(pile, {}, { exec: fabriquerExec(), dossierTemp: racine });
  assert.strictEqual(r.animated, true);
  await refuse(video.convertirVideo(Buffer.concat([pile, Buffer.alloc(1)]), {}, { exec: fabriquerExec(), dossierTemp: racine }), 'STICKER_ASSET_INVALID', '20 Mo + 1 octet');
  fs.rmSync(racine, { recursive: true, force: true });
});

test('conversion : ffmpeg absent → 422 neutre « vidéo non prise en charge »', async () => {
  video.reinitialiserDisponibilite();
  const exec = async () => { throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }); };
  const e = await refuse(video.convertirVideo(mp4(), {}, { exec }), 'STICKER_ASSET_INVALID', 'ffmpeg absent', 422);
  assert.strictEqual(e.message, 'vidéo non prise en charge');
});

test('conversion : début au-delà de la fin de la vidéo → 422', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const exec = fabriquerExec({ sonde: sonde({ format: { duration: '2.0' } }) });
  const e = await refuse(video.convertirVideo(mp4(), { start: 2000 }, { exec, dossierTemp: racine }), 'STICKER_ASSET_INVALID', 'début = fin');
  assert.strictEqual(e.message, 'début au-delà de la fin de la vidéo');
  assert.ok(!exec.appels.some((a) => a.args.includes('-nostdin')), 'ffmpeg n\'a pas été lancé');
  fs.rmSync(racine, { recursive: true, force: true });
});

test('conversion : la sortie intermédiaire trop grosse est refusée', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const gros = Buffer.alloc(LIMITES_VIDEO.INTERMEDIAIRE_MAX_OCTETS + 1, 1);
  await refuse(video.convertirVideo(mp4(), {}, { exec: fabriquerExec({ contenuSortie: gros }), dossierTemp: racine }), 'STICKER_ASSET_INVALID', 'sortie énorme');
  assert.ok(vide(racine));
  fs.rmdirSync(racine);
});

test('conversion : un seul ffmpeg à la fois (sémaphore partagé), les autres attendent', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const exec = fabriquerExec({ dureeMs: 40 });
  const semaphore = creerSemaphore({ max: 1, fileMax: 3, attenteMs: 5000 });
  const trois = await Promise.all([1, 2, 3].map(() => video.convertirVideo(mp4(), {}, { exec, dossierTemp: racine, semaphore })));
  assert.strictEqual(trois.length, 3);
  assert.strictEqual(exec.maxActifs, 1, `ffmpeg simultanés : ${exec.maxActifs}`);
  assert.ok(vide(racine));
  fs.rmdirSync(racine);
});

test('conversion : file pleine → 503 SERVICE_UNAVAILABLE retryable (jamais un échec définitif)', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const exec = fabriquerExec({ dureeMs: 80 });
  const semaphore = creerSemaphore({ max: 1, fileMax: 0, attenteMs: 5000 });
  const premiere = video.convertirVideo(mp4(), {}, { exec, dossierTemp: racine, semaphore });
  await new Promise((r) => setTimeout(r, 15));
  try {
    await video.convertirVideo(mp4(), {}, { exec, dossierTemp: racine, semaphore });
    assert.fail('aurait dû être refusé');
  } catch (e) {
    assert.ok(e instanceof SlotOccupe, e.message);
    assert.deepStrictEqual([e.status, e.code], [503, 'SERVICE_UNAVAILABLE']);
    assert.ok(Number.isInteger(e.retryAfterS));
  }
  await premiere;
  fs.rmSync(racine, { recursive: true, force: true });
});

test('conversion : une conversion en échec libère le sémaphore', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const semaphore = creerSemaphore({ max: 1, fileMax: 0, attenteMs: 50 });
  await refuse(video.convertirVideo(mp4(), {}, { exec: fabriquerExec({ ffmpegErreur: true }), dossierTemp: racine, semaphore }), 'STICKER_ASSET_INVALID', 'échec');
  const r = await video.convertirVideo(mp4(), {}, { exec: fabriquerExec(), dossierTemp: racine, semaphore });
  assert.strictEqual(r.animated, true, 'le slot est libre après l\'échec');
  fs.rmSync(racine, { recursive: true, force: true });
});

/* ── Création : quotas et liste de blocage ─────────────────────────────── */

test('création : quotas lus AVANT la conversion (ffmpeg jamais lancé)', async () => {
  video.reinitialiserDisponibilite();
  const exec = fabriquerExec();
  for (const usage of [
    { assets: asset.LIMITES.ASSETS_PAR_COMPTE, uploadsDerniereHeure: 0 },
    { assets: 0, uploadsDerniereHeure: asset.LIMITES.UPLOADS_PAR_HEURE },
  ]) {
    await refuse(video.preparerAssetVideo(mp4(), { ownerId: 7 }, { exec, usage: async () => usage }), 'STICKER_QUOTA_EXCEEDED', JSON.stringify(usage), 429);
  }
  assert.strictEqual(exec.appels.length, 0);
});

test('création : empreinte du fichier FINAL bloquée → STICKER_ASSET_BLOCKED', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const vus = [];
  await refuse(video.preparerAssetVideo(mp4(), { ownerId: 7 }, {
    exec: fabriquerExec(),
    dossierTemp: racine,
    usage: async () => ({ assets: 0, uploadsDerniereHeure: 0 }),
    estBloque: async (sha) => { vus.push(sha); return true; },
  }), 'STICKER_ASSET_BLOCKED', 'liste de blocage', 422);
  assert.ok(/^[0-9a-f]{64}$/.test(vus[0]), 'empreinte sha256 transmise');
  fs.rmSync(racine, { recursive: true, force: true });
});

test('création : l\'espace officiel (ownerId 0) n\'est pas soumis aux quotas', async () => {
  video.reinitialiserDisponibilite();
  const racine = racineTemp();
  const r = await video.preparerAssetVideo(mp4(), { ownerId: 0 }, {
    exec: fabriquerExec(),
    dossierTemp: racine,
    usage: async () => { throw new Error('ne doit pas être lu'); },
  });
  assert.strictEqual(r.animated, true);
  fs.rmSync(racine, { recursive: true, force: true });
});

/* ── Le plafond des GIF reste 3 Mo (multer laisse passer 20 Mo pour la vidéo) ── */

test('GIF / WebP animé : toujours 3 Mo au plus, contrôlé sur le format RÉEL', async () => {
  const limite = anime.LIMITES_ANIME.ENTREE_MAX_OCTETS;
  const gros = Buffer.concat([GIF.subarray(0, 6), Buffer.alloc(limite + 1 - 6, 1)]);
  await refuse(anime.convertirAnime(gros), 'STICKER_ASSET_INVALID', 'GIF de 3 Mo + 1', 422);
  // Seule la conversion d'une vidéo relève ce plafond, pour SON WebP intermédiaire.
  const e = await anime.convertirAnime(gros, { entreeMaxOctets: 16 * 1024 * 1024 }).catch((x) => x);
  assert.notStrictEqual(e.message, 'fichier trop lourd (3 Mo maximum)', 'le plafond relevé est bien pris en compte');
});

/* ── Sécurité du module ────────────────────────────────────────────────── */

test('sécurité : aucun appel à un shell dans le module (execFile uniquement)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'stickerVideo.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const imports = source.match(/const \{([^}]*)\} = require\('child_process'\)/);
  assert.ok(imports, 'import de child_process attendu');
  assert.deepStrictEqual(imports[1].split(',').map((x) => x.trim()).filter(Boolean), ['execFile'], 'seul execFile est importé (ni exec, ni spawn, ni fork)');
  assert.ok(!/require\('child_process'\)\.(exec|spawn|fork)/.test(source), 'aucun accès direct à exec/spawn/fork');
  assert.ok(!/\bshell\s*:\s*true/.test(source), 'shell: true interdit');
  assert.ok(!/\bspawn\s*\(/.test(source), 'pas de spawn');
  assert.ok(/shell:\s*false/.test(source), 'shell: false explicite');
  assert.ok(/-protocol_whitelist/.test(source));
});

test('sécurité : le processus enfant ne reçoit pas les secrets du serveur', async () => {
  // Le vrai exécuteur, sur un binaire inoffensif : `node -e` affiche son environnement.
  process.env.SECRET_TEST_STICKER = 'valeur-secrete';
  const r = await video.executerBinaire(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))'], { timeoutMs: 5000 });
  const cles = JSON.parse(r.stdout);
  assert.ok(!cles.includes('SECRET_TEST_STICKER'), `fuite : ${cles}`);
  assert.ok(cles.includes('PATH'));
  delete process.env.SECRET_TEST_STICKER;
});

test('sécurité : délai dépassé → processus tué (killed), pas de blocage', async () => {
  const debut = Date.now();
  try {
    await video.executerBinaire(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 300 });
    assert.fail('aurait dû être interrompu');
  } catch (e) {
    assert.strictEqual(e.killed, true);
    assert.ok(Date.now() - debut < 5000, 'tué dans les temps');
  }
});

test('sécurité : sortie trop volumineuse → interrompu', async () => {
  try {
    await video.executerBinaire(process.execPath, ['-e', 'process.stdout.write("x".repeat(5e6))'], { timeoutMs: 5000, maxBuffer: 1000 });
    assert.fail('aurait dû être interrompu');
  } catch (e) {
    assert.ok(e, 'maxBuffer dépassé');
  }
});

(async () => {
  let ok = 0;
  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n  ') : e}`);
      process.exit(1);
    }
  }
  console.log(`stickerVideo.test.js : ${ok} tests OK`);
})();
