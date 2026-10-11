const fs = require('fs/promises');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { chargeStickersExport } = require('../services/stickerStore');
const { emitToUser } = require('../utils/userSocketRegistry');
const { retireClesAppareils } = require('../services/e2eeKeyService');
const { loadUserPrivacyPrefs } = require('../services/privacyPrefsService');
const { loadUserAppSettings } = require('../services/appSettingsService');
const { loadUserDndSchedule } = require('../services/dndScheduleService');
const { loadUserVoicemailSchedule } = require('../services/voicemailScheduleService');
const { loadUserNotificationPrefs } = require('../notifications/notificationPrefs');
const { withLease } = require('../services/schedulerLease');
const {
  EXPORT_JOB_STATUS,
  exportStatusFromDb,
} = require('../constants/profilePrefs');
const {
  GRACE_DAYS,
  scheduleAccountDeletion,
  cancelAccountDeletion,
  purgeExpiredAccounts,
  startDeletionPurgeScheduler,
} = require('../services/accountDeletionService');

const EXPORT_DIR = path.join(__dirname, '../../uploads/exports');
const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = url.trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  if (!trimmed.startsWith('http')) return null;
  return trimmed;
};

const _disconnectAllUserSockets = (io, alanyaID) => {
  if (!io?.sockets?.adapter?.rooms) return 0;
  const room = io.sockets.adapter.rooms.get(`user_${Number(alanyaID)}`);
  if (!room) return 0;
  let closed = 0;
  for (const sid of [...room]) {
    const s = io.sockets.sockets.get(sid);
    if (s) {
      s.disconnect(true);
      closed += 1;
    }
  }
  return closed;
};

/**
 * État stickers du compte pour l'export de données (plan §4 : `user_sticker_*`
 * entrent dans l'export) : packs installés (code lisible), favoris, packs perso
 * créés (métadonnées + stickers) et signalements émis. Pas de fichiers : l'export
 * n'embarque pas non plus les médias de conversation, seulement leur description. Migration 097 pas encore jouée :
 * `ER_NO_SUCH_TABLE` rend une section vide plutôt que de faire échouer l'export.
 */
const _chargeStickersExport = async (alanyaID) => {
  try {
    return await chargeStickersExport(alanyaID);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { installedPacks: [], favorites: [], createdPacks: [], reports: [] };
    throw e;
  }
};

