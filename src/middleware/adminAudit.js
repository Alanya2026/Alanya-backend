const pool = require('../config/db');

/**
 * Journal des actions administrateur.
 *
 * Monté une fois, en tête du routeur admin, plutôt que recopié dans chaque
 * contrôleur : écrit là-bas, le journal aurait un trou dès la première route
 * ajoutée, et le trou serait invisible. Ici, une route mutante qu'aucune entrée
 * de `ACTIONS` ne décrit est journalisée en `unmapped` — le manque devient une
 * ligne dans la table au lieu d'un silence.
 *
 * L'écriture a lieu sur `finish`, après que la réponse est partie : elle ne peut
 * ni retarder ni faire échouer une action d'administration. Une panne d'écriture
 * se solde par une trace perdue et une ligne dans les logs, jamais par un 500.
 */

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Routes mutantes volontairement hors journal, et la raison.
 *
 * Y figurer est un choix ; ne figurer nulle part est un oubli, et c'est ce que
 * `unmapped` révèle.
 */
const SKIP = new Map([
  // La connexion n'est pas encore authentifiée : `req.user` n'existe pas.
  // Journaliser les connexions admin demande de remonter l'identité depuis le
  // contrôleur — utile, mais c'est un autre travail.
  ['POST /auth/login', 'non authentifiée'],
  // POST par commodité (le ciblage voyage dans le corps), mais ne calcule
  // qu'une taille d'audience et n'écrit rien.
  ['POST /broadcasts/estimate', 'lecture déguisée en POST'],
]);

/**
 * Carte route → action métier.
 *
 * Les verbes sont ceux que le chantier des permissions reprendra : nommer ici
 * `users.ban` plutôt que « POST sur /users/:id/ban » sert les deux.
 */
