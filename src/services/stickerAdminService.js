/**
 * Back-office des stickers (plan §6.4) — chargement et publication des packs
 * officiels, réglages de lancement, modération.
 *
 * Mêmes décisions que la partie publique : un pack officiel se découvre par son
 * `code`, un fichier passe par le MÊME pipeline que le script de chargement
 * (`utils/stickerAsset` → `services/stickerAssetService`), et un contenu publié
 * ne se réécrit pas — on l'archive.
 *
 * Aucune règle de permission ici : les routes la portent (`requirePermission`).
 * Ce module ne connaît que la base et le stockage.
 */

const pool = require('../config/db');
const storage = require('./mediaStorage');
const { creerStickerOfficiel } = require('./stickerAssetService');
const { getStickerSettings, invalidateStickerSettings } = require('./stickerSettingsService');

/** Plafond d'un pack (plan §4). Aligné sur `uploadSticker` (multer, `files: 40`). */
const MAX_STICKERS_PACK = 40;

/** Valeurs de la migration 097 — ne jamais renuméroter (contrat §2). */
const STATUT = Object.freeze({ BROUILLON: 0, PUBLIE: 1, ARCHIVE: 2 });
const VISIBILITE_OFFICIEL = 0;

/** Nombre minimal de stickers pour publier (liste de contrôle du ticket T2). */
const MIN_STICKERS_PUBLICATION = 8;

class StickerAdminError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.name = 'StickerAdminError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const refus = (code, message, status = 400, extra) =>
  new StickerAdminError(code, message, status, extra);

/** Objet i18n quel que soit le format rendu par le driver (chaîne ou objet). */
function lireI18n(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

/** Normalise `{fr,en,zh}` : clés vides ou absentes retirées. */
function normaliserI18n(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw refus('STICKER_INVALID_PAYLOAD', 'name_i18n doit être un objet {"fr":…,"en":…,"zh":…}');
  }
  const out = {};
  for (const langue of ['fr', 'en', 'zh']) {
    const v = value[langue];
    if (typeof v === 'string' && v.trim()) out[langue] = v.trim();
  }
  return out;
}