const _buildSyncExport = async (alanyaID) => {
  const [users] = await pool.execute(
    `SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.idPays,
            u.avatar_url, u.bio, u.type_compte, u.created_at,
            p.libelle AS pays_libelle, p.prefix AS pays_prefix
       FROM users u
       LEFT JOIN pays p ON u.idPays = p.idPays
      WHERE u.alanyaID = ? AND u.exclus = 0`,
    [alanyaID],
  );
  if (users.length === 0) return null;

  const profile = {
    ...users[0],
    avatar_url: sanitizeUrl(users[0].avatar_url),
    password: undefined,
  };
  delete profile.password;

  const [preferredContacts] = await pool.execute(
    `SELECT pc.idPrefContact, pc.idFriend, pc.added_via, pc.added_note, pc.created_at,
            u.nom, u.pseudo, u.alanyaPhone
       FROM preferredContact pc
       JOIN users u ON pc.idFriend = u.alanyaID
      WHERE pc.alanyaID = ?`,
    [alanyaID],
  );

  const [blocked] = await pool.execute(
    `SELECT b.idBlock, b.idCallerBlock, b.dateBlock,
            u.nom, u.pseudo, u.alanyaPhone
       FROM blocked b
       JOIN users u ON b.idCallerBlock = u.alanyaID
      WHERE b.alanyaID = ?`,
    [alanyaID],
  );

  const [sessions] = await pool.execute(
    `SELECT id, device_name, platform, login_method, created_at, last_active_at, revoked_at
       FROM appareils
      WHERE alanyaID = ?
      ORDER BY last_active_at DESC`,
    [alanyaID],
  );

  const [conversations] = await pool.execute(
    `SELECT c.conversID, c.isGroup, c.GroupName, c.groupPhoto, c.description,
            c.lastMessageAt, c.lastMessageType, c.lastMessageStatus,
            cp.unreadCount, cp.isPinned, cp.isArchived, cp.role, cp.joinedAt,
            cp.mutedUntil, cp.muteForever, cp.mentionsOnly
       FROM conversation c
       JOIN conv_participants cp ON c.conversID = cp.conversID
      WHERE cp.alanyaID = ?
      ORDER BY cp.isPinned DESC, c.lastMessageAt DESC`,
    [alanyaID],
  );

  const convIds = conversations.map((c) => Number(c.conversID)).filter((id) => id > 0);
  let participantsByConv = new Map();
  if (convIds.length > 0) {
    const ph = convIds.map(() => '?').join(',');
    const [parts] = await pool.execute(
      `SELECT cp.conversID, u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, cp.role, cp.joinedAt
         FROM conv_participants cp
         JOIN users u ON cp.alanyaID = u.alanyaID
        WHERE cp.conversID IN (${ph})`,
      convIds,
    );
    for (const p of parts) {
      const cid = Number(p.conversID);
      if (!participantsByConv.has(cid)) participantsByConv.set(cid, []);
      participantsByConv.get(cid).push({
        alanyaID: p.alanyaID,
        nom: p.nom,
        pseudo: p.pseudo,
        alanyaPhone: p.alanyaPhone,
        role: Number(p.role) || 0,
        joinedAt: p.joinedAt,
      });
    }
  }

  const [privacyPrefs, appSettings, notificationPrefs, dndSchedule, voicemailSchedule] =
    await Promise.all([
      loadUserPrivacyPrefs(alanyaID),
      loadUserAppSettings(alanyaID),
      loadUserNotificationPrefs(alanyaID),
      loadUserDndSchedule(alanyaID),
      loadUserVoicemailSchedule(alanyaID),
    ]);

  const stickers = await _chargeStickersExport(alanyaID);

  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    profile,
    preferredContacts,
    blocked,
    sessions,
    privacyPrefs,
    appSettings,
    notificationPrefs,
    dndSchedule,
    voicemailSchedule,
    stickers,
    conversations: conversations.map((c) => ({
      ...c,
      lastMessage: undefined,
      participants: participantsByConv.get(Number(c.conversID)) || [],
    })),
  };
};

const _buildFullExport = async (alanyaID) => {
  const base = await _buildSyncExport(alanyaID);
  if (!base) return null;

  const [messages] = await pool.execute(
    `SELECT msgID, senderID, conversationID, content, type, status,
            sendAt, readAt, deliveredAt, mediaUrl, mediaName, mediaDuration,
            isDeleted, isEdited, editedAt, replyToID, clientID
       FROM message
      WHERE senderID = ?
         OR conversationID IN (
           SELECT conversID FROM conv_participants WHERE alanyaID = ?
         )
      ORDER BY conversationID ASC, sendAt ASC`,
    [alanyaID, alanyaID],
  );

  return { ...base, version: 2, messages };
};

