/**
 * Catalogue de l'offre : fonctionnalités et plans.
 *
 * Lectures en cache 30 s — le catalogue est lu à chaque calcul de droits, il
 * change rarement. Toute écriture invalide le cache de l'instance.
 */

const pool = require('../../config/db');
const { BillingError } = require('./errors');

const TTL_MS = 30_000;
let _features = null;
const _planFeatures = new Map();

function invalidateCatalog() {
  _features = null;
  _planFeatures.clear();
}

/** mysql2 rend les colonnes JSON déjà décodées ; on tolère la chaîne. */
const json = (v) => {
  if (v == null || typeof v === 'object') return v ?? null;
  try { return JSON.parse(v); } catch { return null; }
};

async function listFeatures() {
  if (_features && Date.now() - _features.at < TTL_MS) return _features.rows;
  const [rows] = await pool.execute(
    `SELECT code, name_i18n, description_i18n, is_paid, is_available, sort_order
       FROM feature ORDER BY sort_order ASC, code ASC`,
  );
  const clean = rows.map((r) => ({
    ...r,
    name_i18n: json(r.name_i18n),
    description_i18n: json(r.description_i18n),
    is_paid: Number(r.is_paid),
    is_available: Number(r.is_available),
  }));
  _features = { at: Date.now(), rows: clean };
  return clean;
}

async function featuresOfPlan(planId) {
  const hit = _planFeatures.get(Number(planId));
  if (hit && Date.now() - hit.at < TTL_MS) return hit.codes;
  const [rows] = await pool.execute(
    'SELECT feature_code FROM plan_feature WHERE plan_id = ?',
    [planId],
  );
  const codes = rows.map((r) => r.feature_code);
  _planFeatures.set(Number(planId), { at: Date.now(), codes });
  return codes;
}

/** Plans avec leurs fonctionnalités, dans l'ordre d'affichage. */
async function listPlans({ activeOnly = false } = {}) {
  const [plans] = await pool.execute(
    `SELECT * FROM plan ${activeOnly ? 'WHERE is_active = 1' : ''}
      ORDER BY sort_order ASC, id ASC`,
  );
  if (!plans.length) return [];
  const [links] = await pool.query(
    'SELECT plan_id, feature_code FROM plan_feature WHERE plan_id IN (?)',
    [plans.map((p) => p.id)],
  );
  return plans.map((p) => ({
    ...p,
    name_i18n: json(p.name_i18n),
    is_active: Number(p.is_active),
    is_featured: Number(p.is_featured),
    features: links.filter((l) => l.plan_id === p.id).map((l) => l.feature_code),
  }));
}

async function getPlan(id) {
  const [[plan]] = await pool.execute('SELECT * FROM plan WHERE id = ?', [id]);
  return plan ? { ...plan, name_i18n: json(plan.name_i18n) } : null;
}

/** Refuse un code de fonctionnalité inconnu du catalogue. */
async function assertKnownFeatures(codes) {
  if (!codes) return;
  const known = new Set((await listFeatures()).map((f) => f.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new BillingError('FEATURE_NOT_FOUND', 400, `Fonctionnalité inconnue : ${unknown.join(', ')}`);
  }
}

const PLAN_COLUMNS = [
  'code', 'name_i18n', 'duration_months', 'price_amount', 'currency', 'reminder_days',
  'is_active', 'is_featured', 'sort_order', 'store_product_ios', 'store_product_android',
  // Espace du coffre-fort (migration 103) : à appliquer avant d'écrire cette colonne.
  'safebox_bytes',
];

const columnValue = (key, v) => (key === 'name_i18n' ? JSON.stringify(v) : v);

async function replacePlanFeatures(conn, planId, codes) {
  await conn.execute('DELETE FROM plan_feature WHERE plan_id = ?', [planId]);
  if (codes.length) {
    await conn.query(
      'INSERT INTO plan_feature (plan_id, feature_code) VALUES ?',
      [codes.map((c) => [planId, c])],
    );
  }
}

async function createPlan(value, adminId) {
  await assertKnownFeatures(value.features);
  const cols = PLAN_COLUMNS.filter((k) => value[k] !== undefined);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.execute(
      `INSERT INTO plan (${cols.join(', ')}, updated_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`,
      [...cols.map((k) => columnValue(k, value[k])), adminId],
    );
    if (value.features) await replacePlanFeatures(conn, res.insertId, value.features);
    await conn.commit();
    return res.insertId;
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') throw new BillingError('PLAN_CODE_TAKEN', 409, 'Ce code de plan existe déjà');
    throw err;
  } finally {
    conn.release();
    invalidateCatalog();
  }
}

/**
 * Modifie un plan. Le prix d'une période déjà payée est porté par son
 * paiement (`payment.amount`) : changer `price_amount` ne touche que les
 * paiements à venir.
 */
async function updatePlan(id, value, adminId) {
  const existing = await getPlan(id);
  if (!existing) throw new BillingError('PLAN_NOT_FOUND', 404, 'Plan introuvable');
  await assertKnownFeatures(value.features);

  // La cohérence relance/durée se vérifie sur le plan RÉSULTANT : un PUT qui
  // ne change que la relance doit la confronter à la durée déjà en base.
  const duration = value.duration_months ?? Number(existing.duration_months);
  const reminder = value.reminder_days ?? Number(existing.reminder_days);
  if (reminder >= duration * 28) {
    throw new BillingError('INVALID_PLAN', 400, 'reminder_days doit être plus court que la durée du plan');
  }

  const cols = PLAN_COLUMNS.filter((k) => k !== 'code' && value[k] !== undefined);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (cols.length) {
      await conn.execute(
        `UPDATE plan SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE id = ?`,
        [...cols.map((k) => columnValue(k, value[k])), adminId, id],
      );
    }
    if (value.features) await replacePlanFeatures(conn, id, value.features);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    invalidateCatalog();
  }
}

async function updateFeature(code, value) {
  const keys = Object.keys(value);
  const [res] = await pool.execute(
    `UPDATE feature SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE code = ?`,
    [...keys.map((k) => (k.endsWith('_i18n') && value[k] != null ? JSON.stringify(value[k]) : value[k])), code],
  );
  invalidateCatalog();
  if (!res.affectedRows) throw new BillingError('FEATURE_NOT_FOUND', 404, 'Fonctionnalité introuvable');
}

module.exports = {
  listFeatures,
  featuresOfPlan,
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  updateFeature,
  invalidateCatalog,
};
