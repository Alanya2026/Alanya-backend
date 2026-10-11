/**
 * Suppression de compte et export — données stickers (type 10).
 * `node src/services/accountDeletionStickers.test.js`.
 *
 * T8a : `user_sticker_pack`, `user_sticker_favorite` et `sticker_report`
 * (rapporteur) partent avec le compte, ainsi que le contenu privé (packs et
 * lignes d'actifs dont le compte est propriétaire) ; l'officiel n'est jamais
 * visé. AUCUN fichier n'est supprimé (décision propriétaire 11/10/2026).
 * L'export de données inclut ces lignes (plan §4). Contrôle par un
 * `../config/db` doublé — même patron que `stickerRoutes.test.js`.
 */
const assert = require('assert');
const path = require('path');

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

let ok = 0;
const tests = [];
const test = (nom, fn) => { tests.push([nom, fn]); };

(async () => {
  const requetes = [];
  const journal = [];
  const conn = {
    execute: async (sql, p) => {
      requetes.push([sql, p]);
      journal.push(sql);
      return [[], []];
    },
    beginTransaction: async () => { journal.push('BEGIN'); },
    commit: async () => { journal.push('COMMIT'); },
    rollback: async () => { throw new Error('rollback inattendu'); },
    release: () => {},
  };
  const pool = {
    execute: async (sql, p) => {
      requetes.push([sql, p]);
      if (/SELECT alanyaID FROM users/i.test(sql)) return [[{ alanyaID: 42 }], []];
      return [[], []];
    },
    getConnection: async () => conn,
  };
  remplace('../config/db', pool);
  const svc = require('./accountDeletionService');

  const trouve = (re) => requetes.find(([sql]) => re.test(sql));

  test('la purge supprime les données stickers du compte', async () => {
    requetes.length = 0;
    await svc.purgeExpiredAccounts();

    const packs = trouve(/DELETE FROM user_sticker_pack WHERE alanyaID/i);
    const favoris = trouve(/DELETE FROM user_sticker_favorite WHERE alanyaID/i);
    const signalements = trouve(/DELETE FROM sticker_report WHERE reporter_id/i);
    const packsPrives = trouve(/DELETE FROM sticker_pack WHERE owner_id/i);
    const actifsPrives = trouve(/DELETE FROM sticker_asset WHERE owner_id/i);

    assert.ok(packs, 'packs installés non supprimés');
    assert.ok(favoris, 'favoris non supprimés');
    assert.ok(signalements, 'signalements du rapporteur non supprimés');
    assert.ok(packsPrives, 'packs privés non supprimés');
    assert.ok(actifsPrives, 'actifs privés non supprimés');
    // L'officiel (owner_id = 0) n'est jamais visé : le paramètre est le compte.
    assert.deepStrictEqual(actifsPrives[1], [42]);
    assert.deepStrictEqual(packsPrives[1], [42]);
  });

  test('aucun fichier supprimé, aucun job posé : la purge ne touche que la base', async () => {
    requetes.length = 0;
    journal.length = 0;
    await svc.purgeExpiredAccounts();

    assert.ok(!requetes.some(([sql]) => /job_queue/i.test(sql)), 'aucun job posé (décision propriétaire : fichiers conservés)');
    const lu = require('fs').readFileSync(path.join(__dirname, 'accountDeletionService.js'), 'utf8');
    assert.ok(!/removeAllVersions|stickerFilesPurge|mediaStorage/.test(lu.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')),
      "le service n'appelle aucune suppression de fichier sticker");
    assert.ok(!require('fs').existsSync(path.join(__dirname, 'stickerFilesPurge.js')), 'plus de module de purge de fichiers');

    // Les lignes d'actifs partent, avant le compte ; la clé de stockage n'est même plus lue.
    const iUser = journal.findIndex((x) => /DELETE FROM users WHERE alanyaID/i.test(x));
    const iActifs = journal.findIndex((x) => /DELETE FROM sticker_asset WHERE owner_id/i.test(x));
    assert.ok(iActifs > -1 && iUser > iActifs, 'actifs (lignes) supprimés avant le compte');
    assert.ok(!journal.some((x) => /SELECT[\s\S]*storage_key[\s\S]*FROM sticker_asset/i.test(x)), 'aucune clé de stockage lue');
  });

  test("le retrait admin (takedownAsset) ne supprime aucun fichier : base seulement", async () => {
    const lu = require('fs').readFileSync(path.join(__dirname, 'stickerAdminService.js'), 'utf8');
    const debut = lu.indexOf('async function takedownAsset');
    const corps = lu.slice(debut, lu.indexOf('\n}\n', debut)).replace(/\/\/.*$/gm, '');
    assert.ok(debut > -1 && !/removeAllVersions|storage\./.test(corps), "takedownAsset n'efface aucun fichier");
    const vus = [];
    const db = { execute: async (sql, p) => { vus.push(sql); return [/SELECT id, sha256/i.test(sql) ? [{ id: 5, sha256: 'a'.repeat(64) }] : [], []]; } };
    await require('./stickerAdminService').takedownAsset(5, { by: 1 }, db);
    assert.ok(vus.some((x) => /UPDATE sticker_asset SET status = 1/i.test(x)), 'status = 1');
    assert.ok(vus.some((x) => /INSERT IGNORE INTO sticker_blocklist/i.test(x)), 'empreinte bloquée');
    assert.ok(!vus.some((x) => /DELETE/i.test(x)), 'aucune suppression de ligne ni de fichier');
  });

  test("l'empreinte d'un actif retiré par un admin reste bloquée ; la liste n'est jamais vidée", async () => {
    requetes.length = 0;
    journal.length = 0;
    await svc.purgeExpiredAccounts();

    const blocage = trouve(/INSERT IGNORE INTO sticker_blocklist/i);
    assert.ok(blocage, 'les empreintes retirées par un admin sont (re)posées dans la liste de blocage');
    assert.match(blocage[0], /status = 1/i, 'seulement les actifs retirés');
    assert.deepStrictEqual(blocage[1], [42]);
    assert.ok(!trouve(/DELETE\s+(\w+\s+)?FROM\s+sticker_blocklist/i), 'sticker_blocklist n\'est jamais purgée');
    const iBloc = journal.findIndex((x) => /INSERT IGNORE INTO sticker_blocklist/i.test(x));
    const iActifs = journal.findIndex((x) => /DELETE FROM sticker_asset WHERE owner_id/i.test(x));
    assert.ok(iBloc < iActifs, "l'empreinte est posée AVANT la suppression de l'actif");
  });

  test('favoris et installations des tiers sur les stickers du compte partent aussi', async () => {
    requetes.length = 0;
    await svc.purgeExpiredAccounts();
    assert.ok(trouve(/DELETE f FROM user_sticker_favorite f[\s\S]+p\.owner_id = \?/i), 'favoris de tiers sur ses packs');
    assert.ok(trouve(/DELETE f FROM user_sticker_favorite f[\s\S]+a\.owner_id = \?/i), 'favoris de tiers sur ses actifs');
    assert.ok(trouve(/DELETE FROM user_sticker_pack WHERE pack_id IN \(SELECT id FROM sticker_pack WHERE owner_id = \?\)/i),
      "installations (lien) de ses packs par d'autres");
  });

  test("table absente (migration 097 non jouée) : la purge n'échoue pas", async () => {
    requetes.length = 0;
    const errConn = {
      execute: async (sql, p) => {
        requetes.push([sql, p]);
        if (/user_sticker_pack|user_sticker_favorite|sticker_report|sticker_pack|sticker_asset/i.test(sql)) {
          const e = new Error('table inconnue');
          e.code = 'ER_NO_SUCH_TABLE';
          throw e;
        }
        return [[], []];
      },
      beginTransaction: async () => {},
      commit: async () => {},
      rollback: async () => { throw new Error('rollback inattendu'); },
      release: () => {},
    };
    pool.getConnection = async () => errConn;
    try {
      await svc.purgeExpiredAccounts();
    } finally {
      pool.getConnection = async () => conn;
    }
    assert.ok(trouve(/DELETE FROM users WHERE alanyaID/i), 'la suppression du compte continue');
  });

  test("l'export inclut les packs installés et les favoris", async () => {
    const db = {
      execute: async (sql) => {
        if (/FROM user_sticker_pack/i.test(sql)) {
          return [[{ pack_id: 3, code: 'mboa', position: 0, added_at: new Date() }], []];
        }
        if (/FROM user_sticker_favorite/i.test(sql)) {
          return [[{ sticker_id: 9, added_at: new Date() }], []];
        }
        return [[], []];
      },
    };
    const { chargeStickersExport } = require('./stickerStore');
    const r = await chargeStickersExport(42, db);
    assert.strictEqual(r.installedPacks.length, 1);
    assert.strictEqual(r.installedPacks[0].code, 'mboa');
    assert.strictEqual(r.favorites.length, 1);
    assert.strictEqual(r.favorites[0].sticker_id, 9);
  });

  test("l'export inclut packs perso (métadonnées + stickers) et signalements émis", async () => {
    const vus = [];
    const db = {
      execute: async (sql, p) => {
        vus.push([sql, p]);
        if (/FROM sticker_pack p[\s\S]*WHERE p\.owner_id = \?/i.test(sql) && !/JOIN sticker s/i.test(sql)) {
          return [[
            { id: 5, code: 'u_42_ab12cd34', name_i18n: '{"fr":"Mes têtes","en":"My faces"}', description_i18n: null,
              visibility: 2, status: 1, share_token: 'T'.repeat(24), version: 3, created_at: new Date('2026-09-01') },
            { id: 6, code: 'u_42_00000000', name_i18n: { fr: 'Vide' }, description_i18n: null,
              visibility: 1, status: 0, share_token: null, version: 1, created_at: new Date('2026-09-02') },
          ], []];
        }
        if (/FROM sticker s[\s\S]*JOIN sticker_pack p/i.test(sql)) {
          return [[
            { id: 90, pack_id: 5, position: 0, emoji: '😀', name_i18n: '{"fr":"Content"}', asset_id: 11, animated: 0 },
            { id: 91, pack_id: 5, position: 1, emoji: '😢', name_i18n: null, asset_id: 12, animated: 1 },
          ], []];
        }
        if (/FROM sticker_report/i.test(sql)) {
          return [[{ id: 1, asset_id: 77, reason: 1, status: 0, created_at: new Date('2026-09-05') }], []];
        }
        return [[], []];
      },
    };
    const { chargeStickersExport } = require('./stickerStore');
    const r = await chargeStickersExport(42, db);

    assert.strictEqual(r.createdPacks.length, 2);
    const [p1, p2] = r.createdPacks;
    assert.strictEqual(p1.code, 'u_42_ab12cd34');
    assert.deepStrictEqual(p1.name, { fr: 'Mes têtes', en: 'My faces' });
    assert.strictEqual(p1.shared, true);
    assert.ok(!('share_token' in p1) && !JSON.stringify(r).includes('T'.repeat(24)), 'le jeton de partage ne sort pas dans le fichier');
    assert.deepStrictEqual(p1.stickers.map((s) => [s.id, s.emoji, s.position]), [[90, '😀', 0], [91, '😢', 1]]);
    assert.deepStrictEqual(p1.stickers[0].name, { fr: 'Content' });
    assert.strictEqual(p1.stickers[1].animated, true);
    assert.strictEqual(p2.shared, false);
    assert.deepStrictEqual(p2.stickers, []);

    assert.deepStrictEqual(r.reports, [{ asset_id: 77, reason: 'spam', status: 0, created_at: new Date('2026-09-05') }]);
    assert.ok(!JSON.stringify(r).includes('storage_key') && !/\.webp/.test(JSON.stringify(r)), 'pas de fichier ni de clé de stockage');
    // Seuls les packs actifs du compte, via le JWT.
    const reqPacks = vus.find(([sql]) => /FROM sticker_pack p/i.test(sql) && !/JOIN sticker s/i.test(sql));
    assert.match(reqPacks[0], /p\.status <> 2/);
    assert.deepStrictEqual(reqPacks[1], [42]);
  });

  test("le contrôleur d'export rend une section stickers même si 097 manque", async () => {
    const lu = require('fs').readFileSync(path.join(__dirname, '../controllers/accountLifecycleController.js'), 'utf8');
    assert.ok(/installedPacks: \[\], favorites: \[\], createdPacks: \[\], reports: \[\]/.test(lu), 'repli ER_NO_SUCH_TABLE complet');
  });

  for (const [nom, fn] of tests) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n  ${e.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`accountDeletionStickers.test.js : ${ok} tests OK`);
})().catch((e) => { console.error(e); process.exit(1); });
