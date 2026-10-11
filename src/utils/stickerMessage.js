/**
 * Message sticker (type 10) : validation et canonisation, PARTAGÉES par
 * `message:send` (socket) et `POST /api/conversations/:id/messages` (HTTP).
 *
 * Les deux chemins appellent `resolveStickerFields` et rien d'autre : une règle
 * ajoutée ici arrive des deux côtés (AGENTS.md, « les deux chemins d'envoi
 * reçoivent chaque règle »). Le test de parité le vérifie.
 *
 * ── Ce que le serveur décide ──
 *
 * Le client n'envoie qu'un `sid`. Tout le reste est relu en base :
 *   - `mediaUrl` est RECALCULÉE depuis la clé de stockage ; celle du client,
 *     et `w`, `h`, `a`, `emoji`, sont ignorés ;
 *   - `content` est réécrit sous sa forme canonique (contrat §1) ;
 *   - `mediaName` vaut `Sticker <emoji>` (repli lisible pour un ancien APK).
 *
 * ── Trois fermetures différentes, à ne pas confondre ──
 *
 *   1. Fonctionnalité fermée (`sticker_settings.enabled`, table
 *      absente) → `STICKER_INVALID_PAYLOAD` : rien n'est révélé.
 *   2. Sticker ou pack introuvable/indisponible → `STICKER_NOT_FOUND`,
 *      `STICKER_PACK_UNAVAILABLE`.
 *   3. Pack Plus sans droit → `SUBSCRIPTION_REQUIRED` (`feature:
 *      "stickers_premium"`). Cette fermeture-là NE SE FAIT JAMAIS faute de
 *      calcul : droits indisponibles (base, migration absente) = on laisse
 *      passer. Mieux vaut un sticker Plus de trop qu'un envoi refusé à tort.
 *
 * ── E2EE ──
 *
 * Dans une conversation chiffrée, `content` est dans le corps scellé : le
 * serveur ne peut rien vérifier, et ne touche à rien (plan §9, option a —
 * contrôle côté client tant que l'E2EE est fermé).
 */

/** Type de message d'un sticker. */
const { STICKER_PREVIEW } = require('./messagePreview');

const STICKER_TYPE = 10;

/** Limites du contrat §1. */
const CONTENT_MAX_OCTETS = 512;
const PAYLOAD_VERSION = 1;
const FEATURE_PREMIUM = 'stickers_premium';

/** Statuts du contrat (valeurs de `sticker_pack.status`). */
const PACK_STATUS = Object.freeze({ BROUILLON: 0, PUBLIE: 1, ARCHIVE: 2 });
const PACK_VISIBILITY = Object.freeze({ OFFICIEL: 0, PRIVE: 1, LIEN: 2 });

/** Statuts HTTP du contrat (fixtures/erreurs.json). */
const ERREURS = Object.freeze({
  STICKER_NOT_FOUND: { status: 404, message: 'Sticker introuvable' },
  STICKER_PACK_UNAVAILABLE: { status: 404, message: 'Pack de stickers indisponible' },
  STICKER_INVALID_PAYLOAD: { status: 400, message: 'Sticker invalide' },
  SUBSCRIPTION_REQUIRED: { status: 403, message: 'Pack réservé à Alanya Plus' },
  // Base des réglages illisible (panne, migration non jouée) : retryable, le
  // client rejoue. Jamais un `STICKER_*` terminal. Code général déjà existant.
  SERVICE_UNAVAILABLE: { status: 503, message: 'Service temporairement indisponible' },
});

/** Erreur d'envoi de sticker : code stable, statut HTTP, `feature` éventuel. */
class StickerMessageError extends Error {
  constructor(code, extra = {}) {
    const def = ERREURS[code] || { status: 400, message: code };
    super(def.message);
    this.name = 'StickerMessageError';
    this.code = code;
    this.status = def.status;
    if (extra.feature) this.feature = extra.feature;
  }
}

const refus = (code, extra) => new StickerMessageError(code, extra);

const estSticker = (type) => Number(type) === STICKER_TYPE;

/**
 * Lit la charge utile d'un sticker.
 *
 * @returns {{sid: number}}  seul champ retenu : tout le reste vient de la base
 * @throws {StickerMessageError} STICKER_INVALID_PAYLOAD
 */
