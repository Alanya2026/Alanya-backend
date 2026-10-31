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
const { keyConfigured, wrapFileKey, unwrapFileKey, accountTag, sourceFingerprint } = require('./keys');
const { defaultStorage } = require('./storage');
const { getSafeboxSettings } = require('./settings');
const { collectOrphans } = require('./purge');
const { decryptPreview, imageMime } = require('./cipher');
const { createPlusSpace } = require('./plusSpace');

const introuvable = () => new SafeboxError('SAFEBOX_NOT_FOUND', 404, 'Introuvable');
const taille = (b) => Number(b.stored_bytes) + Number(b.preview_bytes);

function createSafeboxService({
  db = pool,
  getStorage = () => defaultStorage(),
  env = process.env,
  getSettings = getSafeboxSettings,
  trashDays = async () => (await require('../purgeRegistry').resolveOptions('safebox')).trashDays,
  spaceFor = null,
} = {}) {
  const espace = spaceFor || createPlusSpace({ db }).spaceFor;

  /** Le stockage, ou 503 tant que MEGA S4 et SAFEBOX_KEY ne sont pas configurés. */
  function ready() {
    const storage = keyConfigured(env) ? getStorage() : null;
    if (!storage) throw new SafeboxError('SAFEBOX_UNAVAILABLE', 503, 'Coffre-fort indisponible');
    return storage;
  }

  /**
   * Espace du compte et plus gros fichier permis : l'espace de base, ou celui
   * du plan Alanya Plus en phase payante (lot 4, `plusSpace.js`).
   */
  async function quotaFor(alanyaID, settings) {
    return (await espace(alanyaID, settings)).quotaBytes;
  }

  async function maxFileFor(alanyaID, settings) {
    return (await espace(alanyaID, settings)).maxFileBytes;
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

  /**
   * La migration 108 (six dossiers) doit être passée : sans elle, l'insertion
   * des racines « photos » et « partager » créerait des lignes vides (INSERT
   * IGNORE sur un ENUM qui ne les connaît pas) et le type « photos » serait
   * refusé. Le coffre répond alors « indisponible » sans rien écrire. Seule la
   * réponse positive est gardée : appliquer la migration suffit, sans
   * redémarrer.
   */
  let sixDossiers = false;
  async function assertSixDossiers() {
    if (sixDossiers) return;
    const [[c]] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'safebox_folder' AND COLUMN_NAME = 'root'
          AND COLUMN_TYPE LIKE '%''partager''%'`,
    );
    if (!Number(c.n)) {
      console.error('[Coffre] migration 108_safebox_six_dossiers.sql absente : coffre indisponible');
      throw new SafeboxError('SAFEBOX_UNAVAILABLE', 503, 'Coffre-fort indisponible');
    }
    sixDossiers = true;
  }

  // ── Compte et dossiers racines ───────────────────────────────────────────

  /**
   * Ouvre le coffre à sa première visite : la ligne du compte et les six
   * racines. Un coffre ouvert avant le 24/10/2026 reçoit ici « albums » et
   * « partager » à sa visite suivante.
   */
  async function ensureAccount(alanyaID) {
    await assertSixDossiers();
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

  /**
   * Ce que le coffre occupe. Un même contenu à plusieurs endroits (Photos et
   * un album, décision du 24/10/2026) ne compte qu'une fois : on somme les
   * blobs distincts du compte. La corbeille ne compte que les blobs dont tous
   * les exemplaires y sont, ce que la vider libérerait.
   */
  async function usageOf(conn, alanyaID) {
    const [[u]] = await conn.query(
      `SELECT COALESCE(SUM(t), 0) AS used,
              COALESCE(SUM(IF(en_cours, t, 0)), 0) AS pending,
              COALESCE(SUM(IF(tout_jete, t, 0)), 0) AS trash
         FROM (SELECT b.stored_bytes + b.preview_bytes AS t,
                      b.status = 'pending' AS en_cours,
                      MIN(f.trashed_at IS NOT NULL) AS tout_jete
                 FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
                WHERE f.alanyaID = ?
                GROUP BY b.id) x`,
      [alanyaID],
    );
    let notes = { used: 0, pending: 0, trash: 0 };
    try {
      // Audios des commentaires de photos (migration 107) : ils comptent aussi.
      const [[n]] = await conn.query(
        `SELECT COALESCE(SUM(n.audio_bytes), 0) AS used,
                COALESCE(SUM(IF(n.audio_status = 'pending', n.audio_bytes, 0)), 0) AS pending,
                COALESCE(SUM(IF(f.trashed_at IS NOT NULL, n.audio_bytes, 0)), 0) AS trash
           FROM safebox_note n JOIN safebox_file f ON f.id = n.file_id
          WHERE f.alanyaID = ? AND n.audio_prefix IS NOT NULL`,
        [alanyaID],
      );
      notes = { used: Number(n.used), pending: Number(n.pending), trash: Number(n.trash) };
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    return {
      usedBytes: Number(u.used) + notes.used,
      pendingBytes: Number(u.pending) + notes.pending,
      trashBytes: Number(u.trash) + notes.trash,
    };
  }

  /** `GET /api/safebox` — l'espace, les dossiers racines, les limites. */
  async function overview(alanyaID) {
    ready();
    const settings = await getSettings();
    const racines = await ensureAccount(alanyaID);
    const usage = await usageOf(db, alanyaID);
    // Par racine, chaque contenu une fois : dans la première racine où il se
    // trouve, dans l'ordre d'affichage (une photo de Photos ajoutée à un album
    // compte dans Photos).
    const [parRang] = await db.query(
      `SELECT rang, COALESCE(SUM(t), 0) AS octets, COUNT(*) AS fichiers
         FROM (SELECT b.stored_bytes + b.preview_bytes AS t, MIN(FIELD(fo.root, ?)) AS rang
                 FROM safebox_file f
                 JOIN safebox_blob b ON b.id = f.blob_id
                 JOIN safebox_folder fo ON fo.id = f.folder_id
                WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
                GROUP BY b.id) x
        GROUP BY rang`,
      [C.ROOTS, alanyaID],
    );
    const familles = {};
    for (const root of C.ROOTS) familles[root] = { bytes: 0, files: 0 };
    for (const r of parRang) {
      const root = C.ROOTS[Number(r.rang) - 1];
      if (root) familles[root] = { bytes: Number(r.octets), files: Number(r.fichiers) };
    }
    const sonEspace = await espace(alanyaID, settings);
    return {
      quota: {
        quotaBytes: sonEspace.quotaBytes,
        plus: sonEspace.plus,
        baseQuotaBytes: settings.baseQuotaBytes,
        ...usage,
        byRoot: familles,
      },
      roots: C.ROOTS.map((root) => ({ id: racines[root].id, root })),
      limits: {
        maxFileBytes: sonEspace.maxFileBytes,
        shareDownloadsPerDay: settings.shareDownloadsPerDay,
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

  /**
   * Pour chaque blob, en une requête : ses détails (durée, définition,
   * pages…, migration 104) et s'il est perdu chez MEGA (migration 106). Sans
   * ces migrations, rien : la carte s'affiche sans détails, rien n'est perdu.
   */
  async function detailsDe(blobIds) {
    const ids = [...new Set(blobIds.map(Number).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    for (const colonnes of ['id, meta, lost_at', 'id, meta']) {
      try {
        const [rows] = await db.query(`SELECT ${colonnes} FROM safebox_blob WHERE id IN (?)`, [ids]);
        for (const r of rows) out.set(Number(r.id), { meta: R.normalizeMeta(r.meta), lostAt: r.lost_at ?? null });
        return out;
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      }
    }
    return out;
  }

  async function metaDe(blobId) {
    return (await detailsDe([blobId])).get(Number(blobId))?.meta ?? null;
  }

  const perdu = () => new SafeboxError('SAFEBOX_FILE_LOST', 410,
    "Fichier endommagé : son contenu a été perdu chez l'hébergeur et ne peut pas être récupéré");

  /**
   * Ce que sont devenus les partages de ces fichiers, pour le badge de
   * l'expéditeur : partages actifs (le fichier seul ou dans un lot, migration
   * 109), destinataires (membres actuels des discussions, expéditeur exclu),
   * ceux d'entre eux qui l'ont reçu (téléchargé ou gardé dans leur coffre), et
   * la discussion du dernier partage (« Famille Ngono · téléchargé par 5 sur
   * 8 »). `received` est null sans la migration 104 ; sans la 102, aucun
   * fichier n'a de partage.
   */
  async function envoisDe(fileIds) {
    const ids = [...new Set(fileIds.map(Number).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const partages = `SELECT s.id AS share_id, s.file_id, s.conversation_id, s.sender_id
                        FROM safebox_share s
                       WHERE s.file_id IN (?) AND s.revoked_at IS NULL
                      UNION ALL
                      SELECT s.id, i.file_id, s.conversation_id, s.sender_id
                        FROM safebox_share_item i JOIN safebox_share s ON s.id = i.share_id
                       WHERE i.file_id IN (?) AND s.revoked_at IS NULL`;
    try {
      const [rows] = await db.query(
        `SELECT x.file_id, COUNT(DISTINCT x.share_id) AS partages, COUNT(DISTINCT cp.alanyaID) AS destinataires,
                SUBSTRING_INDEX(GROUP_CONCAT(x.conversation_id ORDER BY x.share_id DESC), ',', 1) AS derniere
           FROM (${partages}) x
           LEFT JOIN conv_participants cp ON cp.conversID = x.conversation_id AND cp.alanyaID <> x.sender_id
          GROUP BY x.file_id`,
        [ids, ids],
      );
      for (const r of rows) {
        out.set(Number(r.file_id), {
          shares: Number(r.partages),
          recipients: Number(r.destinataires),
          received: null,
          lastConversationId: Number(r.derniere) || null,
        });
      }
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return out;
      throw e;
    }
    if (!out.size) return out;
    const avecPartage = [...out.keys()];
    try {
      const [rows] = await db.query(
        `SELECT x.file_id, COUNT(DISTINCT r.alanyaID) AS recus
           FROM (${partages}) x
           JOIN safebox_share_recipient r ON r.share_id = x.share_id
           JOIN conv_participants cp ON cp.conversID = x.conversation_id AND cp.alanyaID = r.alanyaID
          GROUP BY x.file_id`,
        [avecPartage, avecPartage],
      );
      for (const v of out.values()) v.received = 0;
      for (const r of rows) out.get(Number(r.file_id)).received = Number(r.recus);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    return out;
  }

  /**
   * Commentaires des photos (migration 107), pour leur propriétaire seulement :
   * texte, et audio prêt avec son adresse signée et sa clé.
   *
   * Un commentaire suit la photo, pas l'exemplaire (31/10/2026) : rangé sur
   * un seul exemplaire (son porteur), il se montre sur tous ceux du même
   * contenu dans le coffre — Photos et albums.
   */
  async function notesDe(storage, fileIds) {
    const ids = [...new Set(fileIds.map(Number).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    let rows;
    try {
      [rows] = await db.query(
        `SELECT f.id AS pour, n.*
           FROM safebox_file f
           JOIN safebox_file x ON x.alanyaID = f.alanyaID AND x.blob_id = f.blob_id
           JOIN safebox_note n ON n.file_id = x.id
          WHERE f.id IN (?)
          ORDER BY f.id, x.trashed_at IS NULL DESC, n.updated_at DESC`,
        [ids],
      );
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return out;
      throw e;
    }
    for (const n of rows) {
      if (!out.has(Number(n.pour))) out.set(Number(n.pour), await noteShape(storage, n));
    }
    return out;
  }

  async function noteShape(storage, n) {
    const pret = n.audio_prefix && n.audio_status === 'ready' && n.audio_wrapped_key;
    const audio = pret
      ? {
        durationMs: Number(n.audio_duration_ms),
        plainBytes: Number(n.audio_plain_bytes),
        storedBytes: Number(n.audio_bytes),
        url: await storage.downloadUrl(R.blockKey(n.audio_prefix, 1), C.PREVIEW_URL_TTL_S),
        key: unwrapFileKey(n.audio_wrapped_key, `note-${n.file_id}`, env).toString('base64'),
      }
      : null;
    if (!n.text && !audio) return null;
    return { text: n.text || null, audio, updatedAt: n.updated_at };
  }

  /**
   * Où se trouve chaque contenu dans le coffre du compte, hors corbeille :
   * un même blob peut être dans Photos et dans des albums (décision du
   * 24/10/2026). La feuille de suppression le dit et propose « partout ».
   */
  async function endroitsDe(alanyaID, blobIds) {
    const ids = [...new Set(blobIds.map(Number).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const [rows] = await db.query(
      `SELECT f.id, f.blob_id, f.folder_id, fo.root, fo.name
         FROM safebox_file f JOIN safebox_folder fo ON fo.id = f.folder_id
        WHERE f.alanyaID = ? AND f.blob_id IN (?) AND f.trashed_at IS NULL
        ORDER BY f.id`,
      [alanyaID, ids],
    );
    for (const r of rows) {
      const cle = Number(r.blob_id);
      if (!out.has(cle)) out.set(cle, []);
      // Nom nul pour un dossier racine : l'application affiche son nom traduit.
      out.get(cle).push({ fileId: Number(r.id), folderId: Number(r.folder_id), root: r.root, folderName: r.name });
    }
    return out;
  }

  /**
   * Ajoute aux lignes leur `meta` et, sur demande, leur `sent` (badge), leur
   * `note` et leurs autres endroits (`places` : le compte propriétaire).
   */
  async function enrichir(rows, { envois = false, notes = null, places = null } = {}) {
    const details = await detailsDe(rows.map((f) => f.blob_id));
    const partages = envois ? await envoisDe(rows.map((f) => f.id)) : new Map();
    const commentaires = notes ? await notesDe(notes, rows.filter((f) => f.family === 'photos').map((f) => f.id)) : null;
    const endroits = places ? await endroitsDe(places, rows.map((f) => f.blob_id)) : null;
    for (const f of rows) {
      if (commentaires) f.note = commentaires.get(Number(f.id)) ?? null;
      const d = details.get(Number(f.blob_id));
      f.meta = d?.meta ?? null;
      f.lost = Boolean(d?.lostAt);
      if (envois) f.sent = partages.get(Number(f.id)) ?? null;
      if (endroits) f.alsoIn = (endroits.get(Number(f.blob_id)) ?? []).filter((p) => p.fileId !== Number(f.id));
    }
    return rows;
  }

  /** Un destinataire a reçu le fichier (une ligne pour toujours, migration 104). */
  async function noterDestinataire(shareId, alanyaID) {
    try {
      await db.query('INSERT IGNORE INTO safebox_share_recipient (share_id, alanyaID) VALUES (?, ?)', [shareId, alanyaID]);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
  }

  /** Un fichier tel que l'application l'affiche, clé comprise (le propriétaire seul le voit). */
  async function fileShape(f, storage) {
    if (f.meta === undefined) await enrichir([f]);
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
      // Original, HD ou Compressé (décision du 24/10/2026), gardé dans la
      // colonne `compressed` : voir R.qualityCode.
      quality: R.qualityName(f.compressed),
      cipherFormat: f.cipher_format,
      meta: f.meta,
      // Contenu introuvable chez MEGA au dernier rapprochement (migration 106).
      lost: Boolean(f.lost),
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    };
    if (f.sent !== undefined) out.sent = f.sent;
    if (f.alsoIn !== undefined) out.alsoIn = f.alsoIn;
    // Commentaire privé : seulement quand l'appelant l'a demandé pour le propriétaire.
    if (f.note !== undefined) out.note = f.note;
    if (f.wrapped_key) out.key = unwrapFileKey(f.wrapped_key, f.blob_id, env).toString('base64');
    out.previewUrl = Number(f.preview_bytes) > 0
      ? await storage.downloadUrl(R.previewKey(prefix), C.PREVIEW_URL_TTL_S)
      : null;
    return out;
  }

  const COLONNES_FICHIER = `f.id, f.folder_id, f.name, f.ext, f.mime, f.family, f.original_bytes,
                          f.compressed, f.trashed_at, f.trashed_by_folder, f.created_at, f.updated_at,
                          b.id AS blob_id, b.prefix, b.block_size, b.block_count, b.stored_bytes,
                          b.plain_bytes, b.preview_bytes, b.cipher_format, b.wrapped_key, b.status`;
  const FICHIER = `SELECT ${COLONNES_FICHIER} FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id`;

  /**
   * `GET /api/safebox/albums/recent` — les albums de l'accueil en une seule
   * demande (30/10/2026) : les derniers remplis (dernier ajout, sinon
   * création), leur nombre de fichiers et quatre fichiers de couverture,
   * photos et vidéos d'abord. Seules ces couvertures portent leur clé.
   */
  async function recentAlbums(alanyaID, { limit } = {}) {
    const storage = ready();
    const n = Math.min(Math.max(R.parseId(limit) ?? 3, 1), 12);
    const racine = (await ensureAccount(alanyaID)).albums;
    if (!racine) return { albums: [] };
    const [albums] = await db.query(
      `SELECT fo.id, fo.parent_id, fo.root, fo.name, fo.depth, fo.created_at, fo.updated_at,
              COUNT(f.id) AS fichiers, MAX(f.created_at) AS dernier_ajout
         FROM safebox_folder fo
         LEFT JOIN (SELECT f.id, f.folder_id, f.created_at
                      FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
                     WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready') f
                ON f.folder_id = fo.id
        WHERE fo.parent_id = ? AND fo.alanyaID = ? AND fo.trashed_at IS NULL
        GROUP BY fo.id
        ORDER BY COALESCE(dernier_ajout, fo.created_at) DESC, fo.id DESC
        LIMIT ${n}`,
      [alanyaID, racine.id, alanyaID],
    );
    if (!albums.length) return { albums: [] };
    const [couvertures] = await db.query(
      `SELECT * FROM (
         SELECT ${COLONNES_FICHIER},
                ROW_NUMBER() OVER (PARTITION BY f.folder_id
                                   ORDER BY f.family IN ('photos', 'videos') DESC, f.id DESC) AS rang
           FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
          WHERE f.folder_id IN (?) AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
       ) x WHERE x.rang <= 4 ORDER BY x.folder_id, x.rang`,
      [albums.map((a) => a.id), alanyaID],
    );
    const formes = await Promise.all((await enrichir(couvertures)).map((f) => fileShape(f, storage)));
    return {
      albums: albums.map((a) => ({
        ...folderShape(a),
        fileCount: Number(a.fichiers),
        lastAddedAt: a.dernier_ajout ?? null,
        cover: formes.filter((f) => f.folderId === Number(a.id)),
      })),
    };
  }

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
      files: await Promise.all((await enrichir(fichiers, { envois: true, notes: storage, places: alanyaID }))
        .map((f) => fileShape(f, storage))),
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
      const [jetes] = await conn.query(
        'SELECT DISTINCT blob_id FROM safebox_file WHERE trashed_by_folder = ? AND alanyaID = ?',
        [d.id, alanyaID],
      );
      await retenirSuppression(conn, alanyaID, jetes.map((x) => x.blob_id));
      await relogerNotes(conn, alanyaID, jetes.map((x) => x.blob_id));
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
      const [revenus] = await conn.query(
        'SELECT DISTINCT blob_id FROM safebox_file WHERE trashed_by_folder = ? AND alanyaID = ?',
        [d.id, alanyaID],
      );
      await conn.query(
        'UPDATE safebox_file SET trashed_at = NULL, trashed_by_folder = NULL WHERE trashed_by_folder = ? AND alanyaID = ?',
        [d.id, alanyaID],
      );
      await oublierSuppression(conn, alanyaID, revenus.map((x) => x.blob_id));
      await relogerNotes(conn, alanyaID, revenus.map((x) => x.blob_id));
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

  /**
   * `PATCH /api/safebox/files/:id` — renommer (même famille) et/ou déplacer
   * vers un dossier qui accepte sa famille : le dossier de sa famille, Albums
   * ou Partager.
   */
  async function updateFile(alanyaID, fileId, body = {}) {
    const storage = ready();
    await assertSixDossiers(); // un déplacement dépend des six racines
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
      if (!R.acceptsFamily(cible.root, f.family)) {
        throw new SafeboxError('SAFEBOX_WRONG_FAMILY', 400, "Ce dossier n'accepte pas ce type de fichier", { expectedRoot: f.family });
      }
      champs.push('folder_id = ?');
      valeurs.push(cible.id);
    }
    if (champs.length) {
      await db.query(`UPDATE safebox_file SET ${champs.join(', ')} WHERE id = ? AND alanyaID = ?`, [...valeurs, f.id, alanyaID]);
    }
    return fileShape(await liveFile(db, alanyaID, f.id), storage);
  }

  /**
   * `DELETE /api/safebox/files/:id` — à la corbeille. Seulement cet exemplaire
   * (« Retirer de l'album seulement ») ; avec `everywhere`, tous les
   * exemplaires du même contenu dans le coffre (« Supprimer partout »), seul
   * moyen de libérer sa place. Rend le nombre d'exemplaires jetés.
   */
  async function trashFile(alanyaID, fileId, { everywhere = false } = {}) {
    ready();
    const f = await liveFile(db, alanyaID, fileId);
    const [r] = everywhere
      ? await db.query(
        `UPDATE safebox_file SET trashed_at = NOW(), trashed_by_folder = NULL
          WHERE alanyaID = ? AND blob_id = ? AND trashed_at IS NULL`,
        [alanyaID, f.blob_id],
      )
      : await db.query(
        'UPDATE safebox_file SET trashed_at = NOW(), trashed_by_folder = NULL WHERE id = ? AND alanyaID = ? AND trashed_at IS NULL',
        [f.id, alanyaID],
      );
    await retenirSuppression(db, alanyaID, [f.blob_id]);
    await relogerNotes(db, alanyaID, [f.blob_id]);
    return { ok: true, trashed: r.affectedRows };
  }

  /**
   * `POST /api/safebox/files/:id/restore` — dans son dossier, ou à la racine
   * de ce dossier si lui-même est à la corbeille.
   */
  async function restoreFile(alanyaID, fileId) {
    const storage = ready();
    const racines = await ensureAccount(alanyaID);
    const id = R.parseId(fileId);
    if (!id) throw introuvable();
    const [[f]] = await db.query(
      `SELECT f.id, f.blob_id, fo.root, fo.trashed_at AS dossier_corbeille
         FROM safebox_file f JOIN safebox_folder fo ON fo.id = f.folder_id
        WHERE f.id = ? AND f.alanyaID = ? AND f.trashed_at IS NOT NULL AND f.trashed_by_folder IS NULL`,
      [id, alanyaID],
    );
    if (!f) throw introuvable();
    const versRacine = f.dossier_corbeille ? ', folder_id = ?' : '';
    await db.query(
      `UPDATE safebox_file SET trashed_at = NULL${versRacine} WHERE id = ? AND alanyaID = ?`,
      f.dossier_corbeille ? [racines[f.root].id, id, alanyaID] : [id, alanyaID],
    );
    await oublierSuppression(db, alanyaID, [f.blob_id]);
    await relogerNotes(db, alanyaID, [f.blob_id]);
    return fileShape(await liveFile(db, alanyaID, id), storage);
  }

  /**
   * `POST /api/safebox/folders/:id/files` — ajoute des fichiers du coffre à
   * un album, sans copie (décision du 24/10/2026) : l'album désigne les mêmes
   * blocs, et l'espace ne les compte qu'une fois. Un fichier déjà dans cet
   * album n'est pas ajouté deux fois. Rend les fichiers de l'album.
   */
  async function addToFolder(alanyaID, folderId, body = {}) {
    const storage = ready();
    await assertSixDossiers();
    const ids = Array.isArray(body.fileIds) ? [...new Set(body.fileIds.map(R.parseId))] : [];
    if (!ids.length || ids.length > C.PAGE_SIZE || ids.some((id) => !id)) {
      throw new SafeboxError('SAFEBOX_INVALID_MOVE', 400, `De 1 à ${C.PAGE_SIZE} fichiers à la fois`, { max: C.PAGE_SIZE });
    }
    const ajoutes = await tx(async (conn) => {
      const album = await liveFolder(conn, alanyaID, folderId);
      if (album.root !== 'albums') {
        throw new SafeboxError('SAFEBOX_INVALID_MOVE', 400, "On n'ajoute sans copie que dans Albums");
      }
      const [sources] = await conn.query(
        `${FICHIER} WHERE f.id IN (?) AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
        [ids, alanyaID],
      );
      if (sources.length !== ids.length) throw introuvable();
      // Verrou des blobs : une purge ne peut pas les emporter pendant qu'on
      // les désigne (voir markIfOrphan dans purge.js).
      await conn.query('SELECT id FROM safebox_blob WHERE id IN (?) FOR UPDATE', [sources.map((s) => s.blob_id)]);
      const [deja] = await conn.query(
        'SELECT id, blob_id FROM safebox_file WHERE folder_id = ? AND blob_id IN (?) AND trashed_at IS NULL',
        [album.id, sources.map((s) => s.blob_id)],
      );
      const presents = new Map(deja.map((d) => [Number(d.blob_id), Number(d.id)]));
      const out = [];
      for (const s of sources) {
        const blob = Number(s.blob_id);
        if (!presents.has(blob)) {
          const [r] = await conn.query(
            `INSERT INTO safebox_file (alanyaID, folder_id, blob_id, name, ext, mime, family, original_bytes, compressed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [alanyaID, album.id, blob, s.name, s.ext, s.mime, s.family, s.original_bytes, Number(s.compressed)],
          );
          presents.set(blob, r.insertId);
        }
        out.push(presents.get(blob));
      }
      return out;
    });
    const [rows] = await db.query(`${FICHIER} WHERE f.id IN (?) AND f.alanyaID = ?`, [ajoutes, alanyaID]);
    await enrichir(rows, { places: alanyaID });
    return { files: await Promise.all(rows.map((f) => fileShape(f, storage))) };
  }

  /** `GET /api/safebox/files/:id/download` — clé et adresses de tous les blocs. */
  async function downloadFile(alanyaID, fileId) {
    const storage = ready();
    const f = await liveFile(db, alanyaID, fileId);
    return planDeTelechargement(storage, f);
  }

  async function planDeTelechargement(storage, f) {
    if (f.meta === undefined) await enrichir([f]);
    if (f.lost) throw perdu();
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
              fo.name AS folder_name, fo.root AS folder_root
         FROM safebox_file f
         JOIN safebox_blob b ON b.id = f.blob_id
         JOIN safebox_folder fo ON fo.id = f.folder_id
        WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
          -- Un contenu à plusieurs endroits n'apparaît qu'une fois, sous son
          -- premier exemplaire ; \`alsoIn\` dit où sont les autres.
          AND f.id = (SELECT MIN(f2.id) FROM safebox_file f2
                       WHERE f2.alanyaID = f.alanyaID AND f2.blob_id = f.blob_id AND f2.trashed_at IS NULL)
        ORDER BY (b.stored_bytes + b.preview_bytes) DESC, f.id DESC
        LIMIT ${n}`,
      [alanyaID],
    );
    const { trashBytes } = await usageOf(db, alanyaID);
    await enrichir(rows, { envois: true, places: alanyaID });
    return {
      trashBytes,
      files: await Promise.all(rows.map(async (f) => ({
        ...(await fileShape(f, storage)),
        // Nul pour un dossier racine : l'application affiche le nom traduit
        // de sa racine.
        folderName: f.folder_name,
        folderRoot: f.folder_root,
      }))),
    };
  }

  // ── Commentaire d'une photo (décision du 18/10/2026) ─────────────────────

  /** Une photo vivante de mon coffre : seules les photos ont un commentaire. */
  async function photoAMoi(alanyaID, fileId) {
    const f = await liveFile(db, alanyaID, fileId);
    if (f.family !== 'photos') {
      throw new SafeboxError('SAFEBOX_NOTE_UNAVAILABLE', 400, 'Les commentaires sont réservés aux photos');
    }
    return f;
  }

  /**
   * Le porteur du commentaire d'une photo : l'exemplaire du même contenu qui
   * le range (un vivant d'abord), sinon cette photo elle-même.
   */
  async function porteur(conn, alanyaID, f) {
    await relogerNotes(conn, alanyaID, [f.blob_id]);
    const [[p]] = await conn.query(
      `SELECT n.file_id FROM safebox_note n JOIN safebox_file x ON x.id = n.file_id
        WHERE x.alanyaID = ? AND x.blob_id = ?
        ORDER BY x.trashed_at IS NULL DESC, n.updated_at DESC LIMIT 1`,
      [alanyaID, f.blob_id],
    );
    return p ? Number(p.file_id) : Number(f.id);
  }

  /**
   * Après une corbeille ou une restauration : un commentaire porté par un
   * exemplaire à la corbeille passe sur un exemplaire vivant du même contenu,
   * s'il y en a un. Il ne part ainsi qu'avec le dernier exemplaire. La clé
   * de son audio, liée à l'exemplaire, est rechiffrée pour le nouveau.
   */
  async function relogerNotes(conn, alanyaID, blobIds) {
    const ids = [...new Set(blobIds.map(Number).filter(Boolean))];
    if (!ids.length) return;
    let jetees;
    try {
      [jetees] = await conn.query(
        `SELECT n.file_id, n.audio_wrapped_key, f.blob_id
           FROM safebox_note n JOIN safebox_file f ON f.id = n.file_id
          WHERE f.alanyaID = ? AND f.blob_id IN (?) AND f.trashed_at IS NOT NULL`,
        [alanyaID, ids],
      );
    } catch (e) {
      if (e.code === 'ER_NO_SUCH_TABLE') return;
      throw e;
    }
    for (const n of jetees) {
      const [vivants] = await conn.query(
        `SELECT x.id, m.file_id AS a_sa_note FROM safebox_file x LEFT JOIN safebox_note m ON m.file_id = x.id
          WHERE x.alanyaID = ? AND x.blob_id = ? AND x.trashed_at IS NULL ORDER BY x.id`,
        [alanyaID, n.blob_id],
      );
      // Pas d'exemplaire vivant, ou un vivant a déjà le sien : rien à déplacer.
      if (!vivants.length || vivants.some((v) => v.a_sa_note != null)) continue;
      const cible = Number(vivants[0].id);
      const cle = n.audio_wrapped_key
        ? wrapFileKey(unwrapFileKey(n.audio_wrapped_key, `note-${n.file_id}`, env), `note-${cible}`, env)
        : null;
      await conn.query('UPDATE safebox_note SET file_id = ?, audio_wrapped_key = ? WHERE file_id = ?',
        [cible, cle, n.file_id]);
    }
  }

  async function lireNote(conn, fileId, verrou = false) {
    const [[n]] = await conn.query(`SELECT * FROM safebox_note WHERE file_id = ?${verrou ? ' FOR UPDATE' : ''}`, [fileId]);
    return n || null;
  }

  async function rendreNote(storage, alanyaID, f) {
    const id = await porteur(db, alanyaID, f);
    return noteShape(storage, (await lireNote(db, id)) || { file_id: id });
  }

  /** Efface chez MEGA l'audio remplacé ou supprimé ; à défaut, le rapprochement s'en charge. */
  async function effacerAudio(storage, prefixe) {
    if (!prefixe) return;
    try {
      await storage.removePrefix(prefixe);
    } catch (e) {
      console.error(`[Coffre] audio de commentaire ${prefixe} non supprimé (le rapprochement le reprendra) :`, e.message);
    }
  }

  /** `PUT /api/safebox/files/:id/note` — texte du commentaire (null ou vide : effacé). */
  async function setNoteText(alanyaID, fileId, body = {}) {
    const storage = ready();
    const f = await photoAMoi(alanyaID, fileId);
    const texte = R.normalizeNoteText(body.text);
    await tx(async (conn) => {
      const id = await porteur(conn, alanyaID, f);
      const n = await lireNote(conn, id, true);
      if (!texte && !(n && n.audio_prefix)) {
        await conn.query('DELETE FROM safebox_note WHERE file_id = ?', [id]);
      } else {
        await conn.query(
          'INSERT INTO safebox_note (file_id, text) VALUES (?, ?) ON DUPLICATE KEY UPDATE text = VALUES(text)',
          [id, texte],
        );
      }
    });
    return { note: await rendreNote(storage, alanyaID, f) };
  }

  /**
   * `POST /api/safebox/files/:id/note/audio` — réserve la place d'un audio
   * (5 minutes au plus) et rend son adresse d'envoi. Un audio précédent est
   * remplacé.
   */
  async function reserveNoteAudio(alanyaID, fileId, body = {}) {
    const storage = ready();
    const settings = await getSettings();
    const f = await photoAMoi(alanyaID, fileId);
    const { size, plainSize, durationMs } = R.validateNoteAudio(body);
    const quotaBytes = await quotaFor(alanyaID, settings);
    const prefix = `u/${accountTag(alanyaID, env)}/${crypto.randomUUID()}/`;
    const ancien = await tx(async (conn) => {
      await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      const id = await porteur(conn, alanyaID, f);
      const n = await lireNote(conn, id, true);
      const { usedBytes } = await usageOf(conn, alanyaID);
      const libere = n && n.audio_prefix ? Number(n.audio_bytes) || 0 : 0;
      if (!R.fitsQuota({ usedBytes: usedBytes - libere, quotaBytes, addBytes: size })) {
        throw new SafeboxError('SAFEBOX_QUOTA_EXCEEDED', 409, 'Espace du coffre insuffisant', {
          usedBytes, quotaBytes, neededBytes: size,
        });
      }
      await conn.query(
        `INSERT INTO safebox_note (file_id, audio_prefix, audio_bytes, audio_plain_bytes, audio_duration_ms,
                                   audio_wrapped_key, audio_status, audio_activity_at)
         VALUES (?, ?, ?, ?, ?, NULL, 'pending', NOW())
         ON DUPLICATE KEY UPDATE audio_prefix = VALUES(audio_prefix), audio_bytes = VALUES(audio_bytes),
           audio_plain_bytes = VALUES(audio_plain_bytes), audio_duration_ms = VALUES(audio_duration_ms),
           audio_wrapped_key = NULL, audio_status = 'pending', audio_activity_at = NOW()`,
        [id, prefix, size, plainSize, durationMs],
      );
      return n ? n.audio_prefix : null;
    });
    await effacerAudio(storage, ancien);
    return {
      size,
      url: await storage.uploadUrl(R.blockKey(prefix, 1), size, C.UPLOAD_URL_TTL_S),
      urlTtlSeconds: C.UPLOAD_URL_TTL_S,
    };
  }

  /** `POST /api/safebox/files/:id/note/audio/complete` — vérifie l'objet chez MEGA, range la clé. */
  async function completeNoteAudio(alanyaID, fileId, body = {}) {
    const storage = ready();
    const f = await photoAMoi(alanyaID, fileId);
    const cle = R.decodeFileKey(body.key);
    const id = await porteur(db, alanyaID, f);
    const n = await lireNote(db, id);
    if (!n || !n.audio_prefix || n.audio_status !== 'pending') throw introuvable();
    const objets = await storage.list(n.audio_prefix);
    const recu = objets.find((o) => o.key === R.blockKey(n.audio_prefix, 1));
    if (!recu || Number(recu.size) !== Number(n.audio_bytes)) {
      throw new SafeboxError('SAFEBOX_UPLOAD_INCOMPLETE', 409, "L'audio n'est pas encore arrivé chez MEGA", {
        missing: [1], missingCount: 1, previewMissing: false,
      });
    }
    const [r] = await db.query(
      `UPDATE safebox_note SET audio_wrapped_key = ?, audio_status = 'ready', audio_activity_at = NOW()
        WHERE file_id = ? AND audio_prefix = ? AND audio_status = 'pending'`,
      [wrapFileKey(cle, `note-${id}`, env), id, n.audio_prefix],
    );
    if (!r.affectedRows) throw introuvable(); // remplacé ou déplacé entre-temps
    return { note: await rendreNote(storage, alanyaID, f) };
  }

  /** `DELETE /api/safebox/files/:id/note/audio` — supprime l'audio, garde le texte. */
  async function deleteNoteAudio(alanyaID, fileId) {
    const storage = ready();
    const f = await photoAMoi(alanyaID, fileId);
    const ancien = await tx(async (conn) => {
      const id = await porteur(conn, alanyaID, f);
      const n = await lireNote(conn, id, true);
      if (!n || !n.audio_prefix) return null;
      if (n.text) {
        await conn.query(
          `UPDATE safebox_note SET audio_prefix = NULL, audio_bytes = NULL, audio_plain_bytes = NULL,
             audio_duration_ms = NULL, audio_wrapped_key = NULL, audio_status = NULL, audio_activity_at = NULL
           WHERE file_id = ?`,
          [id],
        );
      } else {
        await conn.query('DELETE FROM safebox_note WHERE file_id = ?', [id]);
      }
      return n.audio_prefix;
    });
    await effacerAudio(storage, ancien);
    return { note: await rendreNote(storage, alanyaID, f) };
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
    const empreinte = R.normalizeSourceFp(body.sourceFp);
    const count = R.blockCount(tailles.size, C.BLOCK_BYTES);
    const prefix = `u/${accountTag(alanyaID, env)}/${crypto.randomUUID()}/`;
    const quotaBytes = await quotaFor(alanyaID, settings);
    await ensureAccount(alanyaID);

    const { fileId, blobId, blob } = await tx(async (conn) => {
      // Verrou du compte : deux réservations simultanées ne dépassent pas l'espace.
      await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      const dossier = await liveFolder(conn, alanyaID, body.folderId);
      const { ext, famille } = R.assertFamily(dossier.root, nom, settings.extensions);
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
        [alanyaID, dossier.id, b.insertId, nom, ext, mime, famille, tailles.originalSize, R.qualityCode(body)],
      );
      return {
        fileId: f.insertId,
        blobId: b.insertId,
        blob: {
          prefix, stored_bytes: tailles.size, block_size: C.BLOCK_BYTES, block_count: count,
          preview_bytes: tailles.previewSize,
        },
      };
    });
    const meta = R.normalizeMeta(body.meta);
    if (meta) {
      try {
        await db.query('UPDATE safebox_blob SET meta = ? WHERE id = ?', [JSON.stringify(meta), blobId]);
      } catch (e) {
        if (e.code !== 'ER_BAD_FIELD_ERROR') throw e; // migration 104 absente : sans détails
      }
    }
    if (empreinte) {
      try {
        await db.query('UPDATE safebox_blob SET source_fp = ? WHERE id = ?',
          [sourceFingerprint(alanyaID, empreinte, env), blobId]);
      } catch (e) {
        if (!sansMigration111(e)) throw e;
      }
    }

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
      files: await Promise.all((await enrichir(fichiers)).map(async (f) => ({
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

  // ── Sauvegarde automatique (lot 10) ──────────────────────────────────────
  //
  // Le téléphone calcule l'empreinte de l'original de chaque fichier ; le
  // serveur la lie au compte (`sourceFingerprint`) et la garde sur le blob.
  // Avant d'envoyer, le téléphone demande ce que le coffre a déjà : rien n'est
  // renvoyé deux fois, et ce que l'inscrit a supprimé du coffre n'y revient
  // pas (« ne plus sauvegarder », migration 111).

  const sansMigration111 = (e) => e.code === 'ER_NO_SUCH_TABLE' || e.code === 'ER_BAD_FIELD_ERROR';

  /**
   * Ces contenus viennent de passer à la corbeille : ceux qui ne sont plus
   * nulle part dans mon coffre ne seront plus sauvegardés.
   */
  async function retenirSuppression(conn, alanyaID, blobIds) {
    const ids = [...new Set(blobIds.map(Number).filter(Boolean))];
    if (!ids.length) return;
    try {
      await conn.query(
        `INSERT IGNORE INTO safebox_backup_skip (alanyaID, source_fp)
         SELECT DISTINCT ?, b.source_fp FROM safebox_blob b
          WHERE b.id IN (?) AND b.source_fp IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM safebox_file f
                             WHERE f.blob_id = b.id AND f.alanyaID = ? AND f.trashed_at IS NULL)`,
        [alanyaID, ids, alanyaID],
      );
    } catch (e) {
      if (!sansMigration111(e)) throw e;
    }
  }

  /** Revenus de la corbeille : ils se sauvegardent de nouveau. */
  async function oublierSuppression(conn, alanyaID, blobIds) {
    const ids = [...new Set(blobIds.map(Number).filter(Boolean))];
    if (!ids.length) return;
    try {
      await conn.query(
        `DELETE s FROM safebox_backup_skip s JOIN safebox_blob b ON b.source_fp = s.source_fp
          WHERE s.alanyaID = ? AND b.id IN (?)`,
        [alanyaID, ids],
      );
    } catch (e) {
      if (!sansMigration111(e)) throw e;
    }
  }

  /**
   * `POST /api/safebox/backup/check` — pour chaque empreinte d'original
   * (`fps`), ce que le coffre en a :
   *   saved     dans le dossier de son type (Photos, Vidéos…), rien à faire ;
   *   elsewhere seulement ailleurs (un album, Partager) — avec `link`, il est
   *             ajouté sans copie au dossier de son type et devient `saved` ;
   *   uploading un envoi est en cours (autre appareil, réinstallation) ;
   *   skip      supprimé du coffre par l'inscrit : ne plus sauvegarder ;
   *   new       à envoyer.
   */
  async function backupCheck(alanyaID, body = {}) {
    ready();
    await assertSixDossiers();
    const fps = R.sourceFps(body.fps);
    const racines = await ensureAccount(alanyaID);
    const parEmpreinte = new Map(fps.map((fp) => [sourceFingerprint(alanyaID, fp, env), fp]));
    const empreintes = [...parEmpreinte.keys()];
    const results = Object.fromEntries(fps.map((fp) => [fp, { state: 'new' }]));
    let fichiers;
    try {
      [fichiers] = await db.query(
        `SELECT f.id, f.family, fo.root, b.id AS blob_id, b.status, b.source_fp
           FROM safebox_file f
           JOIN safebox_blob b ON b.id = f.blob_id
           JOIN safebox_folder fo ON fo.id = f.folder_id
          WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.source_fp IN (?)
          ORDER BY f.id`,
        [alanyaID, empreintes],
      );
    } catch (e) {
      if (sansMigration111(e)) throw new SafeboxError('SAFEBOX_UNAVAILABLE', 503, 'Coffre-fort en cours de mise à jour');
      throw e;
    }
    const [sautes] = await db.query(
      'SELECT source_fp FROM safebox_backup_skip WHERE alanyaID = ? AND source_fp IN (?)',
      [alanyaID, empreintes],
    );
    for (const x of sautes) results[parEmpreinte.get(x.source_fp)] = { state: 'skip' };
    const ailleurs = new Map();
    for (const f of fichiers) {
      const fp = parEmpreinte.get(f.source_fp);
      const r = results[fp];
      if (f.status !== 'ready') {
        if (r.state === 'new') results[fp] = { state: 'uploading' };
      } else if (f.root === f.family) {
        results[fp] = { state: 'saved', fileId: Number(f.id) };
      } else if (r.state !== 'saved') {
        results[fp] = { state: 'elsewhere', fileId: Number(f.id) };
        ailleurs.set(fp, f);
      }
    }
    if (body.link === true) {
      for (const [fp, f] of ailleurs) {
        if (results[fp].state !== 'elsewhere') continue;
        const fileId = await tx(async (conn) => {
          // Verrou du blob : voir addToFolder.
          const [[b]] = await conn.query('SELECT status FROM safebox_blob WHERE id = ? FOR UPDATE', [f.blob_id]);
          if (!b || b.status !== 'ready') return null;
          const [[src]] = await conn.query(`${FICHIER} WHERE f.id = ?`, [f.id]);
          const [r] = await conn.query(
            `INSERT INTO safebox_file (alanyaID, folder_id, blob_id, name, ext, mime, family, original_bytes, compressed)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [alanyaID, racines[src.family].id, f.blob_id, src.name, src.ext, src.mime, src.family,
              src.original_bytes, Number(src.compressed)],
          );
          return r.insertId;
        });
        if (fileId) results[fp] = { state: 'saved', fileId: Number(fileId), linked: true };
      }
    }
    return { results };
  }

  /** `POST /api/safebox/backup/skip` — « ne plus sauvegarder » ces originaux (`fps`). */
  async function backupSkip(alanyaID, body = {}) {
    ready();
    const fps = R.sourceFps(body.fps);
    try {
      await db.query(
        'INSERT IGNORE INTO safebox_backup_skip (alanyaID, source_fp) VALUES ?',
        [fps.map((fp) => [alanyaID, sourceFingerprint(alanyaID, fp, env)])],
      );
    } catch (e) {
      if (sansMigration111(e)) throw new SafeboxError('SAFEBOX_UNAVAILABLE', 503, 'Coffre-fort en cours de mise à jour');
      throw e;
    }
    return { ok: true, skipped: fps.length };
  }

  // ── Partage entre inscrits (lots 3 et 9) ─────────────────────────────────
  //
  // Le message (type 11, utils/safeboxShareMessage.js) ne porte que le numéro
  // du partage. Tout le reste est remis ici, aux membres ACTUELS de la
  // discussion : un membre qui quitte un groupe perd l'accès. Le fichier reste
  // dans le coffre de l'expéditeur, sur son espace ; dès qu'il le met à la
  // corbeille, le partage est retiré.
  //
  // Un partage porte un fichier (`kind` « file », `file_id`) ou, depuis le
  // lot 9, un lot — un album ou une sélection — dont les éléments sont dans
  // `safebox_share_item` (migration 109). La limite de téléchargements compte
  // par partage : ce qui est téléchargé d'un même lot dans les deux heures
  // compte une fois.

  const retire = () => new SafeboxError('SAFEBOX_SHARE_REVOKED', 410, "Fichier retiré par l'expéditeur");
  const estLot = (s) => s.kind === 'batch';
  const avatar = (url) => (url && url !== 'NON DEFINI' ? url : null);

  async function estMembre(conn, conversationId, alanyaID) {
    const [r] = await conn.query(
      'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
      [conversationId, alanyaID],
    );
    return r.length > 0;
  }

  /** Les fichiers d'un nouveau partage : un album (`folderId`), plusieurs (`fileIds`) ou un seul (`fileId`). */
  async function fichiersAPartager(alanyaID, body) {
    if (body.folderId != null) {
      const dossier = await liveFolder(db, alanyaID, body.folderId);
      const [rows] = await db.query(
        `${FICHIER} WHERE f.folder_id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
          ORDER BY f.id DESC LIMIT ${C.SHARE_MAX_ITEMS + 1}`,
        [dossier.id, alanyaID],
      );
      if (!rows.length) throw new SafeboxError('SAFEBOX_SHARE_INVALID', 400, 'Cet album est vide');
      if (rows.length > C.SHARE_MAX_ITEMS) {
        throw new SafeboxError('SAFEBOX_SHARE_TOO_MANY', 400, `${C.SHARE_MAX_ITEMS} fichiers au plus par partage`, {
          max: C.SHARE_MAX_ITEMS,
        });
      }
      return { fichiers: rows, lot: true, titre: dossier.name };
    }
    if (body.fileIds != null) {
      const ids = R.shareFileIds(body.fileIds);
      const [rows] = await db.query(
        `${FICHIER} WHERE f.id IN (?) AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
        [ids, alanyaID],
      );
      if (rows.length !== ids.length) throw introuvable();
      const parId = new Map(rows.map((r) => [Number(r.id), r]));
      return { fichiers: ids.map((id) => parId.get(id)), lot: ids.length > 1, titre: null };
    }
    return { fichiers: [await liveFile(db, alanyaID, body.fileId)], lot: false, titre: null };
  }

  /**
   * `POST /api/safebox/shares` — partager dans une discussion dont je suis
   * membre : un fichier (`fileId`), plusieurs (`fileIds`, avec un `title`) ou
   * un album (`folderId` : ses fichiers, sans les sous-dossiers). Un seul
   * fichier fait un partage simple, que les anciennes applications lisent.
   * `cover` : mes fichiers des quatre premiers éléments, d'où l'application
   * tire les mini-images floues du message.
   */
  async function createShare(alanyaID, body = {}) {
    ready();
    const conv = R.parseId(body.conversationId);
    if (!conv) throw introuvable();
    const { fichiers, lot, titre } = await fichiersAPartager(alanyaID, body);
    if (!(await estMembre(db, conv, alanyaID))) throw introuvable();
    if (!lot) {
      const f = fichiers[0];
      const [r] = await db.query(
        `INSERT INTO safebox_share (file_id, conversation_id, sender_id, name, mime, family, plain_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [f.id, conv, alanyaID, f.name, f.mime, f.family, Number(f.plain_bytes)],
      );
      return {
        shareId: r.insertId,
        kind: 'file',
        name: f.name,
        mime: f.mime,
        family: f.family,
        plainBytes: Number(f.plain_bytes),
        count: 1,
        families: null,
        meta: await metaDe(f.blob_id),
        cover: [Number(f.id)],
      };
    }
    const resume = R.batchSummary(fichiers);
    const nom = body.title != null ? R.normalizeName(body.title, C.FILE_NAME_MAX) : (titre || fichiers[0].name);
    const shareId = await tx(async (conn) => {
      const [r] = await conn.query(
        `INSERT INTO safebox_share (file_id, kind, conversation_id, sender_id, name, mime, family, plain_bytes, item_count, families)
         VALUES (NULL, 'batch', ?, ?, ?, NULL, ?, ?, ?, ?)`,
        [conv, alanyaID, nom, resume.family, resume.plainBytes, resume.count, JSON.stringify(resume.families)],
      );
      await conn.query(
        'INSERT INTO safebox_share_item (share_id, position, file_id, name, mime, family, plain_bytes) VALUES ?',
        [fichiers.map((f, i) => [r.insertId, i, f.id, f.name, f.mime, f.family, Number(f.plain_bytes)])],
      );
      return r.insertId;
    });
    return {
      shareId,
      kind: 'batch',
      name: nom,
      mime: null,
      family: resume.family,
      plainBytes: resume.plainBytes,
      count: resume.count,
      families: resume.families,
      meta: null,
      cover: fichiers.slice(0, 4).map((f) => Number(f.id)),
    };
  }

  /**
   * Le partage si le demandeur est membre de sa discussion (sinon 404), et,
   * pour un fichier seul, celui de l'expéditeur s'il est encore disponible
   * (hors corbeille, partage non retiré).
   */
  async function partageVisible(alanyaID, shareId) {
    const id = R.parseId(shareId);
    if (!id) throw introuvable();
    const [[s]] = await db.query(
      `SELECT s.* FROM safebox_share s
         JOIN conv_participants cp ON cp.conversID = s.conversation_id AND cp.alanyaID = ?
        WHERE s.id = ?`,
      [alanyaID, id],
    );
    if (!s) throw introuvable();
    let fichier = null;
    if (s.file_id && !s.revoked_at) {
      const [[f]] = await db.query(
        `${FICHIER} WHERE f.id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
        [s.file_id, s.sender_id],
      );
      fichier = f || null;
    }
    return { s, fichier };
  }

  /**
   * Les éléments d'un lot dans l'ordre, après la position `apres`, chacun avec
   * le fichier de l'expéditeur s'il est encore disponible (null sinon, et
   * pour tous quand le partage est retiré).
   */
  async function elementsDu(s, { apres = -1, limite = C.SHARE_MAX_ITEMS } = {}) {
    const [items] = await db.query(
      'SELECT * FROM safebox_share_item WHERE share_id = ? AND position > ? ORDER BY position LIMIT ?',
      [s.id, apres, limite],
    );
    const ids = s.revoked_at ? [] : items.map((i) => i.file_id).filter(Boolean);
    const vivants = new Map();
    if (ids.length) {
      const [rows] = await db.query(
        `${FICHIER} WHERE f.id IN (?) AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
        [ids, s.sender_id],
      );
      for (const f of rows) vivants.set(Number(f.id), f);
    }
    return items.map((item) => ({ item, fichier: vivants.get(Number(item.file_id)) ?? null }));
  }

  /** Un élément d'un lot (404 s'il n'en fait pas partie), et son fichier s'il est disponible. */
  async function elementDuLot(s, itemId) {
    const id = R.parseId(itemId);
    if (!id) {
      throw new SafeboxError('SAFEBOX_SHARE_ITEM_REQUIRED', 400, 'Mettez à jour Alanya pour ouvrir ce partage');
    }
    const [[item]] = await db.query('SELECT * FROM safebox_share_item WHERE id = ? AND share_id = ?', [id, s.id]);
    if (!item) throw introuvable();
    if (s.revoked_at || !item.file_id) return null;
    const [[f]] = await db.query(
      `${FICHIER} WHERE f.id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
      [item.file_id, s.sender_id],
    );
    return f || null;
  }

  /** Mes fichiers (hors corbeille) qui désignent ces contenus : blob → fichier. */
  async function mesContenus(alanyaID, blobIds) {
    const ids = [...new Set(blobIds.map(Number).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const [rows] = await db.query(
      'SELECT MIN(id) AS id, blob_id FROM safebox_file WHERE alanyaID = ? AND blob_id IN (?) AND trashed_at IS NULL GROUP BY blob_id',
      [alanyaID, ids],
    );
    for (const r of rows) out.set(Number(r.blob_id), Number(r.id));
    return out;
  }

  async function telechargementsRestants(conn, shareId, alanyaID, limite) {
    const [[r]] = await conn.query(
      `SELECT COUNT(*) AS n FROM safebox_share_download
        WHERE share_id = ? AND alanyaID = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      [shareId, alanyaID],
    );
    return Math.max(0, limite - Number(r.n));
  }

  const shareShape = (s, disponible, extra = {}) => ({
    id: Number(s.id),
    conversationId: Number(s.conversation_id),
    senderId: Number(s.sender_id),
    kind: estLot(s) ? 'batch' : 'file',
    name: s.name,
    mime: s.mime,
    family: s.family,
    plainBytes: Number(s.plain_bytes),
    count: estLot(s) ? Number(s.item_count) : 1,
    families: estLot(s) ? R.normalizeFamilies(s.families) : null,
    createdAt: s.created_at,
    available: Boolean(disponible),
    // Retiré par l'expéditeur (« Retirer le partage », lot 9) ou par la
    // modération ; mis à la corbeille, le fichier rend seulement `available` faux.
    removedByModeration: Boolean(s.revoked_at) && s.revoked_by !== 'sender',
    revokedBySender: Boolean(s.revoked_at) && s.revoked_by === 'sender',
    ...extra,
  });

  /**
   * Un élément tel que l'écran ouvert depuis la carte l'affiche, clé comprise
   * (le demandeur est membre de la discussion). `id` 0 désigne le fichier
   * d'un partage simple.
   */
  async function elementShape(storage, { item, fichier: f }, details, miens) {
    const out = {
      id: Number(item.id),
      position: Number(item.position),
      name: item.name,
      ext: R.extensionOf(item.name),
      mime: item.mime,
      family: item.family,
      plainBytes: Number(item.plain_bytes),
      available: Boolean(f),
    };
    if (!f) return out;
    const d = details.get(Number(f.blob_id));
    out.storedBytes = taille(f);
    out.quality = R.qualityName(f.compressed);
    out.meta = d?.meta ?? null;
    out.lost = Boolean(d?.lostAt);
    out.key = unwrapFileKey(f.wrapped_key, f.blob_id, env).toString('base64');
    out.previewUrl = Number(f.preview_bytes) > 0
      ? await storage.downloadUrl(R.previewKey(f.prefix), C.PREVIEW_URL_TTL_S)
      : null;
    out.savedFileId = miens.get(Number(f.blob_id)) ?? null;
    return out;
  }

  /** Le fichier d'un partage simple, vu comme l'élément 0. */
  const elementSimple = (s, fichier) => ({
    item: { id: 0, position: 0, name: s.name, mime: s.mime, family: s.family, plain_bytes: s.plain_bytes },
    fichier,
  });

  async function elementsShape(storage, alanyaID, elements) {
    const blobs = elements.filter((e) => e.fichier).map((e) => e.fichier.blob_id);
    const details = await detailsDe(blobs);
    const miens = await mesContenus(alanyaID, blobs);
    return Promise.all(elements.map((e) => elementShape(storage, e, details, miens)));
  }

  async function expediteurDe(s) {
    const [[u]] = await db.query('SELECT nom, pseudo, avatar_url FROM users WHERE alanyaID = ?', [s.sender_id]);
    return { id: Number(s.sender_id), name: u ? (u.nom || u.pseudo || null) : null, avatarUrl: avatar(u?.avatar_url) };
  }

  /** Les contenus d'un partage (fichier seul ou éléments d'un lot), tant que les fichiers existent. */
  async function blobsDu(s) {
    const [rows] = estLot(s)
      ? await db.query(
        `SELECT DISTINCT f.blob_id FROM safebox_share_item i JOIN safebox_file f ON f.id = i.file_id
          WHERE i.share_id = ?`,
        [s.id],
      )
      : await db.query('SELECT blob_id FROM safebox_file WHERE id = ?', [s.file_id || 0]);
    return rows.map((r) => Number(r.blob_id));
  }

  /**
   * Le suivi chez l'expéditeur : chaque membre actuel de la discussion (sauf
   * lui), et s'il a gardé le contenu dans son coffre, l'a téléchargé, ou pas
   * encore.
   */
  async function suiviDu(s) {
    const [membres] = await db.query(
      `SELECT u.alanyaID, u.nom, u.pseudo, u.avatar_url
         FROM conv_participants cp JOIN users u ON u.alanyaID = cp.alanyaID
        WHERE cp.conversID = ? AND cp.alanyaID <> ?
        ORDER BY u.nom, u.alanyaID`,
      [s.conversation_id, s.sender_id],
    );
    const recus = new Map();
    try {
      const [rows] = await db.query('SELECT alanyaID, received_at FROM safebox_share_recipient WHERE share_id = ?', [s.id]);
      for (const r of rows) recus.set(Number(r.alanyaID), r.received_at);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    const gardes = new Set();
    const blobs = await blobsDu(s);
    if (blobs.length && membres.length) {
      const [rows] = await db.query(
        'SELECT DISTINCT alanyaID FROM safebox_file WHERE blob_id IN (?) AND alanyaID IN (?) AND trashed_at IS NULL',
        [blobs, membres.map((m) => m.alanyaID)],
      );
      for (const r of rows) gardes.add(Number(r.alanyaID));
    }
    return membres.map((m) => {
      const id = Number(m.alanyaID);
      return {
        alanyaID: id,
        name: m.nom || m.pseudo || null,
        avatarUrl: avatar(m.avatar_url),
        state: gardes.has(id) ? 'saved' : recus.has(id) ? 'downloaded' : 'pending',
        at: recus.get(id) ?? null,
      };
    });
  }

  const resumeSuivi = (membres) => ({
    members: membres.length,
    downloaded: membres.filter((m) => m.state === 'downloaded').length,
    saved: membres.filter((m) => m.state === 'saved').length,
  });

  /**
   * `GET /api/safebox/shares/:id` — la carte du message : état, expéditeur,
   * aperçu et clé (membres seulement). Un lot rend les quatre premiers
   * éléments disponibles (`cover`, la mosaïque) ; l'expéditeur reçoit en plus
   * le résumé du suivi (`tracking`, « téléchargé par 2 sur 7 ») et ses
   * fichiers encore disponibles (`fileIds`, pour « Envoyer ailleurs »).
   */
  async function shareInfo(alanyaID, shareId) {
    const storage = ready();
    const settings = await getSettings();
    const { s, fichier } = await partageVisible(alanyaID, shareId);
    const expediteur = Number(s.sender_id) === Number(alanyaID);
    const extra = { isSender: expediteur, sender: await expediteurDe(s) };
    if (expediteur) extra.tracking = resumeSuivi(await suiviDu(s));
    if (estLot(s)) {
      const dispo = (await elementsDu(s)).filter((e) => e.fichier);
      extra.availableCount = dispo.length;
      if (expediteur) extra.fileIds = dispo.map((e) => Number(e.fichier.id));
      extra.cover = await elementsShape(storage, alanyaID, dispo.slice(0, 4));
      if (dispo.length) {
        extra.downloadsLeft = expediteur
          ? null
          : await telechargementsRestants(db, s.id, alanyaID, settings.shareDownloadsPerDay);
        extra.savedCount = (await mesContenus(alanyaID, dispo.map((e) => e.fichier.blob_id))).size;
      }
      return shareShape(s, dispo.length > 0, extra);
    }
    if (expediteur) extra.fileIds = fichier ? [Number(fichier.id)] : [];
    if (fichier) {
      extra.storedBytes = taille(fichier);
      extra.quality = R.qualityName(fichier.compressed);
      extra.key = unwrapFileKey(fichier.wrapped_key, fichier.blob_id, env).toString('base64');
      extra.previewUrl = Number(fichier.preview_bytes) > 0
        ? await storage.downloadUrl(R.previewKey(fichier.prefix), C.PREVIEW_URL_TTL_S)
        : null;
      extra.downloadsLeft = expediteur
        ? null
        : await telechargementsRestants(db, s.id, alanyaID, settings.shareDownloadsPerDay);
      extra.savedFileId = (await mesContenus(alanyaID, [fichier.blob_id])).get(Number(fichier.blob_id)) ?? null;
      const d = (await detailsDe([fichier.blob_id])).get(Number(fichier.blob_id));
      extra.meta = d?.meta ?? null;
      extra.lost = Boolean(d?.lostAt);
    }
    return shareShape(s, fichier, extra);
  }

  /**
   * `GET /api/safebox/shares/:id/items` — les éléments, par pages de 100
   * (curseur : la position du dernier). Un partage simple rend son fichier
   * comme élément 0.
   */
  async function shareItems(alanyaID, shareId, { cursor } = {}) {
    const storage = ready();
    const { s, fichier } = await partageVisible(alanyaID, shareId);
    const n = Number(cursor);
    const apres = cursor != null && cursor !== '' && Number.isSafeInteger(n) && n >= 0 ? n : -1;
    let elements;
    if (estLot(s)) elements = await elementsDu(s, { apres, limite: C.PAGE_SIZE });
    else elements = apres < 0 ? [elementSimple(s, fichier)] : [];
    return {
      items: await elementsShape(storage, alanyaID, elements),
      nextCursor: estLot(s) && elements.length === C.PAGE_SIZE
        ? Number(elements[elements.length - 1].item.position)
        : null,
    };
  }

  /**
   * `GET /api/safebox/shares/:id/download` — clé et adresses de tous les
   * blocs ; pour un lot, ceux de l'élément `item`. Un téléchargement compte
   * une fois par partage et par fenêtre de deux heures : renouveler les
   * adresses d'un gros fichier, ou prendre un autre élément du même lot, ne
   * coûte rien. L'expéditeur n'est jamais limité.
   */
  async function shareDownload(alanyaID, shareId, query = {}) {
    const storage = ready();
    const settings = await getSettings();
    const { s, fichier } = await partageVisible(alanyaID, shareId);
    const cible = estLot(s) ? await elementDuLot(s, query.item) : fichier;
    if (!cible) throw retire();
    if (Number(s.sender_id) !== Number(alanyaID)) {
      await tx(async (conn) => {
        // Verrou du partage : deux demandes simultanées ne comptent qu'une fois.
        await conn.query('SELECT id FROM safebox_share WHERE id = ? FOR UPDATE', [s.id]);
        const [recent] = await conn.query(
          `SELECT 1 FROM safebox_share_download
            WHERE share_id = ? AND alanyaID = ? AND created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR) LIMIT 1`,
          [s.id, alanyaID],
        );
        if (recent.length) return;
        if (await telechargementsRestants(conn, s.id, alanyaID, settings.shareDownloadsPerDay) <= 0) {
          throw new SafeboxError('SAFEBOX_DOWNLOAD_LIMIT', 429, "Trop de téléchargements de ce fichier aujourd'hui", {
            limit: settings.shareDownloadsPerDay,
          });
        }
        await conn.query('INSERT INTO safebox_share_download (share_id, alanyaID) VALUES (?, ?)', [s.id, alanyaID]);
      });
      await noterDestinataire(s.id, alanyaID);
    }
    const plan = await planDeTelechargement(storage, cible);
    // Rien du coffre de l'expéditeur (numéro de fichier, dossier) ne sort.
    plan.file = { ...plan.file, id: null, folderId: null };
    return { share: shareShape(s, true), ...plan };
  }

  /**
   * `POST /api/safebox/shares/:id/save` — garder dans mon coffre. Rien n'est
   * copié chez MEGA : mon fichier désigne les mêmes blocs. Il compte pourtant
   * dans mon espace, et survit au retrait par l'expéditeur. Pour un lot :
   * l'élément `itemId`, ou, sans lui, le lot entier en album.
   */
  async function saveShare(alanyaID, shareId, body = {}) {
    const storage = ready();
    const settings = await getSettings();
    const { s, fichier } = await partageVisible(alanyaID, shareId);
    if (estLot(s) && body.itemId == null) return garderLeLot(alanyaID, s, settings);
    const cible = estLot(s) ? await elementDuLot(s, body.itemId) : fichier;
    if (!cible) throw retire();
    const quotaBytes = await quotaFor(alanyaID, settings);
    const racines = await ensureAccount(alanyaID);
    const id = await tx(async (conn) => {
      await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      const [[deja]] = await conn.query(
        'SELECT id FROM safebox_file WHERE alanyaID = ? AND blob_id = ? AND trashed_at IS NULL LIMIT 1',
        [alanyaID, cible.blob_id],
      );
      if (deja) return Number(deja.id);
      const dossier = await liveFolder(conn, alanyaID, body.folderId ?? racines[cible.family].id);
      if (!R.acceptsFamily(dossier.root, cible.family)) {
        throw new SafeboxError('SAFEBOX_WRONG_FAMILY', 400, "Ce dossier n'accepte pas ce type de fichier", { expectedRoot: cible.family });
      }
      // Verrou du blob, puis son état : une purge ne peut pas l'emporter
      // pendant qu'on le désigne (voir markIfOrphan dans purge.js).
      const [[b]] = await conn.query('SELECT status FROM safebox_blob WHERE id = ? FOR UPDATE', [cible.blob_id]);
      if (!b || b.status !== 'ready') throw retire();
      const { usedBytes } = await usageOf(conn, alanyaID);
      const ajout = taille(cible);
      if (!R.fitsQuota({ usedBytes, quotaBytes, addBytes: ajout })) {
        throw new SafeboxError('SAFEBOX_QUOTA_EXCEEDED', 409, 'Espace du coffre insuffisant', {
          usedBytes, quotaBytes, neededBytes: ajout,
        });
      }
      const [r] = await conn.query(
        `INSERT INTO safebox_file (alanyaID, folder_id, blob_id, name, ext, mime, family, original_bytes, compressed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [alanyaID, dossier.id, cible.blob_id, cible.name, cible.ext, cible.mime, cible.family,
          cible.original_bytes, Number(cible.compressed)],
      );
      return r.insertId;
    });
    if (Number(s.sender_id) !== Number(alanyaID)) await noterDestinataire(s.id, alanyaID);
    return fileShape(await liveFile(db, alanyaID, id), storage);
  }

  /**
   * Un lot gardé devient un album dans mes Albums, au nom du lot (« Kribi
   * 2026 (2) » si le nom est pris), avec chaque élément encore disponible.
   * L'espace ne compte que les contenus que je n'avais pas déjà.
   */
  async function garderLeLot(alanyaID, s, settings) {
    const elements = (await elementsDu(s)).filter((e) => e.fichier);
    if (!elements.length) throw retire();
    const quotaBytes = await quotaFor(alanyaID, settings);
    const racines = await ensureAccount(alanyaID);
    const { albumId, ajoutes } = await tx(async (conn) => {
      await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      const parent = await liveFolder(conn, alanyaID, racines.albums.id);
      const [[n]] = await conn.query(
        'SELECT COUNT(*) AS n FROM safebox_folder WHERE alanyaID = ? AND parent_id IS NOT NULL',
        [alanyaID],
      );
      if (Number(n.n) >= settings.maxFolders) {
        throw new SafeboxError('SAFEBOX_FOLDER_LIMIT', 409, 'Trop de dossiers', { maxFolders: settings.maxFolders });
      }
      const base = R.normalizeName([...s.name].slice(0, C.FOLDER_NAME_MAX).join(''), C.FOLDER_NAME_MAX);
      const nom = R.freeName(base, await siblingNames(conn, parent.id), C.FOLDER_NAME_MAX);
      const [r] = await conn.query(
        'INSERT INTO safebox_folder (alanyaID, parent_id, root, name, depth) VALUES (?, ?, ?, ?, ?)',
        [alanyaID, parent.id, parent.root, nom, Number(parent.depth) + 1],
      );
      await conn.query('UPDATE safebox_folder SET path = ? WHERE id = ?', [R.childPath(parent.path, r.insertId), r.insertId]);
      // Verrou des blobs : voir saveShare.
      const blobs = [...new Set(elements.map((e) => Number(e.fichier.blob_id)))];
      const [etats] = await conn.query('SELECT id, status FROM safebox_blob WHERE id IN (?) FOR UPDATE', [blobs]);
      const prets = new Set(etats.filter((b) => b.status === 'ready').map((b) => Number(b.id)));
      const { usedBytes: avant } = await usageOf(conn, alanyaID);
      const vus = new Set();
      for (const { fichier: f } of elements) {
        const blob = Number(f.blob_id);
        if (!prets.has(blob) || vus.has(blob)) continue;
        vus.add(blob);
        await conn.query(
          `INSERT INTO safebox_file (alanyaID, folder_id, blob_id, name, ext, mime, family, original_bytes, compressed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [alanyaID, r.insertId, blob, f.name, f.ext, f.mime, f.family, f.original_bytes, Number(f.compressed)],
        );
      }
      if (!vus.size) throw retire();
      const { usedBytes: apres } = await usageOf(conn, alanyaID);
      if (!R.fitsQuota({ usedBytes: avant, quotaBytes, addBytes: apres - avant })) {
        throw new SafeboxError('SAFEBOX_QUOTA_EXCEEDED', 409, 'Espace du coffre insuffisant', {
          usedBytes: avant, quotaBytes, neededBytes: apres - avant,
        });
      }
      return { albumId: r.insertId, ajoutes: vus.size };
    });
    if (Number(s.sender_id) !== Number(alanyaID)) await noterDestinataire(s.id, alanyaID);
    const [[album]] = await db.query(
      'SELECT id, parent_id, root, name, depth, created_at, updated_at FROM safebox_folder WHERE id = ?',
      [albumId],
    );
    return { folder: folderShape(album), files: ajoutes };
  }

  /**
   * `GET /api/safebox/shares/received` — l'onglet « Reçus » : ce qu'on m'a
   * envoyé par le coffre, toutes discussions confondues (celles dont je suis
   * membre aujourd'hui), du plus récent au plus ancien. Chaque partage vient
   * avec son expéditeur, l'aperçu de son premier élément disponible, et ce
   * que j'en ai fait (téléchargé, gardé).
   */
  async function receivedShares(alanyaID, { cursor } = {}) {
    const storage = ready();
    const avant = R.parseId(cursor);
    const [rows] = await db.query(
      `SELECT s.*, u.nom AS sender_nom, u.pseudo AS sender_pseudo, u.avatar_url AS sender_avatar
         FROM safebox_share s
         JOIN conv_participants cp ON cp.conversID = s.conversation_id AND cp.alanyaID = ?
         JOIN users u ON u.alanyaID = s.sender_id
        WHERE s.sender_id <> ? ${avant ? 'AND s.id < ?' : ''}
        ORDER BY s.id DESC LIMIT ${C.RECEIVED_PAGE_SIZE}`,
      avant ? [alanyaID, alanyaID, avant] : [alanyaID, alanyaID],
    );
    const recus = new Map();
    if (rows.length) {
      try {
        const [r] = await db.query(
          'SELECT share_id, received_at FROM safebox_share_recipient WHERE alanyaID = ? AND share_id IN (?)',
          [alanyaID, rows.map((s) => s.id)],
        );
        for (const x of r) recus.set(Number(x.share_id), x.received_at);
      } catch (e) {
        if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
      }
    }
    const shares = [];
    for (const s of rows) {
      let premier = null;
      if (!s.revoked_at) {
        if (estLot(s)) {
          const [[f]] = await db.query(
            `${FICHIER} JOIN safebox_share_item i ON i.file_id = f.id
              WHERE i.share_id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
              ORDER BY i.position LIMIT 1`,
            [s.id, s.sender_id],
          );
          premier = f || null;
        } else if (s.file_id) {
          const [[f]] = await db.query(
            `${FICHIER} WHERE f.id = ? AND f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'`,
            [s.file_id, s.sender_id],
          );
          premier = f || null;
        }
      }
      const extra = {
        isSender: false,
        sender: { id: Number(s.sender_id), name: s.sender_nom || s.sender_pseudo || null, avatarUrl: avatar(s.sender_avatar) },
        receivedAt: recus.get(Number(s.id)) ?? null,
        cover: null,
        savedFileId: null,
      };
      if (premier) {
        const element = { item: { id: 0, position: 0, name: premier.name, mime: premier.mime, family: premier.family, plain_bytes: premier.plain_bytes }, fichier: premier };
        [extra.cover] = await elementsShape(storage, alanyaID, [element]);
        if (!estLot(s)) {
          extra.savedFileId = extra.cover.savedFileId;
          extra.quality = extra.cover.quality;
          extra.meta = extra.cover.meta;
        }
      }
      shares.push(shareShape(s, premier, extra));
    }
    return {
      shares,
      nextCursor: rows.length === C.RECEIVED_PAGE_SIZE ? Number(rows[rows.length - 1].id) : null,
    };
  }

  /** `GET /api/safebox/shares/:id/recipients` — le suivi, pour l'expéditeur seul. */
  async function shareRecipients(alanyaID, shareId) {
    const { s } = await partageVisible(alanyaID, shareId);
    if (Number(s.sender_id) !== Number(alanyaID)) throw introuvable();
    const membres = await suiviDu(s);
    return { members: membres, tracking: resumeSuivi(membres) };
  }

  /**
   * `POST /api/safebox/shares/:id/revoke` — « Retirer le partage » : la carte
   * affiche « Fichier retiré par l'expéditeur », le fichier reste dans son
   * coffre. Les copies déjà gardées par les destinataires restent chez eux.
   */
  async function revokeShare(alanyaID, shareId) {
    const id = R.parseId(shareId);
    if (!id) throw introuvable();
    const [[s]] = await db.query('SELECT id, revoked_at FROM safebox_share WHERE id = ? AND sender_id = ?', [id, alanyaID]);
    if (!s) throw introuvable();
    if (!s.revoked_at) {
      await db.query(
        "UPDATE safebox_share SET revoked_at = NOW(), revoked_by = 'sender' WHERE id = ? AND revoked_at IS NULL",
        [id],
      );
    }
    return { id, revoked: true };
  }

  // ── Fin d'Alanya Plus (lot 4) ────────────────────────────────────────────

  /**
   * Supprime ce qui dépasse l'espace du compte, 30 jours après la fin d'Alanya
   * Plus (appelé par billing/featurePurge.js). Dans l'ordre : envois en cours,
   * corbeille, puis les fichiers les plus RÉCENTS d'abord (décision du
   * 15/10/2026). Les blocs partent chez MEGA par le ramassage des orphelins ;
   * un fichier qu'un destinataire a enregistré dans son coffre reste chez lui.
   */
  async function purgeExcess(alanyaID) {
    const storage = keyConfigured(env) ? getStorage() : null;
    if (!storage) return { files: 0, bytes: 0 };
    const settings = await getSettings();
    const sonEspace = await espace(alanyaID, settings);
    if (sonEspace.plus) return { files: 0, bytes: 0 };
    const blobIds = new Set();
    let fichiers = 0;
    let octets = 0;
    await tx(async (conn) => {
      const [compte] = await conn.query('SELECT alanyaID FROM safebox_account WHERE alanyaID = ? FOR UPDATE', [alanyaID]);
      if (!compte.length) return;
      let { usedBytes } = await usageOf(conn, alanyaID);
      if (usedBytes <= sonEspace.quotaBytes) return;
      const supprimer = async (rows) => {
        if (!rows.length) return;
        await conn.query('DELETE FROM safebox_file WHERE id IN (?)', [rows.map((r) => r.id)]);
        for (const r of rows) {
          fichiers += 1;
          // Un contenu à plusieurs endroits ne compte qu'une fois.
          if (blobIds.has(Number(r.blob_id))) continue;
          blobIds.add(Number(r.blob_id));
          octets += Number(r.t);
        }
      };
      const [enCours] = await conn.query(
        `SELECT f.id, f.blob_id, b.stored_bytes + b.preview_bytes AS t
           FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
          WHERE f.alanyaID = ? AND (b.status = 'pending' OR f.trashed_at IS NOT NULL)`,
        [alanyaID],
      );
      await supprimer(enCours);
      await conn.query(
        'DELETE FROM safebox_folder WHERE alanyaID = ? AND trashed_at IS NOT NULL AND trashed_by_folder IS NULL',
        [alanyaID],
      );
      ({ usedBytes } = await usageOf(conn, alanyaID));
      // Par contenu, le plus récent d'abord : un contenu à plusieurs endroits
      // ne libère sa place que lorsque tous ses exemplaires partent.
      while (usedBytes > sonEspace.quotaBytes) {
        const [lot] = await conn.query(
          `SELECT f.blob_id, b.stored_bytes + b.preview_bytes AS t, MAX(f.created_at) AS recent, MAX(f.id) AS dernier
             FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
            WHERE f.alanyaID = ? AND f.trashed_at IS NULL AND b.status = 'ready'
            GROUP BY f.blob_id
            ORDER BY recent DESC, dernier DESC LIMIT 200`,
          [alanyaID],
        );
        if (!lot.length) break;
        const partants = [];
        for (const r of lot) {
          if (usedBytes <= sonEspace.quotaBytes) break;
          partants.push(Number(r.blob_id));
          usedBytes -= Number(r.t);
        }
        const [exemplaires] = await conn.query(
          `SELECT f.id, f.blob_id, b.stored_bytes + b.preview_bytes AS t
             FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
            WHERE f.alanyaID = ? AND f.blob_id IN (?) AND f.trashed_at IS NULL`,
          [alanyaID, partants],
        );
        await supprimer(exemplaires);
      }
    });
    if (blobIds.size) {
      await collectOrphans(db, storage, { blobIds: [...blobIds] })
        .catch((e) => console.error('[Coffre] ménage après dépassement :', e.message));
    }
    return { files: fichiers, bytes: octets };
  }

  // ── Modération d'un fichier signalé (décision du 18/10/2026, point 7) ───

  /**
   * Le partage et ses contenus, corbeille comprise, sans contrôle
   * d'appartenance : admin seulement. Pour un lot, `fichier` est le premier
   * élément qui a un aperçu (ce que voit la modération) et `blobIds` tous ses
   * contenus.
   */
  async function partagePourModeration(shareId) {
    const id = R.parseId(shareId);
    if (!id) throw introuvable();
    const [[s]] = await db.query('SELECT * FROM safebox_share WHERE id = ?', [id]);
    if (!s) throw introuvable();
    let fichiers = [];
    if (estLot(s)) {
      [fichiers] = await db.query(
        `${FICHIER} JOIN safebox_share_item i ON i.file_id = f.id WHERE i.share_id = ? ORDER BY i.position`,
        [s.id],
      );
    } else if (s.file_id) {
      [fichiers] = await db.query(`${FICHIER} WHERE f.id = ?`, [s.file_id]);
    }
    const fichier = fichiers.find((f) => Number(f.preview_bytes) > 0) || fichiers[0] || null;
    return { s, fichier, blobIds: [...new Set(fichiers.map((f) => Number(f.blob_id)))] };
  }

  /**
   * Partages actifs qui portent l'un de ces contenus, seul ou dans un lot
   * (un destinataire a pu le renvoyer).
   */
  const PARTAGES_DES_CONTENUS = `SELECT sh.id FROM safebox_share sh JOIN safebox_file f ON f.id = sh.file_id
                                  WHERE f.blob_id IN (?) AND sh.revoked_at IS NULL
                                 UNION
                                 SELECT sh.id FROM safebox_share sh
                                   JOIN safebox_share_item i ON i.share_id = sh.id
                                   JOIN safebox_file f ON f.id = i.file_id
                                  WHERE f.blob_id IN (?) AND sh.revoked_at IS NULL`;

  /**
   * A — ce que voit la modération : le partage, son état, jusqu'où le contenu
   * s'est répandu, et son aperçu déchiffré par le serveur (quelques dizaines
   * de Ko, jamais le fichier lui-même). Un lot montre son premier aperçu.
   */
  async function moderationView(shareId) {
    const { s, fichier, blobIds } = await partagePourModeration(shareId);
    const out = {
      id: Number(s.id),
      conversationId: Number(s.conversation_id),
      senderId: Number(s.sender_id),
      kind: estLot(s) ? 'batch' : 'file',
      count: estLot(s) ? Number(s.item_count) : 1,
      name: s.name,
      mime: s.mime,
      family: s.family,
      plainBytes: Number(s.plain_bytes),
      createdAt: s.created_at,
      revokedAt: s.revoked_at,
      fileDeleted: !fichier,
      trashed: Boolean(fichier?.trashed_at),
      vaults: 0,
      activeShares: 0,
      recipients: null,
      preview: null,
      previewError: false,
    };
    if (!fichier) return out;
    const [[c]] = await db.query('SELECT COUNT(DISTINCT alanyaID) AS n FROM safebox_file WHERE blob_id IN (?)', [blobIds]);
    out.vaults = Number(c.n);
    const [[p]] = await db.query(`SELECT COUNT(*) AS n FROM (${PARTAGES_DES_CONTENUS}) x`, [blobIds, blobIds]);
    out.activeShares = Number(p.n);
    try {
      const [[r]] = await db.query(
        `SELECT COUNT(DISTINCT r.alanyaID) AS n FROM safebox_share_recipient r
          WHERE r.share_id IN (
            SELECT sh.id FROM safebox_share sh JOIN safebox_file f ON f.id = sh.file_id WHERE f.blob_id IN (?)
            UNION
            SELECT i.share_id FROM safebox_share_item i JOIN safebox_file f ON f.id = i.file_id WHERE f.blob_id IN (?))`,
        [blobIds, blobIds],
      );
      out.recipients = Number(r.n);
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    if (Number(fichier.preview_bytes) > 0 && fichier.status === 'ready' && fichier.wrapped_key) {
      try {
        const chiffre = await ready().getSmall(R.previewKey(fichier.prefix), C.MAX_PREVIEW_BYTES + 64);
        const clair = decryptPreview(unwrapFileKey(fichier.wrapped_key, fichier.blob_id, env), chiffre);
        const type = imageMime(clair);
        if (type) out.preview = `data:${type};base64,${clair.toString('base64')}`;
      } catch (e) {
        console.error(`[Coffre] aperçu du partage ${s.id} illisible pour la modération :`, e.message);
        out.previewError = true;
      }
    }
    return out;
  }

  /**
   * B — retire tous les partages actifs de ces contenus, quel que soit celui
   * qui les a envoyés, seuls ou dans un lot. Les copies déjà gardées dans des
   * coffres restent : c'est C qui les efface.
   */
  async function moderationRevoke(shareId) {
    const { s, blobIds } = await partagePourModeration(shareId);
    let n = 0;
    if (blobIds.length) {
      const [ids] = await db.query(PARTAGES_DES_CONTENUS, [blobIds, blobIds]);
      if (ids.length) {
        const [r] = await db.query(
          "UPDATE safebox_share SET revoked_at = NOW(), revoked_by = 'moderation' WHERE id IN (?) AND revoked_at IS NULL",
          [ids.map((x) => x.id)],
        );
        n += r.affectedRows;
      }
    }
    const [r2] = await db.query(
      "UPDATE safebox_share SET revoked_at = NOW(), revoked_by = 'moderation' WHERE id = ? AND revoked_at IS NULL",
      [s.id],
    );
    return { revoked: n + r2.affectedRows };
  }

  /**
   * C — supprime le contenu partout (chaque élément, pour un lot) : le coffre
   * de l'expéditeur, les copies gardées par d'autres, puis les blocs chez
   * MEGA. Irréversible. Les partages sont retirés d'abord : plus aucun
   * « Garder dans mon coffre » ne peut désigner ces blobs pendant la
   * suppression.
   */
  async function moderationDelete(shareId) {
    const storage = ready();
    const { blobIds } = await partagePourModeration(shareId);
    const { revoked } = await moderationRevoke(shareId);
    if (!blobIds.length) return { revoked, files: 0, vaults: 0, megaDeleted: false };
    const [[c]] = await db.query(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT alanyaID) AS comptes FROM safebox_file WHERE blob_id IN (?)',
      [blobIds],
    );
    await db.query('DELETE FROM safebox_file WHERE blob_id IN (?)', [blobIds]);
    const ramassage = await collectOrphans(db, storage, { blobIds });
    return { revoked, files: Number(c.n), vaults: Number(c.comptes), megaDeleted: ramassage.supprimes === blobIds.length };
  }

  return {
    overview,
    listFolder,
    recentAlbums,
    createFolder,
    updateFolder,
    trashFolder,
    restoreFolder,
    updateFile,
    trashFile,
    restoreFile,
    addToFolder,
    downloadFile,
    largestFiles,
    createShare,
    shareInfo,
    shareItems,
    shareDownload,
    saveShare,
    receivedShares,
    shareRecipients,
    revokeShare,
    backupCheck,
    backupSkip,
    purgeExcess,
    moderationView,
    moderationRevoke,
    moderationDelete,
    setNoteText,
    reserveNoteAudio,
    completeNoteAudio,
    deleteNoteAudio,
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
