/**
 * Registre des purges de rétention, pilotables depuis l'espace super-admin.
 *
 * Les purges nocturnes suppriment définitivement des fichiers et des lignes.
 * Elles n'avaient jusqu'ici ni interrupteur, ni compteur préalable, ni trace
 * d'exécution : les couper imposait de modifier le code, et rien ne
 * distinguait « elle tourne et n'a rien à faire » de « elle ne tourne pas ».
 * C'est ce dernier point qui a laissé le bug d'alias SQL de la purge des
 * médias passer inaperçu — elle échouait chaque nuit, en silence.
 *
 * Chaque purge se décrit ici : ce qu'elle supprime, quels réglages elle
 * expose, comment compter ce qui serait supprimé, comment l'exécuter. Elles
 * n'ont pas la même forme (les médias exposent une durée, les trajets trois,
 * les diffusions et la rétention générale aucune — leurs durées sont figées
 * dans leur SQL), d'où un descripteur par purge plutôt qu'un schéma commun
 * forcé.
 *
 * Voir migration 068 : `purge_settings` (état + surcharges) et `purge_runs`
 * (journal). Migration 074 : `story`, détachée de la rétention générale.
 */

const pool = require('../config/db');
const mediaPolicy = require('../constants/mediaRetentionPolicy');
const tripPolicy = require('../constants/tripPolicy');

const NAMES = ['media', 'broadcast', 'story', 'welcome_status', 'trip', 'data_retention', 'backup_key_access', 'e2ee_envelope', 'safebox'];

