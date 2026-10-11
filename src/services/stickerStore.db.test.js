/**
 * Requêtes SQL des stickers — HORS CI : exige la migration 097 jouée sur la
 * base visée (`.env`). `node src/services/stickerStore.db.test.js`
 *
 * Écrit un pack, deux stickers et des lignes d'abonnement sous des
 * identifiants de test (aucune clé étrangère vers `users` : voir la
 * migration), puis supprime UNIQUEMENT ce qu'il a créé, par identifiant.
 */
const assert = require('assert');
const crypto = require('crypto');
const pool = require('../config/db');
const store = require('./stickerStore');
const { prepareStickerMessage } = require('../utils/stickerMessage');

const COMPTE = 2_000_000_001;
const AUTRE = 2_000_000_002;
const code = `t_db_${crypto.randomBytes(4).toString('hex')}`;
const sha = (n) => crypto.createHash('sha256').update(`${code}:${n}`).digest('hex');
const cree = { packs: [], assets: [], stickers: [] };

async function nettoyer() {
  if (cree.stickers.length) {
    await pool.query('DELETE FROM user_sticker_favorite WHERE sticker_id IN (?)', [cree.stickers]);
    await pool.query('DELETE FROM sticker WHERE id IN (?)', [cree.stickers]);
  }
  if (cree.packs.length) {
    await pool.query('DELETE FROM user_sticker_pack WHERE pack_id IN (?)', [cree.packs]);
    await pool.query('DELETE FROM sticker_pack WHERE id IN (?)', [cree.packs]);
  }
  if (cree.assets.length) await pool.query('DELETE FROM sticker_asset WHERE id IN (?)', [cree.assets]);
}

