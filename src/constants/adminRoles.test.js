const assert = require('assert');
const {
  ALL_PERMISSIONS,
  ADMIN_PERMISSIONS,
  SUPER_ADMIN_ONLY,
  ROLE_USER,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  permissionsFor,
  can,
} = require('./adminRoles');
const adminRouter = require('../routes/admin');

/* ── Le modèle de rôles ──────────────────────────────────────────────── */
// Le super-admin détient tout ce que détient l'admin : sans cette propriété,
// une route ouverte à l'admin pourrait être fermée au super-admin.
for (const p of ADMIN_PERMISSIONS) {
  assert.ok(can(ROLE_SUPER_ADMIN, p), `le super-admin devrait détenir ${p}`);
}
// Et réciproquement, l'admin ne détient aucune permission réservée.
for (const p of SUPER_ADMIN_ONLY) {
  assert.ok(!can(ROLE_ADMIN, p), `l’admin ne devrait pas détenir ${p}`);
}

// Un utilisateur ordinaire n'a rien, même pas la lecture.
assert.deepStrictEqual(permissionsFor(ROLE_USER), []);
assert.strictEqual(can(ROLE_USER, 'users.read'), false);
assert.strictEqual(can(undefined, 'users.read'), false);
assert.strictEqual(can(ROLE_ADMIN, 'permission.inventée'), false);

// Le correctif de la garde manquante : bannir était ouvert à tout admin alors
// que le commentaire du contrôleur annonçait « super-admin uniquement ».
assert.strictEqual(can(ROLE_ADMIN, 'users.ban'), false, 'bannir remonte au super-admin');
assert.strictEqual(can(ROLE_ADMIN, 'users.unban'), false, 'débannir suit bannir');
assert.strictEqual(can(ROLE_SUPER_ADMIN, 'users.ban'), true);
// Les codes d'activation sont des années d'abonnement : générer ou annuler reste
// au super-admin, comme offrir un abonnement. Les lister est une lecture.
assert.strictEqual(can(ROLE_ADMIN, 'billing.codes'), false, 'générer des codes : super-admin');
assert.strictEqual(can(ROLE_SUPER_ADMIN, 'billing.codes'), true);
assert.strictEqual(can(ROLE_ADMIN, 'billing.read'), true, 'lister les codes : lecture');
// Ce que l'admin garde : lire, diagnostiquer, retirer un contenu.
assert.strictEqual(can(ROLE_ADMIN, 'documents.trace'), false, 'enquête par empreinte : super-admin');
assert.strictEqual(can(ROLE_SUPER_ADMIN, 'documents.trace'), true);
assert.strictEqual(can(ROLE_ADMIN, 'users.read'), true);
assert.strictEqual(can(ROLE_ADMIN, 'audit.read'), true);
assert.strictEqual(can(ROLE_ADMIN, 'media.delete'), true);

/* ── Chaque route déclare sa permission ──────────────────────────────── */
// C'est le garde-fou du chantier : une route ajoutée sans `requirePermission`
// fait échouer ce test au lieu de s'ouvrir silencieusement à tout admin.
//
// `/auth/login` est hors gardes — c'est elle qui authentifie.
const UNGUARDED = new Set(['POST /auth/login']);

const routes = [];
for (const layer of adminRouter.stack) {
  if (!layer.route) continue;
  const methods = Object.entries(layer.route.methods)
    .filter(([, used]) => used)
    .map(([m]) => m.toUpperCase());
  const declared = layer.route.stack
    .map((s) => s.handle?.permission)
    .filter(Boolean);
  for (const method of methods) {
    routes.push({ key: `${method} ${layer.route.path}`, declared });
  }
}

assert.ok(routes.length > 50, `pile de routeur inattendue : ${routes.length} routes`);

const sansPermission = routes
  .filter((r) => !UNGUARDED.has(r.key) && r.declared.length === 0)
  .map((r) => r.key);
assert.deepStrictEqual(
  sansPermission,
  [],
  `route(s) sans requirePermission :\n  ${sansPermission.join('\n  ')}`,
);

const enTrop = routes.filter((r) => r.declared.length > 1).map((r) => r.key);
assert.deepStrictEqual(enTrop, [], `route(s) avec plusieurs permissions :\n  ${enTrop.join('\n  ')}`);

const inconnues = routes
  .flatMap((r) => r.declared)
  .filter((p) => !ALL_PERMISSIONS.has(p));
assert.deepStrictEqual(inconnues, [], `permission(s) inconnue(s) : ${inconnues.join(', ')}`);

/* ── Et pas de permission morte ──────────────────────────────────────── */
// Une permission que plus aucune route n'exige laisse croire qu'un pouvoir est
// encadré alors qu'il a disparu — ou pire, qu'il est passé ailleurs sans garde.
const utilisees = new Set(routes.flatMap((r) => r.declared));
const mortes = [...ALL_PERMISSIONS].filter((p) => !utilisees.has(p));
assert.deepStrictEqual(mortes, [], `permission(s) qu’aucune route n’exige : ${mortes.join(', ')}`);

console.log(
  `adminRoles.test.js OK — ${routes.length} routes, ${ALL_PERMISSIONS.size} permissions, ` +
    `${ADMIN_PERMISSIONS.length} pour l’admin`,
);
