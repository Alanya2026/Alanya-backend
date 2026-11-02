/**
 * Planification du répondeur v2 : cascade de fuseau, plages par jour,
 * débordement de minuit, plafond des 24 h, exclusivité durée/plages, délai
 * avant bascule.
 *
 * Faux pool injecté dans `require.cache` avant le chargement des services —
 * même procédé que `src/services/securitySettingsService.test.js`. Aucune base
 * n'est nécessaire, et c'est voulu : la migration 088 s'applique à la main, ce
 * test doit passer sur une base qui ne l'a pas encore reçue.
 */
const assert = require('assert');

const dbPath = require.resolve('../config/db');
let requetes = [];
/** 'ok' = les tables répondent ; 'absente' = migration 088 non jouée. */
let mode = 'ok';
let ligneUser = null;
let lignesPlages = [];
let membresListe = [];

const fakePool = {
  execute: async (sql, params) => {
    const texte = sql.replace(/\s+/g, ' ').trim();
    requetes.push({ sql: texte, params });
    if (mode === 'absente') {
      const e = new Error("Table doesn't exist");
      e.code = 'ER_NO_SUCH_TABLE';
      throw e;
    }
    if (/FROM user_voicemail_slot/.test(texte)) return [lignesPlages, []];
    if (/FROM contact_list_member/.test(texte)) {
      const [idList, idFriend] = params;
      const trouve = membresListe.some(
        (m) => Number(m.idList) === Number(idList) && Number(m.idFriend) === Number(idFriend),
      );
      return [trouve ? [{ 1: 1 }] : [], []];
    }
    if (/^INSERT INTO user_voicemail_schedule/.test(texte)) {
      ligneUser = {
        ...ligneUser,
        enabled: Number(params[1]),
        no_answer_enabled: Number(params[2]),
        untilAt: params[3],
        timezone: params[4],
        bypassListId: params[5],
        greeting_url: params[6],
        greeting_seconds: params[7],
      };
      return [{ affectedRows: 1 }, []];
    }
    return [ligneUser ? [{ ...ligneUser }] : [], []];
  },
  query: async () => [[], []],
  getConnection: async () => ({
    beginTransaction: async () => {},
    execute: async () => [{ affectedRows: 1 }, []],
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  }),
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true, exports: fakePool, paths: [], children: [],
};

const s = require('./voicemailScheduleService');

// Le droit Alanya Plus est piloté ici : la fausse base n'a pas les tables de
// l'offre.
let droitRepondeur = true;
let droitsDemandes = 0;
s._setVoicemailRightChecker(async () => {
  droitsDemandes += 1;
  return droitRepondeur;
});
const sl = require('./voicemailSlots');

const creneau = (patch = {}) => ({ ...s.DEFAULT_SCHEDULE, ...patch });
const plage = (dayBit, startTime, endTime) => ({ dayBit, startTime, endTime });

