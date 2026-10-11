/**
 * Contrôleurs du back-office stickers (plan §6.4).
 *
 * Chaque fonction traduit une requête en appel de `services/stickerAdminService`
 * et met la réponse en forme pour l'admin (objets i18n entiers, URLs d'aperçu).
 * Les permissions ne sont PAS vérifiées ici : les routes les portent.
 */

const { publicUrl } = require('../../services/mediaStorage');
const { StickerSettingsInaccessibles } = require('../../services/stickerSettingsService');
const admin = require('../../services/stickerAdminService');
const { StickerAdminError, lireI18n } = admin;

/** URL d'aperçu, tolérante à l'absence de clé. */
const url = (key) => (key ? publicUrl(key) : null);

const repondreErreur = (res, e, contexte) => {
  if (e instanceof StickerAdminError || (e && e.code && e.status)) {
    const corps = { error: e.message, code: e.code };
    if (e.missing) corps.missing = e.missing;
    return res.status(e.status || 400).json(corps);
  }
  if (e instanceof StickerSettingsInaccessibles || e.code === 'ER_NO_SUCH_TABLE') {
    return res.status(503).json({
      error: 'Réglages stickers indisponibles (migration 097 non jouée ou base injoignable)',
      code: 'STICKER_SETTINGS_UNAVAILABLE',
    });
  }
  if (e && e.code === 'ER_DUP_ENTRY') {
    return res.status(409).json({ error: 'Conflit de valeur unique', code: 'STICKER_INVALID_PAYLOAD' });
  }
  console.error(`[Admin stickers] ${contexte}:`, e.message);
  return res.status(500).json({ error: 'Erreur serveur', code: 'INTERNAL' });
};

/** Forme admin d'une ligne `sticker_pack`. */
const versPack = (p) => ({
  id: p.id,
  code: p.code,
  name_i18n: lireI18n(p.name_i18n) || {},
  description_i18n: lireI18n(p.description_i18n),
  author: p.author,
  cover_sticker_id: p.cover_sticker_id,
  cover_url: url(p.cover_thumb_key),
  is_premium: Number(p.is_premium) === 1,
  visibility: Number(p.visibility),
  status: Number(p.status),
  share_token: p.share_token,
  sort_order: Number(p.sort_order),
  version: Number(p.version),
  published_at: p.published_at,
  created_at: p.created_at,
  updated_at: p.updated_at,
  sticker_count: p.sticker_count != null ? Number(p.sticker_count) : undefined,
  // Poids cumulé des fichiers actifs du pack, en octets (SUM de sticker_asset.bytes).
  total_bytes: p.total_bytes != null ? Number(p.total_bytes) : undefined,
});

/** Forme admin d'une ligne `sticker` jointe à son actif. */
const versSticker = (s) => ({
  id: s.id,
  position: Number(s.position),
  emoji: s.emoji,
  name_i18n: lireI18n(s.name_i18n),
  asset_id: s.asset_id,
  asset_status: Number(s.asset_status),
  url: url(s.storage_key),
  thumb_url: url(s.thumb_key),
  width: s.width,
  height: s.height,
  bytes: s.bytes,
  animated: Number(s.animated) === 1,
});

/* ── Packs ───────────────────────────────────────────────────────────── */

const listPacks = async (req, res) => {
  try {
    const lignes = await admin.listerPacks({
      status: req.query.status,
      q: req.query.q ? String(req.query.q).trim() : null,
    });
    return res.json({ packs: lignes.map(versPack) });
  } catch (e) {
    return repondreErreur(res, e, 'listPacks');
  }
};

const getPack = async (req, res) => {
  try {
    const { pack, stickers } = await admin.getPack(Number(req.params.id));
    return res.json({ pack: versPack(pack), stickers: stickers.map(versSticker) });
  } catch (e) {
    return repondreErreur(res, e, 'getPack');
  }
};

const createPack = async (req, res) => {
  try {
    const creat = await admin.createPack(req.body || {}, { by: req.user?.alanyaID });
    return res.status(201).json(creat);
  } catch (e) {
    return repondreErreur(res, e, 'createPack');
  }
};

