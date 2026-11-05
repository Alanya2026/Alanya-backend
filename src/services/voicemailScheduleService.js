/**
 * Planification du répondeur : lecture, écriture, et la seule question qui
 * compte côté appel — « à cet instant, cet utilisateur reçoit-il encore ses
 * appels ? »
 *
 * La FORME du créneau est celle de `dndScheduleService` (migration 033) :
 * `enabled` + `startTime`/`endTime` + `daysBitmask` avec bit0=lundi. C'est un
 * modèle éprouvé, et l'utilisateur règle les deux écrans de la même façon.
 *
 * Deux choses en diffèrent, et ce ne sont pas des détails.
 *
 * 1. L'HEURE. `isDndActive` évalue avec `now.getHours()`, c'est-à-dire l'heure
 *    locale du SERVEUR. Décaler une notification d'une heure se pardonne ;
 *    décider qu'un téléphone ne sonnera pas, non. On évalue donc dans le fuseau
 *    du compte, résolu par la cascade de `resolveTimezone`.
 *
 * 2. L'ÉCHÉANCE. `untilAt` porte l'activation ponctuelle, et elle est toujours
 *    datée : il n'existe aucun mode « actif jusqu'à nouvel ordre ». C'est un
 *    instant ABSOLU (le pool est en `timezone: 'Z'`), calculé sur l'appareil et
 *    envoyé en UTC — ce chemin-là ne dépend donc d'aucun fuseau.
 */

const pool = require('../config/db');
const slots = require('./voicemailSlots');

const DEFAULT_SCHEDULE = Object.freeze({
  /** Les plages programmées s'appliquent-elles ? */
  enabled: 0,
  /** Bascule au répondeur sur non-réponse, refus, ou ligne occupée. */
  no_answer_enabled: 0,
  untilAt: null,
  timezone: null,
  bypassListId: null,
  greeting_url: null,
  greeting_seconds: null,
  slots: [],
});

/** Dernier recours de la cascade : le fuseau du marché principal. */
const FALLBACK_TIMEZONE = 'Africa/Douala';

/**
 * Plafond de l'activation ponctuelle.
 *
 * Vingt-quatre heures, pas davantage. Ce n'est pas une limite technique : c'est
 * la même règle que « aucune activation sans échéance ». Une durée qu'on peut
 * pousser à une semaine redevient un réglage qu'on oublie, et son propriétaire
 * croit son téléphone joignable. Qui veut une indisponibilité durable passe par
 * les plages, qui s'éteignent d'elles-mêmes chaque jour.
 */
const MAX_UNTIL_MS = 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
//  Fuseau
// ─────────────────────────────────────────────────────────────────────────────

/** Vrai si `Intl` accepte cet identifiant — le seul juge qui compte ici. */
const isValidTimezone = (tz) => {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch (_) {
    return false;
  }
};

/**
 * La cascade : ce que l'appareil a posé, sinon le pays du compte, sinon le
 * serveur, sinon le marché principal.
 *
 * `pays.timeZone` contient de vrais identifiants IANA et est déjà joint par
 * compte dans tout le backend — c'est le choix documenté par la migration 017.
 * Un fuseau invalide (donnée héritée, pays mal renseigné) est ignoré sans
 * jeter : une planification illisible ne doit jamais faire échouer un appel.
 */
const resolveTimezone = ({ scheduleTimezone, countryTimezone } = {}) => {
  if (isValidTimezone(scheduleTimezone)) return scheduleTimezone;
  if (isValidTimezone(countryTimezone)) return countryTimezone;
  if (isValidTimezone(process.env.TZ)) return process.env.TZ;
  return FALLBACK_TIMEZONE;
};

/**
 * L'heure murale dans un fuseau, décomposée.
 *
 * Deux pièges silencieux sont désamorcés ici :
 *
 * — `hour` peut valoir `'24'` à minuit pile selon l'implémentation ICU, avec
 *   `hour12: false`. Non ramené modulo 24, il décale l'évaluation d'un jour
 *   entier, une minute par nuit.
 *
 * — le jour de la semaine ne doit JAMAIS être lu dans un nom de jour localisé
 *   (`weekday: 'short'`), qui dépend de la locale et des données ICU
 *   disponibles. On le dérive de la date civile via `Date.UTC`, qui est
 *   invariant.
 */
