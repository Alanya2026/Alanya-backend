const assert = require('assert');
const { buildUsersWhere } = require('./usersQuery');

// Aucun filtre → pas de WHERE et tri par défaut.
const none = buildUsersWhere({});
assert.strictEqual(none.whereSql, '');
assert.strictEqual(none.sortCol, 'u.created_at');
assert.strictEqual(none.dir, 'DESC');
assert.deepStrictEqual(none.params, []);

// Filtre type de compte (account_type, socle de compte).
const at = buildUsersWhere({ account_type: '1' });
assert.match(at.whereSql, /u\.account_type = \?/);
assert.deepStrictEqual(at.params, [1]);

// Filtre rôle (type_compte).
const tc = buildUsersWhere({ type_compte: '2' });
assert.match(tc.whereSql, /u\.type_compte = \?/);
assert.deepStrictEqual(tc.params, [2]);

// Un type_compte vide est ignoré (même traitement que account_type).
const tcEmpty = buildUsersWhere({ type_compte: '' });
assert.strictEqual(tcEmpty.whereSql, '');

// Statut admin = rôle >= 1, toujours.
const admin = buildUsersWhere({ status: 'admin' });
assert.match(admin.whereSql, /u\.type_compte >= \?/);
assert.deepStrictEqual(admin.params, [1]);

// Filtres combinés : pay x rôle x type de compte.
const combo = buildUsersWhere({ idPays: '4', type_compte: '1', account_type: '0' });
assert.match(combo.whereSql, /u\.idPays = \?/);
assert.match(combo.whereSql, /u\.type_compte = \?/);
assert.match(combo.whereSql, /u\.account_type = \?/);
// Ordre des paramètres : ordre des clauses (account_type, type_compte, idPays).
assert.deepStrictEqual(combo.params, [0, 1, '4']);

// La recherche couvre aussi l'alanyaID (sélecteur de comptes E2EE).
const chercheId = buildUsersWhere({ search: '12' });
assert.match(chercheId.whereSql, /CAST\(u\.alanyaID AS CHAR\) LIKE \?/);
assert.deepStrictEqual(chercheId.params, ['%12%', '%12%', '%12%', '%12%']);

// Liste explicite d'IDs : doublons et valeurs invalides écartés.
const ids = buildUsersWhere({ ids: '3, 1,3,abc,-2' });
assert.match(ids.whereSql, /u\.alanyaID IN \(\?,\?\)/);
assert.deepStrictEqual(ids.params, [3, 1]);
assert.deepStrictEqual(buildUsersWhere({ ids: '' }).params, []);

console.log('usersQuery.test.js OK');