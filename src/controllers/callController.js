const pool = require('../config/db');
const { isBlockedEitherWay } = require('../utils/blockUtils');
const { canCallUser } = require('../services/privacyPrefsService');
const { isOfficialAccount } = require('../utils/officialAccountGuard');
const { getClientIp, parseCallMode } = require('../utils/clientIp');
const { processRejectCall } = require('../socket/handlers/calls');
 
// Récupère l'historique des appels de l'utilisateur connecté.
//
// Pagination keyset : `before` = IDcall du plus ancien appel déjà affiché,
// `limit` = taille de page (50 par défaut, 100 max). Sans `before` on renvoie
// la page la plus récente — c'est le comportement historique, donc les
// anciennes versions de l'app continuent de marcher sans changement.
//
// Le curseur porte sur le couple (created_at, IDcall) et non sur created_at
// seul : deux appels peuvent tomber dans la même seconde, et un curseur sur la
// date seule sauterait l'un des deux ou le renverrait en boucle.
const getCalls = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const before = parseInt(req.query.before, 10);
    const hasCursor = Number.isInteger(before) && before > 0;

    const params = [alanyaID, alanyaID];
    let keyset = '';
    if (hasCursor) {
      // Sous-requête non corrélée : MySQL l'évalue une seule fois. Le filtre
      // sur le propriétaire évite qu'un curseur emprunté à l'appel d'un tiers
      // serve de sonde temporelle. Si la ligne curseur est introuvable, la
      // comparaison vaut NULL → page vide, ce qui arrête proprement le
      // défilement côté app plutôt que de renvoyer à nouveau la page 1.
      keyset = `AND (c.created_at, c.IDcall) <
                  (SELECT created_at, IDcall FROM callHistory
                    WHERE IDcall = ? AND (idCaller = ? OR idReceiver = ?))`;
      params.push(before, alanyaID, alanyaID);
    }
    params.push(limit);

    // pool.query (et non execute) : le LIMIT paramétré passe par l'échappement
    // classique, comme dans getMessages.
    const [rows] = await pool.query(
      `SELECT c.*,
              u1.nom as caller_nom, u1.pseudo as caller_pseudo, u1.avatar_url as caller_avatar,
              u2.nom as receiver_nom, u2.pseudo as receiver_pseudo, u2.avatar_url as receiver_avatar
       FROM callHistory c
       JOIN users u1 ON c.idCaller   = u1.alanyaID
       JOIN users u2 ON c.idReceiver = u2.alanyaID
       WHERE (c.idCaller = ? OR c.idReceiver = ?)
         ${keyset}
       ORDER BY c.created_at DESC, c.IDcall DESC
       LIMIT ?`,
      params
    );
    res.json(rows);
  } catch (error) {
    throw error;
  }
};

// Crée un nouvel appel (type 0 = audio, 1 = vidéo)
const createCall = async (req, res) => {
  try {
    const { idReceiver, type = 0 } = req.body;
    const idCaller = req.user.alanyaID;

    if (!idReceiver) {
      return res.status(400).json({ error: 'idReceiver required', code: 'ID_RECEIVER_REQUIRED' });
    }

    // Symétrique du garde posé sur `call_user` côté Socket.IO : les deux
    // chemins d'appel doivent refuser le compte officiel.
    if (await isOfficialAccount(idReceiver)) {
      return res.status(403).json({
        error: 'Ce compte ne reçoit pas d\'appels',
        code: 'OFFICIAL_NOT_CALLABLE',
      });
    }

    if (await isBlockedEitherWay(idCaller, idReceiver)) {
      return res.status(403).json({ error: 'Appel impossible', code: 'CALL_BLOCKED' });
    }

    // Filtre d'appels du destinataire : même refus que sur `call_user`.
    if (!(await canCallUser(idCaller, idReceiver))) {
      return res.status(403).json({ error: 'Appel impossible', code: 'CALL_BLOCKED' });
    }

    const callerIp = getClientIp(req);
    // `start_time` n'est plus renseignée à l'ouverture — voir le même INSERT
    // dans le handler call_user : elle marque le décrochage, pas la sonnerie.
    // L'heure d'initiation est portée par created_at.
    const [result] = await pool.execute(
      `INSERT INTO callHistory (idCaller, idReceiver, type, status, created_at, ip)
       VALUES (?, ?, ?, 0, NOW(), ?)`,
      [idCaller, idReceiver, type, callerIp]
    );

    const [rows] = await pool.execute(
      `SELECT c.*, u.nom as receiver_nom, u.pseudo as receiver_pseudo
       FROM callHistory c
       JOIN users u ON c.idReceiver = u.alanyaID
       WHERE c.IDcall = ?`,   
      [result.insertId]
    );

    res.json(rows[0]);
  } catch (error) {
    throw error;
  }
};

// Met à jour le statut de l'appel (0 = en cours, 1 = terminé, 2 = manqué)
const endCall = async (req, res) => {
  try {
    const { id }       = req.params;
    const { status = 1, mode: rawMode } = req.body;
    const alanyaID     = req.user.alanyaID;
    const mode = parseCallMode(rawMode);
 
    // `duree` est assignée AVANT `status`, et cet ordre est le correctif :
    // MySQL évalue les assignations de gauche à droite en voyant les valeurs
    // déjà écrites, donc le CASE lit ici le statut tel qu'il était EN BASE, et
    // non celui que le client annonce dans son corps de requête. Seul un
    // décrochage effectif — `status = 1`, écrit par answer_call — donne une
    // durée ; sans quoi il suffirait de poster `status: 1` pour transformer un
    // temps de sonnerie en durée d'appel.
    await pool.execute(
      `UPDATE callHistory
       SET duree  = CASE WHEN status = 1
                         THEN LEAST(GREATEST(0, TIMESTAMPDIFF(SECOND, start_time, NOW())), 86400)
                         ELSE 0 END,
           status = ?,
           mode   = COALESCE(?, mode)
       WHERE IDcall = ? AND (idCaller = ? OR idReceiver = ?)`,
      [status, mode, id, alanyaID, alanyaID]
    );

    res.json({ message: 'Call ended' });
  } catch (error) {
    throw error;
  }
};

/**
 * Refus d'appel via HTTP — utilisé quand Flutter/CallKit refuse sans socket prêt
 * (app tuée + bouton Refuser de la notification).
 * Body: { callerId, callId? }
 */
const rejectCallHttp = async (req, res) => {
  try {
    const callerID = parseInt(req.body?.callerId, 10);
    const callIdHint = req.body?.callId ?? null;
    const receiverID = req.user.alanyaID;

    if (!callerID || Number.isNaN(callerID)) {
      return res.status(400).json({ error: 'callerId required', code: 'CALLER_ID_REQUIRED' });
    }

    const io = req.app.get('io');
    const userSockets = req.app.get('userSockets');

    const result = await processRejectCall({
      io,
      userSockets,
      callerID,
      receiverID,
      callIdHint,
    });

    res.json({ ok: true, callId: result.callId ?? null });
  } catch (error) {
    throw error;
  }
};

module.exports = { getCalls, createCall, endCall, rejectCallHttp };