const ACTIONS = {
  // Comptes
  'POST /users': { action: 'users.create', targetType: 'user' },
  'DELETE /users/:id': { action: 'users.delete', targetType: 'user', param: 'id' },
  'POST /users/:id/ban': { action: 'users.ban', targetType: 'user', param: 'id' },
  'DELETE /users/:id/ban': { action: 'users.unban', targetType: 'user', param: 'id' },
  'PUT /users/:id/role': { action: 'users.role', targetType: 'user', param: 'id' },
  'PUT /users/:id/socle': { action: 'users.socle', targetType: 'user', param: 'id' },
  'PUT /users/:id/phone': { action: 'users.phone', targetType: 'user', param: 'id' },

  // Contenus
  'DELETE /groups/:id': { action: 'groups.delete', targetType: 'group', param: 'id' },
  'DELETE /media/:id': { action: 'media.delete', targetType: 'media', param: 'id' },
  'DELETE /meetings/:id': { action: 'meetings.delete', targetType: 'meeting', param: 'id' },
  'POST /meetings/:id/end': { action: 'meetings.end', targetType: 'meeting', param: 'id' },

  // Modération
  'POST /reports/:id/actions': { action: 'reports.handle', targetType: 'report', param: 'id' },
  'POST /reports/:id/safebox/revoke': { action: 'safebox.revoke', targetType: 'report', param: 'id' },
  'POST /reports/:id/safebox/delete': { action: 'safebox.delete', targetType: 'report', param: 'id' },

  // Diffusions
  'POST /broadcasts': { action: 'broadcasts.send', targetType: 'broadcast' },
  'DELETE /broadcasts/scheduled/:jobId': { action: 'broadcasts.cancel', targetType: 'broadcast_job', param: 'jobId' },

  // Rétention
  'POST /purges/:name/run': { action: 'purges.run', targetType: 'purge', param: 'name' },
  'PUT /purges/:name': { action: 'purges.settings', targetType: 'purge', param: 'name' },
  'PUT /safebox/settings': { action: 'safebox.settings', targetType: 'safebox' },
  'POST /trips/retention/purge': { action: 'trips.purge', targetType: 'purge' },

  // Réglages et annuaire
  'PUT /settings': { action: 'settings.write', targetType: 'settings' },

  // Verrouillage de la connexion sur les appareils enrôlés. Le DÉSARMEMENT est
  // le geste qui compte : il rouvre la connexion par mot de passe depuis
  // n'importe quel téléphone, et doit laisser une trace nominative.
  'PUT /security-settings': { action: 'security.settings', targetType: 'settings' },

  // Interrupteur du chiffrement de bout en bout. Chaque palier du déploiement
  // passe par ici, et une activation ne se défait pas : un fil passé en
  // chiffré le reste. Qui a ouvert quoi, et quand, doit pouvoir se retrouver.
  'PUT /e2ee-settings': { action: 'e2ee.settings', targetType: 'settings' },

  // Clés de sauvegarde. Les deux gestes les plus lourds de conséquence du
  // système : ils décident de ce qui restera lisible.
  'POST /backup/keys': { action: 'backup.keys.rotate', targetType: 'backup_key' },
  'POST /backup/keys/:kid/retire': {
    action: 'backup.keys.retire', targetType: 'backup_key', param: 'kid',
  },
  'POST /reserved-alanya-phones': { action: 'phones.reserve', targetType: 'phone' },
  'DELETE /reserved-alanya-phones/:phone': { action: 'phones.release', targetType: 'phone', param: 'phone' },
  'POST /official-account': { action: 'official.create', targetType: 'user' },

  // Assistance éditoriale. Ces deux routes n'écrivent rien — elles seraient
  // donc candidates à SKIP, comme `POST /broadcasts/estimate`. Elles y échappent
  // pour deux raisons : elles envoient du texte chez un tiers, et elles coûtent
  // de l'argent. Quand une traduction publiée se révélera fautive, savoir
  // qu'elle vient de la machine et non d'un traducteur change le diagnostic.
  'POST /ai/translate': { action: 'ai.translate', targetType: 'ai' },
  'POST /ai/review': { action: 'ai.review', targetType: 'ai' },

  // Accueil des nouveaux
  'PUT /welcome/draft': { action: 'welcome.draft', targetType: 'welcome' },
  'POST /welcome/publish': { action: 'welcome.publish', targetType: 'welcome' },
  'POST /welcome/backfill': { action: 'welcome.backfill', targetType: 'welcome' },
  'PUT /welcome/status': { action: 'welcome.status', targetType: 'welcome' },

  // Abonnement. Les transitions de l'interrupteur exigent un motif : il est
  // recopié ici (`body.reason`).
  'PUT /billing/settings': { action: 'billing.settings', targetType: 'billing' },
  'POST /billing/model': { action: 'billing.model', targetType: 'billing' },
  'POST /billing/activate': { action: 'billing.activate', targetType: 'billing' },
  'POST /billing/deactivate': { action: 'billing.deactivate', targetType: 'billing' },
  'POST /billing/extend-grace': { action: 'billing.grace', targetType: 'billing' },
  'POST /billing/plans': { action: 'billing.plans.create', targetType: 'plan' },
  'PUT /billing/plans/:id': { action: 'billing.plans.update', targetType: 'plan', param: 'id' },
  'PUT /billing/features/:code': { action: 'billing.features.update', targetType: 'feature', param: 'code' },
  'POST /billing/codes': { action: 'billing.codes.generate', targetType: 'billing' },
  'POST /billing/codes/:id/revoke': { action: 'billing.codes.revoke', targetType: 'code', param: 'id' },
  'POST /users/:id/billing/gift': { action: 'billing.gift', targetType: 'user', param: 'id' },
  'POST /users/:id/badge/revoke': { action: 'badge.revoke', targetType: 'user', param: 'id' },
  'POST /users/:id/badge/restore': { action: 'badge.restore', targetType: 'user', param: 'id' },

  // Vérification d'identité. Refus, pièce demandée et révocation portent un
  // motif (`body.reason`), recopié ici. Les ouvertures de pièces ont leur
  // propre journal (verification_document_access).
  'POST /verifications/:id/approve': { action: 'verifications.approve', targetType: 'verification', param: 'id' },
  'POST /verifications/:id/refuse': { action: 'verifications.refuse', targetType: 'verification', param: 'id' },
  'POST /verifications/:id/request-document': {
    action: 'verifications.request_document', targetType: 'verification', param: 'id',
  },
  'POST /verifications/:id/revoke': { action: 'verifications.revoke', targetType: 'verification', param: 'id' },
  'POST /verifications/:id/reconfirm': { action: 'verifications.reconfirm', targetType: 'verification', param: 'id' },

  // Stickers. Le verbe porte le nom de la permission qui garde la route
  // (AGENTS.md) : charger, poser et modérer sont le quotidien de l'admin ;
  // publier et régler décident de ce que tous les comptes voient.
  'POST /sticker-packs': { action: 'stickers.write', targetType: 'sticker_pack' },
  'PATCH /sticker-packs/:id': { action: 'stickers.write', targetType: 'sticker_pack', param: 'id' },
  'POST /sticker-packs/:id/stickers': { action: 'stickers.write', targetType: 'sticker_pack', param: 'id' },
  'PATCH /stickers/:id': { action: 'stickers.write', targetType: 'sticker', param: 'id' },
  'DELETE /stickers/:id': { action: 'stickers.write', targetType: 'sticker', param: 'id' },
  'POST /sticker-packs/:id/publish': { action: 'stickers.publish', targetType: 'sticker_pack', param: 'id' },
  'POST /sticker-packs/:id/archive': { action: 'stickers.publish', targetType: 'sticker_pack', param: 'id' },
  'PUT /sticker-settings': { action: 'stickers.settings', targetType: 'settings' },
  'POST /sticker-assets/:id/takedown': { action: 'stickers.moderate', targetType: 'sticker_asset', param: 'id' },

  // Compte de l'administrateur lui-même
  'PUT /me': { action: 'profile.update', targetType: 'self' },
  'PUT /me/password': { action: 'profile.password', targetType: 'self' },
};