const updatePack = async (req, res) => {
  try {
    await admin.updatePack(Number(req.params.id), req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    return repondreErreur(res, e, 'updatePack');
  }
};

const addStickers = async (req, res) => {
  try {
    const fichiers = Array.isArray(req.files) ? req.files : [];
    if (!fichiers.length) {
      return res.status(400).json({ error: 'au moins un fichier requis (champ files)', code: 'STICKER_INVALID_PAYLOAD' });
    }
    let meta = [];
    if (req.body?.meta) {
      try {
        meta = JSON.parse(req.body.meta);
        if (!Array.isArray(meta)) meta = [];
      } catch (_) {
        return res.status(400).json({ error: 'meta doit être un tableau JSON', code: 'STICKER_INVALID_PAYLOAD' });
      }
    }
    const emojiUnique = req.body?.emoji ? String(req.body.emoji).trim() : null;

    const entrees = [];
    for (let i = 0; i < fichiers.length; i += 1) {
      const m = meta[i] || {};
      const emoji = (m.emoji ? String(m.emoji).trim() : null) || emojiUnique;
      if (!emoji) {
        return res.status(400).json({
          error: 'emoji requis par sticker (champ emoji ou meta[i].emoji)',
          code: 'STICKER_INVALID_PAYLOAD',
        });
      }
      entrees.push({ buffer: fichiers[i].buffer, emoji, nameI18n: m.name_i18n || null });
    }

    const crees = await admin.addStickers(Number(req.params.id), entrees);
    return res.status(201).json({ stickers: crees });
  } catch (e) {
    return repondreErreur(res, e, 'addStickers');
  }
};

const updateSticker = async (req, res) => {
  try {
    await admin.updateSticker(Number(req.params.id), req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    return repondreErreur(res, e, 'updateSticker');
  }
};

const deleteSticker = async (req, res) => {
  try {
    await admin.deleteSticker(Number(req.params.id));
    return res.status(204).end();
  } catch (e) {
    return repondreErreur(res, e, 'deleteSticker');
  }
};

const publishPack = async (req, res) => {
  try {
    const r = await admin.publishPack(Number(req.params.id));
    return res.json(r);
  } catch (e) {
    return repondreErreur(res, e, 'publishPack');
  }
};

const archivePack = async (req, res) => {
  try {
    const r = await admin.archivePack(Number(req.params.id));
    return res.json(r);
  } catch (e) {
    return repondreErreur(res, e, 'archivePack');
  }
};

/* ── Réglages ────────────────────────────────────────────────────────── */

const getSettings = async (_req, res) => {
  try {
    return res.json(await admin.getSettings());
  } catch (e) {
    return repondreErreur(res, e, 'getSettings');
  }
};

const updateSettings = async (req, res) => {
  try {
    const r = await admin.updateSettings(req.body || {}, { by: req.user?.alanyaID });
    return res.json(r);
  } catch (e) {
    return repondreErreur(res, e, 'updateSettings');
  }
};

/* ── Modération ─────────────────────────────────────────────────────── */

const listReports = async (_req, res) => {
  try {
    const lignes = await admin.listReports();
    return res.json({
      reports: lignes.map((r) => ({
        id: r.id,
        asset_id: r.asset_id,
        reporter_id: r.reporter_id,
        reason: r.reason,
        status: Number(r.status),
        created_at: r.created_at,
        asset_status: Number(r.asset_status),
        url: url(r.storage_key),
        thumb_url: url(r.thumb_key),
        reporter_nom: r.reporter_nom,
        reporter_pseudo: r.reporter_pseudo,
      })),
    });
  } catch (e) {
    return repondreErreur(res, e, 'listReports');
  }
};

const takedownAsset = async (req, res) => {
  try {
    const r = await admin.takedownAsset(Number(req.params.id), { by: req.user?.alanyaID });
    return res.json(r);
  } catch (e) {
    return repondreErreur(res, e, 'takedownAsset');
  }
};

module.exports = {
  listPacks,
  getPack,
  createPack,
  updatePack,
  addStickers,
  updateSticker,
  deleteSticker,
  publishPack,
  archivePack,
  getSettings,
  updateSettings,
  listReports,
  takedownAsset,
};
