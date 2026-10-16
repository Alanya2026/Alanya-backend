/**
 * Ménage du coffre-fort. MEGA S4 n'a pas de cycle de vie (501 au test du
 * 14/10/2026) : rien ne s'efface de son côté, tout passe par ici.
 *
 * Trois étapes, dans cet ordre :
 *   1. la corbeille au-delà de sa durée (lignes supprimées) ;
 *   2. les envois abandonnés, sans nouveau bloc depuis `abandonHours` ;
 *   3. les blobs orphelins — plus aucun fichier ne les désigne — supprimés
 *      chez MEGA puis en base. C'est la seule étape qui touche MEGA : les deux
 *      premières, la suppression d'un compte (cascade) et « Vider la
 *      corbeille » ne font que rendre des blobs orphelins.
 *
 * Garde-fou : un passage automatique qui trouverait plus de `alertFloor`
 * blobs orphelins s'arrête avant de rien supprimer chez MEGA et échoue, ce
 * qui le rend visible dans Admin › Purges. Le lancer à la main vaut
 * confirmation.
 *
 * S'y ajoutent deux ménages : les traces de téléchargement de fichiers
 * partagés (plus de 31 jours : l'admin les compte sur 30), et, une fois par semaine, le rapprochement
 * entre MEGA et la base — des objets restés chez MEGA sans ligne
 * `safebox_blob` (une suppression interrompue, par exemple). Seuls les objets
 * de plus de deux jours partent, et le même seuil d'arrêt s'applique.
 */

const pool = require('../../config/db');
const { defaultStorage } = require('./storage');

const LOT = 1000;

/** Supprime par lots, pour ne pas tenir de gros verrous. */
async function parLots(db, sql, params) {
  let total = 0;
  for (;;) {
    const [r] = await db.query(`${sql} LIMIT ${LOT}`, params);
    total += r.affectedRows;
    if (r.affectedRows < LOT) return total;
  }
}

/** Étape 1 : la corbeille au-delà de `trashDays` jours. */
async function expireTrash(db, { trashDays }) {
  const fichiers = await parLots(db,
    `DELETE FROM safebox_file
      WHERE trashed_at IS NOT NULL AND trashed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [trashDays]);
  // Les sous-dossiers mis à la corbeille avec un dossier partent avec lui (cascade).
  const dossiers = await parLots(db,
    `DELETE FROM safebox_folder
      WHERE trashed_at IS NOT NULL AND trashed_by_folder IS NULL
        AND trashed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [trashDays]);
  return { fichiers, dossiers };
}

/** Étape 2 : les envois sans nouveau signe depuis `abandonHours` heures. */
async function expireAbandoned(db, { abandonHours }) {
  const [r] = await db.query(
    `DELETE f FROM safebox_file f
       JOIN safebox_blob b ON b.id = f.blob_id
      WHERE b.status = 'pending'
        AND b.activity_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [abandonHours],
  );
  return r.affectedRows;
}

const ORPHELIN = `(b.status = 'deleting'
  OR NOT EXISTS (SELECT 1 FROM safebox_file f WHERE f.blob_id = b.id))`;

async function countOrphans(db) {
  const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM safebox_blob b WHERE ${ORPHELIN}`);
  return Number(r.n) || 0;
}

/**
 * Marque un blob « deleting » s'il est toujours orphelin. Le blob est
 * verrouillé et la recherche de fichiers est une lecture verrouillante : un
 * « Enregistrer dans mon coffre » (lot 3) qui verrouille aussi le blob passe
 * soit avant (le blob n'est plus orphelin), soit après (il voit « deleting »
 * et refuse). Sans cela, une copie pourrait désigner des blocs en cours de
 * suppression.
 */
async function markIfOrphan(db, id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[blob]] = await conn.query('SELECT status FROM safebox_blob WHERE id = ? FOR UPDATE', [id]);
    if (!blob) { await conn.rollback(); return false; }
    if (blob.status !== 'deleting') {
      const [ref] = await conn.query('SELECT 1 FROM safebox_file WHERE blob_id = ? LIMIT 1 FOR SHARE', [id]);
      if (ref.length) { await conn.rollback(); return false; }
      await conn.query("UPDATE safebox_blob SET status = 'deleting' WHERE id = ?", [id]);
    }
    await conn.commit();
    return true;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Étape 3 : supprime chez MEGA puis en base les blobs orphelins (ceux de
 * `blobIds` seulement, si la liste est donnée). Un échec chez MEGA laisse le
 * blob « deleting » : le passage suivant le reprend.
 */
async function collectOrphans(db, storage, { blobIds = null, limit = 10_000 } = {}) {
  const filtre = blobIds ? 'AND b.id IN (?)' : '';
  if (blobIds && !blobIds.length) return { supprimes: 0, echecs: 0 };
  const [candidats] = await db.query(
    `SELECT b.id, b.prefix FROM safebox_blob b WHERE ${ORPHELIN} ${filtre} ORDER BY b.id LIMIT ${Number(limit)}`,
    blobIds ? [blobIds] : [],
  );
  let supprimes = 0;
  let echecs = 0;
  for (const { id, prefix } of candidats) {
    try {
      if (!(await markIfOrphan(db, id))) continue;
      await storage.removePrefix(prefix);
      await db.query("DELETE FROM safebox_blob WHERE id = ? AND status = 'deleting'", [id]);
      supprimes += 1;
    } catch (e) {
      echecs += 1;
      console.error(`[Coffre] blob ${id} (${prefix}) non supprimé :`, e.message);
    }
  }
  return { supprimes, echecs };
}

