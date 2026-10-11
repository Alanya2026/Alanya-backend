/**
 * Étapes 4 et 5 du pipeline d'upload (plan §4) : liste de blocage, quotas,
 * stockage et lignes `sticker_asset` / `sticker`. Les étapes 2 et 3 (contrôle
 * réel, ré-encodage) sont dans `utils/stickerAsset`.
 *
 * V1a : sert le chargement des packs officiels (`scripts/load_sticker_pack.js`)
 * et servira l'administration. Le dépôt d'un sticker PERSONNEL (V1b) réutilise
 * `preparerAsset` avec `ownerId = alanyaID` ; sa clé est
 * `mediaStorage.personalStickerKey`.
 */

const pool = require('../config/db');
const storage = require('./mediaStorage');
const { preparerAsset, LIMITES } = require('../utils/stickerAsset');

/** Dépendances SQL de `preparerAsset`. */
function depsSql(db = pool) {
  return {
    estBloque: async (sha256) => {
      const [rows] = await db.execute('SELECT 1 FROM sticker_blocklist WHERE sha256 = ? LIMIT 1', [sha256]);
      return rows.length > 0;
    },
    usage: async (ownerId) => {
      const [[r]] = await db.execute(
        `SELECT
           (SELECT COUNT(*) FROM sticker_asset WHERE owner_id = ? AND status = 0) AS assets,
           (SELECT COUNT(*) FROM sticker_asset
             WHERE owner_id = ? AND created_at > DATE_SUB(NOW(3), INTERVAL 1 HOUR)) AS uploads`,
        [ownerId, ownerId],
      );
      return { assets: Number(r.assets) || 0, uploadsDerniereHeure: Number(r.uploads) || 0 };
    },
  };
}

/**
 * Crée un sticker officiel dans un pack : asset, ligne `sticker`, fichiers.
 *
 * Tout est dans UNE transaction : la clé de stockage contient l'identifiant du
 * sticker (`official/stickers/<pack>/<sid>_<sha8>.webp`), qu'on ne connaît
 * qu'après l'INSERT. Si le dépôt échoue, la transaction est annulée et les
 * lignes disparaissent ; un fichier déjà déposé mais non référencé est
 * supprimé au mieux.
 *
 * Déduplication par propriétaire : `UNIQUE (owner_id = 0, sha256)`. La même
 * image dans deux packs partage le fichier du premier.
 *
 * @returns {Promise<{stickerId: number, assetId: number, reutilise: boolean,
 *                    bytes: number, sha256: string}>}
 */
async function creerStickerOfficiel({
  buffer, packId, packCode, position, emoji, nameI18n = null,
}) {
  // V1c : l'administration peut déposer un WebP animé final (aiguillé vers
  // `utils/stickerAnime` par l'en-tête du fichier) ; un statique suit son chemin.
  const pret = await preparerAsset(buffer, { ownerId: 0, animeAutorise: true }, depsSql());
  const conn = await pool.getConnection();
  const deposes = [];
  try {
    await conn.beginTransaction();

    const [exist] = await conn.execute(
      'SELECT id, storage_key FROM sticker_asset WHERE owner_id = 0 AND sha256 = ? FOR UPDATE',
      [pret.sha256],
    );
    let assetId;
    let reutilise = false;
    if (exist.length) {
      assetId = exist[0].id;
      reutilise = true;
    } else {
      const [r] = await conn.execute(
        `INSERT INTO sticker_asset (owner_id, sha256, storage_key, mime, width, height, bytes, animated)
         VALUES (0, ?, 'pending', 'image/webp', ?, ?, ?, ?)`,
        [pret.sha256, pret.width, pret.height, pret.bytes, pret.animated ? 1 : 0],
      );
      assetId = r.insertId;
    }

    const [s] = await conn.execute(
      'INSERT INTO sticker (pack_id, position, asset_id, emoji, name_i18n) VALUES (?, ?, ?, ?, ?)',
      [packId, position, assetId, emoji, nameI18n ? JSON.stringify(nameI18n) : null],
    );
    const stickerId = s.insertId;

    if (!reutilise) {
      const key = storage.officialStickerKey({ pack: packCode, sid: stickerId, sha256: pret.sha256 });
      const thumbKey = storage.officialStickerKey({
        pack: packCode, sid: stickerId, sha256: pret.sha256, thumb: true,
      });
      await storage.putBody(key, pret.webp, { contentType: 'image/webp' });
      deposes.push(key);
      await storage.putBody(thumbKey, pret.thumb, { contentType: 'image/webp' });
      deposes.push(thumbKey);
      await conn.execute(
        'UPDATE sticker_asset SET storage_key = ?, thumb_key = ? WHERE id = ?',
        [key, thumbKey, assetId],
      );
    }

    await conn.commit();
    return {
      stickerId, assetId, reutilise, bytes: pret.bytes, sha256: pret.sha256, animated: Boolean(pret.animated),
    };
  } catch (e) {
    await conn.rollback().catch(() => {});
    for (const key of deposes) {
      await storage.removeAllVersions(key).catch(() => {});
    }
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = { LIMITES, depsSql, creerStickerOfficiel };
