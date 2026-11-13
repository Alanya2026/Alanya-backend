/**
 * Page de téléchargement de l'application de bureau du coffre-fort
 * (« Alanya Coffre-fort », Windows et Linux) : alanya237.com/coffre.
 *
 * Conception : docs/conception/coffre-bureau.html, section 09. Le dépôt de
 * l'application est privé : ses fichiers sont servis ici, depuis un dossier
 * du VPS hors de git (DESKTOP_DOWNLOADS_DIR, par défaut downloads/coffre) :
 *
 *   version.json                       produit par GitHub Actions
 *   AlanyaCoffre-Setup-<v>.exe         installateur Windows
 *   alanya-coffre_<v>_amd64.deb        Ubuntu, Debian, Mint
 *   AlanyaCoffre-<v>.AppImage          autres distributions
 *
 * Routes : GET /coffre (la page), GET /coffre/version.json (lu par
 * l'application pour annoncer une nouvelle version), GET /coffre/files/:nom
 * (seulement les fichiers que version.json annonce).
 */

const fs = require('fs');
const path = require('path');
const { renderPage, escapeHtml: esc, langueDe } = require('./legalController');

const dossier = () =>
  process.env.DESKTOP_DOWNLOADS_DIR || path.join(__dirname, '..', '..', 'downloads', 'coffre');

const NOM_SUR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** version.json relu quand il change ; null s'il manque ou ne se lit pas. */
let _cache = { mtimeMs: -1, version: null };

function lireVersion() {
  const fichier = path.join(dossier(), 'version.json');
  let st;
  try {
    st = fs.statSync(fichier);
  } catch {
    _cache = { mtimeMs: -1, version: null };
    return null;
  }
  if (st.mtimeMs === _cache.mtimeMs) return _cache.version;
  let v = null;
  try {
    v = valider(JSON.parse(fs.readFileSync(fichier, 'utf8')));
  } catch {
    v = null;
  }
  _cache = { mtimeMs: st.mtimeMs, version: v };
  return v;
}

/** Ne garde que des champs sûrs : un fichier mal formé ne casse pas la page. */
function valider(j) {
  if (!j || typeof j !== 'object' || !VERSION.test(String(j.version))) return null;
  const fiche = (x) => {
    if (!x || !NOM_SUR.test(String(x.file))) return null;
    const bytes = Number(x.bytes);
    return {
      file: String(x.file),
      bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
      sha256: SHA.test(String(x.sha256)) ? String(x.sha256) : null,
    };
  };
  const texte = (x) => (typeof x === 'string' ? x.slice(0, 2000) : '');
  return {
    version: String(j.version),
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(j.date)) ? String(j.date) : null,
    notes: { fr: texte(j.notes?.fr), en: texte(j.notes?.en) },
    windows: fiche(j.windows),
    deb: fiche(j.deb),
    appimage: fiche(j.appimage),
  };
}

const taille = (octets, langue) => {
  if (!octets) return '';
  const mo = octets / (1024 * 1024);
  return `${mo.toLocaleString(langue === 'fr' ? 'fr-FR' : 'en-US', { maximumFractionDigits: 0 })} ${langue === 'fr' ? 'Mo' : 'MB'}`;
};

const TEXTES = {
  fr: {
    titre: 'Alanya Coffre-fort pour Windows et Linux',
    description:
      "Le coffre-fort Alanya sur l'ordinateur : parcourir, ajouter, télécharger et ranger ses fichiers, et sauvegarder des dossiers du PC.",
    h1: 'Alanya Coffre-fort sur ordinateur',
    chapo: "Votre coffre-fort Alanya sur Windows et Linux : parcourir et regarder vos fichiers, en ajouter par glisser-déposer, les télécharger, les ranger, et sauvegarder des dossiers du PC.",
    bientot: "Bientôt disponible. Revenez dans quelques jours.",
    version: (v, d) => `Version ${v}${d ? ` · ${d}` : ''}`,
    windows: 'Télécharger pour Windows',
    deb: 'Linux : Ubuntu, Debian, Mint (.deb)',
    appimage: 'Linux : autres distributions (AppImage)',
    nouveau: 'Nouveautés',
    installer: 'Installer',
    winTitre: 'Sous Windows (10 ou 11, 64 bits)',
    winEtapes: [
      'Ouvrez le fichier téléchargé.',
      "Windows affiche « Windows a protégé votre ordinateur » : l'installateur n'est pas signé (un certificat de signature est payant). Cliquez sur « Informations complémentaires », puis « Exécuter quand même ».",
      "Suivez l'installateur. « Alanya Coffre-fort » apparaît dans le menu Démarrer.",
    ],
    linTitre: 'Sous Linux (64 bits)',
    linEtapes: [
      'Ubuntu, Debian, Mint : ouvrez le fichier .deb d\'un double-clic ; la logithèque l\'installe et l\'application apparaît dans le menu.',
      "Autres distributions : autorisez l'exécution de l'AppImage (clic droit › Propriétés › Autoriser l'exécution), puis ouvrez-la. Rien à installer.",
    ],
    connecter: 'Se connecter',
    connEtapes: [
      "Ouvrez l'application sur l'ordinateur : elle affiche un code QR.",
      'Sur votre téléphone, ouvrez Alanya › Compte et sécurité › Lier un nouvel appareil.',
      'Scannez le code, puis confirmez sur le téléphone.',
    ],
    mettreAJour: "Mettre à jour : quand une nouvelle version sort, l'application le signale. Téléchargez-la ici et installez-la par-dessus, sans perdre votre connexion.",
    empreintes: 'Empreintes SHA-256',
  },
  en: {
    titre: 'Alanya SafeBox for Windows and Linux',
    description:
      'Your Alanya SafeBox on the computer: browse, add, download and organise your files, and back up PC folders.',
    h1: 'Alanya SafeBox on your computer',
    chapo: 'Your Alanya SafeBox on Windows and Linux: browse and view your files, add them by drag and drop, download them, organise them, and back up PC folders.',
    bientot: 'Coming soon. Check back in a few days.',
    version: (v, d) => `Version ${v}${d ? ` · ${d}` : ''}`,
    windows: 'Download for Windows',
    deb: 'Linux: Ubuntu, Debian, Mint (.deb)',
    appimage: 'Linux: other distributions (AppImage)',
    nouveau: "What's new",
    installer: 'Install',
    winTitre: 'On Windows (10 or 11, 64-bit)',
    winEtapes: [
      'Open the downloaded file.',
      'Windows shows “Windows protected your PC”: the installer isn\'t signed (a signing certificate costs money). Click “More info”, then “Run anyway”.',
      'Follow the installer. “Alanya Coffre-fort” appears in the Start menu.',
    ],
    linTitre: 'On Linux (64-bit)',
    linEtapes: [
      'Ubuntu, Debian, Mint: double-click the .deb file; the software centre installs it and the app appears in the menu.',
      'Other distributions: allow the AppImage to run (right-click › Properties › Allow executing), then open it. Nothing to install.',
    ],
    connecter: 'Sign in',
    connEtapes: [
      'Open the app on the computer: it shows a QR code.',
      'On your phone, open Alanya › Account and security › Link a new device.',
      'Scan the code, then confirm on the phone.',
    ],
    mettreAJour: 'Updating: when a new version comes out, the app tells you. Download it here and install it over the old one; you stay signed in.',
    empreintes: 'SHA-256 checksums',
  },
};