(async () => {
  try {
    const [p] = await pool.execute(
      `INSERT INTO sticker_pack (code, name_i18n, is_premium, visibility, status, created_by)
       VALUES (?, ?, 0, 0, 1, 0)`,
      [code, JSON.stringify({ fr: 'Test', en: 'Test' })],
    );
    const packId = p.insertId;
    cree.packs.push(packId);
    for (let i = 0; i < 2; i++) {
      const [a] = await pool.execute(
        `INSERT INTO sticker_asset (owner_id, sha256, storage_key, thumb_key, width, height, bytes)
         VALUES (0, ?, ?, ?, 512, 512, 1000)`,
        [sha(i), `official/stickers/${code}/${i}_x.webp`, `official/stickers/${code}/${i}_x_t.webp`],
      );
      cree.assets.push(a.insertId);
      const [s] = await pool.execute(
        'INSERT INTO sticker (pack_id, position, asset_id, emoji, name_i18n) VALUES (?, ?, ?, ?, ?)',
        [packId, i, a.insertId, '😀', JSON.stringify({ fr: `s${i}` })],
      );
      cree.stickers.push(s.insertId);
    }
    const [s0, s1] = cree.stickers;

    // Unicité (owner, sha256) : la même empreinte ne s'insère pas deux fois
    await assert.rejects(
      pool.execute(
        `INSERT INTO sticker_asset (owner_id, sha256, storage_key) VALUES (0, ?, 'x')`, [sha(0)],
      ),
      (e) => e.code === 'ER_DUP_ENTRY',
    );

    // Lecture pour l'envoi
    let r = await store.chargeStickerPourEnvoi(s0, COMPTE);
    assert.strictEqual(r.pack_code, code);
    assert.strictEqual(Number(r.installed), 0);
    assert.strictEqual(await store.chargeStickerPourEnvoi(999_999_999, COMPTE), null);

    // Installation, idempotence, positions, limite
    await store.installerPack(COMPTE, packId);
    await store.installerPack(COMPTE, packId);
    assert.strictEqual((await store.chargeStickerPourEnvoi(s0, COMPTE)).installed, 1);
    assert.strictEqual((await store.chargeStickerPourEnvoi(s0, AUTRE)).installed, 0, 'par compte');
    let moi = await store.chargeMoi(COMPTE);
    assert.strictEqual(moi.packs.filter((x) => x.id === packId).length, 1);

    // Catalogue : un brouillon n'y figure pas, un publié oui, avec son compte
    let cat = await store.listeCatalogue();
    const entree = cat.packs.find((x) => x.id === packId);
    assert.ok(entree && Number(entree.count) === 2);
    assert.match(entree.cover_thumb_key, /_t\.webp$/);
    assert.ok(cat.version > 0);
    await pool.execute('UPDATE sticker_pack SET status = 0 WHERE id = ?', [packId]);
    cat = await store.listeCatalogue();
    assert.ok(!cat.packs.some((x) => x.id === packId), 'brouillon absent du catalogue');
    await pool.execute('UPDATE sticker_pack SET status = 1 WHERE id = ?', [packId]);

    // Stickers du pack : actifs, dans l'ordre ; un fichier retiré disparaît
    assert.deepStrictEqual((await store.listeStickersDuPack(packId)).map((x) => x.id), [s0, s1]);
    await pool.execute('UPDATE sticker_asset SET status = 1 WHERE id = ?', [cree.assets[1]]);
    assert.deepStrictEqual((await store.listeStickersDuPack(packId)).map((x) => x.id), [s0]);
    assert.strictEqual(Number((await store.listeCatalogue()).packs.find((x) => x.id === packId).count), 1);
    assert.strictEqual((await store.chargeStickerPourEnvoi(s1, COMPTE)).asset_status, 1);
    assert.strictEqual(await store.chargeStickerFavorisable(s1), null, 'retiré : pas favorisable');
    assert.ok(await store.chargeStickerFavorisable(s0));

    // Favoris
    await store.ajouterFavori(COMPTE, s0);
    await store.ajouterFavori(COMPTE, s0);
    await store.ajouterFavori(COMPTE, s1);
    moi = await store.chargeMoi(COMPTE);
    assert.deepStrictEqual(moi.favorites.filter((x) => cree.stickers.includes(x)), [s0], 'favori retiré = masqué');
    await store.retirerFavori(COMPTE, s0);
    assert.ok(!(await store.chargeMoi(COMPTE)).favorites.includes(s0));

    // Pack officiel ARCHIVÉ = indisponible (A14) : absent du catalogue, de /me
    // (packs installés et favoris), non favorisable ; l'installation reste en
    // base et le pack republié reparaît tel quel.
    await store.ajouterFavori(COMPTE, s0);
    assert.ok((await store.chargeMoi(COMPTE)).packs.some((x) => x.id === packId), 'publié installé : listé');
    await pool.execute('UPDATE sticker_pack SET status = 2 WHERE id = ?', [packId]);
    assert.ok(!(await store.listeCatalogue()).packs.some((x) => x.id === packId), 'archivé : absent du catalogue');
    moi = await store.chargeMoi(COMPTE);
    assert.ok(!moi.packs.some((x) => x.id === packId), 'archivé installé : absent de /me');
    assert.ok(!moi.favorites.includes(s0), 'favori d\'un pack archivé : absent de /me');
    assert.strictEqual(await store.chargeStickerFavorisable(s0), null, 'archivé : non favorisable');
    assert.strictEqual(Number((await store.chargeStickerPourEnvoi(s0, COMPTE)).pack_status), 2, 'le store rend le statut, l\'envoi refuse');
    await pool.execute('UPDATE sticker_pack SET status = 1 WHERE id = ?', [packId]);
    moi = await store.chargeMoi(COMPTE);
    assert.ok(moi.packs.some((x) => x.id === packId), 'republié : de nouveau dans /me, sans réinstaller');
    assert.ok(moi.favorites.includes(s0), 'republié : favori de retour');
    await store.retirerFavori(COMPTE, s0);

    // Ordre
    const [p2] = await pool.execute(
      `INSERT INTO sticker_pack (code, name_i18n, visibility, status, created_by) VALUES (?, '{"fr":"B"}', 0, 1, 0)`,
      [`${code}_b`],
    );
    cree.packs.push(p2.insertId);
    await store.installerPack(COMPTE, p2.insertId);
    await store.ordonnerPacks(COMPTE, [p2.insertId, packId, 987654321]);
    const ordre = (await store.chargeMoi(COMPTE)).packs.map((x) => x.id).filter((x) => cree.packs.includes(x));
    assert.deepStrictEqual(ordre, [p2.insertId, packId]);
    assert.strictEqual(await store.compteInstalles(COMPTE), 2);

    // Retrait
    await store.retirerPack(COMPTE, packId);
    assert.strictEqual((await store.chargeStickerPourEnvoi(s0, COMPTE)).installed, 0);

    // De bout en bout avec la vraie validation d'envoi (réglages forcés ouverts)
    const out = await prepareStickerMessage(
      { content: JSON.stringify({ v: 1, sid: s0 }), senderID: COMPTE },
      {
        ouvert: async () => true,
        chargeSticker: store.chargeStickerPourEnvoi,
        droits: async () => null,
        urlDe: (k) => `https://x/${k}`,
      },
    );
    assert.strictEqual(out.mediaUrl, `https://x/official/stickers/${code}/0_x.webp`);
    assert.strictEqual(JSON.parse(out.content).pack, code);
  } finally {
    await nettoyer();
    await pool.end();
  }
  console.log('stickerStore.db.test.js : OK');
})().catch((e) => { console.error(e); process.exit(1); });