/** Borne une valeur de réglage. Une saisie hors bornes est ramenée, jamais rejetée en silence. */
function clampInt(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ── Descripteurs ────────────────────────────────────────────────────────────
//
// `knobs` : réglages surchargeables depuis l'admin. Une purge sans knob a ses
// durées figées dans son SQL — c'est signalé à l'écran plutôt que masqué.
// `stats(opts)` : ce qui serait supprimé MAINTENANT, avec les réglages courants.
// `run(opts, { trigger })` : exécution réelle ; `trigger` vaut `auto` ou `manual`.

const DESCRIPTORS = {
  media: {
    label: 'Médias expirés',
    description:
      "Vide `message.mediaUrl` et supprime le fichier chez Backblaze au-delà "
      + 'de la rétention. Le message lui-même est conservé : seule la pièce jointe '
      + 'disparaît. En phase payante, un média garde la durée Alanya Plus tant '
      + "qu'une personne de sa discussion y a droit. La nuit, la purge s'arrête "
      + "sans rien supprimer si elle dépasse le seuil d'arrêt : la lancer à la main "
      + 'vaut confirmation. Exemptés, jamais purgés par âge : `official/` (médias '
      + 'officiels, stickers officiels) et `stickers/` (stickers personnels : '
      + 'ils ne partent que par leur suppression, celle du compte ou un retrait admin).',
    // Déclaré, pas exécuté : la sélection ne vise que `/uploads/media/`.
    exempte: mediaPolicy.PREFIXES_JAMAIS_PURGES,
    knobs: [{
      key: 'mediaDays',
      label: 'Rétention des médias — standard',
      unit: 'jours',
      min: 1,
      max: 365,
      default: () => mediaPolicy.RETENTION.mediaDays,
    }, {
      key: 'plusDays',
      label: 'Rétention des médias — Alanya Plus',
      unit: 'jours',
      min: 1,
      // Pas au-delà : le filet du bucket masque `media/` à 366 jours.
      max: 365,
      default: () => mediaPolicy.RETENTION.plusDays,
    }, {
      key: 'alertFloor',
      label: "Seuil d'arrêt automatique",
      unit: 'fichiers par nuit',
      min: 1,
      max: 1_000_000,
      default: () => mediaPolicy.RETENTION.alertFloor,
    }],
    async stats(opts) {
      const { lireContexte, countPurgeable, plafondDe } = require('./mediaRetention');
      const ctx = await lireContexte({ standardDays: opts.mediaDays, plusDays: opts.plusDays });
      return {
        ...(await countPurgeable(pool, ctx)),
        paliers: ctx.paliers,
        plafondJours: plafondDe(ctx),
      };
    },
    async run(opts, { trigger } = {}) {
      const { runNightlyMediaPurge } = require('./mediaRetention');
      return runNightlyMediaPurge(undefined, {
        mediaDays: opts.mediaDays,
        plusDays: opts.plusDays,
        alertFloor: opts.alertFloor,
        trigger,
      });
    },
  },

  broadcast: {
    label: 'Accusés de diffusion',
    description:
      'Rafraîchit les compteurs de diffusion et supprime les accusés de '
      + 'livraison de plus de 90 jours.',
    knobs: [], // durée figée dans le SQL de broadcastService
    async stats() {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS lignes FROM broadcast_delivery
          WHERE delivered_at IS NOT NULL
            AND delivered_at < DATE_SUB(NOW(), INTERVAL 90 DAY)`,
      );
      return { lignes: Number(rows[0].lignes) || 0, retentionFigee: '90 jours' };
    },
    async run() {
      const { runNightlyDeliveryMaintenance } = require('./broadcastService');
      return runNightlyDeliveryMaintenance();
    },
  },

  story: {
    label: 'Stories expirées',
    description:
      'Supprime les stories ordinaires au-delà de la rétention comptée APRÈS '
      + "leur expiration (une story expire 24 h après sa publication). C'est "
      + "cette purge qui borne l'historique visible dans Analytics : au-delà de "
      + 'cette fenêtre, la section Stories ne peut plus rien compter. Les stories '
      + "d'accueil ne sont pas concernées, elles ont leur propre purge.",
    knobs: [{
      key: 'retentionDays',
      label: 'Conservation après expiration',
      unit: 'jours',
      min: 1,
      max: 365,
      default: () => 7,
    }],
    async stats(opts) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS lignes, MIN(s.createdAt) AS plusAncienne
           FROM statut s
          WHERE s.expiredAt < DATE_SUB(NOW(), INTERVAL ? DAY)
            AND NOT EXISTS (
              SELECT 1 FROM welcome_status_delivery w WHERE w.statut_id = s.ID
            )`,
        [opts.retentionDays],
      );
      return {
        lignes: Number(rows[0].lignes) || 0,
        plusAncienne: rows[0].plusAncienne,
      };
    },
    async run(opts) {
      const { purgeExpiredStories } = require('./dataRetentionService');
      return purgeExpiredStories({ retentionDays: opts.retentionDays });
    },
  },

  welcome_status: {
    label: "Statuts d'accueil expirés",
    description:
      'Supprime les statuts de bienvenue expirés. Sans elle, `statut` grossit '
      + "d'une ligne par inscription sans jamais rétrécir.",
    knobs: [{
      key: 'retentionDays',
      label: 'Conservation après expiration',
      unit: 'jours',
      min: 1,
      max: 365,
      default: () => 7,
    }],
    async stats(opts) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS lignes
           FROM statut s
           JOIN welcome_status_delivery w ON w.statut_id = s.ID
          WHERE s.expiredAt < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.retentionDays],
      );
      return { lignes: Number(rows[0].lignes) || 0 };
    },
    async run(opts) {
      const { purgeExpiredWelcomeStatuses } = require('./welcomeService');
      return purgeExpiredWelcomeStatuses({ retentionDays: opts.retentionDays });
    },
  },

  trip: {
    label: 'Traces de trajets',
    description:
      'Efface les points GPS des trajets clos au-delà de la rétention, puis les '
      + 'trajets eux-mêmes. Un trajet en cours n\'est jamais touché : sa trace '
      + 'est le suivi live.',
    knobs: [
      {
        key: 'pointsHours',
        label: 'Points GPS après clôture',
        unit: 'heures',
        min: 1,
        max: 8760,
        default: () => tripPolicy.RETENTION.pointsHours,
      },
      {
        key: 'pointsIncidentDays',
        label: 'Points GPS si clôture sur alerte',
        unit: 'jours',
        min: 1,
        max: 365,
        default: () => tripPolicy.RETENTION.pointsIncidentDays,
      },
      {
        key: 'tripMonths',
        label: 'Trajets complets',
        unit: 'mois',
        min: 1,
        max: 120,
        default: () => tripPolicy.RETENTION.tripMonths,
      },
    ],
    async stats(opts) {
      const { fetchTraceRetentionStats } = require('./tripRetention');
      return fetchTraceRetentionStats(undefined, opts);
    },
    async run(opts) {
      const { runNightlyTripPurge } = require('./tripRetention');
      return runNightlyTripPurge(undefined, opts);
    },
  },

  backup_key_access: {
    label: 'Journal des clés de sauvegarde',
    description:
      'Supprime les lignes de `backup_key_access` au-delà de la rétention. '
      + "Chaque inscrit demande sa clé à chaque sauvegarde et à chaque "
      + "restauration : la table grossit avec l'usage, pas avec les incidents. "
      + 'Sa valeur est forensique — reconstituer après coup qui a obtenu quoi — '
      + "et cette valeur s'épuise avec le temps, contrairement au volume.",
    knobs: [{
      key: 'retentionDays',
      label: 'Conservation du journal',
      unit: 'jours',
      // Six mois : assez pour couvrir une enquête ouverte longtemps après les
      // faits, assez court pour que la table reste une donnée personnelle
      // qu'on ne garde pas indéfiniment.
      min: 30,
      max: 730,
      default: () => 180,
    }],
    async stats(opts) {
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS lignes, MIN(created_at) AS plusAncienne
           FROM backup_key_access
          WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.retentionDays],
      );
      return {
        lignes: Number(rows[0].lignes) || 0,
        plusAncienne: rows[0].plusAncienne,
      };
    },
    async run(opts) {
      const [res] = await pool.execute(
        `DELETE FROM backup_key_access
          WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.retentionDays],
      );
      return { supprimees: res.affectedRows || 0 };
    },
  },

  e2ee_envelope: {
    label: 'Enveloppes de chiffrement',
    description:
      'Supprime les lignes de `message_envelope` dont le travail est fini, et '
      + 'les clés à usage unique déjà servies. Une enveloppe porte la clé de '
      + "contenu d'un message, scellée pour UN appareil : une fois remise, le "
      + 'destinataire a déchiffré et rangé le clair chez lui, elle ne sert plus '
      + "à rien. Le CORPS du message n'est jamais supprimé ici — il reste dans "
      + '`message_e2ee` tant que le message existe, simplement illisible pour '
      + "qui n'a plus d'enveloppe.",
    knobs: [{
      key: 'remisesDays',
      label: 'Enveloppes remises',
      unit: 'jours',
      // Pas zéro : un appareil peut réinstaller juste après avoir reçu, avant
      // d'avoir sauvegardé. Ces quelques jours sont la seule fenêtre où il
      // peut encore rattraper un message par la synchronisation. Au-delà,
      // c'est la sauvegarde Drive qui porte l'historique, pas le serveur.
      min: 1,
      max: 90,
      default: () => 7,
    }, {
      key: 'attenteDays',
      label: 'Enveloppes jamais remises',
      unit: 'jours',
      // Un appareil éteint depuis un mois n'a plus besoin de ce message en
      // temps réel. Aligné sur la rétention des médias (30 jours) : garder
      // l'enveloppe plus longtemps que la pièce jointe n'aurait pas de sens.
      min: 7,
      max: 365,
      default: () => 30,
    }],
    async stats(opts) {
      const [[remises]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM message_envelope
          WHERE delivered_at IS NOT NULL
            AND delivered_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.remisesDays],
      );
      const [[attente]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM message_envelope
          WHERE delivered_at IS NULL
            AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.attenteDays],
      );
      const [[otpk]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM e2ee_one_time_prekeys
          WHERE claimed_at IS NOT NULL
            AND claimed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      );
      return {
        remises: Number(remises.n) || 0,
        enAttente: Number(attente.n) || 0,
        clesServies: Number(otpk.n) || 0,
      };
    },
    async run(opts) {
      const [r1] = await pool.execute(
        `DELETE FROM message_envelope
          WHERE delivered_at IS NOT NULL
            AND delivered_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.remisesDays],
      );
      const [r2] = await pool.execute(
        `DELETE FROM message_envelope
          WHERE delivered_at IS NULL
            AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
        [opts.attenteDays],
      );
      // Clés à usage unique déjà servies. Elles ne peuvent plus l'être une
      // seconde fois, mais leur ligne retient le `key_id` sous l'index UNIQUE
      // — c'est ce qui empêche un appareil de republier un identifiant déjà
      // consommé. Trente jours après coup, le correspondant qui l'avait
      // réclamée a soit ouvert sa session, soit abandonné.
      const [r3] = await pool.execute(
        `DELETE FROM e2ee_one_time_prekeys
          WHERE claimed_at IS NOT NULL
            AND claimed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`,
      );
      return {
        remises: r1.affectedRows || 0,
        enAttente: r2.affectedRows || 0,
        clesServies: r3.affectedRows || 0,
      };
    },
  },

  data_retention: {
    label: 'Rétention générale',
    description:
      'Historique d\'appels, journal de connexions, jobs en échec, appareils '
      + 'révoqués, jetons push dormants, OTP périmés. Les stories ont leur '
      + 'propre purge depuis la migration 074.',
    knobs: [], // durées figées, une par cible, dans dataRetentionService
    async stats() {
      const cibles = [
        ['callHistory', "SELECT COUNT(*) n FROM callHistory WHERE created_at < DATE_SUB(NOW(), INTERVAL 12 MONTH)", '12 mois'],
        ['userAccess', "SELECT COUNT(*) n FROM userAccess WHERE dateLogin < DATE_SUB(NOW(), INTERVAL 90 DAY)", '90 jours'],
        ['job_queue', "SELECT COUNT(*) n FROM job_queue WHERE failed_at IS NOT NULL AND failed_at < DATE_SUB(NOW(), INTERVAL 30 DAY)", '30 jours'],
        ['appareils', "SELECT COUNT(*) n FROM appareils WHERE revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(), INTERVAL 90 DAY)", '90 jours'],
        ['user_push_devices', "SELECT COUNT(*) n FROM user_push_devices WHERE lastHeartbeatAt IS NOT NULL AND lastHeartbeatAt < DATE_SUB(NOW(), INTERVAL 180 DAY)", '180 jours'],
      ];
      // Un tableau, pas un objet indexé par nom de table : le client admin
      // normalise les CLÉS des réponses en camelCase (lib/api.ts), ce qui
      // transformerait `user_push_devices` en `userPushDevices` à l'écran.
      // En valeur, le nom de la table arrive intact.
      const parCible = [];
      for (const [table, sql, retention] of cibles) {
        try {
          const [rows] = await pool.execute(sql);
          parCible.push({ table, lignes: Number(rows[0].n) || 0, retention });
        } catch (e) {
          parCible.push({ table, erreur: e.message });
        }
      }
      return { parCible };
    },
    async run() {
      const { runDataRetentionPurge } = require('./dataRetentionService');
      return runDataRetentionPurge();
    },
  },

  safebox: {
    label: 'Coffre-fort',
    description:
      'Supprime la corbeille du coffre-fort au-delà de sa durée et les envois '
      + 'abandonnés, puis efface chez MEGA S4 les fichiers que plus aucun coffre '
      + "ne désigne (y compris ceux des comptes supprimés). MEGA S4 n'a pas de "
      + "cycle de vie : sans cette purge, rien n'y est jamais effacé. La nuit, "
      + "elle s'arrête avant de toucher MEGA si elle dépasse le seuil d'arrêt : "
      + 'la lancer à la main vaut confirmation. Les fichiers du coffre ne '
      + "s'effacent jamais par ancienneté.",
    knobs: [{
      key: 'trashDays',
      label: 'Durée de la corbeille',
      unit: 'jours',
      min: 1,
      max: 365,
      default: () => 30,
    }, {
      key: 'abandonHours',
      label: 'Envoi abandonné après',
      unit: 'heures sans nouveau bloc',
      // Pas moins : un téléphone peut rester hors réseau une nuit entière.
      min: 6,
      max: 720,
      default: () => 48,
    }, {
      key: 'alertFloor',
      label: "Seuil d'arrêt automatique",
      unit: 'fichiers par nuit',
      min: 1,
      max: 1_000_000,
      default: () => 5000,
    }],
    async stats(opts) {
      const { purgeStats } = require('./safebox/purge');
      return purgeStats(opts);
    },
    async run(opts, { trigger } = {}) {
      const { runSafeboxPurge } = require('./safebox/purge');
      return runSafeboxPurge(opts, { trigger });
    },
  },
};

// ── Réglages ────────────────────────────────────────────────────────────────

function defaultsFor(name) {
  const out = {};
  for (const knob of DESCRIPTORS[name].knobs) out[knob.key] = knob.default();
  return out;
}

/**
 * Réglages effectifs d'une purge : défauts du code/environnement, surchargés
 * par ce qui a été réglé en base. Une purge absente de la table est active
 * avec ses défauts — l'état de départ reproduit le comportement d'avant.
 */
async function getSetting(name) {
  if (!DESCRIPTORS[name]) throw new Error(`Purge inconnue: ${name}`);
  const [rows] = await pool.execute(
    'SELECT enabled, overrides, updated_at, updated_by FROM purge_settings WHERE name = ?',
    [name],
  );
  const row = rows[0];
  const overrides = row?.overrides
    ? (typeof row.overrides === 'string' ? JSON.parse(row.overrides) : row.overrides)
    : {};
  const defauts = defaultsFor(name);
  const options = { ...defauts };
  for (const knob of DESCRIPTORS[name].knobs) {
    if (overrides[knob.key] != null) {
      options[knob.key] = clampInt(overrides[knob.key], {
        min: knob.min, max: knob.max, fallback: defauts[knob.key],
      });
    }
  }
  return {
    name,
    enabled: row ? !!row.enabled : true,
    options,
    defauts,
    surcharges: overrides,
    updatedAt: row?.updated_at ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

async function isEnabled(name) {
  try {
    return (await getSetting(name)).enabled;
  } catch (e) {
    // Table absente (migration non appliquée) ou base injoignable : ne pas
    // désarmer silencieusement une purge à cause d'un incident d'infra —
    // le comportement d'avant cette fonctionnalité est « toujours active ».
    console.warn(`[Purge] lecture du réglage ${name} impossible, purge maintenue active:`, e.message);
    return true;
  }
}

/** Réglages effectifs, sans jeter : sert au balayage automatique. */
async function resolveOptions(name) {
  try {
    return (await getSetting(name)).options;
  } catch {
    return defaultsFor(name);
  }
}

async function updateSetting(name, { enabled, overrides } = {}, by = null) {
  if (!DESCRIPTORS[name]) throw new Error(`Purge inconnue: ${name}`);
  const courant = await getSetting(name);
  const nextEnabled = typeof enabled === 'boolean' ? enabled : courant.enabled;

  const nextOverrides = { ...courant.surcharges };
  if (overrides && typeof overrides === 'object') {
    for (const knob of DESCRIPTORS[name].knobs) {
      if (!(knob.key in overrides)) continue;
      const brut = overrides[knob.key];
      if (brut === null || brut === '') {
        delete nextOverrides[knob.key]; // retour au défaut
      } else {
        nextOverrides[knob.key] = clampInt(brut, {
          min: knob.min, max: knob.max, fallback: courant.defauts[knob.key],
        });
      }
    }
  }

  await pool.execute(
    `INSERT INTO purge_settings (name, enabled, overrides, updated_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled),
                             overrides = VALUES(overrides),
                             updated_by = VALUES(updated_by)`,
    [name, nextEnabled ? 1 : 0, JSON.stringify(nextOverrides), by],
  );
  return getSetting(name);
}

// ── Exécution + journal ─────────────────────────────────────────────────────

async function recordRun(name, { trigger = 'auto', by = null, ok, result, error, durationMs }) {
  try {
    await pool.execute(
      `INSERT INTO purge_runs (name, trigger_source, by_admin, ok, result, error, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, trigger, by, ok ? 1 : 0, result ? JSON.stringify(result) : null,
        error ? String(error).slice(0, 2000) : null, durationMs],
    );
  } catch (e) {
    // Le journal ne doit jamais faire échouer la purge elle-même.
    console.warn('[Purge] journalisation impossible:', e.message);
  }
}

