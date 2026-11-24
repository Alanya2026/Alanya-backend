/**
 * Rescellement d'un message chiffré à deux : modification, et renvoi d'un
 * message qu'un appareil n'a pas pu ouvrir.
 *
 * ── Une seule opération pour deux besoins ──
 *
 * Le serveur ne détient, pour un message chiffré, qu'un corps scellé
 * (`message_e2ee`) et une enveloppe par appareil (`message_envelope`). Il ne
 * peut rien changer à l'un sans l'auteur : il n'a aucune clé. Modifier un
 * message comme le renvoyer reviennent donc au même geste, fait par un
 * appareil de l'auteur qui a encore le texte : il chiffre à nouveau (corps
 * neuf, clé neuve) et scelle la clé pour TOUS les appareils actuels. Le
 * serveur remplace corps et enveloppes d'un bloc, puis distribue.
 *
 *  - `edition: true` : le texte a changé. `isEdited` / `editedAt` sont posés,
 *    et un appareil qui avait déjà le texte le remplace.
 *  - `edition: false` : même texte, rescellé pour un appareil qui n'a pas pu
 *    ouvrir le premier envoi (session perdue, réinstallation). Un appareil
 *    qui a déjà le texte ignore le rescellement.
 *
 * ── Le renvoi, demandé par qui ne peut pas lire ──
 *
 * `e2ee:renvoi` part de l'appareil qui a échoué. Le serveur vérifie qu'il a
 * le droit de voir ces messages, puis transmet la demande aux appareils de
 * l'auteur (`user_<auteur>`) ; celui qui a encore le texte rescelle. Le
 * serveur n'apprend rien qu'il ne savait déjà : qui parle à qui, et quand.
 *
 * Les groupes viendront avec les chaînes d'expéditeur, où un message n'a pas
 * d'enveloppe par appareil : ils sont refusés ici.
 */

const pool = require('../../../config/db');
const {
  EnveloppeInvalide,
  normaliseChiffre,
} = require('../../../utils/messageEnvelopes');
const { refusCouverture } = require('../../../utils/conversationDevices');
const { chargeMesAppareils } = require('./envelopeRouting');

/** Même fenêtre que la modification d'un message en clair. */
const FENETRE_MODIFICATION_MINUTES = 30;

/** Au-delà, un message illisible le reste : l'auteur n'a plus à y revenir. */
const RENVOI_MAX_JOURS = 30;

/** Une demande de renvoi porte au plus une page d'historique. */
const RENVOI_MAX_MESSAGES = 50;

/** Une même demande (message, appareil) n'est transmise qu'une fois par période. */
const RENVOI_INTERVALLE_MS = 10 * 60 * 1000;

/**
 * Le rescellement est-il permis ? Fonction pure : rend un code de refus, ou
 * `null`.
 *
 * @param {object} p
 * @param {object|null} p.message  ligne `message` jointe à `conversation.isGroup`
 * @param {number} p.auteur        compte qui rescelle
 * @param {boolean} p.edition
 * @param {Date} p.maintenant
 */
function refusRescellement({ message, auteur, edition, maintenant }) {
  // Absent et « pas à moi » se ressemblent : rescelller le message d'un
  // autre n'a aucun sens, et le dire révélerait qu'il existe.
  if (!message || Number(message.senderID) !== Number(auteur)) return 'MESSAGE_NOT_FOUND';
  if (Number(message.isDeleted) === 1) return 'MESSAGE_NOT_FOUND';
  if (Number(message.enc_version) !== 1) return 'E2EE_MESSAGE_CLAIR';
  if (Number(message.isGroup) === 1) return 'E2EE_GROUPE_NON_PRIS_EN_CHARGE';

  const age = maintenant.getTime() - new Date(message.sendAt).getTime();
  if (edition) {
    // Seul un texte se modifie : la légende d'un média passera par son
    // propre lot, un contact ou une position ne se réécrivent pas.
    if (Number(message.type) !== 0) return 'EDIT_TYPE_NON_PRIS_EN_CHARGE';
    if (age > FENETRE_MODIFICATION_MINUTES * 60 * 1000) return 'EDIT_WINDOW_EXPIRED';
  } else if (age > RENVOI_MAX_JOURS * 24 * 3600 * 1000) {
    return 'E2EE_RENVOI_TROP_ANCIEN';
  }
  return null;
}

