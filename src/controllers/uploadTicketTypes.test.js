// Types de fichier acceptés en pièce jointe : ceux que le package `mime` de
// l'application annonce pour les documents courants (Office à macros,
// diaporamas, epub, vcf…) passent ; ce qui peut exécuter du script dans un
// navigateur reste refusé. Stockage et plafonds sont des doubles.
const assert = require('assert');

const MB = 1024 * 1024;

const stub = (rel, exports) => {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
stub('../services/mediaStorage', {
  isB2Enabled: () => true,
  safeExt: () => '.bin',
  newMediaKey: () => 'media/files/2026-10-21/x.bin',
  newImageKey: () => 'avatars/x.jpg',
  presignUpload: async () => ({ url: 'https://r2.test/put', headers: {}, expiresIn: 600 }),
  publicUrl: (k) => `https://cdn.test/${k}`,
});
stub('../services/billing/uploadLimits', {
  limitsFor: async () => ({ maxUploadBytes: 100 * MB, maxAlbumItems: 30 }),
  invalidateUploadLimits: () => {},
});

const { uploadTicket } = require('./uploadController');

const call = async (fileName, mimetype) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await uploadTicket({ user: { alanyaID: 7 }, body: { kind: 'media', fileName, mimetype, size: MB } }, res);
  return res;
};

// Type renvoyé par `lookupMimeType` (package mime 2.0.0) pour chaque extension.
const ACCEPTES = {
  'cours.pptm': 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
  'rapport.docm': 'application/vnd.ms-word.document.macroenabled.12',
  'budget.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
  'budget.xlsb': 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
  'expo.ppsx': 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'expo.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  'expo.pps': 'application/vnd.ms-powerpoint',
  'modele.potx': 'application/vnd.openxmlformats-officedocument.presentationml.template',
  'modele.potm': 'application/vnd.ms-powerpoint.template.macroenabled.12',
  'modele.dotx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'modele.dotm': 'application/vnd.ms-word.template.macroenabled.12',
  'modele.xltx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
  'modele.xltm': 'application/vnd.ms-excel.template.macroenabled.12',
  'livre.epub': 'application/epub+zip',
  'facture.xps': 'application/vnd.ms-xpsdocument',
  'schema.odg': 'application/vnd.oasis.opendocument.graphics',
  'notes.md': 'text/markdown',
  'export.json': 'application/json',
  'contact.vcf': 'text/x-vcard',
  'rdv.ics': 'text/calendar',
  'sources.tar': 'application/x-tar',
  'sources.tar.gz': 'application/gzip',
  'photo.heic': 'image/heic',
  'photo.heif': 'image/heif',
  'scan.bmp': 'image/bmp',
  'scan.tiff': 'image/tiff',
  'film.mkv': 'video/x-matroska',
  'film.avi': 'video/x-msvideo',
};

const REFUSES = {
  'dessin.svg': 'image/svg+xml',
  'page.html': 'text/html',
  'flux.xml': 'application/xml',
  'setup.exe': 'application/x-msdownload',
  'inconnu.xyz': 'application/octet-stream',
};

(async () => {
  for (const [nom, type] of Object.entries(ACCEPTES)) {
    const r = await call(nom, type);
    assert.strictEqual(r.code, 200, `${nom} (${type}) doit passer`);
    assert.strictEqual(r.body.mode, 'direct');
  }

  // L'IANA écrit `macroEnabled` : la casse ne doit pas faire refuser.
  const r = await call('cours.pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12');
  assert.strictEqual(r.code, 200, 'type en casse IANA');

  for (const [nom, type] of Object.entries(REFUSES)) {
    const r2 = await call(nom, type);
    assert.strictEqual(r2.code, 400, `${nom} (${type}) doit être refusé`);
    assert.strictEqual(r2.body.code, 'INVALID_EXTENSION');
  }

  console.log('uploadTicketTypes.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