/**
 * Exécute une purge et la journalise — y compris en cas d'échec, qui est
 * précisément ce que l'absence de journal rendait invisible jusqu'ici.
 */
async function runPurge(name, { trigger = 'auto', by = null } = {}) {
  const desc = DESCRIPTORS[name];
  if (!desc) throw new Error(`Purge inconnue: ${name}`);
  const options = await resolveOptions(name);
  const t0 = Date.now();
  try {
    // Le déclencheur est transmis : une exécution manuelle vaut confirmation
    // pour les purges qui s'arrêtent d'elles-mêmes la nuit (`media`).
    const result = await desc.run(options, { trigger });
    await recordRun(name, { trigger, by, ok: true, result, durationMs: Date.now() - t0 });
    return { ok: true, result };
  } catch (e) {
    console.error(`[Purge] ${name} a échoué:`, e.message);
    await recordRun(name, { trigger, by, ok: false, error: e.message, durationMs: Date.now() - t0 });
    throw e;
  }
}

/** Exécution automatique : respecte l'interrupteur, contrairement à l'appel manuel. */
async function runPurgeIfEnabled(name) {
  if (!(await isEnabled(name))) {
    console.log(`[Purge] ${name} désactivée depuis l'admin — balayage ignoré`);
    return { ok: true, skipped: true };
  }
  return runPurge(name, { trigger: 'auto' });
}