async function chargeMessage(msgID) {
  const [rows] = await pool.execute(
    `SELECT m.msgID, m.senderID, m.conversationID, m.clientID AS clientId,
            m.enc_version, m.isDeleted, m.sendAt, m.type, c.isGroup
       FROM message m
       JOIN conversation c ON c.conversID = m.conversationID
      WHERE m.msgID = ?`,
    [msgID],
  );
  return rows[0] || null;
}

async function estParticipant(conversationID, alanyaID) {
  const [rows] = await pool.execute(
    'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
    [conversationID, alanyaID],
  );
  return rows.length > 0;
}

/** Remplace corps et enveloppes d'un bloc ; pose la modification s'il y a lieu. */
async function remplaceChiffre(msgID, chiffre, edition) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE message_e2ee SET body = ?, nonce = ?, sender_appareil_id = ?
        WHERE msgID = ?`,
      [chiffre.body, chiffre.nonce, chiffre.emetteurAppareilId ?? null, msgID],
    );
    await conn.execute('DELETE FROM message_envelope WHERE msgID = ?', [msgID]);
    const place = [];
    const params = [];
    for (const e of chiffre.enveloppes) {
      place.push('(?, ?, ?, ?, ?)');
      params.push(msgID, e.appareilId, e.header, e.wrappedKey, e.envType);
    }
    await conn.query(
      `INSERT INTO message_envelope (msgID, appareil_id, header, wrapped_key, env_type)
       VALUES ${place.join(', ')}`,
      params,
    );
    if (edition) {
      await conn.execute(
        'UPDATE message SET isEdited = 1, editedAt = NOW() WHERE msgID = ?',
        [msgID],
      );
    }
    const [[relu]] = await conn.execute(
      'SELECT isEdited, editedAt FROM message WHERE msgID = ?',
      [msgID],
    );
    await conn.commit();
    return relu;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * `e2ee:resceller` — `{ msgID, body, envelopes, edition }`, réponse par
 * accusé socket : `{ ok: true, msgID, isEdited, editedAt }` ou
 * `{ ok: false, code, … }` (avec la liste à jour pour
 * `E2EE_APPAREILS_CHANGES`, comme `message:send`).
 */
const e2eeResceller = (io, socket) => {
  socket.on('e2ee:resceller', async (data, ack) => {
    const repondre = (r) => { if (typeof ack === 'function') ack(r); };
    try {
      if (!socket.authenticated || socket.appareilId == null) {
        return repondre({ ok: false, code: 'UNAUTHENTICATED' });
      }
      const msgID = Number(data && data.msgID);
      const edition = !!(data && data.edition === true);
      if (!Number.isInteger(msgID) || msgID < 1) {
        return repondre({ ok: false, code: 'INVALID_PAYLOAD' });
      }

      const message = await chargeMessage(msgID);
      const refus = refusRescellement({
        message, auteur: socket.alanyaID, edition, maintenant: new Date(),
      });
      if (refus) return repondre({ ok: false, code: refus });
      // Encore membre : un exclu ne réécrit pas ce que les autres lisent.
      if (!(await estParticipant(message.conversationID, socket.alanyaID))) {
        return repondre({ ok: false, code: 'MESSAGE_NOT_FOUND' });
      }

      let chiffre;
      try {
        chiffre = normaliseChiffre(data, socket.appareilId);
      } catch (e) {
        if (!(e instanceof EnveloppeInvalide)) throw e;
        return repondre({ ok: false, code: e.code });
      }
      if (!chiffre) return repondre({ ok: false, code: 'E2EE_CORPS_MANQUANT' });

      const couverture = await refusCouverture({
        conversationID: message.conversationID,
        senderID: socket.alanyaID,
        monAppareilId: socket.appareilId,
        enveloppes: chiffre.enveloppes,
      });
      if (couverture) {
        return repondre({
          ok: false,
          code: 'E2EE_APPAREILS_CHANGES',
          conversationID: Number(message.conversationID),
          manquants: couverture.manquants,
          enTrop: couverture.enTrop,
          appareils: couverture.appareils,
        });
      }

      const relu = await remplaceChiffre(msgID, chiffre, edition);

      const charge = {
        msgID,
        conversationID: Number(message.conversationID),
        clientId: message.clientId,
        senderID: Number(message.senderID),
        type: Number(message.type),
        sendAt: message.sendAt,
        enc_version: 1,
        content: null,
        edition,
        isEdited: Number(relu.isEdited) === 1 ? 1 : 0,
        editedAt: relu.editedAt,
      };
      const body = {
        ct: chiffre.body.toString('base64'),
        nonce: chiffre.nonce.toString('base64'),
        senderAppareilId: chiffre.emetteurAppareilId ?? null,
      };
      // Une émission par appareil, avec SA seule enveloppe (même règle que
      // `emetEnveloppes`). L'appareil qui rescelle détient le texte : rien
      // pour lui.
      const mesAppareils = await chargeMesAppareils(socket.alanyaID);
      for (const env of chiffre.enveloppes) {
        io.to(`appareil_${env.appareilId}`).emit('e2ee:rescelle', {
          ...charge,
          estMoi: mesAppareils.has(Number(env.appareilId)),
          body,
          envelope: {
            appareilId: env.appareilId,
            header: env.header,
            envType: env.envType,
            wrappedKey: env.wrappedKey ? env.wrappedKey.toString('base64') : null,
          },
        });
      }

      return repondre({
        ok: true, msgID, isEdited: charge.isEdited, editedAt: charge.editedAt,
      });
    } catch (e) {
      console.error('[E2EE] rescellement :', e.message);
      return repondre({ ok: false, code: 'INTERNAL_ERROR' });
    }
  });
};

/** Dernière transmission de chaque demande, `msgID:appareil` → horodatage. */
const dernieresDemandes = new Map();

function demandeRecente(cle, maintenant) {
  const avant = dernieresDemandes.get(cle);
  if (avant != null && maintenant - avant < RENVOI_INTERVALLE_MS) return true;
  dernieresDemandes.set(cle, maintenant);
  // Borne mémoire : on oublie les demandes périmées au fil de l'eau.
  if (dernieresDemandes.size > 50000) {
    for (const [k, t] of dernieresDemandes) {
      if (maintenant - t >= RENVOI_INTERVALLE_MS) dernieresDemandes.delete(k);
    }
  }
  return false;
}

/**
 * `e2ee:renvoi` — `{ msgIDs: [...] }` : cet appareil n'a pas pu ouvrir ces
 * messages. Transmis à l'auteur de chacun, sur `e2ee:renvoi`
 * `{ appareilId, demandes: [{ msgID, conversationID, clientId }] }`.
 */
const e2eeRenvoi = (io, socket) => {
  socket.on('e2ee:renvoi', async (data) => {
    if (!socket.authenticated || socket.appareilId == null) return;
    const ids = [...new Set(
      (Array.isArray(data && data.msgIDs) ? data.msgIDs : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    )].slice(0, RENVOI_MAX_MESSAGES);
    if (ids.length === 0) return;

    try {
      // Seuls les messages chiffrés d'une conversation à deux dont
      // l'appareil demandeur est membre, et assez récents.
      const [lignes] = await pool.query(
        `SELECT m.msgID, m.senderID, m.conversationID, m.clientID AS clientId
           FROM message m
           JOIN conversation c ON c.conversID = m.conversationID AND c.isGroup = 0
           JOIN conv_participants p ON p.conversID = m.conversationID AND p.alanyaID = ?
          WHERE m.msgID IN (?) AND m.enc_version = 1 AND m.isDeleted = 0
            AND m.sendAt >= NOW() - INTERVAL ? DAY`,
        [socket.alanyaID, ids, RENVOI_MAX_JOURS],
      );
      const maintenant = Date.now();
      const parAuteur = new Map();
      for (const l of lignes) {
        if (demandeRecente(`${l.msgID}:${socket.appareilId}`, maintenant)) continue;
        const auteur = Number(l.senderID);
        if (!parAuteur.has(auteur)) parAuteur.set(auteur, []);
        parAuteur.get(auteur).push({
          msgID: Number(l.msgID),
          conversationID: Number(l.conversationID),
          clientId: l.clientId,
        });
      }
      for (const [auteur, demandes] of parAuteur) {
        io.to(`user_${auteur}`).emit('e2ee:renvoi', {
          appareilId: Number(socket.appareilId),
          demandes,
        });
      }
    } catch (e) {
      console.warn('[E2EE] demande de renvoi :', e.message);
    }
  });
};

module.exports = {
  FENETRE_MODIFICATION_MINUTES,
  RENVOI_MAX_JOURS,
  RENVOI_MAX_MESSAGES,
  refusRescellement,
  e2eeResceller,
  e2eeRenvoi,
  _demandeRecentePourTest: demandeRecente,
};
