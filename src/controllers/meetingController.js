const pool = require('../config/db');
const { notifyMeetingInvite } = require('../services/notificationService');
const { maxParticipantsForMeeting } = require('../constants/participantLimits');
const { isBlockedEitherWay } = require('../utils/blockUtils');
const { loadMeetingAccessByRoom } = require('../services/meetingAccess');
const { verdictLecture, verdictEntree } = require('../services/meetingAccessRules');
const { solderMeeting } = require('../services/meetingClosure');
 
function toMysqlUtc(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return value;
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
 
const START_TIME_UTC =
  "DATE_FORMAT(m.start_time, '%Y-%m-%dT%H:%i:%s.000Z') AS start_time";

const getMeetings = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;
    const [rows] = await pool.execute(
      `SELECT m.*, ${START_TIME_UTC}, u.nom as organiser_nom, u.pseudo as organiser_pseudo, u.avatar_url as organiser_avatar
       FROM meeting m
       JOIN users u ON m.idOrganiser = u.alanyaID
       WHERE m.idOrganiser = ? OR m.idMeeting IN (
         SELECT idMeeting FROM participant WHERE IDparticipant = ?
       )
       ORDER BY m.start_time DESC`,
      [alanyaID, alanyaID]
    );
    res.json(rows);
  } catch (error) {
    throw error;
  }
};

const createMeeting = async (req, res) => {
  try {
    const { start_time, duree, objet, room, type_media = 0 } = req.body;
    const idOrganiser = req.user.alanyaID;

    if (!start_time || !objet || !room) {
      return res.status(400).json({ error: 'start_time, objet, room required', code: 'MEETING_FIELDS_REQUIRED' });
    }

    const [result] = await pool.execute(
      `INSERT INTO meeting (idOrganiser, start_time, duree, objet, room, isEnd, type_media)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [idOrganiser, toMysqlUtc(start_time), duree || 60, objet, room, type_media]
    );

    // L'organisateur est réputé « a rejoint » dès la création — sans quoi son
    // propre détail l'annoncerait « en attente ». `connecte = 0` en revanche :
    // il ne l'est pas encore réellement, `createAndJoin` enchaîne toujours sur
    // `meeting:join_room`, qui pose `connecte = 1`. Avant ce correctif la ligne
    // mentait dès l'INSERT, avant même qu'un invité soit ajouté (voir F5).
    await pool.execute(
      `INSERT INTO participant (idMeeting, IDparticipant, status, start_time, connecte, duree)
       VALUES (?, ?, 1, NOW(), 0, 0)`,
      [result.insertId, idOrganiser]
    );

    const [rows] = await pool.execute(
      `SELECT m.*, ${START_TIME_UTC}, u.nom as organiser_nom, u.pseudo as organiser_pseudo
       FROM meeting m JOIN users u ON m.idOrganiser = u.alanyaID WHERE m.idMeeting = ?`,
      [result.insertId]
    );

    const [participants] = await pool.execute(
      `SELECT p.*, u.nom, u.pseudo, u.avatar_url, up.is_online AS is_online
       FROM participant p
       JOIN users u ON p.IDparticipant = u.alanyaID
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       WHERE p.idMeeting = ?`,
      [result.insertId]
    );

    res.json({ ...rows[0], participants });
  } catch (error) {
    throw error;
  }
};

const getMeetingById = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      `SELECT m.*, ${START_TIME_UTC}, u.nom as organiser_nom, u.pseudo as organiser_pseudo, u.avatar_url as organiser_avatar
       FROM meeting m
       JOIN users u ON m.idOrganiser = u.alanyaID
       WHERE m.idMeeting = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Meeting not found', code: 'MEETING_NOT_FOUND' });
    }

    const [participants] = await pool.execute(
      `SELECT p.*, u.nom, u.pseudo, u.avatar_url, up.is_online AS is_online
       FROM participant p
       JOIN users u ON p.IDparticipant = u.alanyaID
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       WHERE p.idMeeting = ?`,
      [id]
    );

    res.json({ ...rows[0], participants });
  } catch (error) {
    throw error;
  }
};
 
const getMeetingByRoom = async (req, res) => {
  try {
    const { room } = req.params;

    // Contrôle d'appartenance en ligne plutôt que par middleware : la clé est un
    // code de salon, pas `:id`. Et c'est ici que le 404 indifférencié compte le
    // plus — `mtg-<millisecondes>` s'énumère.
    const acces = await loadMeetingAccessByRoom(room, req.user.alanyaID);
    if (verdictLecture(acces) !== 'ok') {
      return res.status(404).json({ error: 'Meeting not found', code: 'MEETING_NOT_FOUND' });
    }

    const [rows] = await pool.execute(
      `SELECT m.*, ${START_TIME_UTC}, u.nom as organiser_nom, u.pseudo as organiser_pseudo, u.avatar_url as organiser_avatar
       FROM meeting m
       JOIN users u ON m.idOrganiser = u.alanyaID
       WHERE m.room = ? AND m.isEnd = 0
       ORDER BY m.start_time DESC
       LIMIT 1`,
      [room]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Meeting not found', code: 'MEETING_NOT_FOUND' });
    }

    const [participants] = await pool.execute(
      `SELECT p.*, u.nom, u.pseudo, u.avatar_url, up.is_online AS is_online
       FROM participant p
       JOIN users u ON p.IDparticipant = u.alanyaID
       LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
       WHERE p.idMeeting = ?`,
      [rows[0].idMeeting]
    );

    res.json({ ...rows[0], participants });
  } catch (error) {
    throw error;
  }
};

const updateMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    const { start_time, duree, objet, room, isEnd } = req.body;
    const alanyaID = req.user.alanyaID;

    const [existing] = await pool.execute(
      'SELECT * FROM meeting WHERE idMeeting = ? AND idOrganiser = ?',
      [id, alanyaID]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Meeting not found or unauthorized', code: 'MEETING_NOT_FOUND' });
    }

    const updates = [];
    const values = [];

    if (start_time) { updates.push('start_time = ?'); values.push(toMysqlUtc(start_time)); }
    if (duree) { updates.push('duree = ?'); values.push(duree); }
    if (objet) { updates.push('objet = ?'); values.push(objet); }
    if (room) { updates.push('room = ?'); values.push(room); }
    if (typeof isEnd === 'number') { updates.push('isEnd = ?'); values.push(isEnd); }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update', code: 'NO_FIELDS_TO_UPDATE' });
    }

    values.push(id);
    await pool.execute(`UPDATE meeting SET ${updates.join(', ')} WHERE idMeeting = ?`, values);

    // Repli HTTP de « terminer pour tout le monde ». Le client n'avait que le
    // chemin socket : socket tombée, l'écran se fermait quand même et `isEnd`
    // restait 0 — la réunion réapparaissait « en cours » au chargement suivant.
    // Terminer par ici doit solder et prévenir exactement comme `meeting:end`,
    // sans quoi le repli laisserait la base à moitié dans l'état d'avant.
    if (isEnd === 1) {
      await solderMeeting(id);
      const io = req.app.get('io');
      if (io) io.to(`meeting_${id}`).emit('meeting:ended', { meetingID: Number(id) });
    }

    const [rows] = await pool.execute(
      `SELECT *, DATE_FORMAT(start_time, '%Y-%m-%dT%H:%i:%s.000Z') AS start_time
       FROM meeting WHERE idMeeting = ?`,
      [id]
    );
    res.json(rows[0]);
  } catch (error) {
    throw error;
  }
};

const deleteMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    // L'organisateur est établi par `requireMeetingOrganiser` (routes/meetings.js).
    // Avant lui, ce `DELETE FROM participant` s'exécutait sans aucune condition :
    // un tiers ne supprimait pas la réunion — la seconde requête, elle, filtrait
    // bien sur `idOrganiser` — mais il en vidait la liste des participants, et la
    // route répondait 200 comme si tout s'était bien passé.
    await pool.execute('DELETE FROM participant WHERE idMeeting = ?', [id]);
    await pool.execute('DELETE FROM meeting WHERE idMeeting = ? AND idOrganiser = ?', [id, alanyaID]);

    res.json({ message: 'Meeting deleted' });
  } catch (error) {
    throw error;
  }
};

const joinMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    // `requireMeetingParticipant` a déjà chargé la réunion et la place de
    // l'appelant : on ne la relit pas. Rien ne clôt une réunion à son échéance —
    // `isEnd` n'est écrit que par l'organisateur — donc sans cette garde on
    // rejoignait encore une réunion terminée depuis trois semaines.
    const acces = req.meetingAccess;
    const verdict = verdictEntree(acces);
    if (verdict === 'terminee') {
      return res.status(410).json({ error: 'Réunion terminée', code: 'MEETING_ENDED' });
    }
    if (verdict === 'echue') {
      return res.status(410).json({ error: 'Réunion échue', code: 'MEETING_EXPIRED' });
    }

    const limit = maxParticipantsForMeeting(acces.typeMedia);

    const [existing] = await pool.execute(
      'SELECT * FROM participant WHERE idMeeting = ? AND IDparticipant = ?',
      [id, alanyaID]
    );

    if (existing.length === 0) {
      // Depuis `requireMeetingParticipant`, cette branche n'est plus atteinte
      // que par l'organisateur dont la ligne `participant` aurait disparu — une
      // purge, une migration. Elle n'inscrit donc plus personne d'étranger : la
      // garde a remplacé l'auto-inscription qui ouvrait la réunion à tous.
      const [countRows] = await pool.execute(
        'SELECT COUNT(*) AS total FROM participant WHERE idMeeting = ?',
        [id],
      );
      const currentCount = countRows[0]?.total ?? 0;
      if (currentCount >= limit) {
        return res.status(403).json({
          error: `Maximum ${limit} participants pour cette réunion`, code: 'LIMIT_REACHED',
        });
      }

      await pool.execute(
        `INSERT INTO participant (idMeeting, IDparticipant, status, start_time, connecte, duree) 
         VALUES (?, ?, 0, NOW(), 0, 0)`,
        [id, alanyaID]
      );
    } else {
      // `status = 1` : c'est ici, au premier join réel, que « a rejoint »
      // devient vrai — pas à l'invitation. `meeting:join_room` pose le même
      // champ ; les deux écritures sont idempotentes, chacune couvre l'un des
      // deux chemins d'entrée (HTTP direct, socket après reconnexion).
      await pool.execute(
        'UPDATE participant SET status = 1, start_time = NOW() WHERE idMeeting = ? AND IDparticipant = ?',
        [id, alanyaID]
      );
    }

    res.json({ message: 'Joined meeting' });
  } catch (error) {
    throw error;
  }
};

