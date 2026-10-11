/**
 * Gestion des packs PERSONNELS (V1b, plan §4 et §6.1) : renommer, archiver,
 * réordonner, ajouter/retirer un sticker, lister les miens, partager par lien.
 * Complète `stickerPersonalService` (dépôt, copie, suppression d'un actif).
 *
 * Décisions du SERVEUR, jamais du client :
 *   - propriétaire seul : chaque écriture verrouille le pack
 *     `WHERE id = ? AND owner_id = <JWT>` ; le pack d'un autre est « introuvable »
 *     (`STICKER_PACK_UNAVAILABLE` 404), jamais « interdit » — pas d'oracle ;
 *   - archiver (`DELETE /packs/:id`) : le pack passe à `status = 2`, perd son
 *     lien de partage, et ses stickers suivent la règle de suppression du plan §4
 *     (le sticker quitte le pack ; le fichier n'est supprimé que si plus aucun
 *     sticker du propriétaire ne le référence). Les anciens messages affichent
 *     « Sticker retiré » ;
 *   - partage : `share_token` = 24 caractères tirés de 18 octets aléatoires, le
 *     pack passe à `visibility = 2` ; révoquer remet `visibility = 1` et efface
 *     le jeton. Résoudre un jeton inconnu, révoqué ou d'un pack archivé répond
 *     toujours la même chose (`STICKER_PACK_UNAVAILABLE`) ;
 *   - installer un lien = COPIER (règle « copie » du plan §4) : un pack PRIVÉ du
 *     destinataire, des fichiers copiés côté stockage sous `stickers/u/<moi>/`
 *     avec un sel neuf (aucun octet ne passe par le serveur), `source_pack_id`
 *     pour l'idempotence (migration 098). L'auteur reste maître de ses fichiers :
 *     révoquer ou supprimer chez lui ne casse rien chez le destinataire ;
 *   - quotas du plan : 20 packs perso (archivés exclus), 200 stickers perso par
 *     compte, 40 par pack ; les images bloquées sont ignorées à la copie.
 *
 * Aucune règle de permission ici : les routes (`requireStickerCreation`) s'en
 * chargent. Les fonctions reçoivent leur `db` en dernier argument pour être
 * éprouvées sans MySQL (voir `stickerPack.test.js`).
 */

const crypto = require('crypto');
const pool = require('../config/db');
const storage = require('./mediaStorage');
const store = require('./stickerStore');
const { LIMITES } = require('../utils/stickerAsset');
const { lireObjet, SUPPORTED } = require('../utils/stickerI18n');
const {
  MAX_PACKS_PERSO, MAX_STICKERS_PACK, VISIBILITE_PRIVE, VISIBILITE_LIEN,
  STATUT_PUBLIE, STATUT_ARCHIVE, refus, introuvable, idPositif, connexionDe, emojiDe, nomDe,
  codePackPerso,
} = require('./stickerPersonalService');

/** Forme d'un jeton de partage : 18 octets → 24 caractères base64url. */
const JETON_RE = /^[A-Za-z0-9_-]{24}$/;
const NOM_MAX = 60;
/** Copies de fichiers lancées en parallèle (B2 : bornées, jamais 80 d'un coup). */
const COPIES_PARALLELES = 8;

const packIndisponible = () => refus('STICKER_PACK_UNAVAILABLE', 'Pack de stickers indisponible', 404);

/** Un jeton bien formé ? Sinon inutile d'interroger la base. */
const jetonValide = (t) => typeof t === 'string' && JETON_RE.test(t);

/** Tire un jeton de partage : 24 caractères, 144 bits. */
const nouveauJeton = () => crypto.randomBytes(18).toString('base64url');

/** `(?, ?, ?)` pour une liste. */
const marques = (liste) => liste.map(() => '?').join(', ');

