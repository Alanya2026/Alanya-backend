// Page d'accueil publique d'un lien de partage de pack (`GET /s/:token`).
//
// L'application partage `alanya://sticker/<jeton>`, que les messageries ne
// rendent pas cliquable ; le lien partagé est donc `https://<domaine>/s/<jeton>`
// et cette page fait la passerelle : nom du pack, nombre de stickers, bouton
// « Ouvrir dans Alanya » (schéma applicatif) et repli vers les boutiques.
//
// Comme la page QR : publique, sans compte, ELLE N'INSTALLE RIEN. L'installation
// est faite par l'app, authentifiée, via `POST /api/stickers/share/:token/add`.
//
// Ce que la page ne dit JAMAIS : l'auteur, un identifiant de compte, le code du
// pack, une adresse de fichier. Le nom et le nombre sont ce que le lien donne
// déjà à qui le détient.
//
// Tout échec — jeton mal formé, inconnu, révoqué, pack archivé ou vide, module
// fermé, réglages illisibles — rend la MÊME page neutre en 404 : pas
// d'énumération. Une panne de base rend cette même page en 500. Toujours
// `Cache-Control: no-store` : une révocation doit être visible tout de suite.

const { apercuPartagePublic } = require('../services/stickerPackService');
const { peutCreerStickers } = require('../services/stickerSettingsService');
const { resoudre } = require('../utils/stickerI18n');
const {
  APP_SCHEME, esc, page, boutonsStore,
} = require('../utils/landingPage');

const LANGUE_PAGE = 'fr';

const pageIntrouvable = () => page({
  titre: 'Lien Alanya indisponible',
  corps: `
    <div class="initiale">?</div>
    <h1>Ce lien n'est plus valide</h1>
    <p class="note">
      Le pack a peut-être cessé d'être partagé par son propriétaire. Demandez-lui
      de vous envoyer un nouveau lien.
    </p>`,
});

/** « 1 sticker » / « 12 stickers ». */
const libelleCompte = (n) => `${n} sticker${n > 1 ? 's' : ''}`;

/**
 * Page d'un pack. `nom` vient de la base : tout passe par `esc`. Le jeton, déjà
 * validé (24 caractères sûrs), est encodé puis échappé comme n'importe quelle
 * valeur d'attribut.
 */
function pagePack({ nom, count, token }) {
  const lienApp = `${APP_SCHEME}://sticker/${encodeURIComponent(token)}`;
  const initiale = Array.from(nom)[0] || '?';
  return page({
    titre: `${nom} — stickers Alanya`,
    corps: `
    <div class="initiale">${esc(initiale.toUpperCase())}</div>
    <h1>${esc(nom)}</h1>
    <p class="ident">${esc(libelleCompte(count))}</p>
    <a class="bouton" href="${esc(lienApp)}">Ouvrir dans Alanya</a>
    ${boutonsStore()}
    <p class="note">
      Ouvrez ce lien depuis votre téléphone : Alanya vous proposera d'ajouter ce
      pack à vos stickers.
    </p>`,
  });
}

const envoyer = (res, statut, html) => res
  .status(statut)
  .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  .type('html')
  .send(html);

const showStickerShareLanding = async (req, res) => {
  try {
    // Module fermé (ou création fermée : le lien ne se résoudrait pas dans
    // l'app), ou réglages illisibles : page neutre, comme un lien révoqué.
    let ouvert = false;
    try {
      ouvert = await peutCreerStickers();
    } catch (e) {
      console.warn('[stickerLanding] réglages illisibles, fermé :', e.code || e.message);
    }
    if (!ouvert) return envoyer(res, 404, pageIntrouvable());

    const token = String(req.params.token || '');
    const apercu = await apercuPartagePublic(token);
    if (!apercu) return envoyer(res, 404, pageIntrouvable());

    // Nom résolu en français, repli de contrat ; nom vide = lien neutre.
    const nom = resoudre(apercu.nameI18n, LANGUE_PAGE).trim();
    if (!nom) return envoyer(res, 404, pageIntrouvable());

    return envoyer(res, 200, pagePack({ nom, count: apercu.count, token }));
  } catch (error) {
    console.error('[stickerLanding] ERROR:', error);
    return envoyer(res, 500, pageIntrouvable());
  }
};

module.exports = { showStickerShareLanding, pagePack, pageIntrouvable };
