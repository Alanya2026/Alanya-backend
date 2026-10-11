/**
 * Accès SQL des stickers (V1a) : catalogue officiel, pack, « mes » packs et
 * favoris, lecture d'un sticker pour l'envoi.
 *
 * Aucune règle ici : les décisions (ouvert ? verrouillé ? disponible ?) sont
 * prises par `utils/stickerMessage` et le contrôleur, sur les lignes rendues
 * par ces fonctions. Ces requêtes sont éprouvées par `stickerStore.db.test.js`
 * (hors CI : elles demandent la migration 097).
 */

const pool = require('../config/db');

/** Un pack officiel au sens du catalogue : visibilité 0 uniquement. */
const OFFICIEL = 0;
const STATUS_PUBLIE = 1;
const STATUS_ARCHIVE = 2;

/** Limite de packs installés par compte (plan §4). */
const MAX_PACKS_INSTALLES = 50;

/**
 * Lecture d'un sticker pour l'envoi : le sticker, son pack, son fichier, et
 * `installed` (le pack est-il installé par l'expéditeur ?) en UNE requête.
 */
async function chargeStickerPourEnvoi(sid, senderID, db = pool) {
  const [rows] = await db.execute(
    `SELECT s.id AS sid, s.emoji, s.pack_id,
            p.code AS pack_code, p.is_premium, p.visibility, p.status AS pack_status, p.owner_id,
            a.status AS asset_status, a.storage_key, a.width, a.height, a.animated,
            EXISTS(SELECT 1 FROM user_sticker_pack u
                    WHERE u.alanyaID = ? AND u.pack_id = p.id) AS installed
       FROM sticker s
       JOIN sticker_pack p ON p.id = s.pack_id
       JOIN sticker_asset a ON a.id = s.asset_id
      WHERE s.id = ?
      LIMIT 1`,
    [senderID, sid],
  );
  return rows[0] || null;
}

/** Packs officiels publiés, avec nombre de stickers actifs et vignette de couverture. */
async function listeCatalogue(db = pool) {
  const [packs] = await db.execute(
    `SELECT p.id, p.code, p.name_i18n, p.description_i18n, p.is_premium, p.version,
            (SELECT COUNT(*) FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
              WHERE s.pack_id = p.id AND a.status = 0) AS count,
            -- Couverture : le sticker désigné, à défaut le premier actif du pack.
            (SELECT COALESCE(ca.thumb_key, ca.storage_key)
               FROM sticker cs JOIN sticker_asset ca ON ca.id = cs.asset_id
              WHERE cs.pack_id = p.id AND ca.status = 0
              ORDER BY (cs.id = p.cover_sticker_id) DESC, cs.position ASC
              LIMIT 1) AS cover_thumb_key
       FROM sticker_pack p
      WHERE p.visibility = ? AND p.status = ?
      ORDER BY p.sort_order ASC, p.id ASC`,
    [OFFICIEL, STATUS_PUBLIE],
  );
  // Version du catalogue : l'instant de la dernière modification d'un pack
  // visible. Une publication, une archive ou une retouche la fait monter.
  const [[v]] = await db.execute(
    `SELECT COALESCE(MAX(UNIX_TIMESTAMP(updated_at)), 0) AS version
       FROM sticker_pack WHERE visibility = ? AND status IN (?, ?)`,
    [OFFICIEL, STATUS_PUBLIE, STATUS_ARCHIVE],
  );
  return { packs, version: Number(v?.version) || 0 };
}

/** Un pack officiel par son code, avec `installed` pour ce compte. */
async function chargePackParCode(code, alanyaID, db = pool) {
  const [rows] = await db.execute(
    `SELECT p.id, p.code, p.name_i18n, p.description_i18n, p.is_premium, p.version,
            p.visibility, p.status,
            EXISTS(SELECT 1 FROM user_sticker_pack u
                    WHERE u.alanyaID = ? AND u.pack_id = p.id) AS installed
       FROM sticker_pack p
      WHERE p.code = ? AND p.visibility = ?
      LIMIT 1`,
    [alanyaID, String(code), OFFICIEL],
  );
  return rows[0] || null;
}

async function chargePackParId(id, alanyaID, db = pool) {
  const [rows] = await db.execute(
    `SELECT p.id, p.code, p.is_premium, p.visibility, p.status,
            EXISTS(SELECT 1 FROM user_sticker_pack u
                    WHERE u.alanyaID = ? AND u.pack_id = p.id) AS installed
       FROM sticker_pack p
      WHERE p.id = ? AND p.visibility = ?
      LIMIT 1`,
    [alanyaID, id, OFFICIEL],
  );
  return rows[0] || null;
}

/** Stickers actifs d'un pack, dans l'ordre `position`. */
async function listeStickersDuPack(packId, db = pool) {
  const [rows] = await db.execute(
    `SELECT s.id, s.position, s.emoji, s.name_i18n,
            a.storage_key, a.thumb_key, a.width, a.height, a.bytes, a.animated
       FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
      WHERE s.pack_id = ? AND a.status = 0
      ORDER BY s.position ASC`,
    [packId],
  );
  return rows;
}

