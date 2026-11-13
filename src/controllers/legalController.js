/**
 * Pages publiques exigées pour publier l'écran de consentement Google
 * (Drive) : accueil, politique de confidentialité, conditions, licences.
 *
 * Servies à la racine du domaine, hors /api, aux URLs déjà câblées dans
 * l'application (`LegalUrls`). Google refuse la vérification de marque tant
 * que ces pages 404, et exige que l'accueil décrive l'application et pointe
 * vers la même politique que l'écran OAuth.
 *
 * Le texte dit ce que le code fait vraiment — notamment que la sauvegarde
 * Drive n'est pas de bout en bout. Une prose plus rassurante serait un
 * mensonge, et Google compare la politique au comportement de l'app.
 */

const PLAY_URL = process.env.QR_PLAY_STORE_URL || '';
const APPSTORE_URL = process.env.QR_APP_STORE_URL || '';

const SUPPORT = 'alanyapro64@gmail.com';
const HOST = 'https://www.alanya237.com';
const MAJ = '21 septembre 2026';
const MAJ_EN = '21 September 2026';

const _INVALID_URL_VALUES = ['NON DEFINI', 'INDEFINI', 'undefined', 'null', ''];
const _sanitizeUrl = (url) => {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (_INVALID_URL_VALUES.includes(trimmed)) return null;
  return trimmed.startsWith('http') ? trimmed : null;
};

const _esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** `fr` ou `en`. Tout le reste retombe sur le français. */
const langueDe = (req) => {
  const q = String(req.query?.lang || '').toLowerCase();
  if (q === 'en' || q === 'fr') return q;
  const accept = String(req.headers?.['accept-language'] || '').toLowerCase();
  if (accept.startsWith('en')) return 'en';
  return 'fr';
};

const _lienLangue = (chemin, langue) =>
  `${chemin}?lang=${langue === 'fr' ? 'en' : 'fr'}`;

const _page = ({ titre, description, chemin, langue, corps }) => {
  const autre = langue === 'fr' ? 'en' : 'fr';
  const bascule = langue === 'fr' ? 'English' : 'Français';
  return `<!doctype html>
<html lang="${langue}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="${_esc(description)}">
<link rel="canonical" href="${HOST}${chemin}">
<title>${_esc(titre)}</title>
<style>
  :root { color-scheme: light dark; --brand:#3F51B5; --ink:#1A1C22; --muted:#5B6273; --line:#E2E5EC; --bg:#F5F6FA; --card:#FFF; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:var(--bg); color:var(--ink); line-height:1.6; }
  header { background:var(--card); border-bottom:1px solid var(--line); }
  .barre { max-width:720px; margin:0 auto; padding:16px 20px; display:flex; align-items:center; gap:12px; }
  .logo { width:36px; height:36px; border-radius:10px; background:var(--brand); color:#fff; font-weight:800; display:grid; place-items:center; text-decoration:none; }
  .marque { font-weight:700; font-size:18px; color:var(--ink); text-decoration:none; }
  .bascule { margin-left:auto; font-size:14px; color:var(--brand); text-decoration:none; }
  nav { display:flex; gap:16px; flex-wrap:wrap; max-width:720px; margin:0 auto; padding:0 20px 14px; font-size:14px; }
  nav a { color:var(--muted); text-decoration:none; }
  nav a[aria-current="page"] { color:var(--brand); font-weight:600; }
  main { max-width:720px; margin:0 auto; padding:32px 20px 72px; }
  h1 { font-size:1.75rem; line-height:1.25; margin:0 0 8px; }
  .maj { color:var(--muted); font-size:14px; margin:0 0 28px; }
  h2 { font-size:1.15rem; margin:28px 0 8px; }
  p, li { font-size:16px; }
  ul { padding-left:1.2em; }
  a { color:var(--brand); }
  .cta { display:inline-block; margin:8px 8px 0 0; padding:12px 18px; border-radius:12px; background:var(--brand); color:#fff; text-decoration:none; font-weight:600; }
  .cta.sec { background:transparent; color:var(--brand); border:1px solid var(--line); }
  footer { max-width:720px; margin:0 auto; padding:0 20px 40px; color:var(--muted); font-size:13px; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#ECEDF2; --muted:#9BA1B0; --line:#2C3040; --bg:#0F1116; --card:#191C24; }
  }
</style>
<header>
  <div class="barre">
    <a class="logo" href="/?lang=${langue}" aria-label="Alanya">A</a>
    <a class="marque" href="/?lang=${langue}">Alanya</a>
    <a class="bascule" href="${_lienLangue(chemin, langue)}">${bascule}</a>
  </div>
  <nav>
    <a href="/?lang=${langue}"${chemin === '/' ? ' aria-current="page"' : ''}>${langue === 'fr' ? 'Accueil' : 'Home'}</a>
    <a href="/legal/privacy?lang=${langue}"${chemin === '/legal/privacy' ? ' aria-current="page"' : ''}>${langue === 'fr' ? 'Confidentialité' : 'Privacy'}</a>
    <a href="/legal/terms?lang=${langue}"${chemin === '/legal/terms' ? ' aria-current="page"' : ''}>${langue === 'fr' ? 'Conditions' : 'Terms'}</a>
    <a href="/legal/licenses?lang=${langue}"${chemin === '/legal/licenses' ? ' aria-current="page"' : ''}>${langue === 'fr' ? 'Licences' : 'Licenses'}</a>
  </nav>
</header>
<main>${corps}</main>
<footer>© ${new Date().getUTCFullYear()} Alanya · ${_esc(langue === 'fr' ? 'Fait avec soin à Yaoundé' : 'Made with care in Yaoundé')} · <a href="mailto:${SUPPORT}">${SUPPORT}</a></footer>
<link rel="alternate" hreflang="${autre}" href="${HOST}${chemin}?lang=${autre}">
`;
};

