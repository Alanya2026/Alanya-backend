/**
 * Réglages du coffre-fort : une seule ligne (`safebox_settings`, id = 1,
 * migration 101), lue en cache 30 s par instance. L'admin les modifiera
 * (lot 5) ; d'ici là, ils se changent en base.
 */

const pool = require('../../config/db');
const { DEFAULT_SETTINGS } = require('../../constants/safebox');
const { extensionsFrom } = require('./rules');

const TTL_MS = 30_000;
let _cache = null;

function normalize(row) {
  const r = { ...DEFAULT_SETTINGS, ...(row || {}) };
  return {
    baseQuotaBytes: Number(r.base_quota_bytes),
    maxFileBytes: Number(r.max_file_bytes),
    maxFileBytesPlus: Number(r.max_file_bytes_plus),
    maxDepth: Number(r.max_depth),
    maxFolders: Number(r.max_folders),
    extensions: extensionsFrom(r.extensions),
  };
}

async function getSafeboxSettings() {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.value;
  let row = null;
  try {
    [[row]] = await pool.execute('SELECT * FROM safebox_settings WHERE id = 1');
  } catch (e) {
    // Table absente (migration 101 non appliquée) : les valeurs du code.
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }
  const value = normalize(row);
  _cache = { at: Date.now(), value };
  return value;
}

function invalidateSafeboxSettings() {
  _cache = null;
}

module.exports = { getSafeboxSettings, invalidateSafeboxSettings, normalize };