function parseStickerPayload(content) {
  if (typeof content !== 'string' || content === '') throw refus('STICKER_INVALID_PAYLOAD');
  if (Buffer.byteLength(content, 'utf8') > CONTENT_MAX_OCTETS) throw refus('STICKER_INVALID_PAYLOAD');

  let data;
  try {
    data = JSON.parse(content);
  } catch (_) {
    throw refus('STICKER_INVALID_PAYLOAD');
  }
  // `[1,2,3]` et `null` sont du JSON valide, pas une charge utile. Un
  // `__proto__` posé par le JSON devient une simple clé : on ne copie jamais
  // `data` ailleurs, on n'en lit que `v` et `sid`.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw refus('STICKER_INVALID_PAYLOAD');
  }
  // Version inconnue : refus côté serveur (le client, lui, tolère). On ne
  // devine pas la forme d'un format futur.
  if (data.v !== PAYLOAD_VERSION) throw refus('STICKER_INVALID_PAYLOAD');

  const { sid } = data;
  // Un nombre JSON, entier, sûr (≤ 2^53 - 1), strictement positif : `"1 OR 1=1"`,
  // `1e999` (Infinity), `-5`, `1.5` sont refusés ici, avant toute requête.
  if (typeof sid !== 'number' || !Number.isSafeInteger(sid) || sid <= 0) {
    throw refus('STICKER_INVALID_PAYLOAD');
  }
  return { sid };
}

/** Forme canonique du `content` (contrat §1, ordre des clés compris). */
function canonicalContent({ packCode, sid, emoji, width, height, animated }) {
  return JSON.stringify({
    v: PAYLOAD_VERSION,
    pack: packCode,
    sid,
    emoji,
    w: Number(width) || 512,
    h: Number(height) || 512,
    a: Number(animated) === 1 ? 1 : 0,
  });
}

/** Dépendances par défaut : la base et le stockage réels. Chargées à l'usage. */
function depsParDefaut() {
  const store = require('../services/stickerStore');
  const { peutUtiliserStickers } = require('../services/stickerSettingsService');
  const { entitlementsOrNull } = require('../services/billing/entitlements');
  const { publicUrl } = require('../services/mediaStorage');
  return {
    ouvert: peutUtiliserStickers,
    chargeSticker: store.chargeStickerPourEnvoi,
    droits: entitlementsOrNull,
    urlDe: publicUrl,
  };
}

/**
 * Valide un message sticker et renvoie les champs canoniques à écrire.
 *
 * @param {object} p
 * @param {*}      p.content   `content` envoyé par le client
 * @param {number} p.senderID
 * @param {object} [deps]      `ouvert()`, `chargeSticker(sid, senderID)`,
 *                             `droits(senderID)`, `urlDe(clé)` — injectables
 * @returns {Promise<{content: string, mediaUrl: string, mediaName: string,
 *                    sid: number, packCode: string}>}
 * @throws {StickerMessageError}
 */
async function prepareStickerMessage({ content, senderID }, deps = depsParDefaut()) {
  // Réglages illisibles (base injoignable, migration non jouée) : erreur
  // RETRYABLE, jamais un refus terminal. Un `STICKER_*` ferait marquer la
  // bulle en échec définitif côté app ; le 503, lui, laisse l'outbox rejouer.
  let ouvert;
  try {
    ouvert = await deps.ouvert();
  } catch (e) {
    throw refus('SERVICE_UNAVAILABLE');
  }
  if (!ouvert) throw refus('STICKER_INVALID_PAYLOAD');

  const { sid } = parseStickerPayload(content);

  const s = await deps.chargeSticker(sid, senderID);
  if (!s) throw refus('STICKER_NOT_FOUND');
  // Fichier retiré (suppression par l'auteur, retrait admin) : le sticker
  // n'existe plus pour un nouvel envoi. Les anciens messages, eux, affichent
  // le marqueur « Sticker retiré » côté application.
  if (Number(s.asset_status) !== 0) throw refus('STICKER_NOT_FOUND');

  const visibilite = Number(s.visibility);
  const statut = Number(s.pack_status);
  const installe = Number(s.installed) === 1;
  if (visibilite === PACK_VISIBILITY.OFFICIEL) {
    // Publié : ouvert. Archivé : ouvert à qui l'a déjà installé (décision 9) —
    // un pack qu'on retire du catalogue ne casse pas les habitudes de ses
    // utilisateurs. Brouillon : jamais.
    if (statut !== PACK_STATUS.PUBLIE && !(statut === PACK_STATUS.ARCHIVE && installe)) {
      throw refus('STICKER_PACK_UNAVAILABLE');
    }
  } else if (visibilite === PACK_VISIBILITY.PRIVE) {
    // Pack perso : seul son propriétaire peut envoyer ses stickers.
    if (Number(s.owner_id) !== Number(senderID)) throw refus('STICKER_PACK_UNAVAILABLE');
  } else if (visibilite === PACK_VISIBILITY.LIEN) {
    // Pack partagé (V1b/T6) : il faut l'avoir installé.
    if (!installe) throw refus('STICKER_PACK_UNAVAILABLE');
  } else {
    // Visibilité inconnue : refus, jamais une ouverture par défaut.
    throw refus('STICKER_PACK_UNAVAILABLE');
  }

  if (Number(s.is_premium) === 1) {
    let droits = null;
    try {
      droits = await deps.droits(senderID);
    } catch (_) {
      droits = null;
    }
    // Fermé SEULEMENT sur un « non » explicite et lisible. Droits absents,
    // fonctionnalité inconnue du catalogue : on laisse passer.
    if (droits && droits.features && droits.features[FEATURE_PREMIUM] === false) {
      throw refus('SUBSCRIPTION_REQUIRED', { feature: FEATURE_PREMIUM });
    }
  }

  const emoji = String(s.emoji ?? '');
  return {
    sid,
    packCode: s.pack_code,
    content: canonicalContent({
      packCode: s.pack_code,
      sid,
      emoji,
      width: s.width,
      height: s.height,
      animated: s.animated,
    }),
    mediaUrl: deps.urlDe(s.storage_key),
    mediaName: `Sticker ${emoji}`,
  };
}

