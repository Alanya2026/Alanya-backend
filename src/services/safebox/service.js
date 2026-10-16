/**
 * Coffre-fort (`safebox`) — dossiers, envois, téléchargements, corbeille.
 *
 * Conception : docs/conception/coffre-fort.html (version 4). Lot 1 : le
 * backend du coffre d'un inscrit. Le partage de gros fichiers (lot 3) et
 * l'espace d'Alanya Plus (lot 4) viendront s'y brancher.
 *
 * Le serveur ne voit passer aucun octet de fichier. Il réserve l'espace, signe
 * les adresses de blocs, vérifie chez MEGA que tout est arrivé, et garde la
 * clé du fichier sous SAFEBOX_KEY.
 *
 * Tout ce qui est appelé de l'extérieur prend l'identifiant du compte en
 * premier : chaque requête SQL filtre sur lui. Un identifiant de dossier ou de
 * fichier d'un autre compte répond « introuvable », jamais « interdit » — ne
 * pas révéler qu'il existe.
 */

const crypto = require('crypto');
const pool = require('../../config/db');
const C = require('../../constants/safebox');
const R = require('./rules');
const { SafeboxError } = require('./errors');
const { keyConfigured, wrapFileKey, unwrapFileKey, accountTag } = require('./keys');
const { defaultStorage } = require('./storage');
const { getSafeboxSettings } = require('./settings');
const { collectOrphans } = require('./purge');

const introuvable = () => new SafeboxError('SAFEBOX_NOT_FOUND', 404, 'Introuvable');
const taille = (b) => Number(b.stored_bytes) + Number(b.preview_bytes);

