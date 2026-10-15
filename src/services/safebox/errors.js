/**
 * Refus métier du coffre-fort : un code stable (docs/error-codes.md), le
 * statut HTTP qui va avec, et d'éventuels champs d'appoint (espace restant,
 * limite dépassée). Les services le lèvent, le contrôleur le traduit par
 * `fail()` — aucun service ne connaît `res`.
 */
class SafeboxError extends Error {
  constructor(code, status, message, extra) {
    super(message || code);
    this.name = 'SafeboxError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

module.exports = { SafeboxError };
