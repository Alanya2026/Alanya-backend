const ALBUM_PREFIX = '__talky_album__';

/**
 * Décode un marqueur album et renvoie le libellé d'aperçu
 * (ex. « 📷 5 photos, 🎥 Vidéo »), ou null si ce n'est pas un album.
 */
function albumPreviewFromContent(content) {
  if (!content || typeof content !== 'string' || !content.startsWith(ALBUM_PREFIX)) {
    return null;
  }
  const header = content.split('\n')[0];
  const parts = header.split('|');
  if (parts.length !== 4 && parts.length !== 6) return null;

  const total = parseInt(parts[3], 10);
  if (!parts[1] || Number.isNaN(total) || total < 2) return null;

  if (parts.length === 6) {
    const photos = parseInt(parts[4], 10);
    const videos = parseInt(parts[5], 10);
    if (Number.isNaN(photos) || Number.isNaN(videos)) return null;

    const labels = [];
    if (photos > 0) {
      labels.push(photos === 1 ? '📷 Photo' : `📷 ${photos} photos`);
    }
    if (videos > 0) {
      labels.push(videos === 1 ? '🎥 Vidéo' : `🎥 ${videos} vidéos`);
    }
    return labels.length ? labels.join(', ') : '📷 Album';
  }

  return total === 1 ? '📷 Photo' : `📷 ${total} photos`;
}

function locationPreviewFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  try {
    const data = JSON.parse(content);
    if (data == null || typeof data !== 'object') return null;
    const lat = Number(data.lat);
    const lng = Number(data.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    const address = typeof data.address === 'string' ? data.address.trim() : '';
    const label = name || address || 'Position';
    return `📍 ${label}`;
  } catch (_) {
    return null;
  }
}

function contactPreviewFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  try {
    const data = JSON.parse(content);
    if (data == null || typeof data !== 'object') return null;
    const id = Number(data.alanyaID);
    if (!Number.isFinite(id) || id <= 0) return null;
    const nom = typeof data.nom === 'string' ? data.nom.trim() : '';
    const pseudo = typeof data.pseudo === 'string' ? data.pseudo.trim() : '';
    const label = nom || pseudo || 'Contact';
    return `👤 ${label}`;
  } catch (_) {
    return null;
  }
}

/**
 * Aperçu d'un message système de groupe (`type = 6`).
 *
 * Le `content` est un payload JSON machine-lisible : ne JAMAIS l'exposer brut
 * dans `conversation.lastMessage`.
 *
 * Le libellé produit ici est en français en dur, et c'est assumé : le serveur
 * n'a pas de contexte de locale, et cette valeur n'est qu'une **amorce** pour
 * la liste de conversations. Le client re-dérive un aperçu localisé dès qu'il
 * possède le message (ConversationSummaryReducer + SystemEventPayload.label).
 * Même compromis que la sentinelle `ConversationMerge.deletedPreview`.
 *
 * Les libellés restent volontairement courts et sans les noms des cibles : une
 * ligne d'aperçu est tronquée, et le fil porte déjà la phrase complète.
 */
function systemPreviewFromContent(content) {
  if (!content || typeof content !== 'string') return null;
  let data;
  try {
    data = JSON.parse(content);
  } catch (_) {
    return null;
  }
  if (data == null || typeof data !== 'object') return null;

  const actor = typeof data.byName === 'string' ? data.byName.trim() : '';
  const value = typeof data.value === 'string' ? data.value.trim() : '';
  const who = actor !== '' ? actor : 'Quelqu\'un';

  switch (data.e) {
    case 'group_created':
      return value !== '' ? `${who} a créé « ${value} »` : `${who} a créé le groupe`;
    case 'member_added':
      return `${who} a ajouté des membres`;
    case 'member_removed':
      return `${who} a retiré un membre`;
    case 'member_left':
      return `${who} a quitté le groupe`;
    case 'group_renamed':
      return value !== ''
        ? `${who} a renommé le groupe en « ${value} »`
        : `${who} a renommé le groupe`;
    case 'group_photo_changed':
      return `${who} a changé la photo du groupe`;
    case 'group_description_changed':
      return `${who} a modifié la description`;
    case 'role_changed':
      return Number(data.role) >= 1
        ? `${who} a nommé un administrateur`
        : `${who} a retiré des droits d'administrateur`;
    case 'settings_changed':
      return `${who} a modifié les réglages du groupe`;

    // Capture d'écran d'une discussion à deux (POST /conversations/:id/screenshot).
    case 'screenshot':
      return `📸 ${who} a fait une capture d'écran`;

    // Lignes d'incident d'un trajet de confiance. Elles ne remontent pas la
    // conversation d'elles-mêmes (`postSystemMessage` ne touche pas à
    // `lastMessageAt`), mais si elles sont le dernier message du fil, l'aperçu
    // doit dire l'incident — pas « Le groupe a été mis à jour ».
    case 'trip_alert':
      return `⚠️ ${who} n'a pas confirmé son arrivée`;
    case 'trip_sos':
      return `🆘 ${who} a déclenché un SOS`;

    default:
      // Événement inconnu : un libellé neutre vaut mieux que du JSON brut.
      return 'Le groupe a été mis à jour';
  }
}

