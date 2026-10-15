/**
 * `node src/services/safebox/storage.test.js` — client MEGA S4 du coffre, sur
 * un faux client S3 : aucune requête ne part.
 */

const assert = require('assert');
const {
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { createStorage, configFrom } = require('./storage');

let ok = 0;
const test = async (nom, fn) => {
  try {
    await fn();
    ok += 1;
  } catch (e) {
    console.error(`✗ ${nom}\n  ${e.stack}`);
    process.exitCode = 1;
  }
};

/** Faux bucket : des objets en mémoire, des pages de `page` objets. */
function fauxClient({ objets = [], page = 1000, refuseGroupe = false } = {}) {
  const contenu = new Map(objets.map((o) => [o.key, o.size]));
  const appels = [];
  return {
    contenu,
    appels,
    async send(cmd) {
      appels.push(cmd.constructor.name);
      if (cmd instanceof ListObjectsV2Command) {
        const cles = [...contenu.keys()].filter((k) => k.startsWith(cmd.input.Prefix)).sort();
        const debut = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
        const tranche = cles.slice(debut, debut + page);
        const suite = debut + page < cles.length;
        return {
          Contents: tranche.map((k) => ({ Key: k, Size: contenu.get(k) })),
          IsTruncated: suite,
          NextContinuationToken: suite ? String(debut + page) : undefined,
        };
      }
      if (cmd instanceof DeleteObjectsCommand) {
        if (refuseGroupe) throw Object.assign(new Error('NotImplemented'), { name: 'NotImplemented' });
        for (const o of cmd.input.Delete.Objects) contenu.delete(o.Key);
        return {};
      }
      if (cmd instanceof DeleteObjectCommand) {
        contenu.delete(cmd.input.Key);
        return {};
      }
      throw new Error(`commande inattendue ${cmd.constructor.name}`);
    },
  };
}

(async () => {
  await test('adresse d\'envoi : taille exacte signée', async () => {
    let vu;
    const storage = createStorage({
      client: fauxClient(),
      bucket: 'safebox',
      sign: async (client, cmd, opts) => { vu = { cmd, opts }; return 'https://signee'; },
    });
    assert.strictEqual(await storage.uploadUrl('u/t/f/00001', 1234, 60), 'https://signee');
    assert.ok(vu.cmd instanceof PutObjectCommand);
    assert.deepStrictEqual(vu.cmd.input, { Bucket: 'safebox', Key: 'u/t/f/00001', ContentLength: 1234 });
    assert.ok(vu.opts.signableHeaders.has('content-length'));
    assert.strictEqual(vu.opts.expiresIn, 60);
  });

  await test('liste : toutes les pages, rien hors du préfixe', async () => {
    const objets = [];
    for (let n = 1; n <= 5; n += 1) objets.push({ key: `u/t/a/0000${n}`, size: n });
    objets.push({ key: 'u/t/b/00001', size: 9 });
    const storage = createStorage({ client: fauxClient({ objets, page: 2 }), bucket: 'safebox' });
    const l = await storage.list('u/t/a/');
    assert.deepStrictEqual(l.map((o) => o.size), [1, 2, 3, 4, 5]);
  });

  await test('suppression d\'un préfixe : groupée, le reste intact', async () => {
    const client = fauxClient({ objets: [
      { key: 'u/t/a/00001', size: 1 }, { key: 'u/t/a/apercu', size: 1 }, { key: 'u/t/b/00001', size: 1 },
    ] });
    const storage = createStorage({ client, bucket: 'safebox' });
    assert.strictEqual(await storage.removePrefix('u/t/a/'), 2);
    assert.deepStrictEqual([...client.contenu.keys()], ['u/t/b/00001']);
    assert.ok(client.appels.includes('DeleteObjectsCommand'));
  });

  await test('suppression groupée refusée par S4 : un par un', async () => {
    const client = fauxClient({ refuseGroupe: true, objets: [{ key: 'u/t/a/00001', size: 1 }, { key: 'u/t/a/00002', size: 1 }] });
    const storage = createStorage({ client, bucket: 'safebox' });
    assert.strictEqual(await storage.removePrefix('u/t/a/'), 2);
    assert.strictEqual(client.contenu.size, 0);
    assert.strictEqual(client.appels.filter((a) => a === 'DeleteObjectCommand').length, 2);
  });

  await test('réglages : point d\'accès complété, région tirée du point d\'accès', async () => {
    assert.strictEqual(configFrom({}), null);
    const cfg = configFrom({
      MEGA_S4_ENDPOINT: 's3.eu-luxembourg-1.megas4.com',
      MEGA_S4_BUCKET: 'safebox', MEGA_S4_KEY_ID: 'k', MEGA_S4_SECRET: 's',
    });
    assert.strictEqual(cfg.endpoint, 'https://s3.eu-luxembourg-1.megas4.com');
    assert.strictEqual(cfg.region, 'eu-luxembourg-1');
    assert.strictEqual(configFrom({ ...cfg, MEGA_S4_ENDPOINT: 'x', MEGA_S4_BUCKET: '' }), null);
  });

  console.log(`safebox/storage : ${ok} tests passés`);
})();
