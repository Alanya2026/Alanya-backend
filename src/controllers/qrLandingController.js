// Page d'accueil publique d'un QR d'identité (`GET /q/u/:token`).
//
// Le QR encode une URL pour qu'un scan par un appareil photo générique mène
// quelque part plutôt que d'afficher une chaîne incompréhensible. Sans cette
// page, cette URL renvoyait le 404 brut d'Express.
//
// Cette page ne fait qu'UNE chose : identifier la personne et transporter le
// jeton jusqu'à l'application. Elle n'ajoute aucun contact — elle n'est pas
// authentifiée, elle ne sait pas qui la consulte. C'est l'app, une fois
// ouverte, qui résout le jeton et écrit le contact. Un lien ouvert par erreur
// dans un navigateur reste donc sans effet.

const pool = require('../config/db');
const qrContactTokens = require('../socket/state/qrContactTokens');
const { qrPermanentAutorise } = require('./qrController');

const {
  APP_SCHEME, esc: _esc, page: _page, boutonsStore: _boutonsStore,
} = require('../utils/landingPage');

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const _sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  return trimmed.startsWith('http') ? trimmed : null;
};

/** Groupe l'Alanya ID par deux chiffres, comme l'app le fait à l'affichage. */
const _formatPhone = (phone) =>
  String(phone ?? '').replace(/\D/g, '').replace(/(\d{2})(?=\d)/g, '$1 ').trim();

const _pageIntrouvable = () =>
  _page({
    titre: 'Code Alanya expiré',
    corps: `
    <div class="initiale">?</div>
    <h1>Ce code n'est plus valide</h1>
    <p class="note">
      Il a peut-être été régénéré par son propriétaire. Demandez-lui de vous
      partager son code Alanya à nouveau.
    </p>`,
  });

/**
 * Page d'identité commune aux deux familles de codes contact. `lienApp` est un
 * schéma applicatif et non un lien https : les liens universels vérifiés
 * exigent l'empreinte de signature Android et le Team ID Apple ; le schéma
 * fonctionne sans aucun de ces prérequis, et l'intent-filter https prendra le
 * relais sans toucher cette page le jour où ils existent.
 */
const _pageIdentite = (res, u, { lienApp, noteValidite = '' }) => {
  const nom = (u.nom || '').trim() || (u.pseudo || '').trim() || 'Utilisateur Alanya';
  const avatar = _sanitizeUrl(u.avatar_url);
  const phone = _formatPhone(u.alanyaPhone);

  const boutonsStore = _boutonsStore();

  const corps = `
    ${avatar
      ? `<img class="avatar" src="${_esc(avatar)}" alt="">`
      : `<div class="initiale">${_esc(nom.charAt(0).toUpperCase())}</div>`}
    <h1>${_esc(nom)}</h1>
    ${u.pseudo ? `<p class="pseudo">@${_esc(u.pseudo)}</p>` : ''}
    ${phone ? `<p class="ident">Alanya ID ${_esc(phone)}</p>` : ''}
    <a class="bouton" href="${_esc(lienApp)}">Ouvrir dans Alanya</a>
    ${boutonsStore}
    <p class="note">
      Ouvrez ce lien depuis votre téléphone : Alanya vous proposera d'ajouter
      ${_esc(nom)} à vos contacts préférés.${noteValidite}
    </p>`;

  res.type('html').send(_page({ titre: `${nom} sur Alanya`, corps }));
};

// Code PERMANENT (/q/u/) — réservé aux futurs comptes business : tant que le
// verrou de qrController est fermé, tout jeton permanent est présenté comme
// expiré, y compris ceux créés avant le verrouillage.
const showIdentityLanding = async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token || !qrPermanentAutorise(null)) {
      return res.status(404).type('html').send(_pageIntrouvable());
    }

    const [rows] = await pool.execute(
      `SELECT nom, pseudo, alanyaPhone, avatar_url
       FROM users
       WHERE qr_public_id = ? AND exclus = 0`,
      [token],
    );
    if (rows.length === 0) {
      return res.status(404).type('html').send(_pageIntrouvable());
    }

    _pageIdentite(res, rows[0], {
      lienApp: `${APP_SCHEME}://q/u/${encodeURIComponent(token)}`,
    });
  } catch (error) {
    console.error('[qrLanding] ERROR:', error);
    res.status(500).type('html').send(_pageIntrouvable());
  }
};

// Code ÉPHÉMÈRE (/q/c/) — la visite de cette page NE consomme PAS le jeton :
// seule la résolution par un utilisateur authentifié dans l'app le fait.
const showContactLanding = async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const entry = token ? await qrContactTokens.get(token) : null;
    if (!entry) {
      return res.status(404).type('html').send(_pageIntrouvable());
    }

    const [rows] = await pool.execute(
      `SELECT nom, pseudo, alanyaPhone, avatar_url
       FROM users
       WHERE alanyaID = ? AND exclus = 0`,
      [entry.alanyaID],
    );
    if (rows.length === 0) {
      return res.status(404).type('html').send(_pageIntrouvable());
    }

    _pageIdentite(res, rows[0], {
      lienApp: `${APP_SCHEME}://q/c/${encodeURIComponent(token)}`,
      noteValidite: ' Ce code est valable une dizaine de minutes et pour une seule personne.',
    });
  } catch (error) {
    console.error('[qrLanding] ERROR:', error);
    res.status(500).type('html').send(_pageIntrouvable());
  }
};

module.exports = { showIdentityLanding, showContactLanding };