// Extensions traitées comme de la musique. Miroir de la liste de
// lib/core/utils/audio_message_kind.dart côté Talky — garder les deux alignées.
const MUSIC_EXTENSIONS = new Set([
  'mp3', 'm4a', 'm4b', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus',
  'wma', 'aiff', 'aif', 'caf', 'amr', 'weba', 'mid', 'midi', 'alac',
]);

/**
 * Vocal ou musique : les deux sont des messages `type = 3`, seul le nom de
 * fichier les distingue. Un vocal enregistré porte un libellé localisé
 * (« Message vocal »), sans extension.
 */
function musicTitle(mediaName) {
  if (typeof mediaName !== 'string') return null;
  const base = mediaName.trim().split('/').pop().split('?')[0];
  const dot = base.lastIndexOf('.');
  if (dot < 0 || dot >= base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!MUSIC_EXTENSIONS.has(ext)) return null;
  const title = base.slice(0, dot).trim();
  return title || null;
}

/**
 * Aperçu d'un sticker (type 10) : « 😀 Sticker », identique pour l'aperçu de
 * conversation et le corps de notification (contrat §1). Constant — jamais
 * l'emoji du sticker ni son JSON : le serveur n'a pas la langue du lecteur, et
 * le client re-dérive un aperçu localisé dès qu'il possède le message.
 */
const STICKER_PREVIEW = '😀 Sticker';

function mediaTypeLabel(type, { isViewOnce = false, mediaName } = {}) {
  const t = parseInt(type, 10) || 0;
  switch (t) {
    case 1:
      return isViewOnce ? '📷 Photo · Vue unique' : '📷 Photo';
    case 2:
      return isViewOnce ? '🎥 Vidéo · Vue unique' : '🎥 Vidéo';
    case 3: {
      if (isViewOnce) return '🎵 Audio · Vue unique';
      const track = musicTitle(mediaName);
      return track ? `🎵 ${track}` : '🎤 Message vocal';
    }
    case 4:
      return mediaName ? `📎 ${mediaName}` : '📎 Fichier';
    case 11:
      return '📦 Fichier';
    case 5:
      return '📍 Position';
    case 7:
      return '👤 Contact';
    case 9:
      return '🧭 Trajet de confiance';
    case 10:
      return STICKER_PREVIEW;
    default:
      return mediaName ?? 'Média';
  }
}


/**
 * Aperçu d'une carte de trajet (type 9). Le libellé suit l'ÉTAT : la carte est
 * réécrite à chaque transition, et la liste des conversations doit suivre.
 *
 * Ne jamais exposer le content brut — même règle que pour les types 5 et 7.
 */