const _boutonsMagasins = (langue) => {
  const play = _sanitizeUrl(PLAY_URL);
  const store = _sanitizeUrl(APPSTORE_URL);
  const android = langue === 'fr' ? 'Télécharger sur Android' : 'Download for Android';
  const ios = langue === 'fr' ? 'Télécharger sur iPhone' : 'Download for iPhone';
  return [
    play && `<a class="cta" href="${_esc(play)}">${android}</a>`,
    store && `<a class="cta sec" href="${_esc(store)}">${ios}</a>`,
  ].filter(Boolean).join('\n');
};

const HOME = {
  fr: {
    titre: 'Alanya — messagerie, appels et trajets de confiance',
    description:
      'Alanya est une application de messagerie mobile : messages, appels, trajets de confiance et sauvegardes chiffrées, y compris sur Google Drive.',
    corps: () => `
<h1>Alanya</h1>
<p class="maj">Messagerie mobile, conçue à Yaoundé.</p>
<p>Alanya permet d'échanger des messages, d'appeler, de partager sa position pendant un trajet de confiance, et de sauvegarder son historique — sur le téléphone ou dans Google Drive.</p>
<p>Les sauvegardes Drive n'utilisent que les fichiers créés par Alanya. L'application ne voit pas le reste de votre Drive.</p>
${_boutonsMagasins('fr')}
<p style="margin-top:28px">Avant d'utiliser Alanya, lisez la <a href="/legal/privacy?lang=fr">politique de confidentialité</a> et les <a href="/legal/terms?lang=fr">conditions d'utilisation</a>.</p>
<p>Questions : <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>`,
  },
  en: {
    titre: 'Alanya — messaging, calls and trusted trips',
    description:
      'Alanya is a mobile messaging app: messages, calls, trusted trips and encrypted backups, including on Google Drive.',
    corps: () => `
<h1>Alanya</h1>
<p class="maj">A mobile messenger, designed in Yaoundé.</p>
<p>Alanya lets you send messages, make calls, share your location during a trusted trip, and back up your history — on the phone or to Google Drive.</p>
<p>Drive backups only use files Alanya created. The app cannot see the rest of your Drive.</p>
${_boutonsMagasins('en')}
<p style="margin-top:28px">Before using Alanya, please read the <a href="/legal/privacy?lang=en">privacy policy</a> and the <a href="/legal/terms?lang=en">terms of use</a>.</p>
<p>Questions: <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>`,
  },
};

