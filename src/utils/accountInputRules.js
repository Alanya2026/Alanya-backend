/**
 * Règles de saisie des comptes : nom, pseudo et nouveau mot de passe.
 * Miroir de `Validators.displayName` / `Validators.newPassword` dans
 * l'application (lib/core/utils/validators.dart).
 */

const NAME_MIN_LENGTH = 3;

// Lettres de toutes écritures (accents compris), chiffres, espace, tiret,
// apostrophe droite ou typographique et tiret bas. La ponctuation
// (. , ; : ! ? @ …) est refusée.
const NAME_PATTERN = /^[\p{L}\p{M}\p{N} _'’-]+$/u;

/**
 * @param {'nom'|'pseudo'} field
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, code: string, message: string, field: string }}
 */
const checkDisplayName = (field, value) => {
  const trimmed = String(value ?? '').trim();
  if ([...trimmed].length < NAME_MIN_LENGTH) {
    return {
      ok: false,
      code: 'NAME_TOO_SHORT',
      message: `Le ${field} doit contenir au moins ${NAME_MIN_LENGTH} caractères`,
      field,
    };
  }
  if (!NAME_PATTERN.test(trimmed)) {
    return {
      ok: false,
      code: 'NAME_INVALID_CHARS',
      message: `Le ${field} ne peut contenir que des lettres, des chiffres, des espaces, - ' et _`,
      field,
    };
  }
  return { ok: true };
};

/** Vrai si le mot de passe contient un espace, une tabulation ou un saut de ligne. */
const passwordHasWhitespace = (password) => /\s/.test(String(password ?? ''));

module.exports = {
  NAME_MIN_LENGTH,
  checkDisplayName,
  passwordHasWhitespace,
};