const _runExportJob = async (jobId, alanyaID) => {
  try {
    await pool.execute(
      'UPDATE user_export_jobs SET status = ? WHERE id = ? AND status = ?',
      [EXPORT_JOB_STATUS.processing, jobId, EXPORT_JOB_STATUS.pending],
    );

    await fs.mkdir(EXPORT_DIR, { recursive: true });
    const payload = await _buildFullExport(alanyaID);
    if (!payload) {
      throw new Error('Utilisateur introuvable');
    }

    const filename = `export_${alanyaID}_${jobId}.json`;
    const filePath = path.join(EXPORT_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');

    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    await pool.execute(
      `UPDATE user_export_jobs
          SET status = ?, filePath = ?, completedAt = NOW(), expiresAt = ?
        WHERE id = ?`,
      [EXPORT_JOB_STATUS.ready, filename, expiresAt, jobId],
    );
  } catch (error) {
    console.error('[AccountExport] job failed:', jobId, error.message);
    await pool.execute(
      'UPDATE user_export_jobs SET status = ?, errorMessage = ?, completedAt = NOW() WHERE id = ?',
      [EXPORT_JOB_STATUS.failed, String(error.message || 'export_failed').slice(0, 2000), jobId],
    );
  }
};

const deleteAccount = async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) {
      return res.status(400).json({ error: 'Mot de passe requis', code: 'PASSWORD_REQUIRED' });
    }

    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      'SELECT password, delete_scheduled_at FROM users WHERE alanyaID = ? AND exclus = 0',
      [alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable', code: 'USER_NOT_FOUND' });
    }

    const valid = await bcrypt.compare(password, rows[0].password);
    if (!valid) {
      return res.status(401).json({ error: 'Mot de passe incorrect', code: 'PASSWORD_INCORRECT' });
    }

    const io = req.app.get('io');
    const scheduledAt = await scheduleAccountDeletion(alanyaID);

    const [devices] = await pool.execute(
      'SELECT id, device_id FROM appareils WHERE alanyaID = ? AND revoked_at IS NULL AND id <> ?',
      [alanyaID, req.user.appareilId ?? 0],
    );
    if (devices.length > 0) {
      await pool.execute(
        'UPDATE appareils SET revoked_at = NOW() WHERE alanyaID = ? AND revoked_at IS NULL AND id <> ?',
        [alanyaID, req.user.appareilId ?? 0],
      );
      // Leur identité de chiffrement part avec eux (ne lève jamais).
      await retireClesAppareils(devices.map((d) => d.id));
      for (const d of devices) {
        emitToUser(io, alanyaID, 'auth:device_revoked', {
          appareilId: d.id,
          deviceId: d.device_id,
          reason: 'account_deletion_scheduled',
        });
      }
    }

    emitToUser(io, alanyaID, 'account:deletion_scheduled', {
      scheduledAt: scheduledAt.toISOString(),
      graceDays: GRACE_DAYS,
    });

    res.json({
      message: 'Suppression planifiée',
      scheduledAt: scheduledAt.toISOString(),
      graceDays: GRACE_DAYS,
    });
  } catch (error) {
    console.error('[DeleteAccount] ERROR:', error);
    res.status(500).json({ error: 'Échec de la suppression du compte', code: 'INTERNAL' });
  }
};

const cancelAccountDeletionHandler = async (req, res) => {
  try {
    const ok = await cancelAccountDeletion(req.user.alanyaID);
    if (!ok) {
      return res.status(400).json({ error: 'Aucune suppression en cours à annuler', code: 'NO_DELETION_PENDING' });
    }
    const io = req.app.get('io');
    emitToUser(io, req.user.alanyaID, 'account:deletion_cancelled', {});
    res.json({ message: 'Suppression annulée' });
  } catch (error) {
    console.error('[CancelDeletion] ERROR:', error);
    res.status(500).json({ error: 'Échec annulation suppression', code: 'INTERNAL' });
  }
};

const cleanupExpiredExports = async () => {
  try {
    const [jobs] = await pool.execute(
      `SELECT id, filePath FROM user_export_jobs
        WHERE expiresAt IS NOT NULL AND expiresAt < NOW() AND filePath IS NOT NULL`,
    );
    for (const job of jobs) {
      try {
        await fs.unlink(path.join(EXPORT_DIR, path.basename(job.filePath)));
      } catch (_) {}
    }
    await pool.execute(
      `DELETE FROM user_export_jobs
        WHERE expiresAt IS NOT NULL AND expiresAt < NOW()`,
    );
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') {
      console.error('[ExportCleanup] ERROR:', e.message);
    }
  }
};