function truncate(value, max) {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Motif de l'action, tel qu'un humain l'a saisi.
 *
 * Deux champs, jamais le corps entier : `PUT /me/password` transporte un mot de
 * passe en clair, et une seule route de ce genre suffirait à rendre la table
 * plus dangereuse que ce qu'elle protège.
 */
function reasonFrom(body) {
  if (!body || typeof body !== 'object') return null;
  return truncate(body.reason ?? body.note, 500);
}

async function record(req, res) {
  // `req.route` n'est peuplé que si une route a effectivement traité la
  // requête : un 404 n'a rien à journaliser.
  const path = req.route?.path;
  if (!path) return;

  const key = `${req.method} ${path}`;
  if (SKIP.has(key)) return;

  const adminId = req.user?.alanyaID ?? null;
  if (!adminId) return;

  const entry = ACTIONS[key];
  const targetId = entry?.param
    ? truncate(req.params?.[entry.param], 64)
    : truncate(req.params?.id, 64);

  await pool.execute(
    `INSERT INTO admin_audit
       (admin_id, action, route, target_type, target_id, reason, ip, user_agent, status_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      adminId,
      entry?.action ?? 'unmapped',
      truncate(key, 160),
      entry?.targetType ?? null,
      targetId,
      reasonFrom(req.body),
      truncate(req.ip, 64),
      truncate(req.get('user-agent'), 255),
      res.statusCode,
    ],
  );
}

function adminAudit(req, res, next) {
  if (!MUTATING.has(req.method)) return next();

  res.on('finish', () => {
    // Une action refusée n'a rien modifié ; la journaliser noierait les vraies
    // sous les tentatives malformées.
    if (res.statusCode >= 400) return;
    record(req, res).catch((e) => {
      console.error('[AdminAudit] écriture échouée:', e.message);
    });
  });

  next();
}

module.exports = { adminAudit, ACTIONS, SKIP, reasonFrom };
