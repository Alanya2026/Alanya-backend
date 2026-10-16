/**
 * Règles pures de l'abonnement : aucune lecture ni écriture en base.
 *
 * Tout ce qui DÉCIDE vit ici, pour être testé sans MySQL (src/services/billing/
 * rules.test.js, lancé par la CI). Les services qui lisent la base
 * (settings.js, catalog.js, entitlements.js) ne font que rassembler les faits
 * et appeler ces fonctions.
 */

const {
  PHASE, BILLING_MODEL, MIN_GRACE_DAYS, OFFLINE_TRUST_DAYS, TIER_LIMITS,
} = require('../../constants/billing');

const DAY_MS = 86_400_000;

const toDate = (v) => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const iso = (v) => toDate(v)?.toISOString() ?? null;

/** La plus proche des dates données (les nulles sont ignorées). */
function earliest(...dates) {
  const valid = dates.map(toDate).filter(Boolean);
  if (!valid.length) return null;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

/**
 * Phase du payant à l'instant `now`.
 * Interrupteur éteint : gratuit. Allumé : grâce jusqu'à `grace_until`, payant
 * ensuite.
 */
function phaseAt(settings, now = new Date()) {
  if (!settings || Number(settings.paid_enabled) !== 1) return PHASE.FREE;
  const graceUntil = toDate(settings.grace_until);
  if (graceUntil && now < graceUntil) return PHASE.GRACE;
  return PHASE.PAID;
}

/** Régime en vigueur. Sans réglage (migration 090 absente), c'est Alanya Plus. */
function billingModel(settings) {
  return Number(settings?.model) === BILLING_MODEL.TRIAL
    ? BILLING_MODEL.TRIAL
    : BILLING_MODEL.PLUS;
}

/**
 * Fin de l'essai d'un compte (régime TRIAL) : trois mois après l'inscription,
 * repoussés à la fin de la grâce quand le payant vient d'être allumé — c'est
 * ce qui donne trois mois aux comptes déjà là le jour de l'activation.
 *
 * Se déduit, ne se stocke pas : aucune ligne par inscription, et régler
 * `trial_days` vaut pour tout le monde. Nulle sans date d'inscription.
 */
function trialEndsAt({ createdAt, settings }) {
  const created = toDate(createdAt);
  if (!created) return null;
  const natural = new Date(created.getTime() + (Number(settings?.trial_days) || 0) * DAY_MS);
  const grace = Number(settings?.paid_enabled) === 1 ? toDate(settings.grace_until) : null;
  return grace && grace > natural ? grace : natural;
}

/**
 * Jusqu'où une nouvelle période ne peut pas commencer à cause de l'essai :
 * payer pendant l'essai ne le consomme pas, la période d'un an commence à sa
 * fin. Nulle en régime PLUS, ou l'essai fini.
 */
function trialFloor({ settings, createdAt, now = new Date() }) {
  if (billingModel(settings) !== BILLING_MODEL.TRIAL) return null;
  const end = trialEndsAt({ createdAt, settings });
  return end && end > now ? end : null;
}

/**
 * Le compte a-t-il payé ? Phase payante, et un abonnement en cours (payé,
 * offert, par code) ou un compte exempté. Pendant l'essai, la grâce, ou payant
 * éteint : non, même avec une période à venir.
 */
function isPaidTier({
  phase, exempt = false, coveredUntil = null, now = new Date(),
}) {
  if (phase !== PHASE.PAID) return false;
  if (exempt) return true;
  const covered = toDate(coveredUntil);
  return Boolean(covered && covered > now);
}

/** Les plafonds d'envoi d'un palier : taille d'un fichier, médias par album. */
function tierLimits(paid) {
  return paid ? TIER_LIMITS.paid : TIER_LIMITS.standard;
}

/** Combien de jours avant la fin d'essai on prévient, et combien après on s'en abstient. */
const TRIAL_ENDING_DAYS = 7;
const TRIAL_ENDED_GRACE_DAYS = 14;

/**
 * Quelle notification de fin d'essai un compte mérite-t-il maintenant ?
 *
 * `ending` dans les sept derniers jours ; `ended` jusqu'à quatorze jours après
 * (au-delà, prévenir serait du bruit : le compte a déjà vu le refus). La
 * requête du balayage ne fait que dégrossir — c'est CETTE règle qui tranche,
 * si bien qu'une requête trop large n'envoie jamais un mauvais message.
 *
 * @returns {'ending'|'ended'|null}
 */
function trialNoticeFor({ endsAt, now = new Date() }) {
  const end = toDate(endsAt);
  if (!end) return null;
  const ms = end.getTime() - now.getTime();
  if (ms > 0 && ms <= TRIAL_ENDING_DAYS * DAY_MS) return 'ending';
  if (ms <= 0 && -ms <= TRIAL_ENDED_GRACE_DAYS * DAY_MS) return 'ended';
  return null;
}

/**
 * Le compte peut-il ÉMETTRE (envoyer un message, lancer un appel) ?
 *
 * Seule règle de l'envoi : le verrou serveur et `features.outgoing` des droits
 * l'appellent, pour ne jamais diverger. Recevoir n'est jamais soumis à rien.
 *
 * `until` : l'instant où cette réponse cesse de valoir (fin d'essai, fin de la
 * période qui couvre), pour que le verrou ne garde pas un « oui » trop
 * longtemps. Nul quand rien de connu ne la fera changer.
 *
 * @param {object} p
 * @param {object} p.settings
 * @param {string} p.phase                 free | grace | paid (déjà ajustée pour un testeur)
 * @param {Date|string|null} p.createdAt   users.created_at
 * @param {boolean} [p.exempt]             équipe ou compte officiel
 * @param {Date|string|null} [p.coveredUntil] fin de la période qui couvre `now`, s'il y en a une
 * @returns {{ allowed: boolean, until: Date|null }}
 */
function outgoingDecision({
  settings, phase, createdAt, exempt = false, coveredUntil = null, now = new Date(),
}) {
  if (billingModel(settings) !== BILLING_MODEL.TRIAL) return { allowed: true, until: null };
  if (phase !== PHASE.PAID || exempt) return { allowed: true, until: null };
  const trialEnd = trialEndsAt({ createdAt, settings });
  if (trialEnd && now < trialEnd) return { allowed: true, until: trialEnd };
  const covered = toDate(coveredUntil);
  if (covered && covered > now) return { allowed: true, until: covered };
  return { allowed: false, until: null };
}

/**
 * Période en cours, fin de la chaîne de périodes contiguës, première période
 * à venir.
 *
 * Renouveler en avance crée une période qui commence à la fin de la
 * précédente : pour l'utilisateur, l'abonnement court jusqu'à la fin de la
 * CHAÎNE, pas de la période en cours. Une période payée pendant la grâce
 * commence à sa fin : elle est « à venir ».
 *
 * @param {Array<{starts_at, ends_at}>} periods toutes celles qui finissent après `now`
 */
function resolvePeriods(periods, now = new Date()) {
  const sorted = [...(periods || [])]
    .map((p) => ({ ...p, _s: toDate(p.starts_at), _e: toDate(p.ends_at) }))
    .filter((p) => p._s && p._e && p._e > now)
    .sort((a, b) => a._s - b._s);

  const current = sorted.find((p) => p._s <= now) || null;
  const upcoming = sorted.find((p) => p._s > now) || null;

  let chainEnd = null;
  if (current) {
    chainEnd = current._e;
    for (const p of sorted) {
      if (p._s <= chainEnd && p._e > chainEnd) chainEnd = p._e;
    }
  }

  const strip = (p) => {
    if (!p) return null;
    const { _s, _e, ...rest } = p;
    return rest;
  };
  return { current: strip(current), upcoming: strip(upcoming), chainEnd };
}

/**
 * Le cœur : les droits d'un compte, à partir des faits.
 *
 * Une fonctionnalité est ouverte si elle est livrée ET (gratuite, ou hors
 * phase payante, ou compte exempté, ou incluse dans le plan de la période en
 * cours). La coche (`verified_badge`) est une fonctionnalité comme une autre :
 * son affichage demande EN PLUS une identité vérifiée, ce que décide la
 * vérification (lot E), pas ce calcul.
 *
 * @param {object} p
 * @param {object} p.settings          ligne billing_settings
 * @param {Array}  p.periods           périodes qui finissent après `now`, avec `plan_code`, `source`
 * @param {Array<{code, is_paid, is_available}>} p.catalog
 * @param {string[]} [p.planFeatures]  codes inclus dans le plan de la période en cours
 * @param {boolean}  [p.exempt]        administrateur ou compte officiel
 * @param {boolean}  [p.autoRenew]
 * @param {Date|string} [p.lastEnd]    fin de la dernière chaîne (subscriber.current_end)
 * @param {Date|string} [p.purgeAfter] données payantes conservées jusque-là
 * @param {Date|string} [p.purgedAt]   … puis effacées à cette date
 * @param {Date|string} [p.createdAt]  inscription du compte (fin d'essai, régime TRIAL)
 * @param {{standardDays: number, plusDays: number}} [p.mediaDays]
 *        durées de conservation des médias (réglages de la purge `media`)
 * @param {Date}     [p.now]
 */
function decideEntitlements({
  settings,
  periods = [],
  catalog = [],
  planFeatures = [],
  exempt = false,
  autoRenew = false,
  lastEnd = null,
  purgeAfter = null,
  purgedAt = null,
  createdAt = null,
  mediaDays = null,
  now = new Date(),
}) {
  const phase = phaseAt(settings, now);
  const { current, upcoming, chainEnd } = resolvePeriods(periods, now);
  const included = current ? planFeatures : [];

  // Régime TRIAL : pendant l'essai, tout est ouvert ; ensuite, seul un
  // abonnement rouvre les fonctionnalités et l'envoi. En phase gratuite,
  // aucun décompte n'est montré — il serait faux à l'activation, qui rouvre
  // une grâce.
  const model = billingModel(settings);
  const trialEnd = model === BILLING_MODEL.TRIAL && !exempt && phase !== PHASE.FREE
    ? trialEndsAt({ createdAt, settings })
    : null;
  const inTrial = Boolean(trialEnd) && now < trialEnd;

  const features = {};
  for (const f of catalog) {
    const available = Number(f.is_available) === 1;
    features[f.code] = available && (
      Number(f.is_paid) === 0
      || phase !== PHASE.PAID
      || exempt
      || inTrial
      || included.includes(f.code)
    );
  }
  // Le droit d'émettre n'est pas au catalogue : l'administration ne peut ni le
  // rendre gratuit ni le retirer d'un plan.
  features.outgoing = outgoingDecision({
    settings, phase, createdAt, exempt, coveredUntil: current ? chainEnd : null, now,
  }).allowed;

  const graceUntil = phase === PHASE.GRACE ? toDate(settings.grace_until) : null;
  const describe = (p, endsAt) => (p
    ? {
      plan: p.plan_code ?? null,
      startsAt: iso(p.starts_at),
      endsAt: iso(endsAt ?? p.ends_at),
      source: Number(p.source) || 0,
      autoRenew: Boolean(autoRenew),
    }
    : null);

  const paidTier = isPaidTier({
    phase, exempt, coveredUntil: current ? chainEnd : null, now,
  });

  return {
    phase,
    model,
    // Ce que ce compte peut envoyer : le téléphone lit ces plafonds au lieu de
    // les coder en dur, et le serveur les applique (uploadLimits.js).
    limits: { ...tierLimits(paidTier), tier: paidTier ? 'paid' : 'standard' },
    graceUntil: iso(graceUntil),
    trial: trialEnd ? { endsAt: iso(trialEnd), active: inTrial } : null,
    period: describe(current, chainEnd),
    upcoming: describe(upcoming),
    exempt: Boolean(exempt),
    features,
    // L'abonnement a pris fin et rien n'a pris le relais : l'application dit
    // « terminé le … » plutôt que de revendre l'offre comme à un inconnu.
    lapsedAt: !current && !upcoming && toDate(lastEnd) && toDate(lastEnd) <= now
      ? iso(lastEnd)
      : null,
    // Données payantes conservées jusqu'à `purgeAfter`, puis effacées
    // (`purgedAt`) : le téléphone affiche la date, puis efface à son tour ce
    // qu'il garde localement. Sans objet tant qu'une période court.
    purgeAfter: !current && !upcoming ? iso(purgeAfter) : null,
    purgedAt: !current && !upcoming ? iso(purgedAt) : null,
    // Au-delà, le téléphone doit redemander ses droits : la fin de
    // l'abonnement, la fin de la grâce, ou une semaine au plus.
    validUntil: iso(earliest(
      chainEnd,
      graceUntil,
      inTrial ? trialEnd : null,
      new Date(now.getTime() + OFFLINE_TRUST_DAYS * DAY_MS),
    )),
    // Durée pendant laquelle CE compte peut télécharger un média depuis le
    // serveur. Le fichier peut vivre plus longtemps, gardé par un autre membre
    // abonné de la discussion : c'est au téléphone de s'arrêter à cette durée,
    // le serveur ne sachant pas qui télécharge.
    mediaRetentionDays: mediaDays
      ? mediaRetentionDays({
        covered: mediaRetentionCovered({
          phase,
          exempt,
          sub: { current_end: lastEnd, purge_after: purgeAfter, purged_at: purgedAt },
          now,
        }),
        ...mediaDays,
      })
      : null,
  };
}

/**
 * Le compte garde-t-il ses médias la durée longue (Alanya Plus) ?
 *
 * Seulement en phase payante : tant que l'offre est gratuite ou en grâce,
 * tout le monde est à la durée standard. Ensuite, un compte exempté, ou un
 * abonné jusqu'à la purge de ses données payantes — le délai commun après
 * l'échéance, annoncé par la notification d'avertissement, vaut aussi pour
 * les médias. Tant que l'échéance n'a pas encore été traitée (`purge_after`
 * vide), le compte reste couvert : mieux vaut garder un jour de trop.
 *
 * ⚠ Recopiée en SQL dans `mediaRetention.js` (`compteCouvert`) : la purge
 * nocturne l'applique à des milliers de messages d'un coup. Toute
 * modification ici doit y être reportée.
 *
 * @param {object} p
 * @param {string} p.phase
 * @param {boolean} [p.exempt]  administrateur ou compte officiel
 * @param {{current_end, purge_after, purged_at}|null} [p.sub] ligne subscriber
 */
function mediaRetentionCovered({ phase, exempt = false, sub = null, now = new Date() }) {
  if (phase !== PHASE.PAID) return false;
  if (exempt) return true;
  if (!sub || sub.purged_at) return false;
  const end = toDate(sub.current_end);
  if (!end) return false;
  if (end > now) return true;
  const due = toDate(sub.purge_after);
  return !due || due > now;
}

/**
 * Durée de conservation qui s'applique à un compte. La durée longue ne peut
 * pas être plus courte que la standard, même mal réglée depuis l'admin.
 */
function mediaRetentionDays({ covered, standardDays, plusDays }) {
  return covered ? Math.max(standardDays, plusDays) : standardDays;
}

/** Fournisseur de paiement actif (variable d'environnement, secrets à côté). */
function paymentProvider(env = process.env) {
  return String(env.PAYMENT_PROVIDER || 'simulated').trim().toLowerCase();
}

/**
 * Ce qui empêche d'activer le payant, ou null.
 * En production, le simulateur ne doit jamais encaisser : tant qu'il est le
 * fournisseur actif, n'importe qui obtiendrait un abonnement réel avec un
 * paiement fictif.
 */
function activationBlocker(env = process.env) {
  if (env.NODE_ENV === 'production' && paymentProvider(env) === 'simulated') {
    return 'BILLING_PROVIDER_SIMULATED';
  }
  return null;
}

/**
 * Le régime TRIAL se paie par des codes : sans le secret qui les signe, on ne
 * peut en émettre aucun, ni en vérifier un. Trente-deux caractères au moins,
 * comme `VAULT_KEY` : un secret court se devine.
 */
function codeSecretBlocker(env = process.env) {
  return String(env.ACTIVATION_CODE_SECRET || '').length >= 32 ? null : 'BILLING_CODE_SECRET_MISSING';
}

/** Ce qui empêche d'activer le payant, selon le régime en vigueur. */
function activationBlockerFor(model, env = process.env) {
  return Number(model) === BILLING_MODEL.TRIAL ? codeSecretBlocker(env) : activationBlocker(env);
}

/**
 * Ce qui empêche un compte d'acheter hors abonnement (le numéro choisi), ou
 * null.
 *
 * Ces achats n'ont pas d'interrupteur : ils sont en vente dès qu'un
 * fournisseur encaisse vraiment. Reste la règle du simulateur — en
 * production il confirme sans rien encaisser, il ne sert donc qu'aux comptes
 * testeurs. Brancher un agrégateur ouvre la vente à tous, sans autre geste.
 */
function purchaseBlocker(alanyaID, env = process.env) {
  if (isBillingTester(alanyaID, env)) return null;
  return activationBlocker(env);
}

/** Entier strict : nombre entier, ou chaîne de chiffres. */
function toStrictInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

const bad = (code, error) => ({ ok: false, code, error });

/** Réglages modifiables par PUT /admin/billing/settings. */
function parseSettingsPatch(body) {
  const src = body || {};
  const value = {};
  const bounds = {
    default_grace_days: [MIN_GRACE_DAYS, 365],
    trial_days: [0, 365],
    retention_days: [0, 365],
    codes_per_payment: [1, 10],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (src[key] === undefined) continue;
    const n = toStrictInt(src[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return bad(key === 'default_grace_days' ? 'INVALID_GRACE' : 'INVALID_BILLING_SETTING',
        `${key} doit être un entier entre ${min} et ${max}`);
    }
    value[key] = n;
  }
  // Le régime a son verbe (POST /admin/billing/model) : motif obligatoire, et
  // seulement payant éteint. Le laisser passer ici contournerait les deux.
  if (src.model !== undefined) {
    return bad('FIELD_IMMUTABLE', 'Le régime se change par /admin/billing/model');
  }
  if (src.pay_url !== undefined) {
    const url = parsePayUrl(src.pay_url);
    if (url === undefined) return bad('INVALID_BILLING_SETTING', 'pay_url doit être une adresse https de 255 caractères au plus');
    value.pay_url = url;
  }
  if (!Object.keys(value).length) return bad('NO_FIELDS_TO_UPDATE', 'Aucune modification');
  return { ok: true, value };
}

/**
 * Adresse du site de paiement : https obligatoire (l'application l'ouvre dans le
 * navigateur, et un code se saisit après un paiement), ni identifiants ni
 * fragment. Vide ou nulle : effacée, le bouton de l'application se grise.
 *
 * @returns {string|null|undefined} undefined si invalide
 */
function parsePayUrl(v) {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return null;
  if (typeof v !== 'string' || v.trim().length > 255) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || !u.hostname.includes('.')) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

const PLAN_CODE_RE = /^[a-z0-9_]{3,40}$/;
const LOCALES = ['fr', 'en', 'zh'];
const REQUIRED_LOCALES = ['fr', 'en'];

/** Nom ou description multilingue : fr et en obligatoires (si `required`). */
function parseI18n(v, { required, max }) {
  if (v == null) return required ? null : undefined;
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const lang of LOCALES) {
    if (v[lang] == null || v[lang] === '') continue;
    if (typeof v[lang] !== 'string' || v[lang].trim().length > max) return null;
    out[lang] = v[lang].trim();
  }
  if (required && REQUIRED_LOCALES.some((l) => !out[l])) return null;
  return out;
}

/**
 * Corps de POST /admin/billing/plans (création) et PUT /admin/billing/plans/:id
 * (modification, `partial`). Le code d'un plan ne change jamais : il sert de
 * référence stable aux produits des stores et au journal.
 */
function parsePlanPayload(body, { partial = false } = {}) {
  const src = body || {};
  const value = {};

  if (!partial) {
    if (typeof src.code !== 'string' || !PLAN_CODE_RE.test(src.code)) {
      return bad('INVALID_PLAN', 'code : 3 à 40 caractères parmi a-z, 0-9 et _');
    }
    value.code = src.code;
  } else if (src.code !== undefined) {
    return bad('FIELD_IMMUTABLE', 'Le code d\'un plan ne se modifie pas');
  }

  if (!partial || src.name_i18n !== undefined) {
    const name = parseI18n(src.name_i18n, { required: true, max: 60 });
    if (!name) return bad('INVALID_PLAN', 'name_i18n : fr et en obligatoires, 60 caractères au plus');
    value.name_i18n = name;
  }

  const ints = {
    duration_months: [1, 36],
    price_amount: [0, 10_000_000],
    reminder_days: [0, 90],
    sort_order: [0, 10_000],
  };
  for (const [key, [min, max]] of Object.entries(ints)) {
    if (src[key] === undefined) {
      if (!partial && key !== 'sort_order') return bad('INVALID_PLAN', `${key} requis`);
      continue;
    }
    const n = toStrictInt(src[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return bad('INVALID_PLAN', `${key} doit être un entier entre ${min} et ${max}`);
    }
    value[key] = n;
  }

  // Une relance ne peut pas précéder le début de la période : « 30 jours
  // avant » n'a pas de sens pour un plan d'un mois.
  if (value.reminder_days !== undefined && value.duration_months !== undefined
      && value.reminder_days >= value.duration_months * 28) {
    return bad('INVALID_PLAN', 'reminder_days doit être plus court que la durée du plan');
  }

  if (src.currency !== undefined) {
    if (typeof src.currency !== 'string' || !/^[A-Z]{3}$/.test(src.currency)) {
      return bad('INVALID_PLAN', 'currency : code ISO 4217 en trois lettres');
    }
    value.currency = src.currency;
  }

  for (const key of ['is_active', 'is_featured']) {
    if (src[key] === undefined) continue;
    if (typeof src[key] !== 'boolean' && src[key] !== 0 && src[key] !== 1) {
      return bad('INVALID_PLAN', `${key} doit être un booléen`);
    }
    value[key] = src[key] ? 1 : 0;
  }

  for (const key of ['store_product_ios', 'store_product_android']) {
    if (src[key] === undefined) continue;
    if (src[key] === null || src[key] === '') { value[key] = null; continue; }
    if (typeof src[key] !== 'string' || src[key].trim().length > 100) {
      return bad('INVALID_PLAN', `${key} : 100 caractères au plus`);
    }
    value[key] = src[key].trim();
  }

  // Espace du coffre-fort donné par le plan (migration 103) ; null = l'espace
  // de base. Plafonné à 100 Tio : au-delà, c'est une faute de frappe.
  if (src.safebox_bytes !== undefined) {
    if (src.safebox_bytes === null || src.safebox_bytes === '') {
      value.safebox_bytes = null;
    } else {
      const n = toStrictInt(src.safebox_bytes);
      if (!Number.isInteger(n) || n < 0 || n > 100 * 1024 ** 4) {
        return bad('INVALID_PLAN', 'safebox_bytes : un nombre d\'octets entre 0 et 100 Tio, ou null');
      }
      value.safebox_bytes = n;
    }
  }

  if (src.features !== undefined) {
    if (!Array.isArray(src.features) || src.features.some((c) => typeof c !== 'string')) {
      return bad('INVALID_PLAN', 'features : liste de codes de fonctionnalité');
    }
    value.features = [...new Set(src.features)];
  }

  if (partial && !Object.keys(value).length) return bad('NO_FIELDS_TO_UPDATE', 'Aucune modification');
  return { ok: true, value };
}

/** Corps de PUT /admin/billing/features/:code. `is_available` n'y est pas : c'est le code qui livre. */
function parseFeaturePatch(body) {
  const src = body || {};
  const value = {};
  if (src.is_available !== undefined) {
    return bad('FIELD_IMMUTABLE', 'is_available suit le code livré, il ne se règle pas');
  }
  if (src.is_paid !== undefined) {
    if (typeof src.is_paid !== 'boolean' && src.is_paid !== 0 && src.is_paid !== 1) {
      return bad('INVALID_FEATURE', 'is_paid doit être un booléen');
    }
    value.is_paid = src.is_paid ? 1 : 0;
  }
  if (src.name_i18n !== undefined) {
    const name = parseI18n(src.name_i18n, { required: true, max: 60 });
    if (!name) return bad('INVALID_FEATURE', 'name_i18n : fr et en obligatoires');
    value.name_i18n = name;
  }
  if (src.description_i18n !== undefined) {
    const desc = parseI18n(src.description_i18n, { required: false, max: 160 });
    if (desc === null) return bad('INVALID_FEATURE', 'description_i18n : 160 caractères au plus');
    value.description_i18n = desc ?? null;
  }
  if (src.sort_order !== undefined) {
    const n = toStrictInt(src.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return bad('INVALID_FEATURE', 'sort_order invalide');
    value.sort_order = n;
  }
  if (!Object.keys(value).length) return bad('NO_FIELDS_TO_UPDATE', 'Aucune modification');
  return { ok: true, value };
}

/** Motif obligatoire des transitions de l'interrupteur (journalisé par adminAudit). */
function parseReason(body) {
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3) return bad('REASON_REQUIRED', 'Motif obligatoire');
  return { ok: true, value: reason.slice(0, 500) };
}

// ── Échéances (lot D) ────────────────────────────────────────────────────
//
// Les jobs sont posés à l'heure dite et relisent l'état au moment de
// s'exécuter : un renouvellement survenu entre-temps les rend inopérants
// sans qu'il faille les annuler. Ces fonctions tranchent, billingJobs.js agit.

/** Dernier avertissement avant la purge. */
const PURGE_WARNING_DAYS = 7;

/**
 * Deux dates désignent-elles le même instant ? À la seconde près.
 *
 * Les colonnes sont des DATETIME : MySQL en retire les millisecondes (ou les
 * arrondit). Un job posé avec la date calculée en JavaScript (`…782227`) et la
 * ligne relue en base (`…782000`) ne se seraient jamais reconnus, et la relance
 * ou l'avertissement de purge restaient inertes sans que rien ne le dise.
 */
const sameInstant = (a, b) => {
  const x = toDate(a);
  const y = toDate(b);
  return Boolean(x && y && Math.abs(x.getTime() - y.getTime()) < 1000);
};

/**
 * Jobs d'une fin de chaîne : relance (fin − reminderDays), renouvellement
 * automatique (veille), expiration (fin). Une relance déjà passée n'est pas
 * posée — elle partirait sur-le-champ, à contretemps.
 */
function dueSchedule({ end, reminderDays = 0, now = new Date() }) {
  const e = toDate(end);
  if (!e) return [];
  const jobs = [];
  const remindAt = new Date(e.getTime() - Number(reminderDays) * DAY_MS);
  if (Number(reminderDays) > 0 && remindAt > now) jobs.push({ kind: 'billing_reminder', at: remindAt });
  const renewAt = new Date(e.getTime() - DAY_MS);
  if (renewAt > now) jobs.push({ kind: 'billing_autorenew', at: renewAt });
  jobs.push({ kind: 'billing_expire', at: e });
  return jobs;
}

/**
 * Relance : seulement si la fin annoncée par le job est toujours celle de la
 * chaîne (pas de renouvellement depuis), qu'elle est à venir, et hors phase
 * gratuite — rien à renouveler quand tout est offert.
 */
function reminderApplies({ phase, currentEnd, jobEnd, now = new Date() }) {
  return phase !== PHASE.FREE && sameInstant(currentEnd, jobEnd) && toDate(currentEnd) > now;
}

/** Renouvellement automatique : même règle, et un moyen de paiement mémorisé. */
function autoRenewApplies({ phase, sub, jobEnd, now = new Date() }) {
  return reminderApplies({ phase, currentEnd: sub?.current_end, jobEnd, now })
    && Number(sub?.auto_renew) === 1
    && Boolean(sub?.renew_msisdn)
    && Boolean(sub?.renew_channel);
}

/**
 * Échéance : pose la date de purge, une seule fois. Au moins sept jours
 * après aujourd'hui, pour que l'avertissement ait sa chance même si
 * l'expiration est traitée en retard. Notifiée seulement en phase payante :
 * ailleurs, la fin d'un abonnement ne retire rien.
 */
function expiryDecision({ phase, sub, now = new Date(), retentionDays = 30 }) {
  const end = toDate(sub?.current_end);
  if (!end || end > now || sub.purge_after || sub.purged_at) return { action: 'none' };
  const purgeAfter = new Date(Math.max(
    end.getTime() + Number(retentionDays) * DAY_MS,
    now.getTime() + PURGE_WARNING_DAYS * DAY_MS,
  ));
  return { action: 'expire', purgeAfter, notify: phase === PHASE.PAID };
}

/**
 * Purge : jamais hors phase payante — tant que tout est gratuit, ces données
 * servent. Elle est alors reportée d'une rétention, et retentée plus tard.
 */
function purgeDecision({ phase, sub, now = new Date(), retentionDays = 30 }) {
  if (!sub || sub.purged_at) return { action: 'none' };
  const due = toDate(sub.purge_after);
  if (!due || due > now) return { action: 'none' };
  const end = toDate(sub.current_end);
  if (end && end > now) return { action: 'none' };
  if (phase !== PHASE.PAID) {
    return {
      action: 'postpone',
      purgeAfter: new Date(now.getTime() + Math.max(1, Number(retentionDays)) * DAY_MS),
    };
  }
  return { action: 'purge' };
}

/** Dernier avertissement : la purge annoncée tient toujours, en phase payante. */
function purgeWarningApplies({ phase, sub, jobPurgeAfter, now = new Date() }) {
  const end = toDate(sub?.current_end);
  return phase === PHASE.PAID
    && Boolean(sub)
    && !sub.purged_at
    && sameInstant(sub.purge_after, jobPurgeAfter)
    && toDate(sub.purge_after) > now
    && !(end && end > now);
}

/**
 * Compensation au retour au payant : la durée de la phase gratuite, en jours
 * entiers arrondis au-dessus. Zéro si les dates ne décrivent pas un retour.
 */
function compensationDays({ deactivatedAt, activatedAt }) {
  const d = toDate(deactivatedAt);
  const a = toDate(activatedAt);
  if (!d || !a || a <= d) return 0;
  return Math.ceil((a.getTime() - d.getTime()) / DAY_MS);
}

/**
 * Comptes testeurs (BILLING_TEST_USERS=12,34) : ils voient la phase payante
 * même interrupteur éteint, et peuvent acheter. C'est ainsi qu'on éprouve le
 * parcours complet en production sans toucher personne d'autre.
 */
function billingTesterIds(env = process.env) {
  return new Set(
    String(env.BILLING_TEST_USERS || '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

function isBillingTester(alanyaID, env = process.env) {
  return billingTesterIds(env).has(Number(alanyaID));
}

/** Phase vue par un compte : un testeur est toujours en phase payante. */
function effectivePhase(settings, alanyaID, now = new Date(), env = process.env) {
  if (isBillingTester(alanyaID, env)) return PHASE.PAID;
  return phaseAt(settings, now);
}

module.exports = {
  DAY_MS,
  PURGE_WARNING_DAYS,
  sameInstant,
  dueSchedule,
  reminderApplies,
  autoRenewApplies,
  expiryDecision,
  purgeDecision,
  purgeWarningApplies,
  compensationDays,
  effectivePhase,
  billingTesterIds,
  isBillingTester,
  earliest,
  phaseAt,
  billingModel,
  trialEndsAt,
  trialFloor,
  trialNoticeFor,
  isPaidTier,
  tierLimits,
  TRIAL_ENDING_DAYS,
  TRIAL_ENDED_GRACE_DAYS,
  outgoingDecision,
  resolvePeriods,
  decideEntitlements,
  mediaRetentionCovered,
  mediaRetentionDays,
  paymentProvider,
  activationBlocker,
  activationBlockerFor,
  codeSecretBlocker,
  purchaseBlocker,
  parseSettingsPatch,
  parsePayUrl,
  parsePlanPayload,
  parseFeaturePatch,
  parseReason,
};
