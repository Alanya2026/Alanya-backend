const rateLimit = require('express-rate-limit');

// Login / Register — échecs uniquement (brute-force). Les inscriptions réussies
// ne consomment pas ce quota ; voir registerLimiter ci-dessous.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, veuillez réessayer dans 15 minutes' },
  skipSuccessfulRequests: true,
});

// Inscriptions réussies par IP — seuls les 2xx comptent (skipFailedRequests).
const registerLimiter = rateLimit({
  windowMs: Number(process.env.REGISTER_WINDOW_MS) || 24 * 60 * 60 * 1000,
  max: Number(process.env.REGISTER_MAX_PER_IP) || 3,
  skipFailedRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({
    error: 'Trop de comptes créés depuis cette connexion, réessayez plus tard',
    code: 'REGISTER_RATE_LIMITED',
  }),
});

// Messages : envoi
const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de messages, ralentissez' },
});

// Upload fichiers : 20 uploads par minute
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de téléchargement dépassée' },
});

// Résolution de QR : 30 par minute
// Défense en profondeur, pas une contrainte fonctionnelle — un humain qui
// scanne dépasse rarement quelques codes par minute. Le plafond sert à rendre
// non rentable l'énumération des jetons opaques (identité ou session), dont la
// sécurité repose déjà sur leur taille.
const qrResolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de scans, veuillez patienter' },
});

// Numéro choisi : vérification et mise de côté, 30 par minute.
// Une vérification dit si un numéro est porté : sans plafond, elle servirait
// à dresser l'annuaire des numéros attribués. Un humain qui cherche un
// numéro qui lui plaît en essaie quelques-uns, pas trente à la minute.
const phoneCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de vérifications, patientez un instant', code: 'RATE_LIMITED' },
});

// Saisie d'un code d'activation : 40 par quart d'heure et par connexion.
// Le verrou par compte (5 échecs, code_attempt) arrête qui s'acharne sur UN
// compte ; ce plafond arrête qui essaierait d'en user plusieurs depuis une
// même connexion. Un humain n'en tape pas quarante.
const codeRedeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de tentatives, patientez un instant', code: 'RATE_LIMITED' },
});

// Prix public lu par le site de paiement, sans authentification.
const publicOfferLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, patientez un instant', code: 'RATE_LIMITED' },
});

//  API générale
// 300 requêtes par minute par IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requêtes, veuillez ralentir' },
});

// Lecture des médias (`/uploads`) : quota propre, hors `generalLimiter`.
// Une salle de classe sort par une seule IP et chaque membre d'un groupe
// télécharge chaque média reçu : 300 requêtes par minute partagées avec l'API
// ne tenaient pas. Ce quota reste une borne contre l'aspiration en masse ; la
// lecture elle-même ne coûte qu'une redirection.
const mediaReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.MEDIA_READ_MAX_PER_MIN) || 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de téléchargements, patientez un instant', code: 'RATE_LIMITED' },
});

// Partage de packs de stickers (V1b/T6). Clé par COMPTE (le JWT est déjà posé :
// `auth` précède) et non par IP : une classe ou un réseau mobile partagent une
// adresse. Les jetons font 144 bits, donc non énumérables ; ces plafonds
// protègent surtout le stockage (une installation copie jusqu'à 80 fichiers).
const parCompte = (req) => `u${req.user?.alanyaID ?? 'anonyme'}`;
const limiteStickerPartage = (max, message) => rateLimit({
  windowMs: 60 * 1000,
  max,
  keyGenerator: parCompte,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: message, code: 'RATE_LIMITED' },
});
// Résoudre un lien : 30 par minute.
const stickerShareReadLimiter = limiteStickerPartage(30, 'Trop de liens consultés, patientez un instant');
// Installer un pack partagé (copie de fichiers) : 10 par minute.
const stickerShareAddLimiter = limiteStickerPartage(10, 'Trop d\'installations, patientez un instant');
// Créer / révoquer un lien : 20 par minute.
const stickerShareManageLimiter = limiteStickerPartage(20, 'Trop de modifications de lien, patientez un instant');

// Création d'un sticker ANIMÉ (V1c) : 10 par heure et par compte. Chaque
// conversion coûte 3 à 6 s de CPU, 15 s au pire (A16) : la limite protège le
// processeur, pas le stockage. Compte tout ce qui franchit les gardes (un rejet
// pour cause de poids a déjà coûté son CPU) ; les 404 « fermé » en amont ne
// comptent pas. Clé par COMPTE, comme les limiteurs de partage ci-dessus.
const stickerAnimeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  keyGenerator: parCompte,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de stickers animés créés, réessayez plus tard', code: 'RATE_LIMITED' },
});

module.exports = { authLimiter, registerLimiter, messageLimiter, uploadLimiter, qrResolveLimiter, generalLimiter,
  mediaReadLimiter,
  phoneCheckLimiter,
  codeRedeemLimiter,
  publicOfferLimiter,
  stickerShareReadLimiter,
  stickerShareAddLimiter,
  stickerShareManageLimiter,
  stickerAnimeLimiter,
  broadcastSendLimiter: rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Limite de diffusions atteinte (10/h)' },
  }),
  broadcastEstimateLimiter: rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop d\'estimations, patientez' },
  }),
  // Assistance éditoriale : chaque appel part chez un fournisseur facturé au
  // jeton. Le plafond n'est pas une défense contre l'abus — les appelants sont
  // authentifiés et peu nombreux — mais contre la boucle : un bouton qui
  // relance à chaque frappe viderait le crédit avant qu'on s'en aperçoive.
  // 20/min laisse traduire bloc par bloc sans jamais gêner.
  aiEditorialLimiter: rateLimit({
    windowMs: 60 * 1000,
    max: Number(process.env.AI_EDITORIAL_MAX_PER_MIN) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Trop de demandes d\'assistance, patientez' },
  }),
};