const pool = require('../config/db');
const { HISTORY_CUTOFF_SQL } = require('../utils/messageHistoryFilter');
const { MEDIA_THUMB_SELECT } = require('../utils/messageThumbSql');

const MEDIA_TYPES = [1, 2]; // image, video

// Poids inconnu (messages antérieurs à la migration 018) : -1 les range en fin
// de tri « plus lourds » au lieu de les laisser flotter selon l'humeur de MySQL
// sur les NULL, et donne au curseur composite une valeur toujours comparable.
const SIZE_EXPR = 'COALESCE(m.mediaSize, -1)';

const OWNERS = ['received', 'sent', 'all'];

/// Curseur du tri par poids : "<taille>_<msgID>". Un simple msgID ne suffit
/// pas, l'ordre n'étant plus celui des identifiants.
const parseSizeCursor = (raw) => {
  const [size, msgID] = String(raw ?? '').split('_');
  const s = Number(size);
  const m = Number(msgID);
  return Number.isFinite(s) && Number.isFinite(m) && m > 0 ? { size: s, msgID: m } : null;
};

const getMyMedia = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const bySize = req.query.sort === 'size';
    const owner = OWNERS.includes(req.query.owner) ? req.query.owner : 'received';

    // Les médias reçus occupent l'espace de l'appareil : ce sont eux que la
    // grille montre par défaut. Les envoyés restent accessibles par le filtre.
    let ownerClause = '';
    const ownerParams = [];
    if (owner === 'received') {
      ownerClause = ' AND m.senderID <> ?';
      ownerParams.push(alanyaID);
    } else if (owner === 'sent') {
      ownerClause = ' AND m.senderID = ?';
      ownerParams.push(alanyaID);
    }

    const params = [
      alanyaID, // appartenance à la conversation
      ...MEDIA_TYPES,
      alanyaID, // supprimé pour moi seul
      alanyaID, // blocage : propriétaire de la liste noire
      alanyaID, // blocage : ne jamais s'auto-exclure
      alanyaID, // vue unique : l'expéditeur garde les siens
      ...ownerParams,
    ];

    let cursorClause = '';
    if (bySize) {
      const cursor = parseSizeCursor(req.query.cursor);
      if (cursor) {
        cursorClause = ` AND (${SIZE_EXPR} < ? OR (${SIZE_EXPR} = ? AND m.msgID < ?))`;
        params.push(cursor.size, cursor.size, cursor.msgID);
      }
    } else {
      const cursor = Number(req.query.cursor) || 0;
      if (cursor > 0) {
        cursorClause = ' AND m.msgID < ?';
        params.push(cursor);
      }
    }
    params.push(limit + 1);

    const orderBy = bySize ? `${SIZE_EXPR} DESC, m.msgID DESC` : 'm.msgID DESC';

    // Mêmes garde-fous que le fil de discussion, sans quoi la grille exposerait
    // ce que la conversation cache : appartenance, historique masqué à l'ajout,
    // expéditeur bloqué, message supprimé pour soi. La vue unique reçue est
    // écartée en bloc — l'afficher en grille contournerait le principe, qu'elle
    // ait déjà été consultée ou non.
    // pool.query et non pool.execute : en requête préparée mysql2 envoie le
    // LIMIT en chaîne et MySQL répond ER_WRONG_ARGUMENTS.
    // mediaThumb est remonté pour les images ET les vidéos : la vignette est
    // générée côté app à l'envoi (120 px, PNG base64) et l'écran « Mes médias »
    // l'affiche en mémoire pour peindre la grille instantanément, sans
    // télécharger le fichier original (pleine taille) de chaque tuile.
    // Rejointe depuis message_thumb plutôt que la colonne message.mediaThumb
    // (audit scalabilité 06/08/2026 §2.2, migration 060) — le WHERE ci-dessous
    // restreint déjà m.type à {1,2}, donc le CASE WHEN d'origine était
    // redondant ; le LEFT JOIN suffit.
    const lire = (filtreSensible) => pool.query(
      `SELECT m.msgID, m.conversationID, m.senderID, m.type, m.mediaUrl,
              m.mediaName, m.mediaDuration, m.mediaSize, m.sendAt,
              u.pseudo AS senderPseudo, u.nom AS senderNom,
              ${MEDIA_THUMB_SELECT}
         FROM message m
         JOIN conv_participants cp
           ON cp.conversID = m.conversationID AND cp.alanyaID = ?
         JOIN users u ON u.alanyaID = m.senderID
         LEFT JOIN message_thumb mt ON mt.msgID = m.msgID
        WHERE m.type IN (?, ?)
          AND m.isDeleted = 0
          AND (m.deletedForID IS NULL OR m.deletedForID <> ?)
          AND m.mediaUrl IS NOT NULL
          AND m.mediaUrl <> ''
          AND ${HISTORY_CUTOFF_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM blocked b
             WHERE b.alanyaID = ?
               AND b.idCallerBlock = m.senderID
               AND m.senderID <> ?
               AND m.sendAt >= b.dateBlock
          )
          AND (m.isViewOnce = 0 OR m.senderID = ?)
          ${filtreSensible}
          ${ownerClause}
          ${cursorClause}
        ORDER BY ${orderBy}
        LIMIT ?`,
      params,
    );
    // Document sensible (migration 110) : il ne s'ouvre que dans la
    // visionneuse protégée, jamais dans une galerie — pas même chez
    // l'expéditeur, dont la galerie ouvrirait la visionneuse ordinaire.
    //
    // Sans la colonne (code déployé avant la migration : un push sur main
    // part en production sans l'appliquer), la requête est rejouée sans le
    // filtre. C'est exact : sans colonne, aucun message sensible n'a pu être
    // écrit (l'INSERT d'un message sensible la nomme).
    let rows;
    try {
      [rows] = await lire('AND m.isSensitive = 0');
    } catch (e) {
      if (e.code !== 'ER_BAD_FIELD_ERROR') throw e;
      [rows] = await lire('');
    }

    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const last = slice[slice.length - 1];

    // Tri récent : curseur numérique, comme avant, pour ne pas casser les
    // versions de l'app déjà installées. Tri par poids : curseur composite.
    let nextCursor = null;
    if (hasMore && last) {
      nextCursor = bySize ? `${last.mediaSize ?? -1}_${last.msgID}` : last.msgID;
    }

    res.json({
      items: slice.map((r) => ({
        msgID: r.msgID,
        conversationID: r.conversationID,
        senderID: r.senderID,
        senderName: r.senderPseudo || r.senderNom || null,
        isMine: r.senderID === alanyaID,
        type: Number(r.type),
        mediaUrl: r.mediaUrl,
        mediaName: r.mediaName,
        mediaThumb: r.mediaThumb ?? null,
        mediaDuration: r.mediaDuration ?? null,
        mediaSize: r.mediaSize ?? null,
        sendAt: r.sendAt,
      })),
      nextCursor,
    });
  } catch (error) {
    console.error('[ProfileMedia] ERROR:', error);
    res.status(500).json({ error: 'Échec chargement médias', code: 'INTERNAL' });
  }
};

module.exports = { getMyMedia };
