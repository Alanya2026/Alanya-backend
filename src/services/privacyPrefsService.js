const pool = require('../config/db');
const {
  visibilityToInt,
  visibilityFromDb,
  previewModeToInt,
  previewModeFromDb,
} = require('../constants/profilePrefs');
const { isOfficialAccount } = require('../utils/officialAccountGuard');

const VISIBILITY_VALUES = new Set(['everyone', 'contacts', 'nobody']);
const PREVIEW_VALUES = new Set(['full', 'name_only', 'generic']);

const DEFAULT_PREFS = Object.freeze({
  lastSeenVisibility: 'everyone',
  onlineVisibility: 'everyone',
  readReceiptsEnabled: 1,
  profilePhotoVisibility: 'everyone',
  addMePolicy: 'everyone',
  previewMode: 'full',
  callsFromContactsOnly: 0,
});

const _normalizeRow = (row) => ({
  ...row,
  lastSeenVisibility: visibilityFromDb(row.lastSeenVisibility),
  onlineVisibility: visibilityFromDb(row.onlineVisibility),
  profilePhotoVisibility: visibilityFromDb(row.profilePhotoVisibility),
  addMePolicy: visibilityFromDb(row.addMePolicy),
  previewMode: previewModeFromDb(row.previewMode),
});

const loadUserPrivacyPrefs = async (alanyaID) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM user_privacy_prefs WHERE alanyaID = ?',
      [alanyaID],
    );
    if (rows.length === 0) return { ...DEFAULT_PREFS };
    return { ...DEFAULT_PREFS, ..._normalizeRow(rows[0]) };
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { ...DEFAULT_PREFS };
    throw e;
  }
};

const FIELD_PREF_MAP = Object.freeze({
  avatar_url: 'profilePhotoVisibility',
  last_seen: 'lastSeenVisibility',
  is_online: 'onlineVisibility',
});

const _isContactOf = async (targetId, viewerId) => {
  const [rows] = await pool.execute(
    'SELECT 1 FROM preferredContact WHERE alanyaID = ? AND idFriend = ? LIMIT 1',
    [targetId, viewerId],
  );
  return rows.length > 0;
};

/**
 * Version batch de `_isContactOf` : lesquels, parmi [viewerIds], sont contacts
 * de [targetId] ?
 *
 * Existe pour le fan-out des notifications. Y appeler `canViewProfileField` par
 * destinataire aurait ré-introduit le N+1 que le chargement groupé de
 * `notifyNewMessage` a précisément supprimé — une requête par membre, soit ~200
 * pour un groupe de 200. Ici, une seule, quel que soit l'effectif.
 *
 * @param {number} targetId
 * @param {Array<number>} viewerIds
 * @returns {Promise<Set<number>>}
 */
const contactsAmong = async (targetId, viewerIds = []) => {
  if (targetId == null || viewerIds.length === 0) return new Set();
  const [rows] = await pool.query(
    'SELECT idFriend FROM preferredContact WHERE alanyaID = ? AND idFriend IN (?)',
    [targetId, viewerIds],
  );
  return new Set(rows.map((r) => Number(r.idFriend)));
};

const _passesVisibility = (level, isSelf, isContact) => {
  if (isSelf) return true;
  if (level === 'everyone') return true;
  if (level === 'nobody') return false;
  return isContact;
};

/**
 * Le viewer peut-il voir un champ de profil du target ?
 * field ∈ avatar_url | last_seen | is_online
 */
const canViewProfileField = async (viewerId, targetId, field) => {
  if (viewerId == null || targetId == null) return false;
  if (Number(viewerId) === Number(targetId)) return true;

  const prefKey = FIELD_PREF_MAP[field];
  if (!prefKey) return true;

  const prefs = await loadUserPrivacyPrefs(targetId);
  const level = prefs[prefKey] || 'everyone';
  if (level === 'everyone') return true;
  if (level === 'nobody') return false;

  return _isContactOf(targetId, viewerId);
};

/** L'acteur peut-il ajouter la cible à une conversation / un groupe ? */
const canAddUser = async (actorId, targetId) => {
  if (Number(actorId) === Number(targetId)) return true;

  // Le compte officiel diffuse, il ne converse pas : il n'entre ni dans un
  // groupe ni dans une conversation créée par un tiers. Sa conversation 1-1
  // naît de la matérialisation d'une diffusion, jamais d'une initiative
  // d'utilisateur. Ce point couvre les trois appelants — createConversation,
  // createGroup et addParticipants.
  if (await isOfficialAccount(targetId)) return false;

  const prefs = await loadUserPrivacyPrefs(targetId);
  const policy = prefs.addMePolicy || 'everyone';
  if (policy === 'everyone') return true;
  if (policy === 'nobody') return false;

  return _isContactOf(targetId, actorId);
};