async function listRuns(name, limit = 20) {
  const n = clampInt(limit, { min: 1, max: 100, fallback: 20 });
  const [rows] = await pool.query(
    `SELECT id, name, ran_at, trigger_source, by_admin, ok, result, error, duration_ms
       FROM purge_runs WHERE name = ? ORDER BY ran_at DESC, id DESC LIMIT ?`,
    [name, n],
  );
  return rows;
}

/**
 * Dernier passage de chaque purge, pour la page « santé du service ».
 *
 * Distinct de `describeAll()`, qui balaie plusieurs tables pour chiffrer ce qui
 * serait supprimé : ici on ne veut qu'une ligne par purge, assez légère pour
 * être rafraîchie régulièrement.
 *
 * Les purges qui n'ont jamais tourné sont rendues avec `dernierPassage: null`
 * plutôt qu'omises — c'est précisément le cas qu'il faut voir. Sans cela, rien
 * ne distinguerait « la purge tourne et n'a rien à faire » de « la purge ne
 * tourne pas ».
 */
async function lastRunPerPurge() {
  const [rows] = await pool.query(
    `SELECT r.name, r.ran_at, r.ok, r.error, r.duration_ms, r.trigger_source
       FROM purge_runs r
       JOIN (SELECT name, MAX(id) AS id FROM purge_runs GROUP BY name) d
         ON d.id = r.id`,
  );
  const parNom = new Map(rows.map((r) => [r.name, r]));
  return NAMES.map((name) => {
    const r = parNom.get(name);
    return {
      name,
      dernierPassage: r ? r.ran_at : null,
      ok: r ? !!r.ok : null,
      erreur: r ? r.error : null,
      dureeMs: r ? r.duration_ms : null,
      declencheur: r ? r.trigger_source : null,
    };
  });
}