const PRIVACY = {
  fr: {
    titre: 'Politique de confidentialité — Alanya',
    description:
      'Comment Alanya collecte, utilise, conserve et partage vos données, y compris les fichiers Google Drive créés par l\'application.',
    corps: () => `
<h1>Politique de confidentialité</h1>
<p class="maj">Dernière mise à jour : ${MAJ}</p>
<p>Alanya est une messagerie mobile éditée depuis Yaoundé (Cameroun). Cette politique décrit les données que nous traitons, y compris lorsque vous connectez Google Drive pour une sauvegarde. Contact : <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>

<h2>1. Données de compte</h2>
<p>Pour créer un compte : numéro Alanya, mot de passe, et éventuellement nom, pseudo, photo, e-mail, pays. Nous conservons aussi les appareils enrôlés, les réglages (confidentialité, notifications, apparence) et les traces techniques nécessaires au service (jetons de session, journaux de connexion).</p>

<h2>2. Messages, appels et médias</h2>
<p>Les messages, vocaux, photos, vidéos, documents et l'historique d'appels transitent par nos serveurs pour être délivrés. Les stories ordinaires expirent après 24 heures. Les médias ont une durée de vie limitée (de l'ordre de 30 jours selon le type). Ce n'est pas une messagerie de bout en bout : Alanya peut, techniquement, lire le contenu qui transite par le serveur. Nous ne le faisons pas pour du ciblage publicitaire.</p>

<h2>3. Google Drive et Google Sign-In</h2>
<p>Si vous choisissez de sauvegarder hors du téléphone, Alanya demande l'accès à Google Drive avec le seul champ <code>https://www.googleapis.com/auth/drive.file</code>. Ce champ limite l'application <strong>aux fichiers qu'elle a elle-même créés</strong> (ou que vous lui avez explicitement ouverts). Alanya ne liste pas, ne lit pas et ne modifie pas le reste de votre Drive — documents, photos, dossiers personnels inclus.</p>
<p>Concrètement, Alanya :</p>
<ul>
  <li>crée un dossier visible nommé <strong>Alanya</strong> dans votre Drive ;</li>
  <li>y dépose des archives chiffrées (historique des messages, pas les médias) et un descriptif <code>latest.json</code> ;</li>
  <li>peut lister, remplacer ou supprimer uniquement ces fichiers ;</li>
  <li>affiche l'adresse du compte Google connecté, pour que vous vérifiiez sur quel Drive la sauvegarde part.</li>
</ul>
<p>Les archives sont chiffrées (AES-256-GCM) avant l'envoi. <strong>Ce n'est pas du chiffrement de bout en bout</strong> : la clé est dérivée côté serveur Alanya, pour qu'une sauvegarde reste restaurable si vous oubliez un mot de passe. Alanya peut donc, techniquement, déchiffrer une archive. Chaque délivrance de clé est journalisée. Le serveur ne stocke pas le contenu de la sauvegarde : seulement une date, une taille, un numéro de version de clé, un décompte de messages, et une adresse e-mail <em>masquée</em> (par exemple <code>a•••@gmail.com</code>) pour vous aider à retrouver le bon compte Google le jour d'une restauration.</p>
<p>Vous pouvez déconnecter Google dans l'application, supprimer le dossier Alanya dans Drive, ou révoquer l'accès depuis <a href="https://myaccount.google.com/permissions">votre compte Google</a>. Alanya n'utilise pas les données Google pour de la publicité, ne les revend pas, et n'en fait pas un profilage.</p>
<p>L'usage qu'Alanya fait des informations reçues des API Google respecte la <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, y compris les exigences d'utilisation limitée (Limited Use).</p>

<h2>4. Autres services techniques</h2>
<ul>
  <li><strong>Firebase Cloud Messaging (Google)</strong> : jetons d'appareil pour les notifications push et les appels manqués. Pas le contenu des messages au-delà de ce que la notification affiche selon vos réglages.</li>
  <li><strong>Cartes</strong> : tuiles OpenStreetMap (ou un fournisseur que nous configurons) pendant un partage de position ou un trajet de confiance. La position n'est collectée que lorsque vous lancez un trajet, et partagée avec le cercle que vous avez choisi.</li>
  <li><strong>Sentry</strong> (si activé) : traces de plantage, expurgées des mots de passe, messages, e-mails et jetons.</li>
  <li><strong>Paiement</strong> : si vous souscrivez à Alanya Plus, le prestataire de paiement traite le moyen de paiement. Nous conservons l'état d'abonnement, pas le numéro de carte.</li>
</ul>

<h2>5. Pourquoi nous traitons ces données</h2>
<p>Pour fournir le service (compte, messages, appels, trajets, sauvegarde), le sécuriser, respecter la loi, et — uniquement si vous y souscrivez — gérer Alanya Plus. Base : exécution du contrat et, pour certaines traces techniques, intérêt légitime à faire fonctionner et protéger le service.</p>

<h2>6. Conservation</h2>
<ul>
  <li>Compte : jusqu'à suppression (délai de grâce de 7 jours, annulable).</li>
  <li>Historique d'appels : jusqu'à 12 mois.</li>
  <li>Journaux de connexion : 90 jours.</li>
  <li>Appareils révoqués : 90 jours.</li>
  <li>Export RGPD téléchargé : 7 jours.</li>
  <li>Fichiers Drive : tant que vous les laissez dans votre Drive. Les supprimer de Drive les fait disparaître d'Alanya ; les supprimer d'Alanya ne vide pas automatiquement Drive.</li>
</ul>

<h2>7. Vos droits</h2>
<p>Depuis l'application : export de vos données (RGPD), suppression du compte, réglages de visibilité (dernière connexion, photo, accusés de lecture). Pour le reste, écrivez à <a href="mailto:${SUPPORT}">${SUPPORT}</a>. Si vous êtes dans l'Union européenne, vous pouvez aussi saisir une autorité de contrôle.</p>

<h2>8. Mineurs</h2>
<p>Alanya n'est pas destinée aux enfants de moins de 13 ans. Nous ne collectons pas sciemment leurs données.</p>

<h2>9. Modifications</h2>
<p>Une mise à jour de cette politique sera datée en tête de page. Un changement majeur sur l'usage des données Google Drive sera annoncé dans l'application.</p>`,
  },
  en: {
    titre: 'Privacy policy — Alanya',
    description:
      'How Alanya collects, uses, stores and shares your data, including Google Drive files created by the app.',
    corps: () => `
<h1>Privacy policy</h1>
<p class="maj">Last updated: ${MAJ_EN}</p>
<p>Alanya is a mobile messenger based in Yaoundé, Cameroon. This policy explains what we process, including when you connect Google Drive for backup. Contact: <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>

<h2>1. Account data</h2>
<p>To create an account: an Alanya number, a password, and optionally a name, handle, photo, email and country. We also keep enrolled devices, your settings (privacy, notifications, appearance) and technical traces needed to run the service (session tokens, login logs).</p>

<h2>2. Messages, calls and media</h2>
<p>Messages, voice notes, photos, videos, documents and call history go through our servers to be delivered. Ordinary stories expire after 24 hours. Media has a limited lifetime (around 30 days depending on type). This is not an end-to-end encrypted messenger: Alanya can technically read content that transits through the server. We do not use it for advertising.</p>

<h2>3. Google Drive and Google Sign-In</h2>
<p>If you choose an off-phone backup, Alanya requests Google Drive access with the single scope <code>https://www.googleapis.com/auth/drive.file</code>. That scope limits the app <strong>to files it created</strong> (or that you explicitly opened with it). Alanya does not list, read or change the rest of your Drive — documents, photos and personal folders included.</p>
<p>In practice Alanya:</p>
<ul>
  <li>creates a visible folder named <strong>Alanya</strong> in your Drive;</li>
  <li>stores encrypted archives there (chat history, not media) and a <code>latest.json</code> descriptor;</li>
  <li>may list, replace or delete only those files;</li>
  <li>shows the connected Google account so you can check which Drive the backup uses.</li>
</ul>
<p>Archives are encrypted (AES-256-GCM) before upload. <strong>This is not end-to-end encryption</strong>: the key is derived on Alanya's servers, so a backup remains restorable if you forget a password. Alanya can therefore technically decrypt an archive. Every key delivery is logged. The server does not store backup contents: only a date, a size, a key version, a message count, and a <em>masked</em> email (for example <code>a•••@gmail.com</code>) to help you find the right Google account on restore.</p>
<p>You can disconnect Google in the app, delete the Alanya folder in Drive, or revoke access from <a href="https://myaccount.google.com/permissions">your Google Account</a>. Alanya does not use Google data for advertising, does not sell it, and does not profile you with it.</p>
<p>Alanya's use of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>4. Other technical services</h2>
<ul>
  <li><strong>Firebase Cloud Messaging (Google)</strong>: device tokens for push notifications and missed calls. Not message bodies beyond what the notification shows under your settings.</li>
  <li><strong>Maps</strong>: OpenStreetMap tiles (or a provider we configure) during location sharing or a trusted trip. Location is collected only when you start a trip, and shared with the circle you chose.</li>
  <li><strong>Sentry</strong> (when enabled): crash traces, stripped of passwords, messages, emails and tokens.</li>
  <li><strong>Payments</strong>: if you subscribe to Alanya Plus, the payment provider handles the payment method. We keep subscription status, not the card number.</li>
</ul>

<h2>5. Why we process this data</h2>
<p>To provide the service (account, messages, calls, trips, backup), to secure it, to comply with the law, and — only if you subscribe — to run Alanya Plus. Legal bases: performance of the contract and, for some technical traces, legitimate interest in operating and protecting the service.</p>

<h2>6. Retention</h2>
<ul>
  <li>Account: until deletion (7-day grace period, cancellable).</li>
  <li>Call history: up to 12 months.</li>
  <li>Login logs: 90 days.</li>
  <li>Revoked devices: 90 days.</li>
  <li>Downloaded GDPR export: 7 days.</li>
  <li>Drive files: for as long as you leave them in your Drive. Deleting them in Drive removes them from Alanya's reach; deleting them in Alanya does not automatically empty Drive.</li>
</ul>

<h2>7. Your rights</h2>
<p>In the app: data export (GDPR), account deletion, visibility settings (last seen, photo, read receipts). For anything else, write to <a href="mailto:${SUPPORT}">${SUPPORT}</a>. If you are in the European Union you may also contact a supervisory authority.</p>

<h2>8. Children</h2>
<p>Alanya is not intended for children under 13. We do not knowingly collect their data.</p>

<h2>9. Changes</h2>
<p>An update to this policy will be dated at the top of the page. A material change to how Google Drive data is used will be announced in the app.</p>`,
  },
};

