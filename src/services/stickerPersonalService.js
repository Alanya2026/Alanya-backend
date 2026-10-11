/**
 * Stickers personnels (V1b, plan §4 et contrat §4) : dépôt, suppression, copie
 * d'un sticker reçu et signalement.
 *
 * Le pipeline d'upload est celui de l'administration et du script de chargement
 * (`utils/stickerAsset` → `preparerAsset`) : contrôle réel, ré-encodage WebP,
 * liste de blocage, quotas. Seule la destination change — les fichiers vont sous
 * `stickers/u/<alanyaID>/…` (`mediaStorage.personalStickerKey`) et les lignes
 * portent `owner_id = alanyaID`.
 *
 * Décisions du SERVEUR, jamais du client :
 *   - déduplication par propriétaire `(owner_id, sha256)` : deux fois la même
 *     image n'occupe qu'un fichier ;
 *   - clé personnelle salée : connaître l'empreinte ne suffit pas à deviner
 *     l'adresse du fichier d'un AUTRE compte (l'oracle d'existence est fermé) ;
 *   - suppression : le sticker quitte son pack, et le fichier n'est effacé que
 *     si plus aucun sticker ne le référence ;
 *   - copie d'un sticker reçu : le fichier est copié côté stockage (aucun octet
 *     ne passe par le serveur), avec un nouvel actif dont JE suis propriétaire —
 *     l'auteur d'origine reste maître de ses fichiers ;
 *   - un pack perso est `visibility = 1` (privé), `owner_id = alanyaID`,
 *     `status = 1` (publié) : utilisable tout de suite, sans back-office. Partagé
 *     par lien il passe à `visibility = 2` ; archivé, à `status = 2` (le plafond
 *     de 20 packs ne compte alors plus le pack).
 *
 * Aucune règle de permission ici : les routes et l'interrupteur
 * `sticker_settings.creation_enabled` s'en chargent. Ce module ne connaît que la
 * base et le stockage ; ses fonctions reçoivent leurs dépendances SQL pour être
 * éprouvées sans MySQL (voir `stickerPersonal.test.js`).
 */

const crypto = require('crypto');
const pool = require('../config/db');
const storage = require('./mediaStorage');
const { preparerAsset } = require('../utils/stickerAsset');
const { depsSql } = require('./stickerAssetService');

/** Quotas personnels (plan §4, décision 5). Les officiels n'en ont pas. */
const MAX_PACKS_PERSO = 20;
/** Aligné sur `uploadSticker` (multer, `files: 40`) et le back-office. */
const MAX_STICKERS_PACK = 40;
/** Emoji de repli quand le client n'en fournit pas : `sticker.emoji` est NOT NULL. */
const EMOJI_DEFAUT = '🙂';

/** Valeurs de la migration 097 — ne jamais renuméroter (contrat §2). */
const VISIBILITE_PRIVE = 1;
const VISIBILITE_LIEN = 2;
const STATUT_PUBLIE = 1;
const STATUT_ARCHIVE = 2;

/**
 * Motifs de signalement (`sticker_report.reason`). L'ordre est le contrat : on
 * stocke l'index, jamais la chaîne. L'application envoie l'un ou l'autre.
 */
const RAISONS = Object.freeze(['inapproprie', 'spam', 'droits', 'autre']);

