/**
 * Espace d'administration du coffre-fort (lot 5) : volume stocké, coffres,
 * plus gros consommateurs, partages, et les réglages de `safebox_settings`.
 * Conception : docs/conception/coffre-fort.html, section 10.
 *
 * Deux volumes, à ne pas confondre :
 *  - `countedBytes` : ce qui compte dans les espaces des inscrits (un fichier
 *    enregistré par trois destinataires compte trois fois) ;
 *  - `megaBytes` : ce que MEGA stocke réellement (chaque blob une fois), donc
 *    ce qui est facturé.
 */

const pool = require('../../config/db');
const { fail, failInternal } = require('../../utils/apiError');
const { ROOTS } = require('../../constants/safebox');
const { getSafeboxSettings, invalidateSafeboxSettings } = require('../../services/safebox/settings');

const Gio = 1024 ** 3;

/**
 * Corps de PUT /api/admin/safebox/settings, validé champ par champ.
 * @returns {{ ok: true, value: object } | { ok: false, message: string }}
 */
function parseSafeboxSettingsPatch(body) {
  const src = body || {};
  const value = {};
  const bornes = {
    base_quota_bytes: [0, 100 * 1024 * Gio],
    max_file_bytes: [1024 * 1024, 100 * Gio],
    max_file_bytes_plus: [1024 * 1024, 100 * Gio],
    max_depth: [1, 20],
    max_folders: [1, 100_000],
    share_downloads_per_day: [1, 1000],
  };
  for (const [cle, [min, max]] of Object.entries(bornes)) {
    if (src[cle] === undefined) continue;
    const n = typeof src[cle] === 'string' && /^\d+$/.test(src[cle]) ? Number(src[cle]) : src[cle];
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      return { ok: false, message: `${cle} doit être un entier entre ${min} et ${max}` };
    }
    value[cle] = n;
  }
  if (src.extensions !== undefined) {
    if (src.extensions === null) {
      value.extensions = null;
    } else if (typeof src.extensions !== 'object' || Array.isArray(src.extensions)) {
      return { ok: false, message: 'extensions : un objet { albums: [...], videos: [...], … } ou null' };
    } else {
      const propre = {};
      for (const [famille, liste] of Object.entries(src.extensions)) {
        if (!ROOTS.includes(famille)) return { ok: false, message: `extensions : famille inconnue « ${famille} »` };
        if (!Array.isArray(liste) || liste.some((e) => typeof e !== 'string' || !/^\.?[a-z0-9]{1,10}$/i.test(e))) {
          return { ok: false, message: `extensions.${famille} : liste d'extensions (lettres et chiffres, 10 au plus)` };
        }
        propre[famille] = [...new Set(liste.map((e) => e.toLowerCase().replace(/^\./, '')))];
      }
      value.extensions = propre;
    }
  }
  if (value.max_file_bytes_plus !== undefined && value.max_file_bytes !== undefined
      && value.max_file_bytes_plus < value.max_file_bytes) {
    return { ok: false, message: 'max_file_bytes_plus ne peut pas être plus petit que max_file_bytes' };
  }
  if (!Object.keys(value).length) return { ok: false, message: 'Aucune modification' };
  return { ok: true, value };
}

const nombre = (v) => Number(v) || 0;