function corps(langue, v) {
  const t = TEXTES[langue];
  const liste = (etapes) => `<ol>${etapes.map((e) => `<li>${esc(e)}</li>`).join('')}</ol>`;
  const bouton = (fiche, libelle, secondaire) =>
    fiche
      ? `<a class="cta${secondaire ? ' sec' : ''}" href="/coffre/files/${encodeURIComponent(fiche.file)}" download>${esc(libelle)}${fiche.bytes ? ` · ${esc(taille(fiche.bytes, langue))}` : ''}</a>`
      : '';
  const fiches = v ? [v.windows, v.deb, v.appimage].filter(Boolean) : [];
  const notes = v?.notes?.[langue];
  return `
<h1>${esc(t.h1)}</h1>
<p class="maj">${v ? esc(t.version(v.version, v.date)) : esc(t.bientot)}</p>
<p>${esc(t.chapo)}</p>
${v ? `<p>${bouton(v.windows, t.windows, false)}${bouton(v.deb, t.deb, true)}${bouton(v.appimage, t.appimage, true)}</p>` : ''}
${notes ? `<h2>${esc(t.nouveau)}</h2><p>${esc(notes)}</p>` : ''}
<h2>${esc(t.installer)}</h2>
<h3>${esc(t.winTitre)}</h3>
${liste(t.winEtapes)}
<h3>${esc(t.linTitre)}</h3>
${liste(t.linEtapes)}
<h2>${esc(t.connecter)}</h2>
${liste(t.connEtapes)}
<p>${esc(t.mettreAJour)}</p>
${fiches.some((f) => f.sha256) ? `<h2>${esc(t.empreintes)}</h2><p style="font-size:13px;word-break:break-all">${fiches
    .filter((f) => f.sha256)
    .map((f) => `${esc(f.file)}<br><code>${esc(f.sha256)}</code>`)
    .join('<br>')}</p>` : ''}`;
}

/** GET /coffre */
function showDesktopPage(req, res) {
  const langue = langueDe(req);
  const t = TEXTES[langue];
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(renderPage({
    titre: t.titre,
    description: t.description,
    chemin: '/coffre',
    langue,
    corps: corps(langue, lireVersion()),
  }));
}

/** GET /coffre/version.json : 404 tant qu'aucune version n'est publiée. */
function showVersion(req, res) {
  const v = lireVersion();
  res.set('Cache-Control', 'no-cache');
  if (!v) return res.status(404).json({ error: 'Aucune version publiée' });
  return res.json(v);
}

/** GET /coffre/files/:nom : seulement un fichier annoncé par version.json. */
function sendFile(req, res) {
  const v = lireVersion();
  const nom = String(req.params.nom || '');
  const annonces = v ? [v.windows, v.deb, v.appimage].filter(Boolean).map((f) => f.file) : [];
  if (!NOM_SUR.test(nom) || !annonces.includes(nom)) {
    return res.status(404).type('text').send('Introuvable');
  }
  res.set('Cache-Control', 'public, max-age=86400');
  return res.download(path.join(dossier(), nom), nom, (err) => {
    if (err && !res.headersSent) res.status(404).type('text').send('Introuvable');
  });
}

module.exports = { showDesktopPage, showVersion, sendFile, lireVersion, valider };