/** Code de pack : minuscules, chiffres et `_` (VARCHAR(40), UTF-8). */
function slugifier(base) {
  return String(base || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

async function codeUnique(base, db = pool) {
  const racine = slugifier(base) || 'pack';
  for (let i = 0; i < 100; i += 1) {
    const code = (i === 0 ? racine : `${racine.slice(0, 36)}_${i + 1}`).slice(0, 40);
    const [r] = await db.execute('SELECT 1 FROM sticker_pack WHERE code = ? LIMIT 1', [code]);
    if (!r.length) return code;
  }
  throw refus('STICKER_INVALID_PAYLOAD', 'Impossible de générer un code de pack unique', 500);
}

/** Packs officiels, avec compteur de stickers actifs et vignette de couverture. */
async function listerPacks({ status, q } = {}, db = pool) {
  const where = ['p.visibility = ?'];
  const params = [VISIBILITE_OFFICIEL];
  if (status !== undefined && status !== null && status !== '') {
    where.push('p.status = ?');
    params.push(Number(status));
  }
  if (q) {
    where.push("(p.code LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(p.name_i18n, '$.fr')) LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  const [rows] = await db.execute(
    `SELECT p.id, p.code, p.name_i18n, p.description_i18n, p.author, p.is_premium,
            p.visibility, p.status, p.share_token, p.sort_order, p.version,
            p.published_at, p.created_at, p.updated_at, p.cover_sticker_id,
            (SELECT COUNT(*) FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
              WHERE s.pack_id = p.id AND a.status = 0) AS sticker_count,
            (SELECT COALESCE(SUM(a3.bytes), 0) FROM sticker s3 JOIN sticker_asset a3 ON a3.id = s3.asset_id
              WHERE s3.pack_id = p.id AND a3.status = 0) AS total_bytes,
            (SELECT a2.thumb_key FROM sticker s2 JOIN sticker_asset a2 ON a2.id = s2.asset_id
              WHERE s2.id = p.cover_sticker_id) AS cover_thumb_key
       FROM sticker_pack p
      WHERE ${where.join(' AND ')}
      ORDER BY p.sort_order ASC, p.id ASC`,
    params,
  );
  return rows;
}

/** Un pack officiel et TOUS ses stickers (y compris les actifs retirés). */
async function getPack(id, db = pool) {
  const [rows] = await db.execute(
    `SELECT p.*,
            (SELECT COUNT(*) FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
              WHERE s.pack_id = p.id AND a.status = 0) AS sticker_count,
            (SELECT COALESCE(SUM(a3.bytes), 0) FROM sticker s3 JOIN sticker_asset a3 ON a3.id = s3.asset_id
              WHERE s3.pack_id = p.id AND a3.status = 0) AS total_bytes
       FROM sticker_pack p
      WHERE p.id = ? AND p.visibility = ?
      LIMIT 1`,
    [id, VISIBILITE_OFFICIEL],
  );
  const pack = rows[0];
  if (!pack) throw refus('STICKER_NOT_FOUND', 'Pack introuvable', 404);
  const [stickers] = await db.execute(
    `SELECT s.id, s.position, s.emoji, s.name_i18n, s.asset_id,
            a.status AS asset_status, a.storage_key, a.thumb_key,
            a.width, a.height, a.bytes, a.animated
       FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
      WHERE s.pack_id = ?
      ORDER BY s.position ASC`,
    [id],
  );
  return { pack, stickers };
}

async function createPack(champs, { by } = {}, db = pool) {
  const nameI18n = normaliserI18n(champs.name_i18n);
  if (!nameI18n || !nameI18n.fr) {
    throw refus('STICKER_INVALID_PAYLOAD', 'name_i18n.fr est requis');
  }
  const code = champs.code ? String(champs.code).trim() : await codeUnique(nameI18n.fr, db);
  if (!/^[a-z0-9][a-z0-9_]{1,39}$/.test(code)) {
    throw refus('STICKER_INVALID_PAYLOAD', 'code invalide (minuscules, chiffres, _, 2 à 40)');
  }
  const description = 'description_i18n' in champs
    ? normaliserI18n(champs.description_i18n)
    : null;
  try {
    const [r] = await db.execute(
      `INSERT INTO sticker_pack
         (code, owner_id, name_i18n, description_i18n, author, is_premium,
          visibility, status, sort_order, created_by)
       VALUES (?, NULL, ?, ?, ?, ?, 0, 0, ?, ?)`,
      [
        code,
        JSON.stringify(nameI18n),
        description ? JSON.stringify(description) : null,
        champs.author ? String(champs.author).slice(0, 80) : null,
        champs.is_premium ? 1 : 0,
        Number.isFinite(Number(champs.sort_order)) ? Number(champs.sort_order) : 0,
        Number(by) || 0,
      ],
    );
    return { id: r.insertId, code };
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw refus('STICKER_INVALID_PAYLOAD', 'code déjà pris', 409);
    throw e;
  }
}

const CHAMPS_PACK = ['name_i18n', 'description_i18n', 'author', 'is_premium', 'sort_order', 'cover_sticker_id'];

async function updatePack(id, champs, db = pool) {
  const { pack } = await getPack(id, db);
  const sets = [];
  const params = [];

  if ('name_i18n' in champs) {
    const n = normaliserI18n(champs.name_i18n);
    if (!n || !n.fr) throw refus('STICKER_INVALID_PAYLOAD', 'name_i18n.fr est requis');
    sets.push('name_i18n = ?');
    params.push(JSON.stringify(n));
  }
  if ('description_i18n' in champs) {
    sets.push('description_i18n = ?');
    const d = normaliserI18n(champs.description_i18n);
    params.push(d ? JSON.stringify(d) : null);
  }
  if ('author' in champs) {
    sets.push('author = ?');
    params.push(champs.author ? String(champs.author).slice(0, 80) : null);
  }
  if ('is_premium' in champs) {
    sets.push('is_premium = ?');
    params.push(champs.is_premium ? 1 : 0);
  }
  if ('sort_order' in champs) {
    sets.push('sort_order = ?');
    params.push(Number(champs.sort_order) || 0);
  }
  if ('cover_sticker_id' in champs) {
    const cover = champs.cover_sticker_id == null ? null : Number(champs.cover_sticker_id);
    if (cover != null) {
      const [ok] = await db.execute(
        'SELECT 1 FROM sticker WHERE id = ? AND pack_id = ? LIMIT 1',
        [cover, id],
      );
      if (!ok.length) throw refus('STICKER_INVALID_PAYLOAD', 'cover_sticker_id hors du pack');
    }
    sets.push('cover_sticker_id = ?');
    params.push(cover);
  }

  if (!sets.length) return pack;
  sets.push('version = version + 1');
  params.push(id, VISIBILITE_OFFICIEL);
  await db.execute(
    `UPDATE sticker_pack SET ${sets.join(', ')} WHERE id = ? AND visibility = ?`,
    params,
  );
  return { ...pack, ...champs };
}

/**
 * Ajoute des stickers à un pack (upload multiple). Chaque entrée porte son
 * `buffer`, son `emoji` et, si fourni, son `name_i18n`.
 */
async function addStickers(packId, entrees, db = pool) {
  const { pack } = await getPack(packId, db);
  const [cnt] = await db.execute('SELECT COUNT(*) AS n FROM sticker WHERE pack_id = ?', [packId]);
  const deja = Number(cnt[0].n) || 0;
  if (deja + entrees.length > MAX_STICKERS_PACK) {
    throw refus('STICKER_PACK_LIMIT', `${MAX_STICKERS_PACK} stickers maximum par pack`, 409);
  }
  const [pos] = await db.execute(
    'SELECT COALESCE(MAX(position), -1) AS p FROM sticker WHERE pack_id = ?',
    [packId],
  );
  let position = Number(pos[0].p) + 1;

  const crees = [];
  for (const e of entrees) {
    const r = await creerStickerOfficiel({
      buffer: e.buffer,
      packId,
      packCode: pack.code,
      position,
      emoji: e.emoji,
      nameI18n: e.nameI18n || null,
    });
    crees.push({ id: r.stickerId, position, bytes: r.bytes, reutilise: r.reutilise });
    position += 1;
  }

  if (crees.length) {
    await db.execute('UPDATE sticker_pack SET version = version + 1 WHERE id = ?', [packId]);
    if (!pack.cover_sticker_id) {
      await db.execute(
        'UPDATE sticker_pack SET cover_sticker_id = ? WHERE id = ? AND cover_sticker_id IS NULL',
        [crees[0].id, packId],
      );
    }
  }
  return crees;
}

/** Le pack d'un sticker, pour décider s'il est encore modifiable. */
async function _stickerEtPack(stickerId, db) {
  const [rows] = await db.execute(
    `SELECT s.id, s.pack_id, s.asset_id, p.status
       FROM sticker s JOIN sticker_pack p ON p.id = s.pack_id
      WHERE s.id = ?
      LIMIT 1`,
    [stickerId],
  );
  const st = rows[0];
  if (!st) throw refus('STICKER_NOT_FOUND', 'Sticker introuvable', 404);
  return st;
}

const _exigerBrouillon = (st) => {
  if (Number(st.status) !== STATUT.BROUILLON) {
    throw refus('STICKER_PACK_PUBLISHED', 'Un pack publié ou archivé ne se modifie pas sticker à sticker', 409);
  }
};

async function updateSticker(stickerId, champs, db = pool) {
  const st = await _stickerEtPack(stickerId, db);
  _exigerBrouillon(st);

  const sets = [];
  const params = [];
  if ('emoji' in champs) {
    const emoji = String(champs.emoji || '').trim();
    if (!emoji) throw refus('STICKER_INVALID_PAYLOAD', 'emoji requis');
    sets.push('emoji = ?');
    params.push(emoji.slice(0, 16));
  }
  if ('position' in champs && Number.isInteger(Number(champs.position))) {
    sets.push('position = ?');
    params.push(Number(champs.position));
  }
  if ('name_i18n' in champs) {
    sets.push('name_i18n = ?');
    const n = normaliserI18n(champs.name_i18n);
    params.push(n ? JSON.stringify(n) : null);
  }
  if (!sets.length) return;
  params.push(stickerId);
  try {
    await db.execute(`UPDATE sticker SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      throw refus('STICKER_INVALID_PAYLOAD', 'position déjà occupée dans ce pack', 409);
    }
    throw e;
  }
}

async function deleteSticker(stickerId, db = pool) {
  const st = await _stickerEtPack(stickerId, db);
  _exigerBrouillon(st);

  const [a] = await db.execute(
    'SELECT storage_key, thumb_key FROM sticker_asset WHERE id = ?',
    [st.asset_id],
  );
  await db.execute('DELETE FROM sticker WHERE id = ?', [stickerId]);
  await db.execute('UPDATE sticker_pack SET cover_sticker_id = NULL WHERE cover_sticker_id = ?', [stickerId]);

  // Actif orphelin : plus aucun sticker ne le référence → ligne et fichiers.
  const [usage] = await db.execute('SELECT COUNT(*) AS n FROM sticker WHERE asset_id = ?', [st.asset_id]);
  if ((Number(usage[0].n) || 0) === 0) {
    await db.execute('DELETE FROM sticker_asset WHERE id = ?', [st.asset_id]);
    if (a[0]) {
      await storage.removeAllVersions(a[0].storage_key).catch(() => {});
      if (a[0].thumb_key) await storage.removeAllVersions(a[0].thumb_key).catch(() => {});
    }
  }
}

/** Liste de contrôle de publication (ticket T2). */
function manquesPublication(pack, nombreActifs) {
  const name = lireI18n(pack.name_i18n) || {};
  const manques = [];
  if (!name.fr) manques.push('name_i18n.fr');
  if (!name.en) manques.push('name_i18n.en');
  if (!pack.cover_sticker_id) manques.push('cover_sticker_id');
  if (nombreActifs < MIN_STICKERS_PUBLICATION) manques.push(`stickers>=${MIN_STICKERS_PUBLICATION}`);
  return manques;
}

async function publishPack(id, db = pool) {
  const { pack } = await getPack(id, db);
  const [cnt] = await db.execute(
    `SELECT COUNT(*) AS n FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
      WHERE s.pack_id = ? AND a.status = 0`,
    [id],
  );
  const manques = manquesPublication(pack, Number(cnt[0].n) || 0);
  if (manques.length) {
    throw refus('STICKER_PACK_INCOMPLETE', 'Liste de contrôle de publication incomplète', 422, { missing: manques });
  }
  await db.execute(
    `UPDATE sticker_pack
        SET status = ?, published_at = COALESCE(published_at, NOW(3)), version = version + 1
      WHERE id = ?`,
    [STATUT.PUBLIE, id],
  );
  return { status: STATUT.PUBLIE };
}

async function archivePack(id, db = pool) {
  const { pack } = await getPack(id, db);
  await db.execute(
    'UPDATE sticker_pack SET status = ?, version = version + 1 WHERE id = ?',
    [STATUT.ARCHIVE, id],
  );
  return { status: STATUT.ARCHIVE, code: pack.code };
}

/** Réglages exposés en JSON (camelCase, contrat admin). Les colonnes de
 *  cohorte de la migration 097 sont conservées en base mais écartées : un seul
 *  interrupteur, `enabled`, décide de l'ouverture. */
function reglagesPublies(row) {
  return {
    id: Number(row.id) || 1,
    enabled: Number(row.enabled) === 1 ? 1 : 0,
    creationEnabled: Number(row.creation_enabled) === 1 ? 1 : 0,
    animatedEnabled: Number(row.animated_enabled) === 1 ? 1 : 0,
    minAppVersion: row.min_app_version ?? null,
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function getSettings() {
  return reglagesPublies(await getStickerSettings());
}

async function updateSettings(champs, { by } = {}, db = pool) {
  const sets = [];
  const params = [];
  for (const k of ['enabled', 'creation_enabled', 'animated_enabled']) {
    if (k in champs) {
      sets.push(`${k} = ?`);
      params.push(champs[k] ? 1 : 0);
    }
  }
  if ('min_app_version' in champs) {
    sets.push('min_app_version = ?');
    params.push(champs.min_app_version ? String(champs.min_app_version).slice(0, 20) : null);
  }
  if (!sets.length) return getSettings();
  sets.push('updated_by = ?');
  params.push(Number(by) || null);
  params.push(1);
  try {
    await db.execute(`UPDATE sticker_settings SET ${sets.join(', ')} WHERE id = ?`, params);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') {
      throw refus('STICKER_INVALID_PAYLOAD', 'Réglages indisponibles (migration 097 non jouée)', 503);
    }
    throw e;
  }
  invalidateStickerSettings();
  return getSettings();
}

async function listReports(db = pool) {
  const [rows] = await db.execute(
    `SELECT r.id, r.asset_id, r.reporter_id, r.reason, r.status, r.created_at,
            a.storage_key, a.thumb_key, a.status AS asset_status,
            u.nom AS reporter_nom, u.pseudo AS reporter_pseudo
       FROM sticker_report r
       JOIN sticker_asset a ON a.id = r.asset_id
       LEFT JOIN users u ON u.alanyaID = r.reporter_id
      ORDER BY r.created_at DESC
      LIMIT 200`,
  );
  return rows;
}

async function takedownAsset(assetId, { by } = {}, db = pool) {
  const [rows] = await db.execute('SELECT id, sha256 FROM sticker_asset WHERE id = ? LIMIT 1', [assetId]);
  if (!rows.length) throw refus('STICKER_NOT_FOUND', 'Actif introuvable', 404);
  await db.execute('UPDATE sticker_asset SET status = 1 WHERE id = ?', [assetId]);
  await db.execute('UPDATE sticker_report SET status = 1 WHERE asset_id = ?', [assetId]);
  // Un retrait change la version des packs qui le portent : le catalogue se
  // rafraîchit (l'ETag suit `updated_at`).
  await db.execute(
    `UPDATE sticker_pack p JOIN sticker s ON s.pack_id = p.id
        SET p.version = p.version + 1
      WHERE s.asset_id = ?`,
    [assetId],
  );
  // Empreinte bloquée : un ré-upload identique est refusé partout (pipeline §4).
  await db.execute(
    'INSERT IGNORE INTO sticker_blocklist (sha256, reason, created_by) VALUES (?, ?, ?)',
    [rows[0].sha256, 'retrait admin', Number(by) || null],
  );
  return { ok: true };
}

module.exports = {
  MAX_STICKERS_PACK,
  MIN_STICKERS_PUBLICATION,
  STATUT,
  VISIBILITE_OFFICIEL,
  StickerAdminError,
  lireI18n,
  slugifier,
  listerPacks,
  getPack,
  createPack,
  updatePack,
  addStickers,
  updateSticker,
  deleteSticker,
  publishPack,
  archivePack,
  getSettings,
  updateSettings,
  listReports,
  takedownAsset,
};