const civilPartsInZone = (date, timeZone) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );

  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  const h = Number(parts.hour) % 24;
  const mi = Number(parts.minute);
  const s = Number(parts.second);
  const jsDay = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

  return { y, m, d, h, mi, s, minutes: h * 60 + mi, dayBit: jsDay === 0 ? 6 : jsDay - 1 };
};

/** `YYYY-MM-DD` dans le fuseau donné — la clé de journée du plafond quotidien. */
const civilDayKey = (date, timeZone) => {
  const c = civilPartsInZone(date, timeZone);
  return `${c.y}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
};

/** Décalage du fuseau, en minutes, à cet instant précis. */
const _offsetMinutesAt = (date, timeZone) => {
  const c = civilPartsInZone(date, timeZone);
  const asUtc = Date.UTC(c.y, c.m - 1, c.d, c.h, c.mi, c.s);
  return Math.round((asUtc - date.getTime()) / 60000);
};

/**
 * Une heure murale → l'instant absolu correspondant.
 *
 * Deux passes : la première utilise le décalage d'aujourd'hui, la seconde le
 * corrige si l'échéance tombe de l'autre côté d'un changement d'heure. Sans la
 * seconde, le bandeau disparaîtrait une heure trop tôt ou trop tard deux nuits
 * par an — visible, et impossible à reproduire le reste de l'année.
 */
const _wallToInstant = (y, m, d, hour, minute, timeZone) => {
  const naive = Date.UTC(y, m - 1, d, hour, minute);
  const premier = _offsetMinutesAt(new Date(naive), timeZone);
  let instant = naive - premier * 60000;
  const second = _offsetMinutesAt(new Date(instant), timeZone);
  if (second !== premier) instant = naive - second * 60000;
  return new Date(instant);
};

// ─────────────────────────────────────────────────────────────────────────────
//  Règles pures
// ─────────────────────────────────────────────────────────────────────────────

const _untilInstant = (schedule) => {
  if (schedule?.untilAt == null) return null;
  const t = new Date(schedule.untilAt);
  return Number.isNaN(t.getTime()) ? null : t;
};

/** L'activation ponctuelle court-elle encore ? Comparaison d'instants, sans fuseau. */
const isUntilActive = (schedule, now = new Date()) => {
  const until = _untilInstant(schedule);
  return until != null && until.getTime() > now.getTime();
};

/**
 * Les plages programmées couvrent-elles cet instant ?
 *
 * Le calendrier lui-même vit dans `voicemailSlots`, qui ne connaît aucun
 * fuseau : on lui passe une heure murale déjà résolue. Ici on ne fait que
 * résoudre le fuseau, une fois, au même endroit que tout le reste.
 *
 * `schedule.slots` est attaché par `loadUserVoicemailSchedule`. Un appelant qui
 * construit un créneau à la main sans plages obtient simplement « inactif ».
 */
const isSlotActive = (schedule, now = new Date(), timeZone = FALLBACK_TIMEZONE) => {
  if (!schedule?.enabled) return false;
  return slots.isAnySlotActive(schedule.slots, civilPartsInZone(now, timeZone));
};

/**
 * Le répondeur intercepte-t-il AVANT toute sonnerie, à cet instant ?
 *
 * Ne concerne que les deux modes qui rendent le téléphone muet. L'interrupteur
 * « sans réponse » n'entre PAS ici : il laisse sonner, et ne se décide qu'à
 * l'expiration du délai — voir `noAnswerDelayMs`.
 */
const isVoicemailActive = (schedule, now = new Date(), timeZone = FALLBACK_TIMEZONE) =>
  isUntilActive(schedule, now) || isSlotActive(schedule, now, timeZone);

/**
 * Jusqu'à quand, en instant absolu — ce que le bandeau affiche et ce sur quoi
 * le client arme son minuteur pour se masquer tout seul.
 *
 * `null` veut dire « actif, mais sans échéance calculable » : c'est le cas
 * d'une plage couvrant la journée entière. Le bandeau affiche alors
 * « Répondeur actif » sans heure, plutôt qu'une échéance inventée.
 */
const activeUntil = (schedule, now = new Date(), timeZone = FALLBACK_TIMEZONE) => {
  const candidats = [];

  if (isUntilActive(schedule, now)) candidats.push(_untilInstant(schedule));

  if (schedule?.enabled) {
    const c = civilPartsInZone(now, timeZone);
    const actif = slots.activeSlot(schedule.slots, c);
    if (actif) {
      if (actif.allDay) return null; // aucune fin dans la journée
      const end = slots.timeToMinutes(actif.slot.endTime);
      candidats.push(
        _wallToInstant(
          c.y,
          c.m,
          c.d + (actif.endsTomorrow ? 1 : 0),
          Math.floor(end / 60),
          end % 60,
          timeZone,
        ),
      );
    }
  }

  if (candidats.length === 0) return null;
  // Les deux peuvent courir en même temps : c'est la plus lointaine qui décide.
  return new Date(Math.max(...candidats.map((d) => d.getTime())));
};

/**
 * Le délai avant de déclarer un appel sans réponse, pour CE destinataire.
 *
 * C'est le seul paramètre que l'interrupteur « sans réponse » fait varier — et
 * c'est tout ce dont on a besoin, parce que la DÉCISION (répondeur ou « sans
 * réponse ») est reprise à l'échéance par `onNoAnswer`, qui relit le réglage.
 *
 * Pourquoi 27 s quand l'étiquette dit 30 : la sonnerie CallKit dure 40 s
 * (`callkit_service.dart`). Basculer nettement avant évite la course avec le
 * système qui arrête la sonnerie de son côté — selon qui gagne, l'appelant
 * tomberait tantôt sur le répondeur, tantôt sur « pas de réponse ».
 */
const NO_ANSWER_VOICEMAIL_MS = 27 * 1000;

const noAnswerDelayMs = (schedule, defaultMs) =>
  schedule?.no_answer_enabled ? NO_ANSWER_VOICEMAIL_MS : defaultMs;

/** L'interrupteur « sans réponse / refus / occupé » est-il armé ? */
const isNoAnswerEnabled = (schedule) => !!schedule?.no_answer_enabled;

// ─────────────────────────────────────────────────────────────────────────────
//  Accès base
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le créneau d'un compte, fuseau résolu compris.
 *
 * La requête part de `users` et non de `user_voicemail_schedule` : un compte
 * sans ligne de planification doit quand même rendre son fuseau de pays, sans
 * quoi la cascade perdrait son deuxième étage pour tout le monde au premier
 * jour.
 *
 * Table absente (migration pas encore posée) → répondeur inactif. Une base
 * incomplète ne doit couper aucun appel : le défaut penche toujours du côté
 * « le téléphone sonne ».
 */
const loadUserVoicemailSchedule = async (alanyaID) => {
  let row = null;
  try {
    const [rows] = await pool.execute(
      `SELECT v.enabled, v.no_answer_enabled, v.untilAt, v.timezone,
              v.bypassListId, v.greeting_url, v.greeting_seconds,
              p.timeZone AS countryTimezone
         FROM users u
         LEFT JOIN user_voicemail_schedule v ON v.alanyaID = u.alanyaID
         LEFT JOIN pays p ON p.idPays = u.idPays
        WHERE u.alanyaID = ?`,
      [alanyaID],
    );
    row = rows[0] || null;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
  }

  if (!row) return { ...DEFAULT_SCHEDULE, resolvedTimezone: resolveTimezone({}) };

  // `enabled` est NULL quand la jointure n'a trouvé aucune ligne : c'est un
  // compte sans planification, pas une planification vide.
  const schedule = row.enabled == null
    ? { ...DEFAULT_SCHEDULE }
    : {
        enabled: row.enabled ? 1 : 0,
        no_answer_enabled: row.no_answer_enabled ? 1 : 0,
        untilAt: row.untilAt,
        timezone: row.timezone,
        bypassListId: row.bypassListId,
        greeting_url: row.greeting_url,
        greeting_seconds: row.greeting_seconds == null ? null : Number(row.greeting_seconds),
        slots: [],
      };

  // Les plages ne sont lues que si elles servent. Un compte sans plages
  // programmées — le cas de l'immense majorité — n'y coûte aucune requête, et
  // ce chemin est traversé par CHAQUE appel entrant.
  if (schedule.enabled) {
    schedule.slots = await slots.loadSlots(alanyaID);
  }

  return {
    ...schedule,
    resolvedTimezone: resolveTimezone({
      scheduleTimezone: schedule.timezone,
      countryTimezone: row.countryTimezone,
    }),
  };
};

const upsertUserVoicemailSchedule = async (alanyaID, patch = {}) => {
  const current = await loadUserVoicemailSchedule(alanyaID);
  const next = { ...current, ...patch };

  let untilAt = null;
  if (next.untilAt != null && next.untilAt !== '') {
    const t = new Date(next.untilAt);
    if (Number.isNaN(t.getTime())) throw new Error('untilAt invalide (attendu une date ISO)');
    // Le plafond se mesure depuis MAINTENANT, pas depuis la valeur précédente :
    // sinon on prolongerait indéfiniment par petits pas.
    if (t.getTime() - Date.now() > MAX_UNTIL_MS) {
      throw new Error('untilAt doit être dans les 24 heures');
    }
    untilAt = t;
  }

  // Durée et plages sont EXCLUSIVES, et l'exclusivité se tient ici plutôt que
  // dans l'écran : deux appareils qui écrivent chacun leur mode laisseraient
  // sinon un compte avec les deux armés, et plus personne ne saurait lequel
  // s'applique. Le dernier geste gagne, et il éteint l'autre.
  let enabled = next.enabled ? 1 : 0;
  if (patch.untilAt != null && patch.untilAt !== '') {
    enabled = 0;
  } else if (patch.enabled) {
    untilAt = null;
  }

  if (next.timezone != null && next.timezone !== '' && !isValidTimezone(next.timezone)) {
    throw new Error('timezone invalide (attendu un identifiant IANA)');
  }
  const timezone = next.timezone == null || next.timezone === '' ? null : next.timezone;

  const bypassListId = next.bypassListId == null || next.bypassListId === ''
    ? null
    : Number(next.bypassListId);
  if (bypassListId != null && !Number.isInteger(bypassListId)) {
    throw new Error('bypassListId invalide');
  }

  await pool.execute(
    `INSERT INTO user_voicemail_schedule
       (alanyaID, enabled, no_answer_enabled, untilAt, timezone, bypassListId,
        greeting_url, greeting_seconds)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       enabled           = VALUES(enabled),
       no_answer_enabled = VALUES(no_answer_enabled),
       untilAt           = VALUES(untilAt),
       timezone          = VALUES(timezone),
       bypassListId      = VALUES(bypassListId),
       greeting_url      = VALUES(greeting_url),
       greeting_seconds  = VALUES(greeting_seconds),
       updatedAt         = NOW()`,
    [
      alanyaID,
      enabled,
      next.no_answer_enabled ? 1 : 0,
      untilAt,
      timezone,
      bypassListId,
      next.greeting_url ?? null,
      next.greeting_seconds ?? null,
    ],
  );

  return loadUserVoicemailSchedule(alanyaID);
};

/**
 * Cet appelant fait-il partie de la liste autorisée à faire sonner ?
 *
 * Lecture de clé primaire sur `contact_list_member` — c'est ce qui justifie de
 * n'accepter qu'UNE liste : le contrôle reste gratuit dans le chemin critique
 * de `call_user`.
 */
const isCallerAllowedToRing = async (bypassListId, callerID) => {
  if (bypassListId == null || callerID == null) return false;
  try {
    const [rows] = await pool.execute(
      'SELECT 1 FROM contact_list_member WHERE idList = ? AND idFriend = ? LIMIT 1',
      [bypassListId, callerID],
    );
    return rows.length > 0;
  } catch (e) {
    if (e.code === 'ER_NO_SUCH_TABLE') return false;
    throw e;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  Droit Alanya Plus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le compte a-t-il droit au répondeur (`voicemail`, migration 114) ?
 *
 * Ouvert pendant l'essai ; ensuite, seul un plan qui le liste le rouvre. Ne
 * ferme jamais faute de calcul, comme `requireFeature` : droits introuvables,
 * le répondeur fait ce que son réglage dit. Chargé à la demande — et
 * remplaçable par [_setVoicemailRightChecker] dans les tests, qui simulent la
 * base sans les tables de l'offre.
 */
let _voicemailRight = async (alanyaID) => {
  const { entitlementsOrNull } = require('./billing/entitlements');
  const { FEATURE } = require('../constants/billing');
  const droits = await entitlementsOrNull(alanyaID);
  return !droits || droits.features?.[FEATURE.VOICEMAIL] !== false;
};

const hasVoicemailRight = (alanyaID) => _voicemailRight(alanyaID);

const _setVoicemailRightChecker = (fn) => { _voicemailRight = fn; };

/**
 * Le créneau tel qu'il s'applique aux appels : éteint sans le droit.
 *
 * Le réglage en base n'est pas touché — il reprend dès le paiement. On ne
 * demande les droits que si le créneau ferait quelque chose : l'écrasante
 * majorité des appels n'a aucun répondeur armé.
 */
const _scheduleForCalls = async (alanyaID, schedule, now) => {
  const arme = isVoicemailActive(schedule, now, schedule.resolvedTimezone)
    || isNoAnswerEnabled(schedule);
  if (!arme || await hasVoicemailRight(alanyaID)) return schedule;
  return {
    ...schedule, enabled: 0, untilAt: null, slots: [], no_answer_enabled: 0,
  };
};

/**
 * La décision, pour un appel entrant : faut-il intercepter ?
 *
 * Point d'entrée unique de `call_user`, pour qu'il n'ait pas à réordonner
 * lui-même les trois questions. La liste d'exception n'est interrogée que si le
 * répondeur est par ailleurs actif : une requête de moins sur l'écrasante
 * majorité des appels, qui n'en déclenchent aucun.
 */
const shouldInterceptCall = async (targetID, callerID, now = new Date()) => {
  const schedule = await _scheduleForCalls(
    targetID, await loadUserVoicemailSchedule(targetID), now,
  );
  if (!isVoicemailActive(schedule, now, schedule.resolvedTimezone)) {
    return { intercept: false, schedule };
  }
  if (await isCallerAllowedToRing(schedule.bypassListId, callerID)) {
    return { intercept: false, schedule, bypassed: true };
  }
  return {
    intercept: true,
    schedule,
    activeUntil: activeUntil(schedule, now, schedule.resolvedTimezone),
  };
};

/**
 * Le répondeur doit-il rattraper cet appel après coup ?
 *
 * Question des TROIS déclencheurs qui laissent d'abord sonner : délai sans
 * réponse, refus explicite, ligne occupée. Un seul interrupteur les commande.
 *
 * La liste d'exception n'intervient PAS ici, et c'est délibéré : elle dit qui
 * peut faire sonner malgré le silence. Sur ces trois chemins le téléphone a
 * sonné — ou aurait sonné — pour tout le monde, il n'y a rien à contourner.
 */
const shouldFallBackToVoicemail = async (targetID, now = new Date()) => {
  const schedule = await _scheduleForCalls(
    targetID, await loadUserVoicemailSchedule(targetID), now,
  );
  return { fallback: isNoAnswerEnabled(schedule), schedule };
};

module.exports = {
  DEFAULT_SCHEDULE,
  FALLBACK_TIMEZONE,
  MAX_UNTIL_MS,
  NO_ANSWER_VOICEMAIL_MS,
  isValidTimezone,
  resolveTimezone,
  civilPartsInZone,
  civilDayKey,
  isUntilActive,
  isSlotActive,
  isVoicemailActive,
  isNoAnswerEnabled,
  noAnswerDelayMs,
  activeUntil,
  loadUserVoicemailSchedule,
  upsertUserVoicemailSchedule,
  isCallerAllowedToRing,
  shouldInterceptCall,
  shouldFallBackToVoicemail,
  hasVoicemailRight,
  _setVoicemailRightChecker,
  _wallToInstant,
};
