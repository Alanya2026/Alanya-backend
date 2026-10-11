/**
 * Suppression de compte — SQL des stickers. HORS CI : exige les migrations 097
 * (et 098) jouées sur la base visée (`.env`) et `job_queue` (039, pour vérifier qu'aucun job n'est posé).
 * `node src/services/accountDeletionStickers.db.test.js`
 *
 * Crée, sous des identifiants de test (aucune clé étrangère vers `users`), un
 * compte propriétaire d'un pack perso et de deux actifs (dont un retiré par un
 * admin), un tiers qui a installé le pack et mis un sticker en favori, puis
 * rejoue `_purgeStickers` dans une transaction. Vérifie : lignes parties,
 * officiel intact, empreinte retirée toujours bloquée, aucun job de fichiers.
 * Les fichiers ne sont jamais supprimés. Supprime UNIQUEMENT ce qu'il a créé.
 */
const assert = require('assert');
const crypto = require('crypto');
const pool = require('../config/db');
const { _purgeStickers } = require('./accountDeletionService');

const PROPRIO = 2_000_000_011;
const TIERS = 2_000_000_012;
const tag = crypto.randomBytes(4).toString('hex');
const sha = (n) => crypto.createHash('sha256').update(`${tag}:${n}`).digest('hex');
const sel = () => crypto.randomBytes(8).toString('hex');

async function nettoyer() {
  await pool.query('DELETE FROM user_sticker_favorite WHERE alanyaID IN (?)', [[PROPRIO, TIERS]]);
  await pool.query('DELETE FROM user_sticker_pack WHERE alanyaID IN (?)', [[PROPRIO, TIERS]]);
  await pool.query('DELETE FROM sticker_report WHERE reporter_id IN (?)', [[PROPRIO, TIERS]]);
  await pool.query(
    'DELETE s FROM sticker s JOIN sticker_pack p ON p.id = s.pack_id WHERE p.owner_id IN (?)',
    [[PROPRIO, TIERS]],
  );
  await pool.query('DELETE FROM sticker_pack WHERE owner_id IN (?)', [[PROPRIO, TIERS]]);
  await pool.query('DELETE FROM sticker_asset WHERE owner_id IN (?)', [[PROPRIO, TIERS]]);
  await pool.query('DELETE FROM sticker_blocklist WHERE sha256 IN (?)', [[sha('retire'), sha('actif')]]);
  await pool.query('DELETE FROM job_queue WHERE dedupe_key LIKE ?', [`sticker_files:${PROPRIO}:%`]);
}

(async () => {
  try {
    await nettoyer();
    const cleActif = `stickers/u/${PROPRIO}/${sel()}_${sha('actif')}.webp`;
    const cleRetire = `stickers/u/${PROPRIO}/${sel()}_${sha('retire')}.webp`;
    const [a1] = await pool.execute(
      'INSERT INTO sticker_asset (owner_id, sha256, storage_key, thumb_key, status) VALUES (?, ?, ?, ?, 0)',
      [PROPRIO, sha('actif'), cleActif, cleActif.replace('.webp', '_t.webp')],
    );
    const [a2] = await pool.execute(
      'INSERT INTO sticker_asset (owner_id, sha256, storage_key, status) VALUES (?, ?, ?, 1)',
      [PROPRIO, sha('retire'), cleRetire],
    );
    const [p] = await pool.execute(
      `INSERT INTO sticker_pack (code, owner_id, name_i18n, visibility, status, created_by)
       VALUES (?, ?, ?, 2, 1, ?)`,
      [`u_${PROPRIO}_${tag}`, PROPRIO, JSON.stringify({ fr: 'Test' }), PROPRIO],
    );
    const [s1] = await pool.execute(
      'INSERT INTO sticker (pack_id, position, asset_id, emoji) VALUES (?, 0, ?, ?)',
      [p.insertId, a1.insertId, '😀'],
    );
    await pool.execute('INSERT INTO user_sticker_pack (alanyaID, pack_id) VALUES (?, ?), (?, ?)',
      [PROPRIO, p.insertId, TIERS, p.insertId]);
    await pool.execute('INSERT INTO user_sticker_favorite (alanyaID, sticker_id) VALUES (?, ?)', [TIERS, s1.insertId]);
    await pool.execute('INSERT INTO sticker_report (asset_id, reporter_id) VALUES (?, ?)', [a1.insertId, TIERS]);
    await pool.execute('INSERT INTO sticker_report (asset_id, reporter_id) VALUES (?, ?)', [a2.insertId, PROPRIO]);
    const [[officiel]] = await pool.query('SELECT COUNT(*) AS n FROM sticker_asset WHERE owner_id = 0');

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await _purgeStickers(conn, PROPRIO);
      await conn.commit();
    } finally {
      conn.release();
    }

    const n = async (sql, params) => Number((await pool.query(sql, params))[0][0].n);
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker_asset WHERE owner_id = ?', [PROPRIO]), 0);
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker_pack WHERE owner_id = ?', [PROPRIO]), 0);
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker WHERE id = ?', [s1.insertId]), 0);
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM user_sticker_pack WHERE alanyaID IN (?)', [[PROPRIO, TIERS]]), 0,
      'installation du tiers retirée avec le pack');
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM user_sticker_favorite WHERE alanyaID = ?', [TIERS]), 0,
      'favori du tiers retiré avec le sticker');
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker_report WHERE reporter_id IN (?)', [[PROPRIO, TIERS]]), 0);
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker_asset WHERE owner_id = 0'), Number(officiel.n), 'officiel intact');
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker_blocklist WHERE sha256 = ?', [sha('retire')]), 1,
      'empreinte retirée par un admin toujours bloquée');
    assert.strictEqual(await n('SELECT COUNT(*) AS n FROM sticker_blocklist WHERE sha256 = ?', [sha('actif')]), 0,
      "un actif simplement supprimé n'est pas bloqué");

    // Aucun fichier supprimé, aucun job posé (décision propriétaire 11/10/2026).
    assert.strictEqual(await n("SELECT COUNT(*) AS n FROM job_queue WHERE kind = 'sticker_files_purge' AND dedupe_key LIKE ?",
      [`sticker_files:${PROPRIO}:%`]), 0, 'aucun job de purge de fichiers');

    console.log('accountDeletionStickers.db.test.js : OK');
  } finally {
    await nettoyer().catch((e) => console.error('nettoyage :', e.message));
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
