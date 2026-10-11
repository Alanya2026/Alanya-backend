/**
 * Rétention des fichiers stickers — `node src/services/stickerRetention.test.js`.
 *
 * Plan §9 : `official/` n'est jamais purgé ; `stickers/` est exempté de la
 * purge « média de conversation » (c'est la suppression §4 qui s'applique).
 * Un sticker de plus de 100 jours — de plus de 365 aussi — reste donc servi :
 * la purge ne le sélectionne pas, le garde 410 ne le juge pas, et le registre
 * des purges déclare l'exemption. Le SQL n'est pas exécuté (CI sans base) : la
 * sélection est rejouée par un double qui applique le motif LIKE et l'âge du
 * prédicat réel.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
require.cache[resolu('../config/db')] = {
  id: resolu('../config/db'), filename: resolu('../config/db'), loaded: true,
  exports: { execute: async () => [[], []], query: async () => [[], []] },
};

const { expiredMediaWhere, purgeExpiredMediaBatch } = require('./mediaRetention');
const registry = require('./purgeRegistry');
const policy = require('../constants/mediaRetentionPolicy');
const { mediaExpiryGuard } = require('../middleware/mediaExpiry');
const storage = require('./mediaStorage');

const JOUR = 24 * 3600 * 1000;
const H = 'a'.repeat(64);
const SEL = 'a1b2c3d4e5f60718';
const il_y_a = (jours) => new Date(Date.now() - jours * JOUR);

// Messages : un sticker perso, un sticker officiel, et un vrai média de conversation.
const MESSAGES = [
  { msgID: 1, type: 10, mediaUrl: storage.publicUrl(`stickers/u/42/${SEL}_${H}.webp`), sendAt: il_y_a(150) },
  { msgID: 2, type: 10, mediaUrl: storage.publicUrl(`stickers/u/42/${SEL}_${H}.webp`), sendAt: il_y_a(900) },
  { msgID: 3, type: 10, mediaUrl: storage.publicUrl('official/stickers/mboa/1_abcd1234.webp'), sendAt: il_y_a(150) },
  { msgID: 4, type: 1, mediaUrl: 'https://alanya237.com/uploads/media/2025-01/images/x.jpg', sendAt: il_y_a(150) },
];

// Double de `db.execute` : applique le motif LIKE et la date du prédicat réel.
const dbDouble = () => ({
  execute: async (sql, params) => {
    if (/^\s*UPDATE/i.test(sql)) return [{ affectedRows: params.length }, []];
    const like = /m\.mediaUrl LIKE '([^']+)'/.exec(sql);
    assert.ok(like, 'le prédicat réel filtre par motif LIKE');
    const re = new RegExp(`^${like[1].split('%').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    const jours = params[0];
    const rows = MESSAGES.filter((m) => m.mediaUrl && re.test(m.mediaUrl)
      && m.sendAt < new Date(Date.now() - jours * JOUR));
    return [rows.map((r) => ({ msgID: r.msgID, mediaUrl: r.mediaUrl })), []];
  },
});

let ok = 0;
const tests = [];
const test = (nom, fn) => tests.push([nom, fn]);

(async () => {
  test('un sticker de plus de 100 jours (et de plus de 365) reste servi : la purge ne le voit pas', async () => {
    const supprimes = [];
    const n = await purgeExpiredMediaBatch(dbDouble(), { standardDays: 100, paliers: 'aucun' },
      { supprimerFichier: (u) => supprimes.push(u) });
    // Contrôle du double : le vrai média de conversation de 150 jours, lui, est bien pris.
    assert.deepStrictEqual(supprimes, [MESSAGES[3].mediaUrl], 'seul le média de conversation expire');
    assert.strictEqual(n, 1);
    for (const m of MESSAGES.slice(0, 3)) {
      assert.ok(!supprimes.includes(m.mediaUrl), `sticker ${m.msgID} intact`);
    }
  });

  test('le prédicat réel ne désigne que /uploads/media/ (pas stickers/, pas official/)', () => {
    const w = expiredMediaWhere({ standardDays: 100 });
    assert.ok(w.sql.includes("m.mediaUrl LIKE '%/uploads/media/%'"));
    assert.ok(!/stickers|official/.test(w.sql), 'aucune clé sticker dans le prédicat');
    for (const m of MESSAGES.slice(0, 3)) {
      assert.ok(!m.mediaUrl.includes('/uploads/media/'), `l'URL du sticker ${m.msgID} n'est pas sous /uploads/media/`);
    }
  });

  test('le garde 410 ne juge pas un sticker : aucune date dans son chemin, il passe', () => {
    const maintenant = Date.now();
    const garde = mediaExpiryGuard({ retentionDays: 100, now: () => maintenant + 900 * JOUR });
    for (const chemin of [`/stickers/u/42/${SEL}_${H}.webp`, `/stickers/u/42/${SEL}_${H}_t.webp`,
      '/official/stickers/mboa/1_abcd1234.webp']) {
      let suite = false;
      const res = { status: () => { throw new Error(`410 inattendu pour ${chemin}`); } };
      garde({ path: chemin }, res, () => { suite = true; });
      assert.ok(suite, `${chemin} servi`);
    }
  });

  test('le registre des purges déclare l\'exemption sticker/official du média de conversation', async () => {
    assert.deepStrictEqual(policy.PREFIXES_JAMAIS_PURGES, ['official/', 'stickers/']);
    const media = registry.DESCRIPTORS.media;
    assert.deepStrictEqual(media.exempte, policy.PREFIXES_JAMAIS_PURGES);
    assert.match(media.description, /stickers\//);
    assert.match(media.description, /official\//);
  });

  test('aucune autre purge du registre ne touche aux fichiers ou lignes stickers', () => {
    const src = require('fs').readFileSync(path.join(__dirname, 'purgeRegistry.js'), 'utf8');
    assert.ok(!/DELETE\s+FROM\s+(sticker|user_sticker)/i.test(src), 'le registre ne supprime aucune table stickers');
  });

  // A13 (décision du propriétaire, 11/10/2026) : aucune suppression de fichier de
  // sticker. Seuls les blocs `catch` d'un dépôt échoué/annulé nettoient des
  // fichiers JAMAIS référencés. Garde-fou de source : toute nouvelle occurrence
  // de `removeAllVersions` dans les services stickers fait échouer ce test.
  test('aucune suppression de fichier de sticker hors des catch d\'un dépôt échoué (A13)', () => {
    const fs = require('fs');
    const sans = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const corps = (src, debut) => {
      const i = src.indexOf(debut);
      assert.ok(i > -1, `fonction introuvable : ${debut}`);
      const j = src.indexOf('\nasync function ', i + 10);
      const k = src.indexOf('\nfunction ', i + 10);
      const fin = [j, k].filter((x) => x > -1).sort((a, b) => a - b)[0];
      return src.slice(i, fin === undefined ? undefined : fin);
    };
    // Aucune occurrence du tout.
    for (const f of ['stickerAdminService.js', 'stickerStore.js', 'accountDeletionService.js']) {
      assert.ok(!/removeAllVersions|\.removeObject|deleteObject/.test(sans(f)), `${f} ne supprime aucun fichier`);
    }
    // Suppressions par l'utilisateur : base seulement.
    const perso = sans('stickerPersonalService.js');
    assert.ok(!/removeAllVersions/.test(corps(perso, 'async function supprimerAssetPerso')), 'supprimerAssetPerso');
    const pack = sans('stickerPackService.js');
    for (const f of ['async function archiverPack', 'async function retirerStickerDuPack', 'async function purgerStickers']) {
      assert.ok(!/removeAllVersions|retirerFichiers/.test(corps(pack, f)), f);
    }
    // Les seuls appels restants : catch d'un dépôt échoué (rollback), fichiers jamais référencés.
    const occurrences = (src) => (src.match(/removeAllVersions/g) || []).length;
    assert.strictEqual(occurrences(perso), 2, 'création + copie : catch uniquement');
    assert.strictEqual(occurrences(pack), 1, 'retirerFichiers (rollback d\'une installation)');
    assert.strictEqual((pack.match(/retirerFichiers\(/g) || []).length, 2, 'définition + un seul appel');
    for (const src of [perso, sans('stickerAssetService.js')]) {
      for (const m of src.matchAll(/removeAllVersions/g)) {
        const avant = src.slice(0, m.index);
        assert.ok(avant.lastIndexOf('} catch') > avant.lastIndexOf('await conn.commit()'), 'après le commit : jamais');
      }
    }
    const appel = pack.indexOf('await retirerFichiers(deposes)');
    assert.ok(appel > pack.lastIndexOf('} catch (e) {', appel) && pack.lastIndexOf('} catch (e) {', appel) > -1, 'dans un catch');
  });

  for (const [nom, fn] of tests) {
    try { await fn(); ok += 1; } catch (e) { console.error(`✗ ${nom}\n  ${e.stack}`); process.exitCode = 1; }
  }
  console.log(`stickerRetention.test.js : ${ok} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
