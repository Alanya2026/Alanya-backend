/**
 * INSERT partagé entre le chemin HTTP (`POST /conversations/:id/messages`,
 * réponse rapide depuis la notification) et le chemin socket (`message:send`).
 *
 * 19 colonnes, dont `status = 1` en littéral → 18 `?`.
 * Un décalage placeholders / params faisait échouer le POST natif en 500 :
 * la réponse restait en file et ne partait que via le socket à l'ouverture
 * de la discussion.
 *
 * ── Deux formes : en clair, et chiffrée ──
 *
 * `enc_version` (migration 092) vaut 0 pour un message en clair et 1 quand le
 * corps est chiffré dans `message_e2ee`. Pour un message chiffré, elle est
 * DANS l'INSERT et non posée par un UPDATE qui suivrait : un message existe
 * soit chiffré soit en clair, jamais en clair pendant un instant puis chiffré.
 * Entre les deux écritures, une relecture concurrente — l'accusé d'un autre
 * appareil, un delta de sync — verrait un message annoncé en clair dont
 * `content` est NULL, donc une bulle vide.
 *
 * La forme en clair, elle, ne nomme PAS la colonne : le `DEFAULT 0` de la
 * migration s'en charge. C'est ce qui rend le chemin qui porte tout le trafic
 * indépendant de l'ordre de déploiement — poussé avant la migration 092, ce
 * code continuerait d'écrire les messages en clair au lieu de les refuser
 * tous. Seul un message chiffré, qu'aucun client ne peut envoyer tant que les
 * clés n'existent pas, a besoin de la colonne.
 *
 * Les deux formes prennent les mêmes paramètres : `enc_version` est un
 * littéral, comme `status`.
 *
 * `sendAt` est un paramètre et non `NOW()` : l'appelant connaît ainsi la
 * valeur exacte de la ligne sans avoir à la relire, ce qui supprime un
 * aller-retour SQL du chemin critique de l'accusé d'envoi. Le pool force
 * `SET time_zone = '+00:00'` et mysql2 tourne en `timezone: 'Z'` (voir
 * config/db.js), donc un `Date` JS s'écrit exactement comme `NOW()` écrivait.
 *
 * `mediaThumb` n'est PAS ici : elle est écrite séparément dans
 * `message_thumb` par `insertMessageThumb`, une fois le `msgID` connu (audit
 * scalabilité 06/08/2026 §2.2 — sortir la vignette base64 de la table la
 * plus chaude du schéma). Voir migration 060.
 */
const MESSAGE_INSERT_SQL = `
INSERT INTO message
  (senderID, conversationID, clientID, content, type, status, sendAt,
   clickSentAt,
   mediaUrl, mediaName, mediaDuration, mediaSize, mediaPageCount,
   replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce, mentions)
VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE msgID = LAST_INSERT_ID(msgID)
`;

const MESSAGE_INSERT_CHIFFRE_SQL = `
INSERT INTO message
  (senderID, conversationID, clientID, content, type, status, sendAt,
   clickSentAt,
   mediaUrl, mediaName, mediaDuration, mediaSize, mediaPageCount,
   replyToID, replyToContent, isStatusReply, isForwarded, isViewOnce, mentions,
   enc_version)
VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
ON DUPLICATE KEY UPDATE msgID = LAST_INSERT_ID(msgID)
`;

/**
 * ── Document sensible (migration 110) ──
 *
 * `isSensitive` et `mediaProtection` ne sont nommées QUE pour un message
 * sensible, pour la même raison qu'`enc_version` : le chemin qui porte tout le
 * trafic reste indépendant de l'ordre de déploiement. Elles s'insèrent après
 * `mentions` (deux `?` de plus), avant le littéral `enc_version`.
 */
const COLONNES_SENSIBLE = ', isSensitive, mediaProtection';

function _avecSensible(sql) {
  return sql
    .replace('isViewOnce, mentions', `isViewOnce, mentions${COLONNES_SENSIBLE}`)
    .replace(/\?, \?, \?\)\nON DUPLICATE/, '?, ?, ?, ?, ?)\nON DUPLICATE')
    .replace(/\?, \?, \?, 1\)\nON DUPLICATE/, '?, ?, ?, ?, ?, 1)\nON DUPLICATE');
}

const MESSAGE_INSERT_SENSIBLE_SQL = _avecSensible(MESSAGE_INSERT_SQL);
const MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL = _avecSensible(MESSAGE_INSERT_CHIFFRE_SQL);

/**
 * La forme d'INSERT qui convient : chiffrée seulement s'il y a un corps,
 * sensible seulement pour un document sensible. `sensible` doit être la même
 * valeur que l'`isSensitive` passé à `messageInsertParams`.
 */
function messageInsertSql(chiffre, sensible = false) {
  if (sensible) return chiffre ? MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL : MESSAGE_INSERT_SENSIBLE_SQL;
  return chiffre ? MESSAGE_INSERT_CHIFFRE_SQL : MESSAGE_INSERT_SQL;
}

function messageInsertParams({
  senderID,
  conversationID,
  clientId,
  content,
  type,
  sendAt,
  clickSentAt,
  mediaUrl,
  mediaName,
  mediaDuration,
  mediaSize,
  mediaPageCount,
  replyToID,
  replyToContent,
  isStatusReply,
  isForwarded,
  isViewOnce,
  mentionsSerialized,
  isSensitive = false,
  mediaProtection = null,
}) {
  const params = [
    senderID,
    conversationID,
    clientId ?? null,
    content ?? null,
    type,
    // Jamais null : une ligne sans date d'envoi casserait le tri des bulles.
    sendAt ? new Date(sendAt) : new Date(),
    clickSentAt ? new Date(clickSentAt) : null,
    mediaUrl ?? null,
    mediaName ?? null,
    mediaDuration ?? null,
    mediaSize ?? null,
    mediaPageCount ?? null,
    replyToID,
    replyToContent,
    isStatusReply,
    isForwarded ? 1 : 0,
    isViewOnce ? 1 : 0,
    mentionsSerialized,
  ];
  // Seulement pour un message sensible : voir `messageInsertSql`.
  if (isSensitive) params.push(1, mediaProtection ?? null);
  return params;
}

/**
 * Écrit (ou remplace) la vignette base64 d'un message dans message_thumb,
 * une fois son msgID connu. No-op silencieux si `mediaThumb` est vide —
 * appelable inconditionnellement après chaque insertion de message.
 */
async function insertMessageThumb(conn, msgID, mediaThumb) {
  if (!mediaThumb) return;
  await conn.execute(
    `INSERT INTO message_thumb (msgID, thumb) VALUES (?, FROM_BASE64(?))
     ON DUPLICATE KEY UPDATE thumb = VALUES(thumb)`,
    [msgID, mediaThumb],
  );
}

module.exports = {
  MESSAGE_INSERT_SQL,
  MESSAGE_INSERT_CHIFFRE_SQL,
  MESSAGE_INSERT_SENSIBLE_SQL,
  MESSAGE_INSERT_CHIFFRE_SENSIBLE_SQL,
  messageInsertSql,
  messageInsertParams,
  insertMessageThumb,
};
