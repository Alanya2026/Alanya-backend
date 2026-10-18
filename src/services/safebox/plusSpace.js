/**
 * Espace du coffre-fort d'un compte — lot 4 (décision du 15/10/2026 : l'espace
 * en plus est vendu avec Alanya Plus, 25 Go au total depuis le 18/10, réglable par plan).
 *
 * Même règle de couverture que les fichiers de 200 Mo des discussions
 * (`billing/uploadLimits.js`) : phase payante, période en cours ou compte
 * exempté (équipe, compte officiel). En phase gratuite, tout le monde a
 * l'espace de base — comme pour la conservation des médias, c'est une règle à
 * part : `decideEntitlements` ouvre tout à tous hors phase payante, ce qui
 * donnerait l'espace Plus à chacun.
 *
 * Une panne de la base ou une migration 103 absente donne l'espace de base :
 * refuser un dépôt à un abonné le temps d'une panne est un moindre mal que
 * d'offrir l'espace de Plus à qui n'a pas payé.
 */

const pool = require('../../config/db');
const { ACCOUNT_TYPE } = require('../../constants/accountTypes');
const { PHASE } = require('../../constants/billing');
const { getBillingSettings } = require('../billing/settings');
const { effectivePhase, isPaidTier } = require('../billing/rules');

function createPlusSpace({
  db = pool,
  getBilling = getBillingSettings,
  clock = () => new Date(),
  env = process.env,
} = {}) {
  /**
   * @returns {{ quotaBytes: number, maxFileBytes: number, plus: boolean }}
   */
  async function spaceFor(alanyaID, settings) {
    const base = { quotaBytes: settings.baseQuotaBytes, maxFileBytes: settings.maxFileBytes, plus: false };
    const now = clock();
    try {
      const phase = effectivePhase(await getBilling(), alanyaID, now, env);
      if (phase !== PHASE.PAID) return base;
      const [[u]] = await db.query(
        `SELECT u.type_compte, u.account_type,
                (SELECT MAX(sp.ends_at) FROM subscription_period sp
                  WHERE sp.alanyaID = u.alanyaID AND sp.starts_at <= ? AND sp.ends_at > ?) AS covered_until,
                (SELECT MAX(p.safebox_bytes) FROM subscription_period sp JOIN plan p ON p.id = sp.plan_id
                  WHERE sp.alanyaID = u.alanyaID AND sp.starts_at <= ? AND sp.ends_at > ?) AS plan_bytes
           FROM users u WHERE u.alanyaID = ?`,
        [now, now, now, now, alanyaID],
      );
      if (!u) return base;
      const exempt = Number(u.type_compte) >= 1 || Number(u.account_type) === ACCOUNT_TYPE.OFFICIEL;
      if (!isPaidTier({ phase, exempt, coveredUntil: u.covered_until, now })) return base;
      let octets = u.plan_bytes == null ? null : Number(u.plan_bytes);
      if (exempt && octets == null) {
        // Compte exempté sans période : l'espace du plan le plus généreux en vente.
        const [[m]] = await db.query('SELECT MAX(safebox_bytes) AS b FROM plan WHERE is_active = 1');
        octets = m?.b == null ? null : Number(m.b);
      }
      return {
        quotaBytes: Math.max(settings.baseQuotaBytes, octets ?? 0),
        maxFileBytes: Math.max(settings.maxFileBytes, settings.maxFileBytesPlus),
        plus: true,
      };
    } catch (e) {
      console.warn('[Coffre] espace Plus indisponible, espace de base :', e.code || e.message);
      return base;
    }
  }

  return { spaceFor };
}

module.exports = { createPlusSpace };
