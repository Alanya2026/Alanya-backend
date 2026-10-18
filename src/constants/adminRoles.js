/**
 * Rôles d'administration et permissions nommées.
 *
 * `users.type_compte` porte le rôle depuis toujours — 0 utilisateur, 1 admin,
 * 2 super-admin — et ne change pas ici : ni renumérotation, ni colonne
 * supplémentaire, ni migration. Ce qui change, c'est qu'une route cesse de
 * déclarer un *niveau* pour déclarer une *intention*.
 *
 * Pourquoi ça compte : jusqu'ici, répondre à « qui a le droit de bannir ? »
 * demandait de lire les 54 lignes du routeur. C'est exactement comme ça que
 * `POST /users/:id/ban` s'est retrouvé gardé par `adminAuth` seul alors que le
 * commentaire au-dessus de `banUser` annonçait « super-admin uniquement ».
 *
 * Les verbes sont ceux du journal d'audit (`middleware/adminAudit.js`) : la
 * même action y porte le même nom, sinon les deux cartes divergent.
 *
 * Limite assumée du modèle : le rôle est attaché au type de compte, pas à la
 * personne. Les administrateurs sont donc identiques entre eux — on peut
 * resserrer ce que « admin » signifie, pas distinguer un support d'un
 * modérateur.
 */

/**
 * Ce qu'un administrateur peut faire.
 *
 * Reproduit la frontière actuelle, à une exception près : le bannissement
 * passe au super-admin (voir `SUPER_ADMIN_ONLY`). Tout le reste garde
 * exactement le niveau qu'il avait — un chantier qui déplace la frontière et
 * la rend lisible en même temps serait irrelisible.
 */
const ADMIN_PERMISSIONS = [
  // Lecture et diagnostic
  'stats.read',
  'users.read',
  'groups.read',
  'media.read',
  'meetings.read',
  'broadcasts.read',
  'trips.read',
  'purges.read',
  'safebox.read',
  'settings.read',
  'phones.read',
  'official.read',
  'villes.read',
  'audit.read',

  // Modération : trier et trancher restent au niveau admin — c'est le travail
  // quotidien. La sanction lourde, elle, passe par `users.ban`, réservé au
  // super-admin, depuis la fiche du compte.
  'reports.read',
  'reports.handle',

  // Exports — contiennent des données personnelles. Restent au niveau admin
  // parce qu'ils y étaient ; à réexaminer, c'est la permission la plus proche
  // d'une exfiltration de tout l'annuaire.
  'users.export',
  'analytics.export',

  // Son propre compte
  'profile.read',
  'profile.update',
  'profile.password',

  // Contenus : retirer ce qui n'a rien à faire là
  'media.delete',
  'meetings.end',
  'meetings.delete',
  'groups.delete',

  // Comptes, sans les actions irréversibles
  'users.create',
  'users.phone',

  // Diffusions
  'broadcasts.send',
  'broadcasts.cancel',

  // Assistance éditoriale — traduire et relire le contenu officiel avant
  // publication. Reste au niveau admin parce qu'elle n'écrit rien : elle
  // remplit des champs que les permissions `welcome.*` et `broadcasts.send`
  // gardent déjà. Un administrateur qui peut rédiger peut se faire aider.
  'ai.editorial',

  // Abonnement : consulter l'état de l'offre et les plans. Voir n'est pas
  // décider — les réglages et les prix restent au super-admin.
  'billing.read',

  // Dossiers d'identité : tout administrateur instruit et décide (volet 5).
  // L'auteur de chaque décision est tracé, chaque ouverture de pièce aussi.
  'verifications.read',
  'verifications.decide',

  // Stickers (type 10) : préparer le catalogue et modérer. Charger des packs,
  // poser un emoji ou un ordre, retirer une image signalée — le quotidien.
  // Publier et régler le lancement, qui décident de ce que TOUT LE MONDE voit,
  // sont au super-admin (voir `SUPER_ADMIN_ONLY`).
  'stickers.read',
  'stickers.write',
  'stickers.moderate',
];

/**
 * Ce que le super-admin est seul à pouvoir faire.
 *
 * `users.ban` et `users.unban` sont les deux seules à changer de niveau : elles
 * étaient ouvertes à tout administrateur. Débannir suit bannir — sans quoi un
 * administrateur pourrait défaire la décision d'un super-admin.
 */
const SUPER_ADMIN_ONLY = [
  'users.ban',
  'users.unban',
  'users.role',
  'users.socle',
  'users.delete',
  'purges.run',
  'purges.settings',
  // Réglages du coffre-fort : l'espace offert à chaque inscrit, donc la
  // facture MEGA. Au niveau des purges, pour la même raison.
  'safebox.settings',
  // Supprimer partout un fichier signalé du coffre, copies enregistrées par
  // d'autres comprises : irréversible, MEGA ne garde aucune copie.
  'safebox.delete',
  'trips.purge',
  'settings.write',
  // Rotation des clés de sauvegarde. Au niveau super-admin comme la
  // suppression d'un compte : mal conduite, elle rend illisibles toutes les
  // sauvegardes déjà déposées, sans recours et sans avertissement.
  'backup.keys',
  'phones.reserve',
  'phones.release',
  'official.create',
  'welcome.read',
  'welcome.draft',
  'welcome.publish',
  'welcome.backfill',
  'welcome.status',
  // L'interrupteur du payant et le catalogue : ils décident de qui paie et
  // combien. Au niveau des purges et des clés, pour la même raison — une
  // erreur touche tous les comptes à la fois.
  'billing.settings',
  'billing.plans',
  // Offrir un abonnement : une période sans paiement, donc de l'argent.
  'billing.gift',
  // Générer ou annuler des codes d'activation : chaque code est une année
  // d'abonnement. Même niveau que l'abonnement offert.
  'billing.codes',
  // Publier un pack de stickers et régler le lancement (interrupteur, version
  // minimale) : ces gestes décident de ce que tous les comptes voient d'un
  // coup, comme l'interrupteur du payant. Charger et modérer restent à
  // l'admin.
  'stickers.publish',
  'stickers.settings',
];

const ROLE_USER = 0;
const ROLE_ADMIN = 1;
const ROLE_SUPER_ADMIN = 2;

const ROLES = {
  [ROLE_ADMIN]: {
    name: 'admin',
    label: 'Administrateur',
    permissions: new Set(ADMIN_PERMISSIONS),
  },
  [ROLE_SUPER_ADMIN]: {
    name: 'super-admin',
    label: 'Super-administrateur',
    permissions: new Set([...ADMIN_PERMISSIONS, ...SUPER_ADMIN_ONLY]),
  },
};

/** Toutes les permissions connues — sert à refuser une faute de frappe. */
const ALL_PERMISSIONS = new Set([...ADMIN_PERMISSIONS, ...SUPER_ADMIN_ONLY]);

function roleFor(typeCompte) {
  return ROLES[Number(typeCompte) || 0] ?? null;
}

/** Permissions effectives d'un compte, triées — c'est ce que le panneau lit. */
function permissionsFor(typeCompte) {
  const role = roleFor(typeCompte);
  return role ? [...role.permissions].sort() : [];
}

function can(typeCompte, permission) {
  return roleFor(typeCompte)?.permissions.has(permission) ?? false;
}

module.exports = {
  ROLE_USER,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  ROLES,
  ADMIN_PERMISSIONS,
  SUPER_ADMIN_ONLY,
  ALL_PERMISSIONS,
  roleFor,
  permissionsFor,
  can,
};
