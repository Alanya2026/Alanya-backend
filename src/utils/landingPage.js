// Gabarit commun des pages d'accueil PUBLIQUES (hors /api, sans authentification) :
// code QR d'identité (`/q/…`) et lien de pack de stickers (`/s/…`). Une seule
// feuille de style, un seul échappement HTML, les mêmes boutons de boutiques.

const APP_SCHEME = process.env.QR_APP_SCHEME || 'alanya';
const PLAY_URL = process.env.QR_PLAY_STORE_URL || '';
const APPSTORE_URL = process.env.QR_APP_STORE_URL || '';

/** Échappement HTML — ces valeurs viennent de la base et finissent dans le DOM. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const page = ({ titre, corps }) => `<!doctype html>
<html lang="fr">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(titre)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center;
    justify-content: center; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #F5F6FA; color: #1A1C22;
  }
  .carte {
    width: 100%; max-width: 380px; background: #FFF; border-radius: 20px;
    padding: 32px 24px; text-align: center;
    box-shadow: 0 8px 32px rgba(16, 20, 40, .10);
  }
  .avatar {
    width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
    margin: 0 auto 16px; display: block; background: #E4E7F2;
  }
  .initiale {
    width: 96px; height: 96px; border-radius: 50%; margin: 0 auto 16px;
    display: flex; align-items: center; justify-content: center;
    background: #3F51B5; color: #FFF; font-size: 40px; font-weight: 600;
  }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .pseudo { color: #6B7280; margin: 0 0 2px; font-size: 15px; }
  .ident { color: #6B7280; margin: 0 0 24px; font-size: 14px;
           font-variant-numeric: tabular-nums; }
  .bouton {
    display: block; padding: 14px 20px; border-radius: 12px;
    text-decoration: none; font-weight: 600; font-size: 16px; margin-bottom: 10px;
    background: #3F51B5; color: #FFF;
  }
  .secondaire { background: transparent; color: #3F51B5; font-weight: 500;
                font-size: 15px; border: 1px solid #D7DAE6; }
  .note { color: #6B7280; font-size: 13px; line-height: 1.5; margin: 16px 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0F1116; color: #ECEDF2; }
    .carte { background: #191C24; box-shadow: none; }
    .pseudo, .ident, .note { color: #9BA1B0; }
    .secondaire { color: #97A2FF; border-color: #2C3040; }
  }
</style>
<div class="carte">${corps}</div>
`;

/** Boutons de repli vers les boutiques (vides tant que les URL ne sont pas configurées). */
const boutonsStore = () => [
  PLAY_URL && `<a class="bouton secondaire" href="${esc(PLAY_URL)}">Télécharger sur Android</a>`,
  APPSTORE_URL && `<a class="bouton secondaire" href="${esc(APPSTORE_URL)}">Télécharger sur iPhone</a>`,
].filter(Boolean).join('\n');

module.exports = { APP_SCHEME, PLAY_URL, APPSTORE_URL, esc, page, boutonsStore };