const RAPPROCHEMENT_JOURS = 7;
const RAPPROCHEMENT_AGE_MS = 2 * 24 * 60 * 60 * 1000;

/** Préfixe de blob d'un objet : `u/<empreinte>/<uuid>/`, ou null. */
function prefixeDe(key) {
  const m = /^(u\/[^/]+\/[^/]+\/)/.exec(key);
  return m ? m[1] : null;
}

/**
 * Objets de plus de deux jours dont le blob n'existe pas en base. Parcourt le
 * bucket page par page. Lève, sans rien supprimer, si un passage automatique
 * en trouve plus que `alertFloor`.
 */
async function reconcile(db, storage, { alertFloor, trigger = 'auto', now = new Date() }) {
  const orphelins = [];
  let jeton;
  do {
    const page = await storage.listPage('u/', jeton);
    jeton = page.next;
    const prefixes = [...new Set(page.objects.map((o) => prefixeDe(o.key)).filter(Boolean))];
    if (!prefixes.length) continue;
    const [connus] = await db.query('SELECT prefix FROM safebox_blob WHERE prefix IN (?)', [prefixes]);
    const enBase = new Set(connus.map((r) => r.prefix));
    for (const o of page.objects) {
      const pre = prefixeDe(o.key);
      if (!pre || enBase.has(pre)) continue;
      if (o.lastModified && now - o.lastModified < RAPPROCHEMENT_AGE_MS) continue;
      orphelins.push(o.key);
    }
  } while (jeton);
  if (trigger !== 'manual' && orphelins.length > alertFloor) {
    throw new Error(
      `${orphelins.length} objets chez MEGA sans fichier en base, au-delà du seuil de ${alertFloor} : `
      + 'rien n\'a été supprimé. Vérifier, puis lancer la purge à la main pour confirmer.',
    );
  }
  if (orphelins.length) await storage.removeKeys(orphelins);
  return orphelins.length;
}

/** Rapprochement s'il n'a pas eu lieu depuis une semaine ; null sinon. */
async function reconcileIfDue(db, storage, opts) {
  let derniere;
  try {
    [[derniere]] = await db.query('SELECT last_reconcile_at FROM safebox_settings WHERE id = 1');
  } catch (e) {
    if (e.code === 'ER_BAD_FIELD_ERROR' || e.code === 'ER_NO_SUCH_TABLE') return null; // migration 102 absente
    throw e;
  }
  const quand = derniere?.last_reconcile_at ? new Date(derniere.last_reconcile_at) : null;
  if (opts.trigger !== 'manual' && quand && Date.now() - quand.getTime() < RAPPROCHEMENT_JOURS * 86_400_000) return null;
  const n = await reconcile(db, storage, opts);
  await db.query('UPDATE safebox_settings SET last_reconcile_at = NOW() WHERE id = 1');
  return n;
}

/** Ce que la purge ferait maintenant, pour la page Admin › Purges. */
async function purgeStats(opts, { db = pool } = {}) {
  const [[corbeille]] = await db.query(
    `SELECT COUNT(*) AS n FROM safebox_file
      WHERE trashed_at IS NOT NULL AND trashed_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [opts.trashDays],
  );
  const [[abandons]] = await db.query(
    `SELECT COUNT(*) AS n FROM safebox_blob
      WHERE status = 'pending' AND activity_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [opts.abandonHours],
  );
  const [[total]] = await db.query(
    `SELECT COUNT(*) AS blobs, COALESCE(SUM(stored_bytes + preview_bytes), 0) AS octets
       FROM safebox_blob WHERE status = 'ready'`,
  );
  return {
    corbeilleEchue: Number(corbeille.n) || 0,
    envoisAbandonnes: Number(abandons.n) || 0,
    orphelins: await countOrphans(db),
    blobsStockes: Number(total.blobs) || 0,
    octetsStockes: Number(total.octets) || 0,
  };
}

/** Exécution, appelée par le registre des purges (`purgeRegistry.js`). */
async function runSafeboxPurge(opts, { trigger = 'auto', db = pool, storage = defaultStorage() } = {}) {
  if (!storage) {
    // Coffre pas encore configuré sur ce serveur : rien n'a pu être déposé.
    return { ignore: 'MEGA S4 non configuré' };
  }
  let corbeille;
  try {
    corbeille = await expireTrash(db, opts);
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return { ignore: 'migration 101 non appliquée' };
    throw e;
  }
  const abandons = await expireAbandoned(db, opts);
  const orphelins = await countOrphans(db);
  if (trigger !== 'manual' && orphelins > opts.alertFloor) {
    throw new Error(
      `${orphelins} blobs orphelins à supprimer chez MEGA, au-delà du seuil de ${opts.alertFloor} : `
      + 'rien n\'a été supprimé chez MEGA. Vérifier, puis lancer la purge à la main pour confirmer.',
    );
  }
  const ramassage = await collectOrphans(db, storage);
  let telechargements = 0;
  try {
    const [r] = await db.query('DELETE FROM safebox_share_download WHERE created_at < DATE_SUB(NOW(), INTERVAL 31 DAY)');
    telechargements = r.affectedRows;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e; // migration 102 absente
  }
  const rapproches = await reconcileIfDue(db, storage, { alertFloor: opts.alertFloor, trigger });
  return { corbeille, abandons, orphelins, ...ramassage, telechargements, rapproches };
}

module.exports = {
  reconcile,
  reconcileIfDue,
  prefixeDe,
  expireTrash,
  expireAbandoned,
  countOrphans,
  collectOrphans,
  purgeStats,
  runSafeboxPurge,
};