// acceptJoinRequest / declineJoinRequest ont été retirées avec le RSVP qui les
// justifiait. Aucun appelant côté application ; après ce lot, "accepter"
// écrirait "a rejoint" sur quelqu'un qui n'a pas rejoint, et "refuser"
// supprimait exactement les invités légitimes (`WHERE status = 0`). Voir
// migrations/077_participant_status_rejoint.sql.

const inviteParticipants = async (req, res) => {
  try {
    const { id } = req.params;
    const { participant_ids = [] } = req.body;
    const alanyaID = req.user.alanyaID;

    // Vérifier que l'utilisateur est l'organisateur et récupérer les détails du meeting
    const [meetings] = await pool.execute(
      'SELECT m.*, u.nom as organiser_nom FROM meeting m JOIN users u ON m.idOrganiser = u.alanyaID WHERE m.idMeeting = ? AND m.idOrganiser = ?',
      [id, alanyaID]
    );

    if (meetings.length === 0) {
      return res.status(403).json({ error: 'Non autorisé', code: 'FORBIDDEN' });
    }

    const meeting = meetings[0];
    const limit = maxParticipantsForMeeting(meeting.type_media ?? 0);

    const [countRows] = await pool.execute(
      'SELECT COUNT(*) AS total FROM participant WHERE idMeeting = ?',
      [id],
    );
    const currentCount = countRows[0]?.total ?? 0;

    let added = 0;
    for (const participantId of participant_ids) {
      if (currentCount + added >= limit) break;

      if (await isBlockedEitherWay(alanyaID, participantId)) {
        return res.status(403).json({
          error: 'Impossible d\'inviter un contact bloqué',
          code: 'INVITE_BLOCKED',
        });
      }

      const [existing] = await pool.execute(
        'SELECT * FROM participant WHERE idMeeting = ? AND IDparticipant = ?',
        [id, participantId]
      );

      if (existing.length === 0) {
        // `status = 0` : invité, pas encore venu. Avant ce correctif la ligne
        // était insérée à 1 — « accepté » — pour quelqu'un qui n'avait pas
        // ouvert l'application. Le badge du détail lisait exactement ce champ
        // et affichait « Accepté » pour tout le monde, y compris un invité qui
        // ignore encore l'invitation.
        await pool.execute(
          'INSERT INTO participant (idMeeting, IDparticipant, status, start_time, connecte, duree) VALUES (?, ?, 0, NOW(), 0, 0)',
          [id, participantId]
        );
        added += 1;

        // Envoyer la notification d'invitation
        try {
          await notifyMeetingInvite(
            participantId,
            meeting.organiser_nom,
            meeting.objet,
            meeting.start_time,
            id,
            meeting.idOrganiser
          );
        } catch (err) {
          console.error('[Meeting] Erreur notification invite:', err.message);
        }
      }
    }

    if (participant_ids.length > 0 && added === 0 && currentCount >= limit) {
      return res.status(403).json({
        error: `Maximum ${limit} participants pour cette réunion`, code: 'LIMIT_REACHED',
      });
    }

    res.json({ message: 'Participants invited', added, limit });
  } catch (error) {
    throw error;
  }
};

const leaveMeeting = async (req, res) => {
  try {
    const { id } = req.params;
    const alanyaID = req.user.alanyaID;

    await pool.execute(
      `UPDATE participant
       SET connecte = 0,
           duree = TIMESTAMPDIFF(SECOND, start_time, NOW())
       WHERE idMeeting = ? AND IDparticipant = ?`,
      [id, alanyaID]
    );

    res.json({ message: 'Left meeting' });
  } catch (error) {
    throw error;
  }
};

module.exports = {
  getMeetings,
  createMeeting,
  getMeetingById,
  getMeetingByRoom,
  updateMeeting,
  deleteMeeting,
  joinMeeting,
  inviteParticipants,
  leaveMeeting,
};