async function main() {
  /* ══ Cascade de fuseau — inchangée depuis la v1 ══ */

  assert.strictEqual(s.isValidTimezone('Africa/Douala'), true);
  assert.strictEqual(s.isValidTimezone('WAT'), false, 'une abréviation n’est pas un identifiant IANA');
  assert.strictEqual(
    s.resolveTimezone({ scheduleTimezone: 'Europe/Paris', countryTimezone: 'Africa/Douala' }),
    'Europe/Paris',
    'ce que l’appareil a posé prime sur le pays du compte',
  );
  assert.strictEqual(
    s.resolveTimezone({ scheduleTimezone: 'Mars/Olympus', countryTimezone: 'Africa/Lagos' }),
    'Africa/Lagos',
    'un fuseau hérité et illisible ne doit pas faire échouer l’appel',
  );

  // Minuit pile : `hour` vaut '24' sur certaines implémentations ICU.
  const minuit = new Date('2026-09-21T23:00:00Z'); // 00:00 le 22 à Douala
  const cMinuit = s.civilPartsInZone(minuit, 'Africa/Douala');
  assert.strictEqual(cMinuit.h, 0, 'minuit doit valoir 0, jamais 24');
  assert.strictEqual(cMinuit.d, 22, 'et le jour doit avoir avancé');
  assert.strictEqual(s.civilPartsInZone(new Date('2026-09-21T12:00:00Z'), 'Africa/Douala').dayBit, 0, 'lundi = bit0');

  /* ══ Plages : la journée ordinaire ══ */

  const bureau = [plage(0, '09:00:00', '17:00:00')];
  const a = (dayBit, minutes) => sl.isAnySlotActive(bureau, { dayBit, minutes });
  assert.strictEqual(a(0, 10 * 60), true, 'lundi 10h : dedans');
  assert.strictEqual(a(0, 8 * 60), false, 'lundi 08h : avant');
  assert.strictEqual(a(0, 17 * 60), false, 'lundi 17h pile : borne haute exclue');
  assert.strictEqual(a(0, 9 * 60), true, 'lundi 09h pile : borne basse incluse');
  assert.strictEqual(a(1, 10 * 60), false, 'mardi 10h : la plage est au lundi');

  /* ══ Plages : le débordement de minuit — le point qu'on oublie ══ */

  const nuitLundi = [plage(0, '22:00:00', '07:00:00')];
  const n = (dayBit, minutes) => sl.isAnySlotActive(nuitLundi, { dayBit, minutes });
  assert.strictEqual(n(0, 23 * 60), true, 'lundi 23h : la part du soir');
  assert.strictEqual(
    n(1, 3 * 60),
    true,
    'mardi 03h : la part du matin, qui appartient à la plage du LUNDI — c’est tout l’objet du débordement',
  );
  assert.strictEqual(n(1, 7 * 60), false, 'mardi 07h pile : la plage est finie');
  assert.strictEqual(n(1, 23 * 60), false, 'mardi 23h : aucune plage le mardi');
  assert.strictEqual(n(0, 12 * 60), false, 'lundi midi : hors plage');
  // Le débordement franchit aussi la frontière de semaine.
  const nuitDimanche = [plage(6, '22:00:00', '07:00:00')];
  assert.strictEqual(
    sl.isAnySlotActive(nuitDimanche, { dayBit: 0, minutes: 3 * 60 }),
    true,
    'lundi 03h appartient à la plage du dimanche : la veille de lundi est dimanche',
  );

  /* ══ Plages : la journée entière ══ */

  const toutLeJour = [plage(5, '08:00:00', '08:00:00')];
  assert.strictEqual(sl.isAnySlotActive(toutLeJour, { dayBit: 5, minutes: 0 }), true);
  assert.strictEqual(sl.isAnySlotActive(toutLeJour, { dayBit: 5, minutes: 23 * 60 }), true);
  assert.strictEqual(
    sl.isAnySlotActive(toutLeJour, { dayBit: 6, minutes: 3 * 60 }),
    false,
    'une journée entière ne déborde pas : elle s’arrête à minuit',
  );
  assert.strictEqual(sl.activeSlot(toutLeJour, { dayBit: 5, minutes: 600 }).allDay, true);

  /* ══ Plusieurs plages le même jour ══ */

  const deux = [plage(2, '12:00:00', '14:00:00'), plage(2, '22:00:00', '23:30:00')];
  assert.strictEqual(sl.isAnySlotActive(deux, { dayBit: 2, minutes: 13 * 60 }), true);
  assert.strictEqual(sl.isAnySlotActive(deux, { dayBit: 2, minutes: 15 * 60 }), false);
  assert.strictEqual(sl.isAnySlotActive(deux, { dayBit: 2, minutes: 23 * 60 }), true);

  /* ══ L'activation ponctuelle : un instant absolu, sans fuseau ══ */

  const maintenant = new Date('2026-09-21T12:00:00Z');
  assert.strictEqual(s.isUntilActive(creneau({ untilAt: '2026-09-21T13:00:00Z' }), maintenant), true);
  assert.strictEqual(
    s.isUntilActive(creneau({ untilAt: '2026-09-21T11:59:59Z' }), maintenant),
    false,
    'une échéance passée vaut inactif',
  );
  assert.strictEqual(s.isUntilActive(creneau({ untilAt: 'pas une date' }), maintenant), false);
  assert.strictEqual(
    s.isVoicemailActive(creneau({ untilAt: '2026-09-21T13:00:00Z' }), maintenant, 'America/Toronto'),
    true,
    'insensible au fuseau, par construction',
  );

  /* ══ L'interrupteur « sans réponse » n'intercepte PAS avant la sonnerie ══ */

  // C'est la distinction centrale de la v2 : il laisse sonner.
  const filet = creneau({ no_answer_enabled: 1 });
  assert.strictEqual(
    s.isVoicemailActive(filet, maintenant, 'Africa/Douala'),
    false,
    'l’interrupteur sans-réponse ne rend pas le téléphone muet',
  );
  assert.strictEqual(s.isNoAnswerEnabled(filet), true);
  assert.strictEqual(s.noAnswerDelayMs(filet, 45000), 27000, 'délai raccourci quand il est armé');
  assert.strictEqual(s.noAnswerDelayMs(creneau(), 45000), 45000, 'délai d’origine sinon');
  assert.ok(
    s.NO_ANSWER_VOICEMAIL_MS < 40000,
    'doit basculer avant que CallKit (40 s) n’arrête la sonnerie de lui-même',
  );

  /* ══ Échéance calculée ══ */

  mode = 'ok';
  const avecPlage = { ...creneau({ enabled: 1 }), slots: [plage(0, '09:00:00', '17:00:00')] };
  assert.strictEqual(
    s.activeUntil(avecPlage, new Date('2026-09-21T09:30:00Z'), 'Africa/Douala').toISOString(),
    '2026-09-21T16:00:00.000Z',
    '17:00 à Douala = 16:00 UTC',
  );
  const avecNuit = { ...creneau({ enabled: 1 }), slots: [plage(0, '22:00:00', '07:00:00')] };
  assert.strictEqual(
    s.activeUntil(avecNuit, new Date('2026-09-21T22:00:00Z'), 'Africa/Douala').toISOString(),
    '2026-09-22T06:00:00.000Z',
    'abordée avant minuit : la fin est demain',
  );
  assert.strictEqual(
    s.activeUntil(avecNuit, new Date('2026-09-22T02:00:00Z'), 'Africa/Douala').toISOString(),
    '2026-09-22T06:00:00.000Z',
    'abordée après minuit : la fin est aujourd’hui',
  );
  // Changement d'heure : Paris passe à l'heure d'été dans la nuit du samedi 28
  // au dimanche 29 mars 2026. La plage doit donc être posée au SAMEDI (bit 5),
  // et la seconde passe de `_wallToInstant` rattrape le décalage — sans elle,
  // l'échéance tomberait une heure trop tard.
  const nuitSamedi = { ...creneau({ enabled: 1 }), slots: [plage(5, '22:00:00', '07:00:00')] };
  assert.strictEqual(
    s.activeUntil(nuitSamedi, new Date('2026-03-28T22:00:00Z'), 'Europe/Paris').toISOString(),
    '2026-03-29T05:00:00.000Z',
    '07:00 murale le dimanche 29 à Paris = 05:00 UTC, une fois passé à l’heure d’été',
  );
  // Journée entière : actif, mais sans échéance à annoncer.
  const journee = { ...creneau({ enabled: 1 }), slots: [plage(0, '08:00:00', '08:00:00')] };
  assert.strictEqual(s.activeUntil(journee, new Date('2026-09-21T12:00:00Z'), 'Africa/Douala'), null);

  /* ══ Lecture : table absente, et plages lues seulement si utiles ══ */

  mode = 'absente';
  const absent = await s.loadUserVoicemailSchedule(42);
  assert.strictEqual(absent.enabled, 0, 'table absente ⇒ répondeur inerte');
  assert.strictEqual(absent.no_answer_enabled, 0);
  assert.strictEqual(
    s.isVoicemailActive(absent, maintenant, absent.resolvedTimezone),
    false,
    'une base incomplète ne doit couper aucun appel',
  );

  mode = 'ok';
  ligneUser = {
    enabled: 0, no_answer_enabled: 1, untilAt: null, timezone: null,
    bypassListId: null, greeting_url: null, greeting_seconds: null,
    countryTimezone: 'Europe/Paris',
  };
  requetes = [];
  const sansPlages = await s.loadUserVoicemailSchedule(42);
  assert.strictEqual(sansPlages.resolvedTimezone, 'Europe/Paris', 'le pays alimente la cascade');
  assert.strictEqual(sansPlages.no_answer_enabled, 1);
  assert.strictEqual(
    requetes.some((r) => /user_voicemail_slot/.test(r.sql)),
    false,
    'plages non lues quand elles ne s’appliquent pas — ce chemin est traversé à CHAQUE appel',
  );

  ligneUser = { ...ligneUser, enabled: 1 };
  lignesPlages = [plage(0, '09:00:00', '17:00:00')];
  requetes = [];
  const avecPlages = await s.loadUserVoicemailSchedule(42);
  assert.strictEqual(avecPlages.slots.length, 1);
  assert.ok(requetes.some((r) => /user_voicemail_slot/.test(r.sql)));

  /* ══ Écriture : plafond des 24 h et exclusivité ══ */

  ligneUser = {
    enabled: 0, no_answer_enabled: 0, untilAt: null, timezone: null,
    bypassListId: null, greeting_url: null, greeting_seconds: null,
    countryTimezone: 'Africa/Douala',
  };
  lignesPlages = [];

  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { untilAt: new Date(Date.now() + 25 * 3600e3).toISOString() }),
    /24 heures/,
    'au-delà de 24 h, l’activation ponctuelle redevient un réglage qu’on oublie',
  );
  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { untilAt: 'demain' }),
    /untilAt invalide/,
  );
  await assert.rejects(
    () => s.upsertUserVoicemailSchedule(42, { timezone: 'WAT' }),
    /timezone invalide/,
  );

  // Armer la durée éteint les plages…
  ligneUser = { ...ligneUser, enabled: 1 };
  requetes = [];
  await s.upsertUserVoicemailSchedule(42, { untilAt: new Date(Date.now() + 3600e3).toISOString() });
  let ecriture = requetes.find((r) => /^INSERT INTO user_voicemail_schedule/.test(r.sql));
  assert.strictEqual(ecriture.params[1], 0, 'armer la durée éteint les plages');
  assert.ok(ecriture.params[3] instanceof Date, 'untilAt part en Date, pas en chaîne');

  // …et armer les plages éteint la durée.
  ligneUser = { ...ligneUser, enabled: 0, untilAt: new Date(Date.now() + 3600e3) };
  requetes = [];
  await s.upsertUserVoicemailSchedule(42, { enabled: 1 });
  ecriture = requetes.find((r) => /^INSERT INTO user_voicemail_schedule/.test(r.sql));
  assert.strictEqual(ecriture.params[1], 1);
  assert.strictEqual(ecriture.params[3], null, 'armer les plages éteint la durée');

  // L'interrupteur sans-réponse, lui, se cumule avec les deux.
  requetes = [];
  await s.upsertUserVoicemailSchedule(42, { no_answer_enabled: true, enabled: 1 });
  ecriture = requetes.find((r) => /^INSERT INTO user_voicemail_schedule/.test(r.sql));
  assert.strictEqual(ecriture.params[1], 1, 'les plages restent armées');
  assert.strictEqual(ecriture.params[2], 1, 'et le filet sans-réponse aussi');

  /* ══ Plages : validation à l'écriture ══ */

  await assert.rejects(() => sl.replaceSlots(42, [{ dayBit: 7, startTime: '09:00', endTime: '10:00' }]), /dayBit/);
  await assert.rejects(() => sl.replaceSlots(42, [{ dayBit: 0, startTime: '25:00', endTime: '10:00' }]), /Format horaire/);
  await assert.rejects(
    () => sl.replaceSlots(42, [
      plage(0, '08:00', '09:00'), plage(0, '10:00', '11:00'),
      plage(0, '12:00', '13:00'), plage(0, '14:00', '15:00'),
    ]),
    /Trois plages par jour/,
  );

  /* ══ La décision complète ══ */

  ligneUser = {
    enabled: 0, no_answer_enabled: 0, untilAt: null, timezone: null,
    bypassListId: 5, greeting_url: null, greeting_seconds: null,
    countryTimezone: 'Africa/Douala',
  };
  requetes = [];
  const repos = await s.shouldInterceptCall(42, 7, maintenant);
  assert.strictEqual(repos.intercept, false);
  assert.strictEqual(
    requetes.some((r) => /contact_list_member/.test(r.sql)),
    false,
    'la liste n’est interrogée que si le répondeur est par ailleurs actif',
  );

  ligneUser = { ...ligneUser, untilAt: new Date('2026-09-21T13:00:00Z') };
  membresListe = [{ idList: 5, idFriend: 7 }];
  const intercepte = await s.shouldInterceptCall(42, 8, maintenant);
  assert.strictEqual(intercepte.intercept, true);
  assert.strictEqual(intercepte.activeUntil.toISOString(), '2026-09-21T13:00:00.000Z');

  const passe = await s.shouldInterceptCall(42, 7, maintenant);
  assert.strictEqual(passe.intercept, false);
  assert.strictEqual(passe.bypassed, true, 'un membre de la liste fait sonner malgré le silence');

  /* ══ Le rattrapage après sonnerie ignore la liste d'exception ══ */

  ligneUser = { ...ligneUser, untilAt: null, no_answer_enabled: 1 };
  const rattrape = await s.shouldFallBackToVoicemail(42);
  assert.strictEqual(
    rattrape.fallback,
    true,
    'la liste ne dispense pas du répondeur après sonnerie : le téléphone a sonné pour tout le monde',
  );
  ligneUser = { ...ligneUser, no_answer_enabled: 0 };
  assert.strictEqual((await s.shouldFallBackToVoicemail(42)).fallback, false);

  /* ══ Sans Alanya Plus, après l'essai : le téléphone sonne ══ */

  droitRepondeur = false;
  ligneUser = { ...ligneUser, untilAt: new Date('2026-09-21T13:00:00Z'), no_answer_enabled: 1 };
  const horsDroit = await s.shouldInterceptCall(42, 8, maintenant);
  assert.strictEqual(horsDroit.intercept, false, 'sans le droit, aucun appel n’est intercepté');
  assert.strictEqual(
    s.isNoAnswerEnabled(horsDroit.schedule),
    false,
    'le créneau rendu à call_user n’arme plus le filet sans réponse',
  );
  assert.strictEqual(
    (await s.shouldFallBackToVoicemail(42, maintenant)).fallback,
    false,
    'ni rattrapage après sonnerie',
  );
  droitRepondeur = true;
  assert.strictEqual((await s.shouldInterceptCall(42, 8, maintenant)).intercept, true,
    'le réglage, intact, reprend dès le paiement');

  ligneUser = { ...ligneUser, untilAt: null, no_answer_enabled: 0 };
  droitsDemandes = 0;
  await s.shouldInterceptCall(42, 8, maintenant);
  assert.strictEqual(droitsDemandes, 0, 'aucun calcul de droits pour un répondeur éteint');

  console.log('✓ voicemailScheduleService v2 : plages, minuit, 24 h, exclusivité, délai de bascule');
}

main().catch((e) => {
  console.error('voicemailScheduleService.test.js ÉCHEC :', e);
  process.exit(1);
});