const TERMS = {
  fr: {
    titre: 'Conditions d\'utilisation — Alanya',
    description: 'Conditions d\'utilisation du service de messagerie Alanya.',
    corps: () => `
<h1>Conditions d'utilisation</h1>
<p class="maj">Dernière mise à jour : ${MAJ}</p>
<p>En créant un compte Alanya, vous acceptez ces conditions. Contact : <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>
<h2>1. Le service</h2>
<p>Alanya est une messagerie : messages, appels, trajets de confiance, sauvegarde facultative. Certaines fonctions (sauvegarde, traduction, trajets, sonneries par liste) peuvent faire partie d'Alanya Plus, une offre payante annuelle.</p>
<h2>2. Votre compte</h2>
<p>Vous êtes responsable de votre mot de passe et de l'usage de vos appareils. Un compte peut être supprimé depuis l'application ; la suppression est effective après 7 jours, délai pendant lequel vous pouvez l'annuler.</p>
<h2>3. Usage acceptable</h2>
<p>Pas de harcèlement, d'usurpation, de spam, ni de contenu illégal. Nous pouvons restreindre ou clôturer un compte qui met en danger d'autres inscrits ou le service.</p>
<h2>4. Sauvegarde</h2>
<p>La sauvegarde couvre l'historique des messages, pas les médias. Sur le téléphone, elle ne survit pas à la perte, au vol ou à l'effacement de l'appareil. Sur Google Drive, elle ne survit que tant que le dossier Alanya reste dans ce Drive et que l'autorisation n'est pas révoquée. Le chiffrement n'est pas de bout en bout : voir la <a href="/legal/privacy?lang=fr">politique de confidentialité</a>.</p>
<h2>5. Disponibilité</h2>
<p>Nous visons un service continu, sans le garantir. Une panne, une maintenance ou un cas de force majeure peuvent interrompre Alanya.</p>
<h2>6. Droit applicable</h2>
<p>Ces conditions sont régies par le droit camerounais, sans préjudice des dispositions impératives du pays où vous résidez.</p>`,
  },
  en: {
    titre: 'Terms of use — Alanya',
    description: 'Terms of use for the Alanya messaging service.',
    corps: () => `
<h1>Terms of use</h1>
<p class="maj">Last updated: ${MAJ_EN}</p>
<p>By creating an Alanya account you accept these terms. Contact: <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>
<h2>1. The service</h2>
<p>Alanya is a messenger: messages, calls, trusted trips, optional backup. Some features (backup, translation, trips, list ringtones) may be part of Alanya Plus, a yearly paid offer.</p>
<h2>2. Your account</h2>
<p>You are responsible for your password and the use of your devices. An account can be deleted from the app; deletion takes effect after 7 days, during which you can cancel it.</p>
<h2>3. Acceptable use</h2>
<p>No harassment, impersonation, spam or illegal content. We may restrict or close an account that endangers other people or the service.</p>
<h2>4. Backup</h2>
<p>Backup covers chat history, not media. On the phone it does not survive loss, theft or a device wipe. On Google Drive it lasts only while the Alanya folder remains in that Drive and access is not revoked. Encryption is not end-to-end: see the <a href="/legal/privacy?lang=en">privacy policy</a>.</p>
<h2>5. Availability</h2>
<p>We aim for continuous service without guaranteeing it. An outage, maintenance or force majeure may interrupt Alanya.</p>
<h2>6. Governing law</h2>
<p>These terms are governed by Cameroonian law, without prejudice to mandatory rules of the country where you live.</p>`,
  },
};

