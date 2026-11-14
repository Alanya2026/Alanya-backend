/** Filtres et tri partagés entre GET /users et GET /users/export. */

const ALLOWED_SORT = {
  created_at: 'u.created_at',
  nom: 'u.nom',
  last_seen: 'up.last_seen',
  // Les comptes sans sauvegarde d'abord en ordre croissant : ce sont eux qu'on
  // cherche. `NULL` trie avant tout en MySQL, ce qui tombe juste ici.
  backup_last_at: 'u.backup_last_at',
};

/**
 * Au-delà, une sauvegarde est considérée comme périmée.
 *
 * Trente jours, comme la rétention des médias sur le serveur : passé ce délai,
 * une restauration ne ramènerait de toute façon plus les photos et vidéos. Les
 * deux durées disent la même chose et n'ont aucune raison de diverger.
 */
const BACKUP_STALE_DAYS = 30;

function buildUsersWhere(query) {
  const {
    search = '',
    status = '',
    from = '',
    to = '',
    idPays = '',
  } = query;

  const where = [];
  const params = [];

  if (search) {
    // L'alanyaID cherche comme le reste : le champ est numérique, mais un
    // `LIKE` sur sa forme texte évite à l'appelant de savoir s'il tient un ID
    // ou un nom. Les deux se cherchent au même endroit.
    where.push('(u.nom LIKE ? OR u.pseudo LIKE ? OR u.alanyaPhone LIKE ? OR CAST(u.alanyaID AS CHAR) LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  // Liste explicite d'alanyaID : résout les comptes d'une sélection (cohorte
  // E2EE) en une requête, sans boucler sur GET /users/:id.
  if (query.ids != null && query.ids !== '') {
    const ids = [
      ...new Set(
        String(query.ids)
          .split(',')
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ].slice(0, 500);
    if (ids.length) {
      where.push(`u.alanyaID IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
  }
  if (status === 'online') { where.push('up.is_online = ?'); params.push(1); }
  if (status === 'banned') { where.push('u.exclus = ?'); params.push(1); }
  if (status === 'admin') { where.push('u.type_compte >= ?'); params.push(1); }
  if (query.account_type != null && query.account_type !== '') {
    where.push('u.account_type = ?');
    params.push(Number(query.account_type));
  }
  if (query.type_compte != null && query.type_compte !== '') {
    where.push('u.type_compte = ?');
    params.push(Number(query.type_compte));
  }
  if (from) { where.push('u.created_at >= ?'); params.push(from); }
  if (to) { where.push('u.created_at <= ?'); params.push(to); }
  if (idPays) { where.push('u.idPays = ?'); params.push(idPays); }

  // État de sauvegarde. `never` est la question la plus utile du lot : ces
  // comptes perdront tout au changement de téléphone, et rien ne le signale
  // aujourd'hui.
  const backup = String(query.backup || '');
  if (backup === 'never') {
    where.push('u.backup_last_at IS NULL');
  } else if (backup === 'stale') {
    where.push(
      `u.backup_last_at IS NOT NULL
       AND u.backup_last_at < DATE_SUB(NOW(), INTERVAL ${BACKUP_STALE_DAYS} DAY)`,
    );
  } else if (backup === 'recent') {
    where.push(
      `u.backup_last_at >= DATE_SUB(NOW(), INTERVAL ${BACKUP_STALE_DAYS} DAY)`,
    );
  }

  const sort = query.sort || 'created_at';
  const order = query.order || 'desc';
  const sortCol = ALLOWED_SORT[sort] || ALLOWED_SORT.created_at;
  const dir = String(order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return { whereSql, params, sortCol, dir };
}

/** `all` ou vide → pas de plafond ; sinon entier positif. */
function parseExportLimit(limitParam) {
  if (limitParam == null || limitParam === '' || String(limitParam).toLowerCase() === 'all') {
    return null;
  }
  const n = parseInt(limitParam, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}

const USERS_SELECT = `
  SELECT u.alanyaID, u.nom, u.pseudo, u.alanyaPhone, u.email, u.avatar_url,
         u.type_compte, u.account_type, u.verification_status, u.verified_until,
         up.is_online AS is_online, up.last_seen AS last_seen, u.exclus, u.exclude_at,
         u.exclude_reason, u.created_at, u.idPays, p.libelle AS pays_libelle,
         u.backup_last_at, u.backup_bytes, u.backup_message_count
  FROM users u
  LEFT JOIN pays p ON u.idPays = p.idPays
  LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
`;

async function fetchUsersForExport(pool, query, exportLimit) {
  const { whereSql, params, sortCol, dir } = buildUsersWhere(query);

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM users u
     LEFT JOIN user_presence up ON up.alanyaID = u.alanyaID
     ${whereSql}`,
    params,
  );

  const limitClause = exportLimit != null ? `LIMIT ${exportLimit}` : '';
  const [items] = await pool.execute(
    `${USERS_SELECT}
     ${whereSql}
     ORDER BY ${sortCol} ${dir}
     ${limitClause}`,
    params,
  );

  return { items, total, exported: items.length };
}

module.exports = {
  BACKUP_STALE_DAYS,
  buildUsersWhere,
  parseExportLimit,
  fetchUsersForExport,
  ALLOWED_SORT,
};
