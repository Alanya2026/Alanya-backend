/**
 * Mise en forme des réponses `/api/stickers/*` — pure, sans base : les lignes
 * SQL entrent, la forme du contrat (fixtures `catalog.json`, `pack.json`,
 * `me.json`) sort. Les clés sont celles des fixtures ; tout champ ajouté est
 * ignorable par un client plus ancien (AGENTS.md).
 */

const { resoudre, lireObjet } = require('./stickerI18n');

/**
 * Packs que l'application installe d'office. Aucune colonne ne le porte
 * (schéma §5) : c'est une décision d'exploitation, d'où la constante ici.
 */
const PACKS_INSTALLES_PAR_DEFAUT = Object.freeze(['alanya']);

const bool = (v) => Number(v) === 1;

/**
 * @param {object} p
 * @param {Array}  p.packs   lignes `sticker_pack` + `count` + `cover_thumb_key`
 * @param {number} p.version version du catalogue
 * @param {string} p.lang
 * @param {(key: string) => string} p.urlDe
 * @param {boolean} p.verrouille  vrai si le compte n'a PAS le droit Plus
 */
function presentCatalog({ packs, version, lang, urlDe, verrouille }) {
  return {
    version: Number(version) || 0,
    packs: packs.map((p) => ({
      id: Number(p.id),
      code: p.code,
      name: resoudre(p.name_i18n, lang),
      description: resoudre(p.description_i18n, lang),
      cover: p.cover_thumb_key ? urlDe(p.cover_thumb_key) : null,
      count: Number(p.count) || 0,
      isPremium: bool(p.is_premium),
      locked: bool(p.is_premium) && Boolean(verrouille),
      version: Number(p.version) || 1,
      installedByDefault: PACKS_INSTALLES_PAR_DEFAUT.includes(p.code),
    })),
  };
}

/**
 * Animés fermés (V1c, `animated_enabled = 0`) : les stickers animés sont OMIS des
 * lectures (pack, mes packs, lien de partage), ni listés ni comptés. Fermé par
 * défaut : un appelant qui oublie `animes` ne laisse rien filtrer vers un client
 * pour qui la fonctionnalité n'existe pas.
 */
const sansAnimes = (stickers, animes) => (animes ? stickers : stickers.filter((s) => !bool(s.animated)));

/** Un sticker au format du contrat (`pack.json`) : mêmes clés partout. */
function presentSticker(s, { lang, urlDe }) {
  return {
    id: Number(s.id),
    position: Number(s.position),
    emoji: s.emoji,
    name: resoudre(s.name_i18n, lang),
    url: urlDe(s.storage_key),
    thumb: urlDe(s.thumb_key || s.storage_key),
    w: Number(s.width) || 512,
    h: Number(s.height) || 512,
    animated: bool(s.animated),
    bytes: Number(s.bytes) || 0,
  };
}

function presentPack({ pack, stickers, lang, urlDe, verrouille, animes = false }) {
  return {
    id: Number(pack.id),
    code: pack.code,
    name: resoudre(pack.name_i18n, lang),
    description: resoudre(pack.description_i18n, lang),
    version: Number(pack.version) || 1,
    isPremium: bool(pack.is_premium),
    locked: bool(pack.is_premium) && Boolean(verrouille),
    stickers: sansAnimes(stickers, animes).map((s) => presentSticker(s, { lang, urlDe })),
  };
}

/** Vignette de couverture : le sticker désigné, à défaut le premier. */
function vignetteDe(coverId, stickers, urlDe) {
  const choisi = stickers.find((s) => Number(s.id) === Number(coverId)) || stickers[0];
  return choisi ? urlDe(choisi.thumb_key || choisi.storage_key) : null;
}

/**
 * « Mes packs » (V1b) : packs perso actifs du compte avec leurs stickers.
 * `shareToken` n'est rendu qu'ici, à son propriétaire.
 *
 * @param {Array} p.packs     lignes `sticker_pack`
 * @param {Array} p.stickers  lignes `sticker` + actif, `pack_id` en tête
 */
function presentMesPacks({ packs, stickers, lang, urlDe, animes = false }) {
  const visibles = sansAnimes(stickers, animes);
  return {
    packs: packs.map((p) => {
      const siens = visibles.filter((s) => Number(s.pack_id) === Number(p.id));
      return {
        id: Number(p.id),
        code: p.code,
        name: resoudre(p.name_i18n, lang),
        nameI18n: lireObjet(p.name_i18n),
        version: Number(p.version) || 1,
        shared: Number(p.visibility) === 2,
        shareToken: p.share_token || null,
        cover: vignetteDe(p.cover_sticker_id, siens, urlDe),
        count: siens.length,
        stickers: siens.map((s) => ({ ...presentSticker(s, { lang, urlDe }), assetId: Number(s.asset_id) })),
      };
    }),
  };
}

/**
 * Fiche d'un lien de partage : lecture seule. Aucun identifiant de compte ne
 * sort (`mine` suffit) ; `addedPackId` = ma copie, si je l'ai déjà installée.
 */
function presentPartage({ pack, stickers: tous, mine, addedPackId, lang, urlDe, animes = false }) {
  const stickers = sansAnimes(tous, animes);
  return {
    name: resoudre(pack.name_i18n, lang),
    description: resoudre(pack.description_i18n, lang),
    version: Number(pack.version) || 1,
    cover: vignetteDe(pack.cover_sticker_id, stickers, urlDe),
    count: stickers.length,
    mine: Boolean(mine),
    added: addedPackId != null,
    addedPackId: addedPackId == null ? null : Number(addedPackId),
    stickers: stickers.map((s) => presentSticker(s, { lang, urlDe })),
  };
}

/**
 * Ids seulement (contrat §4) : le client résout le reste par le catalogue.
 * `features` (V1c, additif) : `{creation, animated[, video]}`, posé seulement quand le
 * contrôleur le fournit — un client ancien l'ignore, absent = faux pour l'app.
 */
function presentMe({ packs, favorites, version, features }) {
  const corps = {
    version: Number(version) || 0,
    packs: packs.map((p) => ({ id: Number(p.id), code: p.code, position: Number(p.position) })),
    favorites: favorites.map((f) => Number(f)),
  };
  if (features) {
    corps.features = { creation: Boolean(features.creation), animated: Boolean(features.animated) };
    // `video` (V1c, contrat §4d) : posé seulement quand le contrôleur le fournit.
    if (features.video !== undefined) corps.features.video = Boolean(features.video);
  }
  return corps;
}

module.exports = {
  PACKS_INSTALLES_PAR_DEFAUT, presentCatalog, presentPack, presentMe, presentMesPacks, presentPartage,
};
