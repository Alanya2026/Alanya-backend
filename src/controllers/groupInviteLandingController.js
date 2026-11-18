// Page d'accueil publique d'un lien d'invitation de groupe (`GET /g/:token`).
//
// Même régime que la page d'un pack de stickers (`/s/:token`) : publique, sans
// compte, ELLE N'INSCRIT À RIEN. Elle dit le nom du groupe et son nombre de
// membres — ce que le lien donne déjà à qui le détient — et transporte le jeton
// jusqu'à l'app, qui montre l'aperçu et attend un appui sur « Rejoindre ».
//
// Ce que la page ne dit JAMAIS : qui a créé le groupe, qui en est membre, un
// identifiant, la photo (elle circulerait hors de l'app), la description.
//
// Jeton mal formé, inconnu ou réinitialisé : la MÊME page neutre en 404, pas
// d'énumération. Panne de base : cette même page en 500. Toujours
// `Cache-Control: no-store` : une réinitialisation doit se voir tout de suite.

const { groupeParJeton } = require('../services/groupInviteService');
const {
  APP_SCHEME, esc, page, boutonsStore,
} = require('../utils/landingPage');

const pageIntrouvable = () => page({
  titre: 'Lien Alanya indisponible',
  corps: `
    <div class="initiale">?</div>
    <h1>Ce lien ne fonctionne plus</h1>
    <p class="note">
      Il a peut-être été réinitialisé par un administrateur du groupe.
      Demandez un nouveau lien à un membre.
    </p>`,
});

const libelleMembres = (n) => `${n} membre${n > 1 ? 's' : ''}`;

function pageGroupe({ nom, memberCount, token }) {
  const lienApp = `${APP_SCHEME}://group/${encodeURIComponent(token)}`;
  const initiale = Array.from(nom)[0] || '?';
  return page({
    titre: `${nom} — groupe Alanya`,
    corps: `
    <div class="initiale">${esc(initiale.toUpperCase())}</div>
    <p class="pseudo">Vous êtes invité à rejoindre</p>
    <h1>${esc(nom)}</h1>
    <p class="ident">Groupe · ${esc(libelleMembres(memberCount))}</p>
    <a class="bouton" href="${esc(lienApp)}">Ouvrir dans Alanya</a>
    ${boutonsStore()}
    <p class="note">
      Après l'installation, rouvrez ce lien : Alanya vous proposera de rejoindre
      le groupe. Cette page ne vous inscrit à rien.
    </p>`,
  });
}

const envoyer = (res, statut, html) => res
  .status(statut)
  .set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
  .type('html')
  .send(html);

const showGroupInviteLanding = async (req, res) => {
  try {
    const token = String(req.params.token || '');
    const groupe = await groupeParJeton(token);
    if (!groupe || !groupe.name) return envoyer(res, 404, pageIntrouvable());
    return envoyer(res, 200, pageGroupe({ nom: groupe.name, memberCount: groupe.memberCount, token }));
  } catch (error) {
    console.error('[groupInviteLanding] ERROR:', error.code || error.message);
    return envoyer(res, 500, pageIntrouvable());
  }
};

module.exports = { showGroupInviteLanding, pageGroupe, pageIntrouvable };