/** Transaction : `fn(conn)` ; commit si elle rend, rollback si elle lève. */
async function enTransaction(db, fn) {
  const conn = await connexionDe(db).getConnection();
  try {
    await conn.beginTransaction();
    const r = await fn(conn);
    await conn.commit();
    return r;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Supprime des fichiers APRÈS le commit : une ligne ne pointe jamais vers un fichier absent. */
async function retirerFichiers(cles) {
  for (const cle of cles || []) {
    if (cle) await storage.removeAllVersions(cle).catch(() => {});
  }
}

/**
 * Verrouille un pack du compte (privé ou partagé). Le pack d'un autre, ou
 * inexistant, est `STICKER_PACK_UNAVAILABLE` : la propriété est vérifiée ici,
 * dans la requête, jamais en comparant après coup.
 */
async function verrouillerPack(conn, alanyaID, packId) {
  const id = idPositif(packId);
  const [rows] = id ? await conn.execute(
    `SELECT id, code, visibility, status, share_token, cover_sticker_id
       FROM sticker_pack
      WHERE id = ? AND owner_id = ? AND visibility IN (?, ?)
      LIMIT 1 FOR UPDATE`,
    [id, alanyaID, VISIBILITE_PRIVE, VISIBILITE_LIEN],
  ) : [[]];
  if (!rows[0]) throw packIndisponible();
  return rows[0];
}

/** Idem, mais le pack doit être actif (publié) : un pack archivé n'est plus modifiable. */
async function verrouillerPackActif(conn, alanyaID, packId) {
  const pack = await verrouillerPack(conn, alanyaID, packId);
  if (Number(pack.status) !== STATUT_PUBLIE) throw packIndisponible();
  return pack;
}

/**
 * Règle de suppression du plan §4, appliquée à des stickers d'UN propriétaire :
 * les stickers quittent leur pack (avec favoris et couverture) ; un actif que
 * plus aucun sticker ne référence est supprimé, lignes puis fichiers.
 *
 * @returns {Promise<{fichiers: string[], stickers: number, assets: number}>}
 *   `fichiers` : clés à effacer APRÈS le commit.
 */
async function purgerStickers(conn, alanyaID, stickerIds) {
  const ids = [...new Set(stickerIds.map(Number))];
  if (!ids.length) return { fichiers: [], stickers: 0, assets: 0 };

  const [lignes] = await conn.execute(
    `SELECT DISTINCT asset_id FROM sticker WHERE id IN (${marques(ids)})`,
    ids,
  );
  const assetIds = lignes.map((l) => Number(l.asset_id));

  await conn.execute(`DELETE FROM user_sticker_favorite WHERE sticker_id IN (${marques(ids)})`, ids);
  await conn.execute(
    `UPDATE sticker_pack SET cover_sticker_id = NULL, version = version + 1
      WHERE cover_sticker_id IN (${marques(ids)})`,
    ids,
  );
  await conn.execute(`DELETE FROM sticker WHERE id IN (${marques(ids)})`, ids);

  const fichiers = [];
  let assets = 0;
  if (assetIds.length) {
    // Orphelins seulement, et seulement les MIENS : jamais l'actif d'un autre,
    // jamais un actif officiel, même si une ligne y renvoyait par erreur.
    const [orphelins] = await conn.execute(
      `SELECT a.id, a.storage_key, a.thumb_key FROM sticker_asset a
        WHERE a.id IN (${marques(assetIds)}) AND a.owner_id = ?
          AND NOT EXISTS (SELECT 1 FROM sticker s WHERE s.asset_id = a.id)
        FOR UPDATE`,
      [...assetIds, alanyaID],
    );
    const orphIds = orphelins.map((o) => Number(o.id));
    if (orphIds.length) {
      await conn.execute(`DELETE FROM sticker_report WHERE asset_id IN (${marques(orphIds)})`, orphIds);
      await conn.execute(`DELETE FROM sticker_asset WHERE id IN (${marques(orphIds)})`, orphIds);
      for (const o of orphelins) fichiers.push(o.storage_key, o.thumb_key);
      assets = orphIds.length;
    }
  }
  return { fichiers: fichiers.filter(Boolean), stickers: ids.length, assets };
}

/** Compte des stickers d'un pack (plafond de 40). */
async function verifierPlafond(conn, packId) {
  const [[c]] = await conn.execute('SELECT COUNT(*) AS n FROM sticker WHERE pack_id = ?', [packId]);
  if (Number(c?.n) >= MAX_STICKERS_PACK) {
    throw refus('STICKER_PACK_LIMIT', `${MAX_STICKERS_PACK} stickers maximum par pack`, 409);
  }
}

const incrementerVersion = (conn, packId) => conn.execute(
  'UPDATE sticker_pack SET version = version + 1 WHERE id = ?',
  [packId],
);

// ── Nom et couverture ───────────────────────────────────────────────────────

/**
 * Nom localisé fourni par le client → objet propre `{fr?, en?, zh?}`, ou `null`
 * si rien d'exploitable. Clés hors `fr|en|zh` écartées, textes tronqués à 60.
 * Accepte `nameI18n` (objet) ou `name` (chaîne = français).
 */
function nomLocaliseDe({ nameI18n, name } = {}) {
  let brut = null;
  if (nameI18n !== undefined && nameI18n !== null) {
    if (typeof nameI18n !== 'object' || Array.isArray(nameI18n)) return null;
    brut = nameI18n;
  } else if (name !== undefined && name !== null) {
    if (typeof name !== 'string') return null;
    brut = { fr: name };
  } else {
    return undefined; // rien à changer
  }
  const propre = {};
  for (const langue of SUPPORTED) {
    const v = brut[langue];
    if (typeof v === 'string' && v.trim()) propre[langue] = v.trim().slice(0, NOM_MAX);
  }
  return Object.keys(propre).length ? propre : null;
}

/**
 * Renomme un pack perso et/ou change sa couverture.
 *
 * @param {object} patch  `{ nameI18n?|name?, coverStickerId? }` — `coverStickerId`
 *   = un sticker de CE pack, ou `null` pour revenir au premier.
 */
async function modifierPack(alanyaID, packId, patch = {}, db = pool) {
  const nom = nomLocaliseDe(patch);
  const aCouverture = Object.prototype.hasOwnProperty.call(patch, 'coverStickerId');
  if (nom === null) throw refus('STICKER_INVALID_PAYLOAD', 'Nom invalide (fr, en ou zh, texte non vide)');
  if (nom === undefined && !aCouverture) throw refus('STICKER_INVALID_PAYLOAD', 'Rien à modifier');

  let couverture = null;
  if (aCouverture && patch.coverStickerId !== null) {
    couverture = idPositif(patch.coverStickerId);
    if (!couverture) throw refus('STICKER_NOT_FOUND', 'Sticker introuvable', 404);
  }

  return enTransaction(db, async (conn) => {
    const pack = await verrouillerPackActif(conn, alanyaID, packId);
    if (couverture) {
      const [ok] = await conn.execute(
        `SELECT s.id FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
          WHERE s.id = ? AND s.pack_id = ? AND a.status = 0 LIMIT 1`,
        [couverture, pack.id],
      );
      if (!ok.length) throw introuvable();
    }
    const colonnes = [];
    const valeurs = [];
    if (nom !== undefined) { colonnes.push('name_i18n = ?'); valeurs.push(JSON.stringify(nom)); }
    if (aCouverture) { colonnes.push('cover_sticker_id = ?'); valeurs.push(couverture); }
    await conn.execute(
      `UPDATE sticker_pack SET ${colonnes.join(', ')}, version = version + 1 WHERE id = ?`,
      [...valeurs, pack.id],
    );
    return { id: Number(pack.id) };
  });
}

// ── Archivage ───────────────────────────────────────────────────────────────

/**
 * Archive un pack perso (propriétaire seul). Idempotent : un pack déjà archivé
 * répond comme un succès (`deja: true`). Ses stickers sont retirés (plan §4) ;
 * les fichiers orphelins sont supprimés après le commit.
 */
async function archiverPack(alanyaID, packId, db = pool) {
  const r = await enTransaction(db, async (conn) => {
    const pack = await verrouillerPack(conn, alanyaID, packId);
    if (Number(pack.status) === STATUT_ARCHIVE) return { id: Number(pack.id), deja: true, fichiers: [] };

    const [stk] = await conn.execute('SELECT id FROM sticker WHERE pack_id = ? FOR UPDATE', [pack.id]);
    const purge = await purgerStickers(conn, alanyaID, stk.map((s) => s.id));
    await conn.execute(
      `UPDATE sticker_pack
          SET status = ?, visibility = ?, share_token = NULL, cover_sticker_id = NULL,
              version = version + 1
        WHERE id = ?`,
      [STATUT_ARCHIVE, VISIBILITE_PRIVE, pack.id],
    );
    await conn.execute('DELETE FROM user_sticker_pack WHERE pack_id = ?', [pack.id]);
    return { id: Number(pack.id), deja: false, stickers: purge.stickers, fichiers: purge.fichiers };
  });
  await retirerFichiers(r.fichiers);
  return { id: r.id, deja: r.deja, stickers: r.stickers || 0 };
}

// ── Stickers d'un pack ──────────────────────────────────────────────────────

/**
 * Réordonne les stickers d'un pack perso : la position est l'index dans `ids`.
 * Les ids qui ne sont pas dans CE pack sont ignorés ; les stickers absents de la
 * liste passent après, dans leur ordre actuel.
 *
 * `UNIQUE (pack_id, position)` : on passe d'abord les positions en négatif (un
 * jeu de valeurs distinct de tout ce qui existe), puis on écrit les définitives.
 */
async function ordonnerStickers(alanyaID, packId, ids, db = pool) {
  return enTransaction(db, async (conn) => {
    const pack = await verrouillerPackActif(conn, alanyaID, packId);
    const [lignes] = await conn.execute(
      'SELECT id FROM sticker WHERE pack_id = ? ORDER BY position ASC, id ASC FOR UPDATE',
      [pack.id],
    );
    const presents = lignes.map((l) => Number(l.id));
    const voulus = [...new Set(ids.map(Number))].filter((id) => presents.includes(id));
    const ordre = [...voulus, ...presents.filter((id) => !voulus.includes(id))];

    await conn.execute('UPDATE sticker SET position = -position - 1 WHERE pack_id = ?', [pack.id]);
    for (let i = 0; i < ordre.length; i += 1) {
      await conn.execute(
        'UPDATE sticker SET position = ? WHERE id = ? AND pack_id = ?',
        [i, ordre[i], pack.id],
      );
    }
    await incrementerVersion(conn, pack.id);
    return { id: Number(pack.id), count: ordre.length };
  });
}

/**
 * Ajoute à un pack perso un actif que JE possède déjà (autre pack, ou actif
 * orphelin). Aucun fichier n'est copié : c'est le même actif, référencé deux fois.
 */
async function ajouterStickerAuPack(alanyaID, packId, { assetId, emoji = null, nom = null } = {}, db = pool) {
  const aid = idPositif(assetId);
  if (!aid) throw introuvable();
  const emojiPropre = emojiDe(emoji);
  const nameI18n = nomDe(nom);

  return enTransaction(db, async (conn) => {
    const pack = await verrouillerPackActif(conn, alanyaID, packId);
    // Verrou sur l'actif : un retrait concurrent (purge d'orphelin) attend.
    const [a] = await conn.execute(
      'SELECT id FROM sticker_asset WHERE id = ? AND owner_id = ? AND status = 0 FOR UPDATE',
      [aid, alanyaID],
    );
    if (!a.length) throw introuvable();
    await verifierPlafond(conn, pack.id);
    const [ins] = await conn.execute(
      `INSERT INTO sticker (pack_id, position, asset_id, emoji, name_i18n)
       SELECT ?, COALESCE(MAX(position), -1) + 1, ?, ?, ? FROM sticker WHERE pack_id = ?`,
      [pack.id, aid, emojiPropre, nameI18n ? JSON.stringify(nameI18n) : null, pack.id],
    );
    await incrementerVersion(conn, pack.id);
    return { stickerId: ins.insertId, packId: Number(pack.id), assetId: aid };
  });
}

/**
 * Retire un sticker d'un pack perso (règle §4). L'actif n'est supprimé, fichiers
 * compris, que si plus aucun de mes stickers ne le référence.
 */
async function retirerStickerDuPack(alanyaID, packId, stickerId, db = pool) {
  const sid = idPositif(stickerId);
  const r = await enTransaction(db, async (conn) => {
    const pack = await verrouillerPackActif(conn, alanyaID, packId);
    const [s] = sid ? await conn.execute(
      'SELECT id FROM sticker WHERE id = ? AND pack_id = ? FOR UPDATE',
      [sid, pack.id],
    ) : [[]];
    if (!s.length) throw introuvable();
    const purge = await purgerStickers(conn, alanyaID, [sid]);
    await incrementerVersion(conn, pack.id);
    return { packId: Number(pack.id), assets: purge.assets, fichiers: purge.fichiers };
  });
  await retirerFichiers(r.fichiers);
  return { packId: r.packId, assets: r.assets };
}

// ── Lecture de mes packs ────────────────────────────────────────────────────

/**
 * Mes packs perso actifs (privés ou partagés) avec leurs stickers : un seul
 * aller-retour pour l'écran « Mes packs ». Les stickers dont le fichier a été
 * retiré (`status ≠ 0`) n'apparaissent pas.
 */
async function listerMesPacks(alanyaID, db = pool) {
  const [packs] = await db.execute(
    `SELECT id, code, name_i18n, description_i18n, visibility, status, share_token,
            cover_sticker_id, version
       FROM sticker_pack
      WHERE owner_id = ? AND visibility IN (?, ?) AND status = ?
      ORDER BY sort_order ASC, id ASC`,
    [alanyaID, VISIBILITE_PRIVE, VISIBILITE_LIEN, STATUT_PUBLIE],
  );
  if (!packs.length) return { packs: [], stickers: [] };
  const ids = packs.map((p) => Number(p.id));
  const [stickers] = await db.execute(
    `SELECT s.pack_id, s.id, s.position, s.emoji, s.name_i18n, s.asset_id,
            a.storage_key, a.thumb_key, a.width, a.height, a.bytes, a.animated
       FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
      WHERE s.pack_id IN (${marques(ids)}) AND a.status = 0
      ORDER BY s.pack_id ASC, s.position ASC`,
    ids,
  );
  return { packs, stickers };
}

// ── Partage par lien ────────────────────────────────────────────────────────

/**
 * Crée le lien de partage d'un pack perso. Idempotent : un pack déjà partagé
 * rend son jeton (aucune rotation — révoquer puis repartager en crée un neuf).
 * Un pack vide ne se partage pas.
 *
 * @returns {Promise<{token: string, cree: boolean}>}
 */
async function partagerPack(alanyaID, packId, db = pool) {
  return enTransaction(db, async (conn) => {
    const pack = await verrouillerPackActif(conn, alanyaID, packId);
    if (pack.share_token) return { token: pack.share_token, cree: false };

    const [[c]] = await conn.execute(
      `SELECT COUNT(*) AS n FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
        WHERE s.pack_id = ? AND a.status = 0`,
      [pack.id],
    );
    if (!Number(c?.n)) throw refus('STICKER_INVALID_PAYLOAD', 'Un pack vide ne se partage pas', 400);

    for (let essai = 0; essai < 5; essai += 1) {
      const token = nouveauJeton();
      try {
        await conn.execute(
          'UPDATE sticker_pack SET share_token = ?, visibility = ? WHERE id = ?',
          [token, VISIBILITE_LIEN, pack.id],
        );
        return { token, cree: true };
      } catch (e) {
        if (e.code !== 'ER_DUP_ENTRY') throw e;
      }
    }
    throw refus('STICKER_INVALID_PAYLOAD', 'Impossible de générer un lien de partage', 500);
  });
}

/** Révoque le lien : le jeton disparaît, le pack redevient privé. Idempotent. */
async function revoquerPartage(alanyaID, packId, db = pool) {
  return enTransaction(db, async (conn) => {
    const pack = await verrouillerPack(conn, alanyaID, packId);
    if (pack.share_token || Number(pack.visibility) === VISIBILITE_LIEN) {
      await conn.execute(
        'UPDATE sticker_pack SET share_token = NULL, visibility = ? WHERE id = ?',
        [VISIBILITE_PRIVE, pack.id],
      );
    }
    return { id: Number(pack.id) };
  });
}

/**
 * Le pack derrière un jeton : partagé (`visibility = 2`), publié, jeton exact.
 * Jeton mal formé, inconnu, révoqué ou pack archivé : même `null`.
 * `addedPackId` = ma copie de ce pack, si je l'ai déjà installé.
 */
async function packParJeton(conn, alanyaID, token, { verrou = false } = {}) {
  if (!jetonValide(token)) return null;
  const [rows] = await conn.execute(
    `SELECT p.id, p.code, p.name_i18n, p.description_i18n, p.owner_id, p.version,
            p.cover_sticker_id,
            (SELECT c.id FROM sticker_pack c
              WHERE c.owner_id = ? AND c.source_pack_id = p.id AND c.status = ?
              ORDER BY c.id ASC LIMIT 1) AS added_pack_id
       FROM sticker_pack p
      WHERE p.share_token = ? AND p.visibility = ? AND p.status = ?
      LIMIT 1${verrou ? ' FOR UPDATE' : ''}`,
    [alanyaID, STATUT_PUBLIE, token, VISIBILITE_LIEN, STATUT_PUBLIE],
  );
  return rows[0] || null;
}

/** Résout un lien (lecture) : le pack, ses stickers actifs, et mon état d'installation. */
async function resoudrePartage(alanyaID, token, db = pool) {
  const pack = await packParJeton(db, alanyaID, token);
  if (!pack) throw packIndisponible();
  const stickers = await store.listeStickersDuPack(pack.id, db);
  return {
    pack,
    stickers,
    mine: Number(pack.owner_id) === Number(alanyaID),
    addedPackId: pack.added_pack_id == null ? null : Number(pack.added_pack_id),
  };
}

/**
 * Aperçu PUBLIC d'un lien (page `GET /s/:token`, sans compte) : le nom i18n et
 * le nombre de stickers actifs, RIEN d'autre — ni identifiant de compte, ni
 * fichier, ni code de pack. Jeton mal formé, inconnu, révoqué, pack archivé ou
 * sans sticker actif : même `null`.
 *
 * @returns {Promise<{nameI18n: *, count: number}|null>}
 */
async function apercuPartagePublic(token, db = pool) {
  if (!jetonValide(token)) return null;
  const [rows] = await db.execute(
    `SELECT p.name_i18n,
            (SELECT COUNT(*) FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
              WHERE s.pack_id = p.id AND a.status = 0) AS count
       FROM sticker_pack p
      WHERE p.share_token = ? AND p.visibility = ? AND p.status = ?
      LIMIT 1`,
    [token, VISIBILITE_LIEN, STATUT_PUBLIE],
  );
  const r = rows[0];
  if (!r || !Number(r.count)) return null;
  return { nameI18n: r.name_i18n, count: Number(r.count) };
}

/**
 * Installe un pack partagé chez moi : COPIE (plan §4). Voir l'en-tête du module.
 *
 * @returns {Promise<{packId: number, code?: string, deja: boolean, mine?: boolean,
 *   stickers?: number, ignores?: number}>}
 *   `deja: true` : rien de nouveau (c'est mon propre pack, ou déjà installé).
 */
async function ajouterPackPartage(alanyaID, token, db = pool) {
  if (!jetonValide(token)) throw packIndisponible();
  const deposes = [];
  try {
    return await enTransaction(db, async (conn) => {
      // 1. Le pack source, verrouillé : deux « ajouter » simultanés se suivent,
      //    et un lien révoqué entre-temps n'est plus résolu.
      const source = await packParJeton(conn, alanyaID, token, { verrou: true });
      if (!source) throw packIndisponible();
      if (Number(source.owner_id) === Number(alanyaID)) {
        return { packId: Number(source.id), deja: true, mine: true };
      }
      if (source.added_pack_id != null) {
        return { packId: Number(source.added_pack_id), deja: true };
      }

      // 2. Quota de packs : on verrouille MES packs, ce qui sérialise aussi deux
      //    installations de liens différents lancées en même temps.
      const [miens] = await conn.execute(
        'SELECT id FROM sticker_pack WHERE owner_id = ? AND status <> ? FOR UPDATE',
        [alanyaID, STATUT_ARCHIVE],
      );
      if (miens.length >= MAX_PACKS_PERSO) {
        throw refus('STICKER_PACK_LIMIT', `${MAX_PACKS_PERSO} packs personnels maximum`, 409);
      }

      // 3. Les stickers copiables : actifs, fichier posé, empreinte non bloquée.
      const [lus] = await conn.execute(
        `SELECT s.id, s.emoji, s.name_i18n, s.position, a.sha256, a.storage_key, a.thumb_key,
                a.mime, a.width, a.height, a.bytes, a.animated
           FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
          WHERE s.pack_id = ? AND a.status = 0 AND a.storage_key <> 'pending'
            AND NOT EXISTS (SELECT 1 FROM sticker_blocklist b WHERE b.sha256 = a.sha256)
          ORDER BY s.position ASC, s.id ASC
          LIMIT ${MAX_STICKERS_PACK}`,
        [source.id],
      );
      if (!lus.length) throw packIndisponible();
      const [[tot]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM sticker WHERE pack_id = ?',
        [source.id],
      );
      const ignores = Math.max(0, Number(tot?.n || 0) - lus.length);

      // 4. Quota de stickers : seuls les actifs que je n'ai pas encore comptent.
      const shas = [...new Set(lus.map((s) => s.sha256))];
      const [deja] = await conn.execute(
        `SELECT id, sha256 FROM sticker_asset
          WHERE owner_id = ? AND status = 0 AND sha256 IN (${marques(shas)}) FOR UPDATE`,
        [alanyaID, ...shas],
      );
      const [[actifs]] = await conn.execute(
        'SELECT COUNT(*) AS n FROM sticker_asset WHERE owner_id = ? AND status = 0',
        [alanyaID],
      );
      const miensParSha = new Map(deja.map((d) => [d.sha256, Number(d.id)]));
      const nouveaux = shas.filter((h) => !miensParSha.has(h)).length;
      if (Number(actifs?.n || 0) + nouveaux > LIMITES.ASSETS_PAR_COMPTE) {
        throw refus(
          'STICKER_QUOTA_EXCEEDED',
          `${LIMITES.ASSETS_PAR_COMPTE} stickers personnels maximum`,
          429,
        );
      }

      // 5. Le pack : privé, publié, à moi, avec la mémoire de sa source.
      const nomSource = lireObjet(source.name_i18n);
      const nom = Object.keys(nomSource).length ? nomSource : { fr: 'Mes stickers' };
      let packId = null;
      let code = null;
      for (let essai = 0; essai < 5 && packId === null; essai += 1) {
        code = codePackPerso(alanyaID);
        try {
          const [r] = await conn.execute(
            `INSERT INTO sticker_pack
               (code, owner_id, name_i18n, visibility, status, sort_order, created_by, source_pack_id)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
            [code, alanyaID, JSON.stringify(nom), VISIBILITE_PRIVE, STATUT_PUBLIE, alanyaID, source.id],
          );
          packId = r.insertId;
        } catch (e) {
          if (e.code !== 'ER_DUP_ENTRY') throw e;
        }
      }
      if (packId === null) throw refus('STICKER_INVALID_PAYLOAD', 'Impossible de générer un code de pack', 500);

      // 6. Un actif à moi par empreinte (nouveau, ou déjà possédé), un sticker
      //    par ligne source. Les copies de fichiers sont décidées ici, faites
      //    ensuite (parallèles, bornées).
      const aCopier = []; // { assetId, src, dst, srcThumb, dstThumb }
      const nouveauxParSha = new Map();
      const idsCrees = new Map(); // id du sticker source → id de ma copie
      let position = 0;
      for (const s of lus) {
        let monAsset = miensParSha.get(s.sha256) ?? nouveauxParSha.get(s.sha256);
        if (monAsset === undefined) {
          const [ins] = await conn.execute(
            `INSERT INTO sticker_asset (owner_id, sha256, storage_key, mime, width, height, bytes, animated)
             VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
            [alanyaID, s.sha256, s.mime || 'image/webp', s.width, s.height, s.bytes,
              Number(s.animated) === 1 ? 1 : 0],
          );
          monAsset = ins.insertId;
          nouveauxParSha.set(s.sha256, monAsset);
          const sel = crypto.randomBytes(8).toString('hex');
          aCopier.push({
            assetId: monAsset,
            src: s.storage_key,
            dst: storage.personalStickerKey({ alanyaID, sha256: s.sha256, sel }),
            srcThumb: s.thumb_key || null,
            dstThumb: s.thumb_key
              ? storage.personalStickerKey({ alanyaID, sha256: s.sha256, sel, thumb: true })
              : null,
          });
        }
        const [st] = await conn.execute(
          'INSERT INTO sticker (pack_id, position, asset_id, emoji, name_i18n) VALUES (?, ?, ?, ?, ?)',
          [packId, position, monAsset, emojiDe(s.emoji),
            s.name_i18n ? JSON.stringify(lireObjet(s.name_i18n)) : null],
        );
        idsCrees.set(Number(s.id), st.insertId);
        position += 1;
      }

      // 7. Copies côté stockage (aucun octet ne passe par le serveur), puis les
      //    clés écrites sur les actifs. Le moindre échec annule tout.
      for (let i = 0; i < aCopier.length; i += COPIES_PARALLELES) {
        const lot = aCopier.slice(i, i + COPIES_PARALLELES);
        await Promise.all(lot.map(async (c) => {
          deposes.push(c.dst);
          await storage.copyObject(c.src, c.dst);
          if (c.srcThumb && c.dstThumb) {
            deposes.push(c.dstThumb);
            await storage.copyObject(c.srcThumb, c.dstThumb);
          }
        }));
      }
      for (const c of aCopier) {
        await conn.execute(
          'UPDATE sticker_asset SET storage_key = ?, thumb_key = ? WHERE id = ?',
          [c.dst, c.dstThumb, c.assetId],
        );
      }

      // 8. Couverture : l'équivalent de celle de la source, si elle a été copiée.
      const couverture = idsCrees.get(Number(source.cover_sticker_id));
      if (couverture) {
        await conn.execute('UPDATE sticker_pack SET cover_sticker_id = ? WHERE id = ?', [couverture, packId]);
      }

      return { packId, code, deja: false, stickers: lus.length, ignores };
    });
  } catch (e) {
    // La transaction est annulée : les fichiers déjà copiés n'ont plus de ligne.
    await retirerFichiers(deposes);
    throw e;
  }
}

module.exports = {
  JETON_RE,
  COPIES_PARALLELES,
  jetonValide,
  nouveauJeton,
  nomLocaliseDe,
  modifierPack,
  archiverPack,
  ordonnerStickers,
  ajouterStickerAuPack,
  retirerStickerDuPack,
  listerMesPacks,
  partagerPack,
  revoquerPartage,
  resoudrePartage,
  apercuPartagePublic,
  ajouterPackPartage,
};
