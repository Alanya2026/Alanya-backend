const pool = require('../config/db');
const {
  generateOpaqueToken, identityPayload, contactPayload, secretMatches,
} = require('../utils/qrToken');
const { addContactByFriendId } = require('../services/contactService');
const { emitToUser, hasForegroundSocket } = require('../utils/userSocketRegistry');
const { notifyQrContactScanned } = require('../services/notificationService');
const qrLoginSessions = require('../socket/state/qrLoginSessions');
const qrContactTokens = require('../socket/state/qrContactTokens');

// Le QR n'encode jamais une donnée brute (alanyaID énumérable, alanyaPhone qui
// sert aussi à se connecter) : uniquement une URL portant un jeton opaque.
// La base d'URL est partagée avec qrAuthController via utils/qrToken.
//
// Trois familles de jetons :
//   /q/c/<token>          contact ÉPHÉMÈRE (10 min, usage unique) — comptes personnels
//   /q/u/<qr_public_id>   contact PERMANENT — réservé aux futurs comptes business
//   /q/l/<id>.<secret>    session de connexion d'un nouvel appareil

const _QR_PATH_RE = /^\/q\/(u|l|c)\/([^/]+)$/;
// Lien d'invitation de groupe : `/g/<jeton>` (groupInviteService.TOKEN_RE).
const _GROUP_PATH_RE = /^\/g\/([A-Za-z0-9_-]{16})\/?$/;

/**
 * Le code permanent est réservé aux comptes business — qui n'existent pas
 * encore : `users.type_compte` est un RÔLE ADMIN (0 utilisateur, 1 admin,
 * 2 super-admin), pas un type de compte métier. Le volet 1 (socle de compte)
 * apportera `account_type` ; ce garde s'y branchera alors. D'ici là, il refuse
 * tout le monde et les comptes personnels vivent sur les jetons éphémères.
 */
const _qrPermanentAutorise = (_alanyaID) => false;

/**
 * Le parsing du payload est la responsabilité du serveur : le client envoie la
 * chaîne brute qu'il vient de scanner, sans jamais l'interpréter. Le domaine
 * n'est pas vérifié — l'autorité de résolution est le jeton, pas l'hôte, et un
 * QR déjà imprimé sous un ancien domaine doit continuer à fonctionner.
 */
const _parsePayload = (raw) => {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;

  let pathname;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }

  const groupe = _GROUP_PATH_RE.exec(pathname);
  if (groupe) return { type: 'group', token: groupe[1] };

  const match = _QR_PATH_RE.exec(pathname);
  if (!match) return null;

  if (match[1] === 'c') {
    return { type: 'contact_ephemere', token: match[2] };
  }

  if (match[1] === 'u') {
    return { type: 'contact', qrPublicId: match[2] };
  }

  // Forme « <sessionId>.<scanSecret> » : les deux jetons sont en base64url,
  // donc le point ne peut appartenir ni à l'un ni à l'autre.
  const dot = match[2].indexOf('.');
  if (dot <= 0 || dot === match[2].length - 1) return null;
  return {
    type: 'login',
    sessionId:  match[2].slice(0, dot),
    scanSecret: match[2].slice(dot + 1),
  };
};


const _toIso = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Retourne le qr_public_id du compte, en le créant à la volée s'il est encore
 * NULL (comptes antérieurs à la migration 026).
 *
 * Deux requêtes concurrentes du même compte génèrent chacune leur jeton :
 * l'UPDATE conditionné par `qr_public_id IS NULL` fait perdre la seconde, qui
 * relit alors le jeton gagnant. L'ER_DUP_ENTRY, lui, ne peut venir que d'une
 * collision entre deux jetons aléatoires — on retente.
 */
const _ensureQrPublicId = async (alanyaID) => {
  const [rows] = await pool.execute(
    'SELECT qr_public_id FROM users WHERE alanyaID = ?',
    [alanyaID]
  );
  if (rows.length === 0) return null;
  if (rows[0].qr_public_id) return rows[0].qr_public_id;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await pool.execute(
        'UPDATE users SET qr_public_id = ? WHERE alanyaID = ? AND qr_public_id IS NULL',
        [generateOpaqueToken(), alanyaID]
      );
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
    }

    const [again] = await pool.execute(
      'SELECT qr_public_id FROM users WHERE alanyaID = ?',
      [alanyaID]
    );
    if (again[0]?.qr_public_id) return again[0].qr_public_id;
  }

  throw new Error('Impossible de générer un qr_public_id unique');
};