class StickerPersonalError extends Error {
  constructor(code, message, status, extra = {}) {
    super(message);
    this.name = 'StickerPersonalError';
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const refus = (code, message, status = 400, extra) =>
  new StickerPersonalError(code, message, status, extra);

const introuvable = () => refus('STICKER_NOT_FOUND', 'Sticker introuvable', 404);

/**
 * Le pool ou la base injectée qui sait ouvrir une transaction : les fonctions
 * reçoivent `db` en dernier argument (tests sans MySQL), mais la transaction
 * se fait aussi bien sur un `db` injecté qui expose `getConnection` que sur le
 * pool du module. En production, `db` vaut le pool : rien ne bouge.
 */
function connexionDe(db) {
  return db && typeof db.getConnection === 'function' ? db : pool;
}

/** Un identifiant de ligne, entier sûr strictement positif. */
const idPositif = (raw) => {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Normalise un emoji : borné à 16 caractères, repli si vide. */
function emojiDe(valeur) {
  const e = String(valeur ?? '').trim();
  return e ? e.slice(0, 16) : EMOJI_DEFAUT;
}

/** `name_i18n` d'un sticker perso : `{fr}` si un nom est fourni, sinon `null`. */
function nomDe(valeur) {
  const n = String(valeur ?? '').trim();
  return n ? { fr: n.slice(0, 60) } : null;
}

/** Motif de signalement : index connu, ou numéro d'index déjà stocké. */
function raisonDe(valeur) {
  if (typeof valeur === 'string' && RAISONS.includes(valeur)) return RAISONS.indexOf(valeur);
  const n = Number(valeur);
  if (Number.isInteger(n) && n >= 0 && n < RAISONS.length) return n;
  return null;
}

/** Code d'un pack perso : `u_<alanyaID>_<8 hex>` (contrat §5, ≤ 40 caractères). */
function codePackPerso(alanyaID, alea = crypto.randomBytes(4).toString('hex')) {
  return `u_${Number(alanyaID)}_${alea}`;
}

/**
 * Un pack perso du compte, ou `null` : la propriété est vérifiée ici. Privé OU
 * partagé par lien (`visibility` 1 ou 2), jamais archivé : un pack archivé
 * n'accepte plus de sticker.
 */
async function chargePackPerso(packId, alanyaID, db = pool) {
  const [rows] = await db.execute(
    `SELECT id, code FROM sticker_pack
      WHERE id = ? AND owner_id = ? AND visibility IN (?, ?) AND status <> ?
      LIMIT 1`,
    [packId, alanyaID, VISIBILITE_PRIVE, VISIBILITE_LIEN, STATUT_ARCHIVE],
  );
  return rows[0] || null;
}

/**
 * Crée un pack perso vide. Plafonné à `MAX_PACKS_PERSO` par compte ; le code
 * est tiré au hasard et rejoué en cas de collision (probabilité négligeable).
 */
async function creerPackPerso(alanyaID, db = pool) {
  const [[c]] = await db.execute(
    'SELECT COUNT(*) AS n FROM sticker_pack WHERE owner_id = ? AND status <> ?',
    [alanyaID, STATUT_ARCHIVE],
  );
  if (Number(c?.n) >= MAX_PACKS_PERSO) {
    throw refus('STICKER_PACK_LIMIT', `${MAX_PACKS_PERSO} packs personnels maximum`, 409);
  }
  const nom = JSON.stringify({ fr: 'Mes stickers' });
  for (let essai = 0; essai < 5; essai += 1) {
    const code = codePackPerso(alanyaID);
    try {
      const [r] = await db.execute(
        `INSERT INTO sticker_pack
           (code, owner_id, name_i18n, visibility, status, sort_order, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        [code, alanyaID, nom, VISIBILITE_PRIVE, STATUT_PUBLIE, alanyaID],
      );
      return { id: r.insertId, code };
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  throw refus('STICKER_INVALID_PAYLOAD', 'Impossible de générer un code de pack perso', 500);
}

/** Le pack perso par défaut : le plus ancien, créé au besoin. */
async function packPersoParDefaut(alanyaID, db = pool) {
  const [rows] = await db.execute(
    `SELECT id, code FROM sticker_pack
      WHERE owner_id = ? AND visibility IN (?, ?) AND status <> ?
      ORDER BY sort_order ASC, id ASC
      LIMIT 1`,
    [alanyaID, VISIBILITE_PRIVE, VISIBILITE_LIEN, STATUT_ARCHIVE],
  );
  if (rows[0]) return rows[0];
  return creerPackPerso(alanyaID, db);
}

/** Résout le pack cible : celui demandé (vérifié), sinon le pack par défaut. */
async function packCible(alanyaID, packId, db = pool) {
  if (packId == null) return packPersoParDefaut(alanyaID, db);
  const id = idPositif(packId);
  const pack = id && await chargePackPerso(id, alanyaID, db);
  if (!pack) throw introuvable();
  return pack;
}

/** Refuse au-delà du plafond de stickers du pack. */
async function verifierPlafondPack(packId, db = pool) {
  const [[c]] = await db.execute(
    'SELECT COUNT(*) AS n FROM sticker WHERE pack_id = ?',
    [packId],
  );
  if (Number(c?.n) >= MAX_STICKERS_PACK) {
    throw refus('STICKER_PACK_LIMIT', `${MAX_STICKERS_PACK} stickers maximum par pack`, 409);
  }
}

/**
 * Dépose un sticker personnel : actif (dédupliqué par propriétaire) + ligne
 * `sticker` dans le pack cible.
 *
 * @param {object} p
 * @param {Buffer} p.buffer    PNG/WebP 512×512 transparent, ≤ 1 Mo
 * @param {number} p.alanyaID
 * @param {number} [p.packId]  pack perso cible (défaut : pack par défaut)
 * @param {string} [p.emoji]
 * @param {string} [p.nom]
 * @returns {Promise<{assetId: number, stickerId: number, packId: number,
 *   reutilise: boolean, bytes: number}>}
 */
async function creerStickerPerso({ buffer, alanyaID, packId = null, emoji = null, nom = null }, db = pool) {
  const pack = await packCible(alanyaID, packId, db);
  await verifierPlafondPack(pack.id, db);

  const pret = await preparerAsset(buffer, { ownerId: alanyaID }, depsSql(db));
  const emojiPropre = emojiDe(emoji);
  const nameI18n = nomDe(nom);

  const conn = await connexionDe(db).getConnection();
  const deposes = [];
  try {
    await conn.beginTransaction();

    const [exist] = await conn.execute(
      'SELECT id FROM sticker_asset WHERE owner_id = ? AND sha256 = ? FOR UPDATE',
      [alanyaID, pret.sha256],
    );
    let assetId;
    let reutilise = false;
    if (exist.length) {
      assetId = exist[0].id;
      reutilise = true;
    } else {
      const [r] = await conn.execute(
        `INSERT INTO sticker_asset (owner_id, sha256, storage_key, mime, width, height, bytes, animated)
         VALUES (?, ?, 'pending', 'image/webp', ?, ?, ?, 0)`,
        [alanyaID, pret.sha256, pret.width, pret.height, pret.bytes],
      );
      assetId = r.insertId;
    }

    const [ins] = await conn.execute(
      `INSERT INTO sticker (pack_id, position, asset_id, emoji, name_i18n)
       SELECT ?, COALESCE(MAX(position), -1) + 1, ?, ?, ? FROM sticker WHERE pack_id = ?`,
      [pack.id, assetId, emojiPropre, nameI18n ? JSON.stringify(nameI18n) : null, pack.id],
    );

    if (!reutilise) {
      // Un seul `sel` pour le sticker ET sa vignette : même racine de clé.
      const sel = crypto.randomBytes(8).toString('hex');
      const key = storage.personalStickerKey({ alanyaID, sha256: pret.sha256, sel });
      const thumbKey = storage.personalStickerKey({ alanyaID, sha256: pret.sha256, sel, thumb: true });
      await storage.putBody(key, pret.webp, { contentType: 'image/webp' });
      deposes.push(key);
      await storage.putBody(thumbKey, pret.thumb, { contentType: 'image/webp' });
      deposes.push(thumbKey);
      await conn.execute(
        'UPDATE sticker_asset SET storage_key = ?, thumb_key = ? WHERE id = ?',
        [key, thumbKey, assetId],
      );
    }

    await conn.commit();
    return { assetId, stickerId: ins.insertId, packId: pack.id, reutilise, bytes: pret.bytes };
  } catch (e) {
    await conn.rollback().catch(() => {});
    for (const key of deposes) {
      await storage.removeAllVersions(key).catch(() => {});
    }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Copie un sticker reçu dans mon espace : nouveau propriétaire, nouveau fichier
 * (copie côté stockage), nouveau `sel`. L'actif source doit être actif ; un actif
 * que je possède déjà pour la même empreinte est réutilisé (aucune copie).
 *
 * @returns {Promise<{assetId, stickerId, packId, reutilise, copie: boolean}>}
 */
async function copierStickerPerso({ alanyaID, assetId, packId = null, emoji = null, nom = null }, db = pool) {
  const id = idPositif(assetId);
  const [src] = id ? await db.execute(
    `SELECT id, owner_id, sha256, storage_key, thumb_key, mime, width, height, bytes, animated, status
       FROM sticker_asset WHERE id = ? LIMIT 1`,
    [id],
  ) : [[]];
  const source = src[0];
  if (!source || Number(source.status) !== 0) throw introuvable();

  // Un retrait admin laisse l'empreinte dans la liste de blocage : on ne la
  // réintroduit pas sous une nouvelle identité.
  const [bloque] = await db.execute(
    'SELECT 1 FROM sticker_blocklist WHERE sha256 = ? LIMIT 1',
    [source.sha256],
  );
  if (bloque.length) throw refus('STICKER_ASSET_BLOCKED', 'Image bloquée', 422);

  const pack = await packCible(alanyaID, packId, db);
  await verifierPlafondPack(pack.id, db);

  const emojiPropre = emojiDe(emoji);
  const nameI18n = nomDe(nom);

  const conn = await connexionDe(db).getConnection();
  const deposes = [];
  try {
    await conn.beginTransaction();

    const [exist] = await conn.execute(
      'SELECT id FROM sticker_asset WHERE owner_id = ? AND sha256 = ? FOR UPDATE',
      [alanyaID, source.sha256],
    );
    let monAssetId;
    let reutilise = false;
    if (exist.length) {
      monAssetId = exist[0].id;
      reutilise = true;
    } else {
      const [r] = await conn.execute(
        `INSERT INTO sticker_asset (owner_id, sha256, storage_key, mime, width, height, bytes, animated)
         VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
        [alanyaID, source.sha256, source.mime || 'image/webp',
          source.width, source.height, source.bytes, Number(source.animated) === 1 ? 1 : 0],
      );
      monAssetId = r.insertId;
    }

    const [ins] = await conn.execute(
      `INSERT INTO sticker (pack_id, position, asset_id, emoji, name_i18n)
       SELECT ?, COALESCE(MAX(position), -1) + 1, ?, ?, ? FROM sticker WHERE pack_id = ?`,
      [pack.id, monAssetId, emojiPropre, nameI18n ? JSON.stringify(nameI18n) : null, pack.id],
    );

    if (!reutilise && source.storage_key) {
      const sel = crypto.randomBytes(8).toString('hex');
      const key = storage.personalStickerKey({ alanyaID, sha256: source.sha256, sel });
      await storage.copyObject(source.storage_key, key);
      deposes.push(key);
      let thumbKey = null;
      if (source.thumb_key) {
        thumbKey = storage.personalStickerKey({ alanyaID, sha256: source.sha256, sel, thumb: true });
        await storage.copyObject(source.thumb_key, thumbKey);
        deposes.push(thumbKey);
      }
      await conn.execute(
        'UPDATE sticker_asset SET storage_key = ?, thumb_key = ? WHERE id = ?',
        [key, thumbKey, monAssetId],
      );
    }

    await conn.commit();
    return { assetId: monAssetId, stickerId: ins.insertId, packId: pack.id, reutilise, copie: !reutilise };
  } catch (e) {
    await conn.rollback().catch(() => {});
    for (const key of deposes) {
      await storage.removeAllVersions(key).catch(() => {});
    }
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Supprime un actif personnel : ses stickers, ses favoris, ses signalements, sa
 * couverture éventuelle, la ligne, puis les fichiers (après le commit, pour ne
 * jamais laisser une ligne pointant vers un fichier absent).
 *
 * @returns {Promise<{assetId: number, stickers: number}>}
 */
async function supprimerAssetPerso(alanyaID, assetId, db = pool) {
  const id = idPositif(assetId);
  const conn = await connexionDe(db).getConnection();
  try {
    await conn.beginTransaction();
    const [a] = id ? await conn.execute(
      'SELECT id, storage_key, thumb_key FROM sticker_asset WHERE id = ? AND owner_id = ? FOR UPDATE',
      [id, alanyaID],
    ) : [[]];
    if (!a.length) throw introuvable();

    const [stk] = await conn.execute('SELECT id FROM sticker WHERE asset_id = ?', [id]);
    const ids = stk.map((s) => Number(s.id));
    if (ids.length) {
      const marques = ids.map(() => '?').join(', ');
      await conn.execute(`DELETE FROM user_sticker_favorite WHERE sticker_id IN (${marques})`, ids);
      await conn.execute(
        `UPDATE sticker_pack SET cover_sticker_id = NULL, version = version + 1
          WHERE cover_sticker_id IN (${marques})`,
        ids,
      );
    }
    await conn.execute('DELETE FROM sticker_report WHERE asset_id = ?', [id]);
    await conn.execute('DELETE FROM sticker WHERE asset_id = ?', [id]);
    await conn.execute('DELETE FROM sticker_asset WHERE id = ?', [id]);
    await conn.commit();

    if (a[0].storage_key) await storage.removeAllVersions(a[0].storage_key).catch(() => {});
    if (a[0].thumb_key) await storage.removeAllVersions(a[0].thumb_key).catch(() => {});
    return { assetId: id, stickers: ids.length };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Signale un sticker (via sa fiche). Idempotent pour un même rapporteur et un
 * même actif : un second signalement identique ne crée pas de doublon.
 *
 * @returns {Promise<{ok: true, deja: boolean}>}
 */
async function signalerSticker({ alanyaID, assetId, reason }, db = pool) {
  const id = idPositif(assetId);
  const [rows] = id ? await db.execute(
    'SELECT id, owner_id, status FROM sticker_asset WHERE id = ? LIMIT 1',
    [id],
  ) : [[]];
  const asset = rows[0];
  if (!asset || Number(asset.status) !== 0) throw introuvable();
  // On ne se signale pas soi-même : probable erreur de client.
  if (Number(asset.owner_id) === Number(alanyaID)) {
    throw refus('STICKER_INVALID_PAYLOAD', 'On ne signale pas son propre sticker');
  }
  const r = raisonDe(reason);
  if (r === null) throw refus('STICKER_INVALID_PAYLOAD', 'Motif de signalement inconnu');

  const [deja] = await db.execute(
    'SELECT id FROM sticker_report WHERE asset_id = ? AND reporter_id = ? AND status = 0 LIMIT 1',
    [id, alanyaID],
  );
  if (deja.length) return { ok: true, deja: true };

  await db.execute(
    'INSERT INTO sticker_report (asset_id, reporter_id, reason) VALUES (?, ?, ?)',
    [id, alanyaID, r],
  );
  return { ok: true, deja: false };
}

module.exports = {
  MAX_PACKS_PERSO,
  MAX_STICKERS_PACK,
  EMOJI_DEFAUT,
  VISIBILITE_PRIVE,
  VISIBILITE_LIEN,
  STATUT_PUBLIE,
  STATUT_ARCHIVE,
  RAISONS,
  StickerPersonalError,
  refus,
  introuvable,
  idPositif,
  connexionDe,
  emojiDe,
  nomDe,
  raisonDe,
  codePackPerso,
  chargePackPerso,
  creerPackPerso,
  packPersoParDefaut,
  creerStickerPerso,
  copierStickerPerso,
  supprimerAssetPerso,
  signalerSticker,
};