/** Packs installés et favoris du compte (ids seulement), et une version indicative. */
async function chargeMoi(alanyaID, db = pool) {
  const [packs] = await db.execute(
    `SELECT p.id, p.code, u.position
       FROM user_sticker_pack u JOIN sticker_pack p ON p.id = u.pack_id
      WHERE u.alanyaID = ? AND p.visibility = ?
      ORDER BY u.position ASC, u.added_at ASC`,
    [alanyaID, OFFICIEL],
  );
  const [fav] = await db.execute(
    `SELECT f.sticker_id
       FROM user_sticker_favorite f
       JOIN sticker s ON s.id = f.sticker_id
       JOIN sticker_asset a ON a.id = s.asset_id
      WHERE f.alanyaID = ? AND a.status = 0
      ORDER BY f.added_at ASC, f.sticker_id ASC`,
    [alanyaID],
  );
  const [[v]] = await db.execute(
    `SELECT GREATEST(
        COALESCE((SELECT MAX(UNIX_TIMESTAMP(added_at)) FROM user_sticker_pack WHERE alanyaID = ?), 0),
        COALESCE((SELECT MAX(UNIX_TIMESTAMP(added_at)) FROM user_sticker_favorite WHERE alanyaID = ?), 0)
      ) AS version`,
    [alanyaID, alanyaID],
  );
  return {
    packs,
    favorites: fav.map((r) => r.sticker_id),
    version: Number(v?.version) || 0,
  };
}

/**
 * Données stickers d'un compte pour l'export de données (plan §4) : packs
 * installés (code lisible) et favoris, triés. Rend les lignes brutes ; l'appelant
 * décide de la forme exportée.
 */
async function chargeStickersExport(alanyaID, db = pool) {
  const [installedPacks] = await db.execute(
    `SELECT usp.pack_id, sp.code, usp.position, usp.added_at
       FROM user_sticker_pack usp
       JOIN sticker_pack sp ON sp.id = usp.pack_id
      WHERE usp.alanyaID = ?
      ORDER BY usp.position, usp.pack_id`,
    [alanyaID],
  );
  const [favorites] = await db.execute(
    `SELECT sticker_id, added_at
       FROM user_sticker_favorite
      WHERE alanyaID = ?
      ORDER BY added_at`,
    [alanyaID],
  );
  return { installedPacks, favorites };
}

async function compteInstalles(alanyaID, db = pool) {
  const [[r]] = await db.execute(
    'SELECT COUNT(*) AS n FROM user_sticker_pack WHERE alanyaID = ?',
    [alanyaID],
  );
  return Number(r.n) || 0;
}

/** Installe (idempotent) : la position est la suivante libre. */
async function installerPack(alanyaID, packId, db = pool) {
  await db.execute(
    `INSERT IGNORE INTO user_sticker_pack (alanyaID, pack_id, position)
     SELECT ?, ?, COALESCE(MAX(position) + 1, 0) FROM user_sticker_pack WHERE alanyaID = ?`,
    [alanyaID, packId, alanyaID],
  );
}

async function retirerPack(alanyaID, packId, db = pool) {
  await db.execute(
    'DELETE FROM user_sticker_pack WHERE alanyaID = ? AND pack_id = ?',
    [alanyaID, packId],
  );
}

/**
 * Réordonne les packs installés : la position est l'index dans `ids`. Les ids
 * qui ne sont pas installés sont ignorés ; les installés absents de la liste
 * passent après, dans leur ordre actuel.
 */
async function ordonnerPacks(alanyaID, ids) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [lignes] = await conn.execute(
      'SELECT pack_id FROM user_sticker_pack WHERE alanyaID = ? ORDER BY position ASC, added_at ASC FOR UPDATE',
      [alanyaID],
    );
    const installes = lignes.map((l) => Number(l.pack_id));
    const voulus = [...new Set(ids)].filter((id) => installes.includes(id));
    const ordre = [...voulus, ...installes.filter((id) => !voulus.includes(id))];
    for (let i = 0; i < ordre.length; i += 1) {
      await conn.execute(
        'UPDATE user_sticker_pack SET position = ? WHERE alanyaID = ? AND pack_id = ?',
        [i, alanyaID, ordre[i]],
      );
    }
    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Un sticker favorisable : actif, dans un pack officiel publié (ou archivé). */
async function chargeStickerFavorisable(stickerId, db = pool) {
  const [rows] = await db.execute(
    `SELECT s.id
       FROM sticker s
       JOIN sticker_pack p ON p.id = s.pack_id
       JOIN sticker_asset a ON a.id = s.asset_id
      WHERE s.id = ? AND a.status = 0 AND p.visibility = ? AND p.status IN (?, ?)
      LIMIT 1`,
    [stickerId, OFFICIEL, STATUS_PUBLIE, STATUS_ARCHIVE],
  );
  return rows[0] || null;
}

async function ajouterFavori(alanyaID, stickerId, db = pool) {
  await db.execute(
    'INSERT IGNORE INTO user_sticker_favorite (alanyaID, sticker_id) VALUES (?, ?)',
    [alanyaID, stickerId],
  );
}

async function retirerFavori(alanyaID, stickerId, db = pool) {
  await db.execute(
    'DELETE FROM user_sticker_favorite WHERE alanyaID = ? AND sticker_id = ?',
    [alanyaID, stickerId],
  );
}

module.exports = {
  MAX_PACKS_INSTALLES,
  STATUS_PUBLIE,
  STATUS_ARCHIVE,
  chargeStickerPourEnvoi,
  listeCatalogue,
  chargePackParCode,
  chargePackParId,
  listeStickersDuPack,
  chargeMoi,
  chargeStickersExport,
  compteInstalles,
  installerPack,
  retirerPack,
  ordonnerPacks,
  chargeStickerFavorisable,
  ajouterFavori,
  retirerFavori,
};