const LICENSES = {
  fr: {
    titre: 'Licences open source — Alanya',
    description: 'Logiciels libres utilisés par Alanya.',
    corps: () => `
<h1>Licences open source</h1>
<p class="maj">Dernière mise à jour : ${MAJ}</p>
<p>Alanya s'appuie sur des bibliothèques libres (Flutter, Google Sign-In, API Google Drive, et d'autres). La liste complète et le texte de chaque licence sont affichés dans l'application, à <strong>Paramètres → À propos → Licences open source</strong>.</p>
<p>L'usage des API Google est aussi soumis aux <a href="https://developers.google.com/terms">Conditions des API Google</a>.</p>`,
  },
  en: {
    titre: 'Open-source licenses — Alanya',
    description: 'Open-source software used by Alanya.',
    corps: () => `
<h1>Open-source licenses</h1>
<p class="maj">Last updated: ${MAJ_EN}</p>
<p>Alanya uses open-source libraries (Flutter, Google Sign-In, the Google Drive API, and others). The full list and each licence text are shown in the app under <strong>Settings → About → Open-source licenses</strong>.</p>
<p>Use of Google APIs is also subject to the <a href="https://developers.google.com/terms">Google APIs Terms of Service</a>.</p>`,
  },
};

const PAGES = {
  '/': HOME,
  '/legal/privacy': PRIVACY,
  '/legal/terms': TERMS,
  '/legal/licenses': LICENSES,
};

const montrer = (chemin) => (req, res) => {
  const langue = langueDe(req);
  const page = PAGES[chemin][langue];
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('html').send(_page({
    titre: page.titre,
    description: page.description,
    chemin,
    langue,
    corps: page.corps(),
  }));
};

module.exports = {
  showHome: montrer('/'),
  showPrivacy: montrer('/legal/privacy'),
  showTerms: montrer('/legal/terms'),
  showLicenses: montrer('/legal/licenses'),
  // Exportés pour les tests : la page d'accueil et la politique sont le
  // contrat avec Google, une régression silencieuse y serait grave.
  langueDe,
  PAGES,
  // Le gabarit commun, pour les autres pages publiques (/coffre).
  renderPage: _page,
  escapeHtml: _esc,
};