/**
 * Le compte a-t-il droit au filtre d'appels (`call_filter`, migration 115) ?
 *
 * Ouvert pendant l'essai ; ensuite, seul un plan qui le liste le rouvre. Ne
 * ferme jamais faute de calcul, comme `requireFeature` : droits introuvables,
 * le filtre fait ce que son réglage dit. Chargé à la demande, et remplaçable
 * par [_setCallFilterRightChecker] dans les tests, qui simulent la base sans
 * les tables de l'offre.
 */
let _callFilterRight = async (alanyaID) => {
  const { entitlementsOrNull } = require('./billing/entitlements');
  const { FEATURE } = require('../constants/billing');
  const droits = await entitlementsOrNull(alanyaID);
  return !droits || droits.features?.[FEATURE.CALL_FILTER] !== false;
};

const hasCallFilterRight = (alanyaID) => _callFilterRight(alanyaID);

const _setCallFilterRightChecker = (fn) => { _callFilterRight = fn; };

/**
 * L'appelant peut-il faire sonner la cible ?
 *
 * Répond non seulement si la cible a allumé le filtre, si l'appelant n'est pas
 * dans ses contacts, et si elle a encore droit au filtre. Le réglage en base
 * n'est pas touché quand le droit manque : il reprend dès le paiement.
 *
 * Les questions sont posées de la moins chère à la plus chère : l'écrasante
 * majorité des appels s'arrête à la première, sans calcul de droits.
 */
const canCallUser = async (callerId, targetId) => {
  if (Number(callerId) === Number(targetId)) return true;

  const prefs = await loadUserPrivacyPrefs(targetId);
  if (!Number(prefs.callsFromContactsOnly)) return true;
  if (await _isContactOf(targetId, callerId)) return true;

  return !(await hasCallFilterRight(targetId));
};

const upsertUserPrivacyPrefs = async (alanyaID, patch = {}) => {
  const current = await loadUserPrivacyPrefs(alanyaID);
  const next = { ...current, ...patch };
  // Colonne de la migration 115 : écrite seulement quand on la change, pour que
  // les autres réglages s'enregistrent encore sur une base pas encore migrée.
  const avecFiltre = patch.callsFromContactsOnly !== undefined;
  await pool.execute(
    `INSERT INTO user_privacy_prefs
       (alanyaID, lastSeenVisibility, onlineVisibility, readReceiptsEnabled,
        profilePhotoVisibility, addMePolicy, previewMode${avecFiltre ? ', callsFromContactsOnly' : ''})
     VALUES (?, ?, ?, ?, ?, ?, ?${avecFiltre ? ', ?' : ''})
     ON DUPLICATE KEY UPDATE
       lastSeenVisibility = VALUES(lastSeenVisibility),
       onlineVisibility = VALUES(onlineVisibility),
       readReceiptsEnabled = VALUES(readReceiptsEnabled),
       profilePhotoVisibility = VALUES(profilePhotoVisibility),
       addMePolicy = VALUES(addMePolicy),
       previewMode = VALUES(previewMode),
       ${avecFiltre ? 'callsFromContactsOnly = VALUES(callsFromContactsOnly),' : ''}
       updatedAt = NOW()`,
    [
      alanyaID,
      visibilityToInt(next.lastSeenVisibility),
      visibilityToInt(next.onlineVisibility),
      next.readReceiptsEnabled ? 1 : 0,
      visibilityToInt(next.profilePhotoVisibility),
      visibilityToInt(next.addMePolicy),
      previewModeToInt(next.previewMode),
      ...(avecFiltre ? [next.callsFromContactsOnly ? 1 : 0] : []),
    ],
  );
  return next;
};

module.exports = {
  VISIBILITY_VALUES,
  PREVIEW_VALUES,
  DEFAULT_PREFS,
  FIELD_PREF_MAP,
  loadUserPrivacyPrefs,
  upsertUserPrivacyPrefs,
  canViewProfileField,
  canAddUser,
  canCallUser,
  hasCallFilterRight,
  contactsAmong,
  _passesVisibility,
  _isContactOf,
  _normalizeRow,
  _setCallFilterRightChecker,
};