const startAccountLifecycleSchedulers = () => {
  // Sous bail : en multi-instances, une seule exécute la purge des comptes et
  // le nettoyage des exports (DELETE users + fs.unlink concurrents sinon).
  // TTL 300 s : une purge peut dépasser la minute sur un gros lot.
  const tick = () => {
    withLease(
      'account_lifecycle',
      async () => {
        await purgeExpiredAccounts().catch((e) =>
          console.error('[AccountDeletion] purge error:', e.message),
        );
        await cleanupExpiredExports().catch((e) =>
          console.error('[ExportCleanup] error:', e.message),
        );
      },
      300,
    ).catch((e) => console.error('[AccountLifecycle] lease error:', e.message));
  };
  tick();
  // Rendre une fonction d'ARRÊT, pas le handle : `server.js` stocke ce retour
  // dans `stopAccountLifecycleSchedulers` et l'appelle à l'extinction. Rendre
  // le Timeout faisait échouer l'arrêt sur un TypeError, avant le
  // `process.exit(0)` qui le suit — le process ne se terminait alors que sur
  // SIGKILL de pm2.
  const handle = setInterval(tick, 60 * 60 * 1000);
  return () => clearInterval(handle);
};

const exportAccountData = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const includeMessages = req.body?.includeMessages === true
      || req.body?.includeMessages === 1
      || req.body?.includeMessages === '1';

    if (!includeMessages) {
      const payload = await _buildSyncExport(alanyaID);
      if (!payload) {
        return res.status(404).json({ error: 'Utilisateur introuvable', code: 'USER_NOT_FOUND' });
      }
      return res.json(payload);
    }

    const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
    const [result] = await pool.execute(
      `INSERT INTO user_export_jobs (alanyaID, status, includeMessages, expiresAt)
       VALUES (?, ?, 1, ?)`,
      [alanyaID, EXPORT_JOB_STATUS.pending, expiresAt],
    );
    const jobId = result.insertId;

    setImmediate(() => {
      _runExportJob(jobId, alanyaID).catch((e) =>
        console.error('[AccountExport] background error:', e.message),
      );
    });

    res.status(202).json({
      jobId,
      status: 'pending',
      message: 'Export en cours. Consultez GET /auth/me/export/:jobId',
    });
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Export async non disponible (migration 034 requise)', code: 'INTERNAL' });
    }
    console.error('[ExportAccount] ERROR:', error);
    res.status(500).json({ error: 'Échec de l\'export', code: 'INTERNAL' });
  }
};

const downloadExportJob = async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Identifiant de job invalide', code: 'INVALID_JOB' });
    }

    const [rows] = await pool.execute(
      'SELECT * FROM user_export_jobs WHERE id = ? AND alanyaID = ?',
      [jobId, req.user.alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Export introuvable', code: 'EXPORT_NOT_FOUND' });
    }

    const job = { ...rows[0], status: exportStatusFromDb(rows[0].status) };
    if (job.status === 'pending' || job.status === 'processing') {
      return res.status(202).json({ jobId, status: job.status });
    }
    if (job.status === 'failed') {
      // `errorMessage` est écrit par le worker et peut contenir une erreur de
      // driver : il reste en base pour le diagnostic, il ne sort pas d'ici.
      console.error('[Export] job %s en échec: %s', jobId, job.errorMessage);
      return res.status(500).json({
        jobId,
        status: 'failed',
        error: 'Export impossible',
        code: 'EXPORT_FAILED',
      });
    }
    if (job.expiresAt && new Date(job.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ error: 'Export expiré', code: 'EXPORT_EXPIRED' });
    }
    if (!job.filePath) {
      return res.status(500).json({ error: 'Fichier d\'export manquant', code: 'INTERNAL' });
    }

    const absPath = path.join(EXPORT_DIR, path.basename(job.filePath));
    try {
      await fs.access(absPath);
    } catch {
      return res.status(404).json({ error: 'Fichier d\'export introuvable', code: 'MEDIA_NOT_FOUND' });
    }

    res.download(absPath, `alanya-export-${jobId}.json`);
  } catch (error) {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(503).json({ error: 'Export async non disponible (migration 034 requise)', code: 'INTERNAL' });
    }
    console.error('[DownloadExport] ERROR:', error);
    res.status(500).json({ error: 'Échec du téléchargement', code: 'INTERNAL' });
  }
};

module.exports = {
  deleteAccount,
  cancelAccountDeletionHandler,
  exportAccountData,
  downloadExportJob,
  startAccountLifecycleSchedulers,
};
