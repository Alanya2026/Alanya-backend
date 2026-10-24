/**
 * Garde-fou du lot 6 : tant que la migration 108 (six dossiers) n'est pas
 * passée, le coffre répond « indisponible » sans rien écrire en base ; dès
 * qu'elle l'est, il repart sans redémarrage — `npm run test:safebox`.
 */

const assert = require('assert');
const crypto = require('crypto');
const { createSafeboxService } = require('./service');
const { SafeboxError } = require('./errors');

let ok = 0;
const etapes = [];
const test = (nom, fn) => etapes.push([nom, fn]);

/** Une base qui ne répond qu'à la question du schéma, et note tout le reste. */
function fausseBase() {
  const base = { migree: false, ecritures: [] };
  base.query = async (sql) => {
    if (sql.includes('information_schema')) return [[{ n: base.migree ? 1 : 0 }]];
    base.ecritures.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
    throw new Error('fin du test : la garde est passée');
  };
  return base;
}

const service = (db) => createSafeboxService({
  db,
  env: { SAFEBOX_KEY: crypto.randomBytes(32).toString('base64') },
  getStorage: () => ({}),
  getSettings: async () => ({}),
  spaceFor: async () => ({ quotaBytes: 0, maxFileBytes: 0, plus: false }),
});

test('sans la migration 108 : indisponible, aucune écriture', async () => {
  const db = fausseBase();
  const svc = service(db);
  for (const appel of [() => svc.overview(1), () => svc.updateFile(1, 5, { folderId: 9 }), () => svc.addToFolder(1, 9, { fileIds: [5] })]) {
    await assert.rejects(appel(), (e) => e instanceof SafeboxError && e.code === 'SAFEBOX_UNAVAILABLE' && e.status === 503);
  }
  assert.deepStrictEqual(db.ecritures, []);
});

test('migration appliquée ensuite : le coffre repart sans redémarrage', async () => {
  const db = fausseBase();
  const svc = service(db);
  await assert.rejects(svc.overview(1), (e) => e.code === 'SAFEBOX_UNAVAILABLE');
  db.migree = true;
  await assert.rejects(svc.overview(1), /la garde est passée/);
  assert.deepStrictEqual(db.ecritures, ['INSERT IGNORE INTO']);
});

(async () => {
  for (const [nom, fn] of etapes) {
    try {
      await fn();
      ok += 1;
    } catch (e) {
      console.error(`✗ ${nom}\n`, e);
      process.exit(1);
    }
  }
  console.log(`safebox/service : ${ok}/${etapes.length} tests passés`);
  process.exit(0);
})();