// Jeton d'ajout de contact éphémère : 10 minutes, consommé au premier scan.
// C'est le code que l'écran « Mon code » affiche pour un compte personnel. Le
// serveur ne fournit que la donnée — le rendu du QR est entièrement client.
const createContactToken = async (req, res) => {
  try {
    const entry = await qrContactTokens.create(req.user.alanyaID);
    res.json({
      token: entry.token,
      payload: contactPayload(entry.token),
      // Durée et non seulement date de fin : le client décompte depuis
      // l'instant de réception, sans comparer son horloge à la nôtre.
      ttlMs: qrContactTokens.TTL_MS,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    });
  } catch (error) {
    console.error('[createContactToken] ERROR:', error);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

// Mon code QR d'identité PERMANENT (créé au premier appel) — comptes business
const getMyQr = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    if (!_qrPermanentAutorise(alanyaID)) {
      return res.status(403).json({
        error: 'Le code permanent est réservé aux comptes business',
        code: 'BUSINESS_ONLY',
      });
    }

    const qrPublicId = await _ensureQrPublicId(alanyaID);
    if (!qrPublicId) {
      return res.status(404).json({ error: 'Utilisateur non trouvé', code: 'USER_NOT_FOUND' });
    }

    res.json({ qrPublicId, payload: identityPayload(qrPublicId) });
  } catch (error) {
    console.error('[getMyQr] ERROR:', error);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

// Régénère le code permanent : les QR déjà partagés cessent de résoudre
const regenerateQr = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    if (!_qrPermanentAutorise(alanyaID)) {
      return res.status(403).json({
        error: 'Le code permanent est réservé aux comptes business',
        code: 'BUSINESS_ONLY',
      });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const qrPublicId = generateOpaqueToken();
      try {
        const [result] = await pool.execute(
          'UPDATE users SET qr_public_id = ? WHERE alanyaID = ?',
          [qrPublicId, alanyaID]
        );
        if (result.affectedRows === 0) {
          return res.status(404).json({ error: 'Utilisateur non trouvé', code: 'USER_NOT_FOUND' });
        }
        return res.json({ qrPublicId, payload: identityPayload(qrPublicId) });
      } catch (error) {
        if (error.code !== 'ER_DUP_ENTRY') throw error;
      }
    }

    throw new Error('Impossible de générer un qr_public_id unique');
  } catch (error) {
    console.error('[regenerateQr] ERROR:', error);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

const _resolveContact = async (req, res, alanyaID, qrPublicId) => {
  const [rows] = await pool.execute(
    'SELECT alanyaID FROM users WHERE qr_public_id = ? AND exclus = 0',
    [qrPublicId]
  );
  // Propriétaire non-business : son code permanent ne résout pas, même si la
  // colonne est renseignée (comptes d'essai antérieurs au verrouillage).
  if (rows.length === 0 || !_qrPermanentAutorise(rows[0].alanyaID)) {
    return res.status(404).json({ error: 'Code QR inconnu ou expiré', code: 'QR_UNKNOWN_OR_EXPIRED' });
  }

  const result = await addContactByFriendId(alanyaID, rows[0].alanyaID);

  switch (result.reason) {
    case 'self':
      return res.json({ type: 'contact', self: true });
    case 'not_found':
      return res.status(404).json({ error: 'Code QR inconnu ou expiré', code: 'QR_UNKNOWN_OR_EXPIRED' });
    case 'blocked':
      return res.status(403).json({ error: 'Impossible d\'ajouter cet utilisateur', code: 'INVALID_USER' });
    case 'already':
      // Rescanner un contact déjà enregistré n'est pas une erreur pour qui scanne.
      return res.json({
        type: 'contact', added: false, alreadyContact: true, contact: result.contact,
      });
    default:
      return res.json({
        type: 'contact', added: true, alreadyContact: false, contact: result.contact,
      });
  }
};

/**
 * Prévient le propriétaire que son code vient d'être utilisé, et l'invite à
 * ajouter le scanneur en retour. Deux canaux : l'événement socket (dialogue
 * in-app immédiat) et, si aucun socket au premier plan, une notification push
 * — sans quoi un code partagé par lien serait consommé sans que son
 * propriétaire ne l'apprenne. Best-effort : ne fait jamais échouer l'ajout.
 */
const _prevenirProprietaire = async (req, ownerID, scannerID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT alanyaID, nom, pseudo, avatar_url FROM users WHERE alanyaID = ?',
      [scannerID]
    );
    if (rows.length === 0) return;

    // Le propriétaire a-t-il DÉJÀ le scanneur en contact ? Si oui, l'inviter
    // à « l'ajouter en retour » n'aurait aucun sens — le client affichera une
    // simple information au lieu du dialogue oui/non.
    const [mutual] = await pool.execute(
      'SELECT idPrefContact FROM preferredContact WHERE alanyaID = ? AND idFriend = ?',
      [ownerID, scannerID]
    );

    const avatar = String(rows[0].avatar_url ?? '').trim();
    const scanner = {
      alanyaID: rows[0].alanyaID,
      nom: rows[0].nom,
      pseudo: rows[0].pseudo,
      avatar_url: avatar.startsWith('http') ? avatar : null,
    };
    const alreadyMutual = mutual.length > 0;

    const io = req.app.get('io');
    emitToUser(io, ownerID, 'qr:contact_scanned', {
      by: scanner,
      alreadyMutual,
      at: new Date().toISOString(),
    });
    // Un seul aller-retour (Redis en multi-instance) : deux appels indépendants
    // pourraient incohérer si une socket se (dé)connecte entre les deux lectures.
    const foreground = await hasForegroundSocket(io, ownerID);
    console.log(
      `[QrContact] scan notifié owner=${ownerID} par=${scannerID}` +
      ` mutual=${alreadyMutual} push=${!foreground}`,
    );

    // App fermée ou en arrière-plan : le push prend le relais — et transporte
    // l'identité du scanneur, pour que le tap rejoue le dialogue d'ajout en
    // retour que l'événement socket ne peut plus livrer.
    if (!foreground) {
      await notifyQrContactScanned(ownerID, scanner, alreadyMutual);
    }
  } catch (error) {
    console.warn('[qr:contact_scanned] émission échouée:', error.message);
  }
};