/**
 * Point d'entrée UNIQUE des deux chemins d'envoi.
 *
 * Renvoie `null` quand le message n'est pas un sticker à traiter : l'appelant
 * garde alors ses champs tels quels.
 *
 * Deux cas pour un type 10 :
 *   - en clair : `{content, mediaUrl, mediaName}` canoniques à substituer à
 *     ceux du client ;
 *   - chiffré (`chiffre` présent) : le serveur ne peut ni lire ni vérifier le
 *     sticker, et il ne doit surtout PAS conserver les champs du client —
 *     `mediaUrl` et `content` seraient stockés en clair, exactement ce que le
 *     chiffrement promet d'empêcher. On renvoie les trois colonnes à NULL ;
 *     le contenu vit dans l'enveloppe.
 *
 * @throws {StickerMessageError}
 */
async function resolveStickerFields({
  type, content, senderID, chiffre = null,
}, deps) {
  if (!estSticker(type)) return null;
  if (chiffre) return { content: null, mediaUrl: null, mediaName: null };
  const r = await prepareStickerMessage({ content, senderID }, deps);
  return { content: r.content, mediaUrl: r.mediaUrl, mediaName: r.mediaName };
}

/**
 * `replyToContent` à stocker quand le message cité est un sticker.
 *
 * Le `content` d'un sticker est un JSON machine (contrat §1) : le recopier dans
 * `replyToContent` l'afficherait brut dans la citation d'un ancien client. On
 * y met le libellé neutre de `messagePreview` (« 😀 Sticker »). Deux cas :
 *   - le message cité est de type 10 (connu par `replyToType`) ;
 *   - la citation n'a pas pu être résolue (`replyToType` null) mais le texte
 *     envoyé par le client EST une charge utile de sticker (`{"v":…,"sid":…}`).
 * Dans tous les autres cas, `replyToContent` est rendu tel quel.
 */
function sanitizeReplyContent(replyToContent, replyToType = null) {
  if (replyToContent == null) return replyToContent;
  if (estSticker(replyToType)) return STICKER_PREVIEW;
  if (typeof replyToContent === 'string' && replyToContent.startsWith('{')) {
    try {
      const d = JSON.parse(replyToContent);
      if (d && typeof d === 'object' && !Array.isArray(d)
        && Number.isSafeInteger(d.sid) && typeof d.pack === 'string' && 'v' in d) {
        return STICKER_PREVIEW;
      }
    } catch (_) { /* texte ordinaire qui commence par « { » */ }
  }
  return replyToContent;
}

/**
 * Champs de transfert d'un message source, pour le transfert par lot.
 *
 * Un sticker se transfère PAR RÉFÉRENCE (contrat §5) : jamais de légende, jamais
 * de copie de fichier (`copie: false`). Son `content` repart tel quel et
 * `mediaUrl` est recalculée par `resolveStickerFields` à l'écriture. Pour tout
 * autre type, la légende ne vaut que pour le premier message du lot.
 *
 * @returns {{content: *, copie: boolean}}
 */
function champsDeTransfert(source, index, legende) {
  if (estSticker(source.type)) return { content: source.content ?? null, copie: false };
  let content = source.content ?? null;
  if (index === 0 && legende) content = legende;
  return { content, copie: true };
}

/** Forme d'erreur du socket (`message:send_failed`). */
function toSocketError(err) {
  return {
    code: err.code,
    message: err.message,
    ...(err.feature ? { feature: err.feature } : {}),
  };
}

module.exports = {
  STICKER_TYPE,
  CONTENT_MAX_OCTETS,
  FEATURE_PREMIUM,
  PACK_STATUS,
  PACK_VISIBILITY,
  StickerMessageError,
  estSticker,
  parseStickerPayload,
  canonicalContent,
  prepareStickerMessage,
  resolveStickerFields,
  sanitizeReplyContent,
  champsDeTransfert,
  toSocketError,
};