/** GET /api/admin/safebox — chiffres et réglages. */
const getSafeboxAdmin = async (req, res) => {
  try {
    const [[totaux]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM safebox_account) AS coffres,
              (SELECT COUNT(*) FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
                WHERE f.trashed_at IS NULL AND b.status = 'ready') AS fichiers,
              (SELECT COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0)
                 FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id) AS compte,
              (SELECT COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0)
                 FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id WHERE f.trashed_at IS NOT NULL) AS corbeille,
              (SELECT COALESCE(SUM(stored_bytes + preview_bytes), 0) FROM safebox_blob WHERE status <> 'deleting') AS mega,
              (SELECT COUNT(*) FROM safebox_blob WHERE status = 'pending') AS envois`,
    );
    const [familles] = await pool.query(
      `SELECT f.family, COUNT(*) AS fichiers, COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0) AS octets
         FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
        WHERE f.trashed_at IS NULL AND b.status = 'ready'
        GROUP BY f.family`,
    );
    const [gros] = await pool.query(
      `SELECT f.alanyaID, u.nom, u.alanyaPhone, COUNT(*) AS fichiers,
              COALESCE(SUM(b.stored_bytes + b.preview_bytes), 0) AS octets
         FROM safebox_file f
         JOIN safebox_blob b ON b.id = f.blob_id
         JOIN users u ON u.alanyaID = f.alanyaID
        GROUP BY f.alanyaID, u.nom, u.alanyaPhone
        ORDER BY octets DESC
        LIMIT 20`,
    );
    // Les partages arrivent avec la migration 102 : leur absence n'empêche pas la page.
    let partages = { partages30j: 0, telechargements30j: 0 };
    try {
      const [[p]] = await pool.query(
        `SELECT (SELECT COUNT(*) FROM safebox_share WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS partages30j,
                (SELECT COUNT(*) FROM safebox_share_download WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)) AS telechargements30j`,
      );
      partages = { partages30j: nombre(p.partages30j), telechargements30j: nombre(p.telechargements30j) };
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }
    // Fichiers dont le contenu manquait chez MEGA au dernier rapprochement
    // (migration 106) : comptés, et les 50 plus récents nommés, pour prévenir
    // leurs propriétaires. Sans la migration, null.
    let perdus = null;
    try {
      const [[n]] = await pool.query(
        `SELECT COUNT(*) AS fichiers FROM safebox_file f JOIN safebox_blob b ON b.id = f.blob_id
          WHERE b.lost_at IS NOT NULL`,
      );
      const [liste] = await pool.query(
        `SELECT f.id, f.name, f.family, f.alanyaID, u.nom, b.plain_bytes, b.lost_at
           FROM safebox_file f
           JOIN safebox_blob b ON b.id = f.blob_id
           LEFT JOIN users u ON u.alanyaID = f.alanyaID
          WHERE b.lost_at IS NOT NULL
          ORDER BY b.lost_at DESC, f.id DESC
          LIMIT 50`,
      );
      perdus = {
        files: nombre(n.fichiers),
        items: liste.map((l) => ({
          fileId: Number(l.id),
          name: l.name,
          family: l.family,
          alanyaID: Number(l.alanyaID),
          ownerName: l.nom,
          plainBytes: nombre(l.plain_bytes),
          lostAt: l.lost_at,
        })),
      };
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
    }
    const reglages = await getSafeboxSettings();
    res.json({
      totals: {
        vaults: nombre(totaux.coffres),
        files: nombre(totaux.fichiers),
        countedBytes: nombre(totaux.compte),
        trashBytes: nombre(totaux.corbeille),
        megaBytes: nombre(totaux.mega),
        pendingUploads: nombre(totaux.envois),
        shares30d: partages.partages30j,
        shareDownloads30d: partages.telechargements30j,
        lostFiles: perdus ? perdus.files : null,
      },
      lost: perdus ? perdus.items : null,
      byFamily: Object.fromEntries(ROOTS.map((r) => {
        const l = familles.find((x) => x.family === r);
        return [r, { files: nombre(l?.fichiers), bytes: nombre(l?.octets) }];
      })),
      topUsers: gros.map((g) => ({
        alanyaID: Number(g.alanyaID),
        name: g.nom,
        phone: g.alanyaPhone,
        files: nombre(g.fichiers),
        bytes: nombre(g.octets),
      })),
      settings: {
        baseQuotaBytes: reglages.baseQuotaBytes,
        maxFileBytes: reglages.maxFileBytes,
        maxFileBytesPlus: reglages.maxFileBytesPlus,
        maxDepth: reglages.maxDepth,
        maxFolders: reglages.maxFolders,
        shareDownloadsPerDay: reglages.shareDownloadsPerDay,
        extensions: reglages.extensions,
        lastReconcileAt: reglages.lastReconcileAt,
      },
    });
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return fail(res, 503, 'SAFEBOX_UNAVAILABLE', 'Coffre-fort non installé (migration 101)');
    }
    console.error('[Admin] getSafeboxAdmin :', error);
    return failInternal(res);
  }
};

/** PUT /api/admin/safebox/settings — super-admin. */
const updateSafeboxSettings = async (req, res) => {
  const parsed = parseSafeboxSettingsPatch(req.body);
  if (!parsed.ok) return fail(res, 400, 'VALIDATION_FAILED', parsed.message);
  try {
    const cols = Object.keys(parsed.value);
    const valeurs = cols.map((c) => (c === 'extensions' && parsed.value[c] !== null
      ? JSON.stringify(parsed.value[c])
      : parsed.value[c]));
    await pool.query(
      `UPDATE safebox_settings SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ? WHERE id = 1`,
      [...valeurs, req.user?.alanyaID ?? null],
    );
    invalidateSafeboxSettings();
    console.log(`[Admin] réglages du coffre modifiés par ${req.user?.email || req.user?.alanyaID} : ${cols.join(', ')}`);
    return getSafeboxAdmin(req, res);
  } catch (error) {
    if (error.code === 'ER_BAD_FIELD_ERROR') {
      return fail(res, 409, 'MIGRATION_REQUIRED', 'Appliquer la migration 102 avant de régler les partages');
    }
    console.error('[Admin] updateSafeboxSettings :', error);
    return failInternal(res);
  }
};

module.exports = { getSafeboxAdmin, updateSafeboxSettings, parseSafeboxSettingsPatch };