/**
 * Branche « contact éphémère » — le régime des comptes personnels. Le jeton est
 * consommé dès qu'il a rempli son office (contact ajouté, ou déjà présent) :
 * usage unique du contrat produit. Il survit en revanche à un scan de son
 * propre code et à un scan par un compte bloqué — ni l'un ni l'autre ne doit
 * pouvoir tuer le code d'autrui.
 */
const _resolveContactEphemere = async (req, res, alanyaID, token) => {
  // Lecture seule d'abord : un scan de son propre code ne doit rien consommer.
  const apercu = await qrContactTokens.get(token);
  if (!apercu) {
    return res.status(404).json({ error: 'Code QR inconnu ou expiré', code: 'QR_UNKNOWN_OR_EXPIRED' });
  }
  if (apercu.alanyaID === alanyaID) {
    return res.json({ type: 'contact', self: true });
  }

  // Réservation AVANT l'ajout, et non consommation après.
  //
  // L'ordre inverse laissait une vraie course, déjà présente en production
  // avant toute question de multi-instance : `addContactByFriendId` demande
  // plusieurs allers-retours en base, pendant lesquels un second scan du même
  // code passait la vérification. Les deux ajouts aboutissaient et le
  // propriétaire était prévenu deux fois, alors que l'écran promet « une seule
  // personne ».
  const entry = await qrContactTokens.claim(token);
  if (!entry) {
    // Un autre scan a emporté le code entre-temps.
    return res.status(404).json({ error: 'Code QR inconnu ou expiré', code: 'QR_UNKNOWN_OR_EXPIRED' });
  }

  let result;
  try {
    result = await addContactByFriendId(alanyaID, entry.alanyaID, { addedVia: 'qr' });
  } catch (e) {
    // Rendre le code à son détenteur : un incident technique ne doit pas tuer
    // un code encore valable.
    await qrContactTokens.release(token);
    throw e;
  }

  switch (result.reason) {
    case 'self':
      await qrContactTokens.release(token);
      return res.json({ type: 'contact', self: true });
    case 'not_found':
      await qrContactTokens.release(token);
      return res.status(404).json({ error: 'Code QR inconnu ou expiré', code: 'QR_UNKNOWN_OR_EXPIRED' });
    case 'blocked':
      // Un scan par un compte bloqué ne doit pas pouvoir tuer le code d'autrui.
      await qrContactTokens.release(token);
      return res.status(403).json({ error: 'Impossible d\'ajouter cet utilisateur', code: 'INVALID_USER' });
    case 'already':
    case 'added':
    default: {
      const added = result.reason !== 'already';
      await qrContactTokens.commit(token);
      _prevenirProprietaire(req, entry.alanyaID, alanyaID);
      return res.json({
        type: 'contact', added, alreadyContact: !added, contact: result.contact,
      });
    }
  }
};