function tripPreviewFromContent(content) {
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== 'object') return null;

    // ⚠ Ces libellés doivent rester mot pour mot identiques à
    // `TripCardPayload.previewLabel` (trip_payload.dart, clés `tripsPreview*`).
    //
    // Deux écrivains se partagent `conversation.lastMessage` : le serveur à
    // chaque transition, le client à chaque resynchronisation du message. Quand
    // ils ne disaient pas la même chose, l'aperçu changeait de texte tout seul
    // selon celui qui avait écrit en dernier — « ✅ Bien arrivé·e » puis
    // « Arrivée confirmée » pour un même trajet.
    //
    // Cette chaîne reste un **repli** : elle est en français, alors que le
    // client rend dans la langue du lecteur. Le client la corrige dès qu'il
    // dispose du message ; l'alignement garantit qu'entre-temps rien ne saute
    // aux yeux.
    const etat = String(data.state || '');

    // Un démenti après une alerte n'est pas un arrêt de partage. Sans ce cas,
    // le cercle qu'on vient d'alarmer lirait « Trajet arrêté » dans sa liste.
    if (etat === 'closed_cancelled' && data.closeReason === 'false_alarm') {
      return '✅ Fausse alerte';
    }

    switch (etat) {
      case 'awaiting_confirm': return '🧭 Arrivée à confirmer';
      case 'alert':            return '🆘 Alerte trajet';
      case 'sos':              return '🆘 SOS';
      case 'closed_confirmed': return '✅ Bien arrivé·e';
      case 'closed_cancelled':
      case 'closed_expired':
      case 'closed_unwatched': return '🧭 Trajet arrêté';
      case 'active':           return '🧭 Trajet en cours';
      default:                 return null;
    }
  } catch {
    return null;
  }
}

/**
 * Aperçu stocké dans conversation.lastMessage / notifications.
 * Ne jamais exposer le marqueur brut `__talky_album__|…`.
 * Aligné sur Talky `_previewForMedia`.
 */
function messagePreview({
  content,
  mediaName,
  type = 0,
  isViewOnce = false,
  isEncrypted = false,
  maxLen = 200,
}) {
  if (isEncrypted) return '🔒 Message chiffré';

  const viewOnce = isViewOnce === true || isViewOnce === 1 || isViewOnce === '1';
  const t = parseInt(type, 10) || 0;

  // type=5 : JSON lat/lng — ne jamais exposer le content brut.
  if (t === 5) {
    const loc = locationPreviewFromContent(content);
    return loc || mediaTypeLabel(5);
  }

  // type=9 : JSON de trajet — l'aperçu suit l'état de la carte.
  if (t === 9) {
    return tripPreviewFromContent(content) || mediaTypeLabel(9);
  }

  // type=10 : sticker. `content` est un JSON versionné — ne JAMAIS l'exposer.
  // Le court-circuit doit rester AVANT le traitement générique ci-dessous,
  // qui renverrait le payload brut.
  if (t === 10) return STICKER_PREVIEW;

  // type=11 : fichier du coffre-fort. `content` est un JSON (nom, taille) —
  // l'aperçu donne le nom, jamais le payload.
  if (t === 11) return require('./safeboxShareMessage').safeboxSharePreview(content);

  // type=7 : JSON contact — ne jamais exposer le content brut.
  if (t === 7) {
    const contact = contactPreviewFromContent(content);
    return contact || mediaTypeLabel(7);
  }

  // type=8 : boutons CTA (message de bienvenue officiel).
  if (t === 8) {
    try {
      const parsed = JSON.parse(String(content || '{}'));
      const buttons = Array.isArray(parsed.buttons) ? parsed.buttons : [];
      if (buttons.length) return buttons.map((b) => b.label).filter(Boolean).join(' · ');
    } catch (_) { /* ignore */ }
    return 'Message de bienvenue';
  }

  // type=6 : événement de groupe, JSON lui aussi. Le court-circuit doit rester
  // AVANT le traitement générique, qui renverrait le payload brut.
  if (t === 6) {
    return systemPreviewFromContent(content) || 'Le groupe a été mis à jour';
  }

  if (!viewOnce) {
    const album = albumPreviewFromContent(content);
    if (album) return album;

    if (content && String(content).trim()) {
      const text = String(content);
      return text.length > maxLen ? text.substring(0, maxLen) : text;
    }
  }

  return mediaTypeLabel(type, { isViewOnce: viewOnce, mediaName });
}

module.exports = {
  STICKER_PREVIEW,
  tripPreviewFromContent,
  albumPreviewFromContent,
  mediaTypeLabel,
  messagePreview,
  systemPreviewFromContent,
};