function createSafeboxService({
  db = pool,
  getStorage = () => defaultStorage(),
  env = process.env,
  getSettings = getSafeboxSettings,
  trashDays = async () => (await require('../purgeRegistry').resolveOptions('safebox')).trashDays,
} = {}) {
  /** Le stockage, ou 503 tant que MEGA S4 et SAFEBOX_KEY ne sont pas configurés. */
  function ready() {
    const storage = keyConfigured(env) ? getStorage() : null;
    if (!storage) throw new SafeboxError('SAFEBOX_UNAVAILABLE', 503, 'Coffre-fort indisponible');
    return storage;
  }

  /**
   * Espace du compte. Lot 1 : l'espace de base pour tous. Le lot 4 y ajoutera
   * celui du plan Alanya Plus (`plan.safebox_bytes`) en phase payante.
   */
  async function quotaFor(alanyaID, settings) {
    return settings.baseQuotaBytes;
  }

  async function maxFileFor(alanyaID, settings) {
    return settings.maxFileBytes;
  }

  async function tx(fn) {
    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      const out = await fn(conn);
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  const doublon = (e) => e && e.code === 'ER_DUP_ENTRY';

  // ── Compte et dossiers racines ───────────────────────────────────────────

  /** Ouvre le coffre à sa première visite : la ligne du compte et les quatre racines. */
  async function ensureAccount(alanyaID) {
    await db.query('INSERT IGNORE INTO safebox_account (alanyaID) VALUES (?)', [alanyaID]);
    const lire = async () => {
      const [rows] = await db.query(
        'SELECT id, root, path FROM safebox_folder WHERE alanyaID = ? AND parent_id IS NULL',
        [alanyaID],
      );
      return rows;
    };
    let racines = await lire();
    if (racines.length < C.ROOTS.length || racines.some((r) => !r.path)) {
      for (const root of C.ROOTS) {
        if (racines.some((r) => r.root === root)) continue;
        // Unique (alanyaID, root_slot) : deux premières visites simultanées
        // n'en créent qu'une.
        await db.query(
          'INSERT IGNORE INTO safebox_folder (alanyaID, root, root_slot, depth) VALUES (?, ?, ?, 0)',
          [alanyaID, root, root],
        );
      }
      await db.query(
        "UPDATE safebox_folder SET path = CONCAT('/', id, '/') WHERE alanyaID = ? AND parent_id IS NULL AND path = ''",
        [alanyaID],
      );
      racines = await lire();
    }
    const parRacine = {};
    for (const r of racines) parRacine[r.root] = { id: Number(r.id), path: r.path };
    return parRacine;
  }

  async function usageOf(conn, alanyaID) {
    const [[u]] = await conn.query(
      `SELECT COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0) AS used,
              COALESCE(SUM(IF(b.status = 'pending', b.stored_bytes + b.preview_bytes, 0)), 0) AS pending,
              COALESCE(SUM(IF(f.trashed_at IS NOT NULL, b.stored_bytes + b.preview_bytes, 0)), 0) AS trash
         FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
        WHERE f.alanyaID = ?`,
      [alanyaID],
    );
    return { usedBytes: Number(u.used), pendingBytes: Number(u.pending), trashBytes: Number(u.trash) };
  }

  /** `GET /api/safebox` — l'espace, les dossiers racines, les limites. */
  async function overview(alanyaID) {
    ready();
    const settings = await getSettings();
    const racines = await ensureAccount(alanyaID);
    const usage = await usageOf(db, alanyaID);
    const [parFamille] = await db.query(
      `SELECT f.family, COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0) AS octets, COUNT(*) AS fichiers
         FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
        WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
        GROUP BY f.family`,
      [alanyaID],
    );
    const familles = {};
    for (const root of C.ROOTS) familles[root] = { bytes: 0, files: 0 };
    for (const r of parFamille) familles[r.family] = { bytes: Number(r.octets), files: Number(r.fichiers) };
    return {
      quota: {
        quotaBytes: await quotaFor(alanyaID, settings),
        ...usage,
        byRoot: familles,
      },
      roots: C.ROOTS.map((root) => ({ id: racines[root].id, root })),
      limits: {
        maxFileBytes: await maxFileFor(alanyaID, settings),
        blockBytes: C.BLOCK_BYTES,
        maxPreviewBytes: C.MAX_PREVIEW_BYTES,
        maxDepth: settings.maxDepth,
        maxFolders: settings.maxFolders,
        folderNameMax: C.FOLDER_NAME_MAX,
        fileNameMax: C.FILE_NAME_MAX,
        extensions: settings.extensions,
      },
    };
  }

  // ── Dossiers ─────────────────────────────────────────────────────────────

  /** Un dossier vivant du compte, ou 404. */
  async function liveFolder(conn, alanyaID, folderId, { lock = false } = {}) {
    const id = R.parseId(folderId);
    if (!id) throw introuvable();
    const [[f]] = await conn.query(
      `SELECT id, parent_id, root, name, path, depth, trashed_at, created_at, updated_at
         FROM safebox_folder WHERE id = ? AND alanyaID = ? AND trashed_at IS NULL
         ${lock ? 'FOR UPDATE' : ''}`,
      [id, alanyaID],
    );
    if (!f) throw introuvable();
    return f;
  }

  const folderShape = (f) => ({
    id: Number(f.id),
    parentId: f.parent_id == null ? null : Number(f.parent_id),
    root: f.root,
    name: f.name,
    depth: Number(f.depth),
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  });

  /** Un fichier tel que l'application l'affiche, clé comprise (le propriétaire seul le voit). */
  async function fileShape(f, storage) {
    const prefix = f.prefix;
    const out = {
      id: Number(f.id),
      folderId: Number(f.folder_id),
      name: f.name,
      ext: f.ext,
      mime: f.mime,
      family: f.family,
      plainBytes: Number(f.plain_bytes),
      storedBytes: taille(f),
      originalBytes: f.original_bytes == null ? null : Number(f.original_bytes),
      compressed: Boolean(f.compressed),
      cipherFormat: f.cipher_format,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    };
    if (f.wrapped_key) out.key = unwrapFileKey(f.wrapped_key, f.blob_id, env).toString('base64');
    out.previewUrl = Number(f.preview_bytes) > 0
      ? await storage.downloadUrl(R.previewKey(prefix), C.PREVIEW_URL_TTL_S)
      : null;
    return out;
  }

  const FICHIER = `SELECT f.id, f.folder_id, f.name, f.ext, f.mime, f.family, f.original_bytes,
                          f.compressed, f.trashed_at, f.trashed_by_folder, f.created_at, f.updated_at,
                          b.id AS blob_id, b.prefix, b.block_size, b.block_count, b.stored_bytes,
                          b.plain_bytes, b.preview_bytes, b.cipher_format, b.wrapped_key, b.status
                     FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id`;

  /** `GET /api/safebox/folders/:id` — sous-dossiers, puis fichiers par pages. */
  async function listFolder(alanyaID, folderId, { cursor } = {}) {
    const storage = ready();
    const dossier = await liveFolder(db, alanyaID, folderId);
    const ids = dossier.path.split('/').filter(Boolean).map(Number);
    const [ascendance] = await db.query(
      'SELECT id, parent_id, root, name, depth, created_at, updated_at FROM safebox_folder WHERE alanyaID = ? AND id IN (?) ORDER BY depth',
      [alanyaID, ids],
    );
    const apres = R.parseId(cursor);
    let sousDossiers = [];
    if (!apres) {
      const [rows] = await db.query(
        `SELECT id, parent_id, root, name, depth, created_at, updated_at FROM safebox_folder
          WHERE parent_id = ? AND alanyaID = ? AND trashed_at IS NULL ORDER BY name`,
        [dossier.id, alanyaID],
      );
      sousDossiers = rows.map(folderShape);
    }
    const [fichiers] = await db.query(
      `${FICHIER}
        WHERE f.folder_id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
          ${apres ? 'AND f.id < ?' : ''}
        ORDER BY f.id DESC LIMIT ${C.PAGE_SIZE}`,
      apres ? [dossier.id, alanyaID, apres] : [dossier.id, alanyaID],
    );
    return {
      folder: folderShape(dossier),
      breadcrumbs: ascendance.map(folderShape),
      folders: sousDossiers,
      files: await Promise.all(fichiers.map((f) => fileShape(f, storage))),
      nextCursor: fichiers.length === C.PAGE_SIZE ? Number(fichiers[fichiers.length - 1].id) : null,
    };
  }

  /** `POST /api/safebox/folders` — un sous-dossier. */
  async function createFolder(alanyaID, body = {}) {
    ready();
    const settings = await getSettings();
    const nom = R.normalizeName(body.name, C.FOLDER_NAME_MAX);
    await ensureAccount(alanyaID);
    const cree = await tx(async (conn) => {
      // Le verrou du compte sérialise les créations : le plafond de dossiers tient.
      await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      const parent = await liveFolder(conn, alanyaID, body.parentId);
      if (Number(parent.depth) + 1 > settings.maxDepth) {
        throw new SafeboxError('SAFEBOX_TOO_DEEP', 409, 'Trop de niveaux de dossiers', { maxDepth: settings.maxDepth });
      }
      const [[n]] = await conn.query(
        'SELECT COUNT(*) AS n FROM safebox_folder WHERE alanyaID = ? AND parent_id IS NOT NULL',
        [alanyaID],
      );
      if (Number(n.n) >= settings.maxFolders) {
        throw new SafeboxError('SAFEBOX_FOLDER_LIMIT', 409, 'Trop de dossiers', { maxFolders: settings.maxFolders });
      }
      let r;
      try {
        [r] = await conn.query(
          'INSERT INTO safebox_folder (alanyaID, parent_id, root, name, depth) VALUES (?, ?, ?, ?, ?)',
          [alanyaID, parent.id, parent.root, nom, Number(parent.depth) + 1],
        );
      } catch (e) {
        if (doublon(e)) throw new SafeboxError('SAFEBOX_NAME_TAKEN', 409, 'Ce nom est déjà pris dans ce dossier');
        throw e;
      }
      await conn.query('UPDATE safebox_folder SET path = ? WHERE id = ?', [R.childPath(parent.path, r.insertId), r.insertId]);
      return r.insertId;
    });
    const [[f]] = await db.query(
      'SELECT id, parent_id, root, name, depth, created_at, updated_at FROM safebox_folder WHERE id = ?',
      [cree],
    );
    return folderShape(f);
  }

  /** Déplace un dossier et sa descendance sous `cible` (même famille, profondeur bornée). */
  async function moveFolder(conn, alanyaID, dossier, cible, settings) {
    if (cible.root !== dossier.root) {
      throw new SafeboxError('SAFEBOX_WRONG_FAMILY', 400, 'Un dossier reste dans sa famille', { expectedRoot: dossier.root });
    }
    if (R.isWithin(cible.path, dossier.path)) {
      throw new SafeboxError('SAFEBOX_INVALID_MOVE', 400, 'Un dossier ne se range pas dans lui-même');
    }
    const [[m]] = await conn.query(
      "SELECT MAX(depth) AS d FROM safebox_folder WHERE alanyaID = ? AND path LIKE CONCAT(?, '%')",
      [alanyaID, dossier.path],
    );
    const delta = Number(cible.depth) + 1 - Number(dossier.depth);
    if (Number(m.d) + delta > settings.maxDepth) {
      throw new SafeboxError('SAFEBOX_TOO_DEEP', 409, 'Trop de niveaux de dossiers', { maxDepth: settings.maxDepth });
    }
    try {
      await conn.query('UPDATE safebox_folder SET parent_id = ? WHERE id = ?', [cible.id, dossier.id]);
    } catch (e) {
      if (doublon(e)) throw new SafeboxError('SAFEBOX_NAME_TAKEN', 409, 'Ce nom est déjà pris dans ce dossier');
      throw e;
    }
    const nouveau = R.childPath(cible.path, dossier.id);
    await conn.query(
      `UPDATE safebox_folder SET path = CONCAT(?, SUBSTRING(path, ?)), depth = depth + ?
        WHERE alanyaID = ? AND path LIKE CONCAT(?, '%')`,
      [nouveau, dossier.path.length + 1, delta, alanyaID, dossier.path],
    );
  }

  /** `PATCH /api/safebox/folders/:id` — renommer et/ou déplacer. */
  async function updateFolder(alanyaID, folderId, body = {}) {
    ready();
    const settings = await getSettings();
    const nom = body.name === undefined ? null : R.normalizeName(body.name, C.FOLDER_NAME_MAX);
    const parentId = body.parentId === undefined ? null : R.parseId(body.parentId);
    if (body.parentId !== undefined && !parentId) throw introuvable();
    await tx(async (conn) => {
      const dossier = await liveFolder(conn, alanyaID, folderId, { lock: true });
      if (dossier.parent_id == null) {
        throw new SafeboxError('SAFEBOX_ROOT_LOCKED', 400, 'Les dossiers racines ne se renomment ni ne se déplacent');
      }
      if (nom !== null && nom !== dossier.name) {
        try {
          await conn.query('UPDATE safebox_folder SET name = ? WHERE id = ?', [nom, dossier.id]);
        } catch (e) {
          if (doublon(e)) throw new SafeboxError('SAFEBOX_NAME_TAKEN', 409, 'Ce nom est déjà pris dans ce dossier');
          throw e;
        }
      }
      if (parentId && parentId !== Number(dossier.parent_id)) {
        const cible = await liveFolder(conn, alanyaID, parentId);
        await moveFolder(conn, alanyaID, dossier, cible, settings);
      }
    });
    const [[f]] = await db.query(
      'SELECT id, parent_id, root, name, depth, created_at, updated_at FROM safebox_folder WHERE id = ?',
      [R.parseId(folderId)],
    );
    return folderShape(f);
  }

  /**
   * `DELETE /api/safebox/folders/:id` — à la corbeille, avec tout ce qu'il
   * contient. Ce qui y était déjà garde sa propre entrée de corbeille.
   */
  async function trashFolder(alanyaID, folderId) {
    ready();
    await tx(async (conn) => {
      const d = await liveFolder(conn, alanyaID, folderId, { lock: true });
      if (d.parent_id == null) {
        throw new SafeboxError('SAFEBOX_ROOT_LOCKED', 400, 'Les dossiers racines ne se suppriment pas');
      }
      await conn.query(
        `UPDATE safebox_folder SET trashed_at = NOW(), trashed_by_folder = ?
          WHERE alanyaID = ? AND path LIKE CONCAT(?, '%') AND id <> ? AND trashed_at IS NULL`,
        [d.id, alanyaID, d.path, d.id],
      );
      await conn.query(
        `UPDATE safebox_file f JOIN safebox_folder fo ON fo.id = f.folder_id
            SET f.trashed_at = NOW(), f.trashed_by_folder = ?
          WHERE f.alanyaID = ? AND fo.path LIKE CONCAT(?, '%') AND f.trashed_at IS NULL`,
        [d.id, alanyaID, d.path],
      );
      await conn.query(
        'UPDATE safebox_folder SET trashed_at = NOW(), trashed_by_folder = NULL WHERE id = ?',
        [d.id],
      );
    });
    return { ok: true };
  }

  /** Noms des sous-dossiers vivants de `parentId`. */
  async function siblingNames(conn, parentId) {
    const [rows] = await conn.query(
      'SELECT name FROM safebox_folder WHERE parent_id = ? AND trashed_at IS NULL',
      [parentId],
    );
    return rows.map((r) => r.name);
  }

  /**
   * `POST /api/safebox/folders/:id/restore` — sort de la corbeille avec son
   * contenu. Si son dossier parent est lui-même à la corbeille, il revient
   * dans le dossier racine de sa famille ; si son nom a été repris entre-temps,
   * il devient « Nom (2) ».
   */
  async function restoreFolder(alanyaID, folderId) {
    ready();
    const settings = await getSettings();
    const racines = await ensureAccount(alanyaID);
    const id = R.parseId(folderId);
    if (!id) throw introuvable();
    await tx(async (conn) => {
      const [[d]] = await conn.query(
        `SELECT id, parent_id, root, name, path, depth FROM safebox_folder
          WHERE id = ? AND alanyaID = ? AND trashed_at IS NOT NULL AND trashed_by_folder IS NULL FOR UPDATE`,
        [id, alanyaID],
      );
      if (!d) throw introuvable();
      const [[parent]] = await conn.query(
        'SELECT id, root, path, depth, trashed_at FROM safebox_folder WHERE id = ?',
        [d.parent_id],
      );
      const cible = parent && !parent.trashed_at ? parent : await liveFolder(conn, alanyaID, racines[d.root].id);
      const nom = R.freeName(d.name, await siblingNames(conn, cible.id), C.FOLDER_NAME_MAX);
      await conn.query('UPDATE safebox_folder SET name = ? WHERE id = ?', [nom, d.id]);
      if (Number(cible.id) !== Number(d.parent_id)) await moveFolder(conn, alanyaID, d, cible, settings);
      await conn.query(
        'UPDATE safebox_folder SET trashed_at = NULL, trashed_by_folder = NULL WHERE trashed_by_folder = ? AND alanyaID = ?',
        [d.id, alanyaID],
      );
      await conn.query(
        'UPDATE safebox_file SET trashed_at = NULL, trashed_by_folder = NULL WHERE trashed_by_folder = ? AND alanyaID = ?',
        [d.id, alanyaID],
      );
      await conn.query('UPDATE safebox_folder SET trashed_at = NULL WHERE id = ?', [d.id]);
    });
    const [[f]] = await db.query(
      'SELECT id, parent_id, root, name, depth, created_at, updated_at FROM safebox_folder WHERE id = ?',
      [id],
    );
    return folderShape(f);
  }

  // ── Fichiers ─────────────────────────────────────────────────────────────

  /** Un fichier prêt et vivant du compte, ou 404. */
  async function liveFile(conn, alanyaID, fileId) {
    const id = R.parseId(fileId);
    if (!id) throw introuvable();
    const [[f]] = await conn.query(
      `${FICHIER} WHERE f.id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
      [id, alanyaID],
    );
    if (!f) throw introuvable();
    return f;
  }

  /** `PATCH /api/safebox/files/:id` — renommer et/ou déplacer. */
  async function updateFile(alanyaID, fileId, body = {}) {
    const storage = ready();
    const settings = await getSettings();
    const f = await liveFile(db, alanyaID, fileId);
    const champs = [];
    const valeurs = [];
    if (body.name !== undefined) {
      const nom = R.normalizeName(body.name, C.FILE_NAME_MAX);
      const { ext } = R.assertFamily(f.family, nom, settings.extensions);
      champs.push('name = ?', 'ext = ?');
      valeurs.push(nom, ext);
    }
    if (body.folderId !== undefined) {
      const cible = await liveFolder(db, alanyaID, body.folderId);
      if (cible.root !== f.family) {
        throw new SafeboxError('SAFEBOX_WRONG_FAMILY', 400, 'Un fichier reste dans sa famille', { expectedRoot: f.family });
      }
      champs.push('folder_id = ?');
      valeurs.push(cible.id);
    }
    if (champs.length) {
      await db.query(`UPDATE safebox_file SET ${champs.join(', ')} WHERE id = ? AND alanyaID = ?`, [...valeurs, f.id, alanyaID]);
    }
    return fileShape(await liveFile(db, alanyaID, f.id), storage);
  }

  /** `DELETE /api/safebox/files/:id` — à la corbeille. */
  async function trashFile(alanyaID, fileId) {
    ready();
    const f = await liveFile(db, alanyaID, fileId);
    await db.query(
      'UPDATE safebox_file SET trashed_at = NOW(), trashed_by_folder = NULL WHERE id = ? AND alanyaID = ? AND trashed_at IS NULL',
      [f.id, alanyaID],
    );
    return { ok: true };
  }

  /** `POST /api/safebox/files/:id/restore` — dans son dossier, ou à la racine s'il est à la corbeille. */
  async function restoreFile(alanyaID, fileId) {
    const storage = ready();
    const racines = await ensureAccount(alanyaID);
    const id = R.parseId(fileId);
    if (!id) throw introuvable();
    const [[f]] = await db.query(
      `SELECT f.id, f.family, fo.trashed_at AS dossier_corbeille
         FROM safebox_file f JOIN safebox_folder fo ON fo.id = f.folder_id
        WHERE f.id = ? AND f.alanyaID = ? AND f.trashed_at IS NOT NULL AND f.trashed_by_folder IS NULL`,
      [id, alanyaID],
    );
    if (!f) throw introuvable();
    const versRacine = f.dossier_corbeille ? ', folder_id = ?' : '';
    await db.query(
      `UPDATE safebox_file SET trashed_at = NULL${versRacine} WHERE id = ? AND alanyaID = ?`,
      f.dossier_corbeille ? [racines[f.family].id, id, alanyaID] : [id, alanyaID],
    );
    return fileShape(await liveFile(db, alanyaID, id), storage);
  }

  /** `GET /api/safebox/files/:id/download` — clé et adresses de tous les blocs. */
  async function downloadFile(alanyaID, fileId) {
    const storage = ready();
    const f = await liveFile(db, alanyaID, fileId);
    const count = Number(f.block_count);
    const geo = { size: Number(f.stored_bytes), blockSize: Number(f.block_size), count };
    const blocs = [];
    for (let n = 1; n <= count; n += 1) {
      blocs.push({
        n,
        size: R.blockSizeOf(n, geo),
        url: await storage.downloadUrl(R.blockKey(f.prefix, n), C.DOWNLOAD_URL_TTL_S),
      });
    }
    return {
      file: await fileShape(f, storage),
      key: unwrapFileKey(f.wrapped_key, f.blob_id, env).toString('base64'),
      blockSize: geo.blockSize,
      blockCount: count,
      blocks: blocs,
      urlTtlSeconds: C.DOWNLOAD_URL_TTL_S,
    };
  }

  /**
   * `GET /api/safebox/largest` — les plus gros fichiers de tout le coffre,
   * pour l'écran « Libérer de l'espace », avec ce que pèse la corbeille.
   */
  async function largestFiles(alanyaID, { limit } = {}) {
    const storage = ready();
    const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const [rows] = await db.query(
      `SELECT f.id, f.folder_id, f.name, f.ext, f.mime, f.family, f.original_bytes,
              f.compressed, f.trashed_at, f.trashed_by_folder, f.created_at, f.updated_at,
              b.id AS blob_id, b.prefix, b.block_size, b.block_count, b.stored_bytes,
              b.plain_bytes, b.preview_bytes, b.cipher_format, b.wrapped_key, b.status,
              fo.name AS folder_name
         FROM safebox_file f
         JOIN safebox_blob b ON b.id = f.blob_id
         JOIN safebox_folder fo ON fo.id = f.folder_id
        WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
        ORDER BY (b.stored_bytes + b.preview_bytes) DESC, f.id DESC
        LIMIT ${n}`,
      [alanyaID],
    );
    const { trashBytes } = await usageOf(db, alanyaID);
    return {
      trashBytes,
      files: await Promise.all(rows.map(async (f) => ({
        ...(await fileShape(f, storage)),
        // Nul pour un dossier racine : l'application affiche son nom traduit.
        folderName: f.folder_name,
      }))),
    };
  }

  // ── Envois ───────────────────────────────────────────────────────────────

  async function signBlocks(storage, blob, numeros) {
    const geo = { size: Number(blob.stored_bytes), blockSize: Number(blob.block_size), count: Number(blob.block_count) };
    const out = [];
    for (const n of numeros) {
      const size = R.blockSizeOf(n, geo);
      out.push({ n, size, url: await storage.uploadUrl(R.blockKey(blob.prefix, n), size, C.UPLOAD_URL_TTL_S) });
    }
    return out;
  }

  async function signPreview(storage, blob) {
    const size = Number(blob.preview_bytes);
    if (!size) return null;
    return { size, url: await storage.uploadUrl(R.previewKey(blob.prefix), size, C.UPLOAD_URL_TTL_S) };
  }

  /**
   * `POST /api/safebox/uploads` — réserve l'espace et rend les premières
   * adresses d'envoi. La réservation compte dans l'espace dès maintenant.
   */
  async function reserveUpload(alanyaID, body = {}) {
    const storage = ready();
    const settings = await getSettings();
    const nom = R.normalizeName(body.name, C.FILE_NAME_MAX);
    const tailles = R.validateSizes(body, { maxFileBytes: await maxFileFor(alanyaID, settings) });
    const format = R.validateCipherFormat(body.cipherFormat);
    const mime = typeof body.mime === 'string' && body.mime.length <= 127 ? body.mime : null;
    const count = R.blockCount(tailles.size, C.BLOCK_BYTES);
    const prefix = `u/${accountTag(alanyaID, env)}/${crypto.randomUUID()}/`;
    const quotaBytes = await quotaFor(alanyaID, settings);
    await ensureAccount(alanyaID);

    const { fileId, blob } = await tx(async (conn) => {
      // Verrou du compte : deux réservations simultanées ne dépassent pas l'espace.
      await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      const dossier = await liveFolder(conn, alanyaID, body.folderId);
      const { ext } = R.assertFamily(dossier.root, nom, settings.extensions);
      const { usedBytes } = await usageOf(conn, alanyaID);
      const ajout = tailles.size + tailles.previewSize;
      if (!R.fitsQuota({ usedBytes, quotaBytes, addBytes: ajout })) {
        throw new SafeboxError('SAFEBOX_QUOTA_EXCEEDED', 409, 'Espace du coffre insuffisant', {
          usedBytes, quotaBytes, neededBytes: ajout,
        });
      }
      const [b] = await conn.query(
        `INSERT INTO safebox_blob (alanyaID, prefix, block_size, block_count, stored_bytes, plain_bytes,
                                   preview_bytes, cipher_format)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [alanyaID, prefix, C.BLOCK_BYTES, count, tailles.size, tailles.plainSize, tailles.previewSize, format],
      );
      const [f] = await conn.query(
        `INSERT INTO safebox_file (alanyaID, folder_id, blob_id, name, ext, mime, family, original_bytes, compressed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [alanyaID, dossier.id, b.insertId, nom, ext, mime, dossier.root, tailles.originalSize, body.compressed ? 1 : 0],
      );
      return {
        fileId: f.insertId,
        blob: {
          prefix, stored_bytes: tailles.size, block_size: C.BLOCK_BYTES, block_count: count,
          preview_bytes: tailles.previewSize,
        },
      };
    });

    const premiers = [];
    for (let n = 1; n <= Math.min(count, C.BLOCK_URLS_PER_CALL); n += 1) premiers.push(n);
    return {
      fileId,
      blockSize: C.BLOCK_BYTES,
      blockCount: count,
      size: tailles.size,
      blocks: await signBlocks(storage, blob, premiers),
      preview: await signPreview(storage, blob),
      urlTtlSeconds: C.UPLOAD_URL_TTL_S,
    };
  }

  /** Un envoi en cours du compte, ou 404. */
  async function pendingUpload(alanyaID, fileId) {
    const id = R.parseId(fileId);
    if (!id) throw introuvable();
    const [[f]] = await db.query(
      `${FICHIER} WHERE f.id = ? AND f.alanyaID = ? AND b.status = 'pending'`,
      [id, alanyaID],
    );
    if (!f) throw introuvable();
    return f;
  }

  const toucher = (blobId) => db.query('UPDATE safebox_blob SET activity_at = NOW() WHERE id = ?', [blobId]);

  /** `POST /api/safebox/uploads/:id/blocks` — adresses de blocs choisis (suivants ou expirés). */
  async function uploadUrls(alanyaID, fileId, body = {}) {
    const storage = ready();
    const f = await pendingUpload(alanyaID, fileId);
    const count = Number(f.block_count);
    const numeros = Array.isArray(body.blocks) ? body.blocks.map(Number) : [];
    if (numeros.length > C.BLOCK_URLS_PER_CALL
        || numeros.some((n) => !Number.isInteger(n) || n < 1 || n > count)
        || new Set(numeros).size !== numeros.length
        || (!numeros.length && !body.preview)) {
      throw new SafeboxError('SAFEBOX_INVALID_BLOCKS', 400, 'Numéros de blocs invalides', {
        blockCount: count, maxPerCall: C.BLOCK_URLS_PER_CALL,
      });
    }
    await toucher(f.blob_id);
    return {
      blocks: await signBlocks(storage, f, numeros),
      preview: body.preview ? await signPreview(storage, f) : null,
      urlTtlSeconds: C.UPLOAD_URL_TTL_S,
    };
  }

  async function compare(storage, f) {
    const objets = await storage.list(f.prefix);
    return R.compareBlocks(objets, {
      prefix: f.prefix,
      size: Number(f.stored_bytes),
      blockSize: Number(f.block_size),
      count: Number(f.block_count),
      previewSize: Number(f.preview_bytes),
    });
  }

  /** `GET /api/safebox/uploads/:id/blocks` — ce que MEGA a déjà reçu, pour reprendre. */
  async function uploadStatus(alanyaID, fileId) {
    const storage = ready();
    const f = await pendingUpload(alanyaID, fileId);
    await toucher(f.blob_id);
    const etat = await compare(storage, f);
    return {
      blockCount: Number(f.block_count),
      received: etat.recus,
      missing: etat.manquants,
      previewMissing: etat.apercuManquant,
    };
  }

  /**
   * `POST /api/safebox/uploads/:id/complete` — vérifie chez MEGA que chaque
   * bloc est là, à sa taille exacte, range la clé, et le fichier apparaît.
   */
  async function completeUpload(alanyaID, fileId, body = {}) {
    const storage = ready();
    const cle = R.decodeFileKey(body.key);
    const f = await pendingUpload(alanyaID, fileId);
    const etat = await compare(storage, f);
    if (etat.manquants.length || etat.apercuManquant) {
      await toucher(f.blob_id);
      throw new SafeboxError('SAFEBOX_UPLOAD_INCOMPLETE', 409, 'Des blocs manquent encore', {
        missing: etat.manquants.slice(0, 200),
        missingCount: etat.manquants.length,
        previewMissing: etat.apercuManquant,
      });
    }
    const [r] = await db.query(
      `UPDATE safebox_blob SET status = 'ready', wrapped_key = ?, completed_at = NOW(), activity_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [wrapFileKey(cle, f.blob_id, env), f.blob_id],
    );
    if (!r.affectedRows) throw introuvable(); // abandonné entre-temps
    const [[pret]] = await db.query(`${FICHIER} WHERE f.id = ? AND f.alanyaID = ?`, [f.id, alanyaID]);
    return fileShape(pret, storage);
  }

  /** `DELETE /api/safebox/uploads/:id` — abandonne l'envoi et libère l'espace réservé. */
  async function cancelUpload(alanyaID, fileId) {
    const storage = ready();
    const f = await pendingUpload(alanyaID, fileId);
    await db.query('DELETE FROM safebox_file WHERE id = ? AND alanyaID = ?', [f.id, alanyaID]);
    await collectOrphans(db, storage, { blobIds: [Number(f.blob_id)] })
      .catch((e) => console.error('[Coffre] ménage après abandon :', e.message));
    return { ok: true };
  }

  // ── Corbeille ────────────────────────────────────────────────────────────

  /** `GET /api/safebox/trash` — ce qui a été mis à la corbeille, et quand cela partira. */
  async function listTrash(alanyaID) {
    const storage = ready();
    const jours = await trashDays();
    const [dossiers] = await db.query(
      `SELECT fo.id, fo.parent_id, fo.root, fo.name, fo.depth, fo.created_at, fo.updated_at, fo.trashed_at,
              (SELECT COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0)
                 FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
                WHERE f.trashed_by_folder = fo.id) AS octets,
              (SELECT COUNT(*) FROM safebox_file f WHERE f.trashed_by_folder = fo.id) AS fichiers
         FROM safebox_folder fo
        WHERE fo.alanyaID = ? AND fo.trashed_at IS NOT NULL AND fo.trashed_by_folder IS NULL
        ORDER BY fo.trashed_at DESC`,
      [alanyaID],
    );
    const [fichiers] = await db.query(
      `${FICHIER} WHERE f.alanyaID = ? AND f.trashed_at IS NOT NULL AND f.trashed_by_folder IS NULL
        AND b.status = 'ready' ORDER BY f.trashed_at DESC LIMIT 1000`,
      [alanyaID],
    );
    const echeance = (d) => new Date(new Date(d).getTime() + jours * 86_400_000);
    return {
      trashDays: jours,
      folders: dossiers.map((d) => ({
        ...folderShape(d),
        trashedAt: d.trashed_at,
        purgeAt: echeance(d.trashed_at),
        storedBytes: Number(d.octets),
        files: Number(d.fichiers),
      })),
      files: await Promise.all(fichiers.map(async (f) => ({
        ...(await fileShape(f, storage)),
        trashedAt: f.trashed_at,
        purgeAt: echeance(f.trashed_at),
      }))),
    };
  }

  /** Supprime des lignes de la corbeille puis, chez MEGA, les blobs devenus orphelins. */
  async function supprimerDefinitivement(storage, alanyaID, { fichierId = null, dossierId = null } = {}) {
    const blobIds = await tx(async (conn) => {
      let ids;
      if (fichierId) {
        [ids] = await conn.query(
          'SELECT blob_id FROM safebox_file WHERE id = ? AND alanyaID = ? AND trashed_at IS NOT NULL AND trashed_by_folder IS NULL',
          [fichierId, alanyaID],
        );
        if (!ids.length) throw introuvable();
        await conn.query('DELETE FROM safebox_file WHERE id = ?', [fichierId]);
      } else if (dossierId) {
        const [[d]] = await conn.query(
          'SELECT id, path FROM safebox_folder WHERE id = ? AND alanyaID = ? AND trashed_at IS NOT NULL AND trashed_by_folder IS NULL',
          [dossierId, alanyaID],
        );
        if (!d) throw introuvable();
        // Tout ce qui est dessous, y compris un sous-dossier mis à la corbeille
        // à part avant lui : la cascade l'emporte aussi.
        [ids] = await conn.query(
          `SELECT f.blob_id FROM safebox_file f JOIN safebox_folder fo ON fo.id = f.folder_id
            WHERE f.alanyaID = ? AND fo.path LIKE CONCAT(?, '%')`,
          [alanyaID, d.path],
        );
        await conn.query('DELETE FROM safebox_folder WHERE id = ?', [d.id]);
      } else {
        [ids] = await conn.query('SELECT blob_id FROM safebox_file WHERE alanyaID = ? AND trashed_at IS NOT NULL', [alanyaID]);
        await conn.query('DELETE FROM safebox_file WHERE alanyaID = ? AND trashed_at IS NOT NULL', [alanyaID]);
        await conn.query(
          'DELETE FROM safebox_folder WHERE alanyaID = ? AND trashed_at IS NOT NULL AND trashed_by_folder IS NULL',
          [alanyaID],
        );
      }
      return [...new Set(ids.map((r) => Number(r.blob_id)))];
    });
    // « Vider la corbeille » supprime tout de suite chez MEGA ; ce qui échoue
    // ici est repris par la purge de la nuit.
    await collectOrphans(db, storage, { blobIds })
      .catch((e) => console.error('[Coffre] ménage après suppression :', e.message));
    return { ok: true, files: blobIds.length };
  }

  /** `DELETE /api/safebox/trash` — vide la corbeille. */
  async function emptyTrash(alanyaID) {
    return supprimerDefinitivement(ready(), alanyaID);
  }

  /** `DELETE /api/safebox/trash/files/:id` — supprime définitivement un fichier. */
  async function deleteTrashedFile(alanyaID, fileId) {
    const id = R.parseId(fileId);
    if (!id) throw introuvable();
    return supprimerDefinitivement(ready(), alanyaID, { fichierId: id });
  }

  /** `DELETE /api/safebox/trash/folders/:id` — supprime définitivement un dossier et son contenu. */
  async function deleteTrashedFolder(alanyaID, folderId) {
    const id = R.parseId(folderId);
    if (!id) throw introuvable();
    return supprimerDefinitivement(ready(), alanyaID, { dossierId: id });
  }

  return {
    overview,
    listFolder,
    createFolder,
    updateFolder,
    trashFolder,
    restoreFolder,
    updateFile,
    trashFile,
    restoreFile,
    downloadFile,
    largestFiles,
    reserveUpload,
    uploadUrls,
    uploadStatus,
    completeUpload,
    cancelUpload,
    listTrash,
    emptyTrash,
    deleteTrashedFile,
    deleteTrashedFolder,
    // Pour les tests.
    ensureAccount,
    usageOf: (alanyaID) => usageOf(db, alanyaID),
  };
}

let _service = null;
function safeboxService() {
  if (!_service) _service = createSafeboxService();
  return _service;
}

module.exports = { createSafeboxService, safeboxService };