/**
 * Branche « connexion » : strictement en lecture seule côté autorisation. Elle
 * ne fait que constater le scan (pending -> scanned) et décrire la session pour
 * l'écran de confirmation. Seul /api/auth/qr-session/:id/approve, appelé après
 * un geste explicite de l'utilisateur, approuve — sans quoi un QR malveillant
 * affiché sous un prétexte quelconque suffirait à voler une session.
 */
const _resolveLogin = async (req, res, alanyaID, parsed) => {
  const session = await qrLoginSessions.get(parsed.sessionId);
  // Un secret invalide est indistinguable d'une session inconnue : pas de
  // signal exploitable pour énumérer les sessions en cours.
  if (!session || !secretMatches(session.scanSecret, parsed.scanSecret)) {
    return res.status(404).json({ error: 'Session de connexion inconnue ou expirée', code: 'SESSION_NOT_FOUND' });
  }

  await qrLoginSessions.markScanned(parsed.sessionId, alanyaID);

  res.json({
    type: 'login',
    session: {
      sessionId:  session.sessionId,
      deviceName: session.deviceName ?? null,
      platform:   session.platform ?? null,
      ipAddress:  session.ipAddress ?? null,
      // Lieu approximatif déduit de l'IP. Null si la géolocalisation n'a pas
      // abouti : l'écran de confirmation retombe alors sur l'adresse brute.
      location:   session.location ?? null,
      createdAt:  _toIso(session.createdAt),
      expiresAt:  _toIso(session.expiresAt),
    },
  });
};

// Point d'entrée unique de tous les QR Alanya
const resolveQr = async (req, res) => {
  try {
    const alanyaID = req.user.alanyaID;

    const parsed = _parsePayload(req.body?.payload);
    if (!parsed) {
      return res.status(400).json({ error: 'Code QR illisible', code: 'INVALID_QR' });
    }

    if (parsed.type === 'contact_ephemere') {
      return await _resolveContactEphemere(req, res, alanyaID, parsed.token);
    }
    if (parsed.type === 'contact') {
      return await _resolveContact(req, res, alanyaID, parsed.qrPublicId);
    }
    if (parsed.type === 'group') {
      // Require local : le contrôleur de groupe tire toute la pile des
      // conversations, inutile aux autres familles de QR et à la page publique.
      const { apercuPourJeton } = require('./groupInviteController');
      const result = await apercuPourJeton(parsed.token, alanyaID);
      if (!result) {
        return res.status(404).json({ error: 'Ce lien d\'invitation ne fonctionne plus', code: 'INVITE_LINK_INVALID' });
      }
      return res.json({ type: 'group', token: parsed.token, ...result });
    }
    return await _resolveLogin(req, res, alanyaID, parsed);
  } catch (error) {
    console.error('[resolveQr] ERROR:', error);
    res.status(500).json({ error: 'Erreur interne', code: 'INTERNAL' });
  }
};

module.exports = {
  createContactToken,
  getMyQr,
  regenerateQr,
  resolveQr,
  identityPayload,
  // Partagé avec qrLandingController : la page publique d'un code permanent
  // doit suivre exactement le même verrou que sa résolution.
  qrPermanentAutorise: _qrPermanentAutorise,
};