/** Vue complète pour l'admin : réglages, ce qui serait supprimé, historique. */
async function describeAll({ withStats = true, runsPerPurge = 5 } = {}) {
  const out = [];
  for (const name of NAMES) {
    const desc = DESCRIPTORS[name];
    const setting = await getSetting(name).catch(() => ({
      name, enabled: true, options: defaultsFor(name), defauts: defaultsFor(name),
      surcharges: {}, updatedAt: null, updatedBy: null,
    }));
    let stats = null;
    let statsErreur = null;
    if (withStats) {
      try { stats = await desc.stats(setting.options); }
      catch (e) { statsErreur = e.message; }
    }
    const runs = await listRuns(name, runsPerPurge).catch(() => []);
    out.push({
      ...setting,
      label: desc.label,
      description: desc.description,
      // Préfixes de stockage que cette purge ne vise jamais (absent = aucun).
      exempte: desc.exempte || [],
      knobs: desc.knobs.map((k) => ({
        key: k.key, label: k.label, unit: k.unit, min: k.min, max: k.max,
        defaut: k.default(), valeur: setting.options[k.key],
      })),
      stats,
      statsErreur,
      runs,
    });
  }
  return out;
}

module.exports = {
  NAMES,
  DESCRIPTORS,
  getSetting,
  updateSetting,
  isEnabled,
  resolveOptions,
  runPurge,
  runPurgeIfEnabled,
  listRuns,
  lastRunPerPurge,
  describeAll,
};
