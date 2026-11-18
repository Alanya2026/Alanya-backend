/**
 * Lien et QR code d'invitation de groupe — `node src/controllers/groupInvite.test.js`.
 *
 * Vrais contrôleur, service, page publique et analyse des QR ; la base est une
 * simulation en mémoire des tables de la migration 116 (toute requête non
 * simulée fait échouer le test). Éprouve :
 *   - le droit de voir le lien (réglage `onlyAdminsCanShareLink`) et la
 *     stabilité du jeton ; la réinitialisation qui tue l'ancien ;
 *   - l'entrée directe, l'idempotence, le retour interdit d'un exclu, le
 *     groupe complet ;
 *   - l'approbation : demande, annulation, première réponse qui l'emporte ;
 *   - la page publique (échappement, page neutre) et `POST /api/qr/resolve`.
 */
const assert = require('assert');
const path = require('path');

process.env.GROUP_MAX_MEMBERS = '5';

const resolu = (rel) => require.resolve(path.join(__dirname, rel));
const remplace = (rel, exports) => {
  require.cache[resolu(rel)] = { id: resolu(rel), filename: resolu(rel), loaded: true, exports };
};

// ── Base simulée ───────────────────────────────────────────────────────────
const db = {
  convs: new Map(),     // id → { GroupName, hide, approve, share, isGroup }
  members: new Map(),   // id → Map(userId → role)
  links: new Map(),     // id → token
  requests: new Map(),  // `${conv}:${user}` → status
  removed: new Set(),   // `${conv}:${user}`
  users: new Map([[1, 'Propriétaire'], [2, 'Awa'], [3, 'Clarisse'], [4, 'Emmanuel'], [5, 'Mireille'], [6, 'Paul'], [7, 'Zoé']]),
};
const membres = (c) => db.members.get(c) || new Map();

const reponses = [
  [/SELECT onlyAdminsCanShareLink, approveNewMembers FROM conversation/, ([c]) => {
    const v = db.convs.get(c);
    return [v ? [{ onlyAdminsCanShareLink: v.share, approveNewMembers: v.approve }] : []];
  }],
  [/SELECT token FROM conv_invite_link WHERE conversID/, ([c]) => [db.links.has(c) ? [{ token: db.links.get(c) }] : []]],
  [/INSERT IGNORE INTO conv_invite_link/, ([c, t]) => {
    if (!db.links.has(c)) db.links.set(c, t);
    return [{ affectedRows: 1 }];
  }],
  [/INSERT INTO conv_invite_link[\s\S]*ON DUPLICATE/, ([c, t]) => { db.links.set(c, t); return [{ affectedRows: 1 }]; }],
  [/FROM conv_invite_link l\s+JOIN conversation/, ([t]) => {
    for (const [c, tok] of db.links) {
      const v = db.convs.get(c);
      if (tok === t && v.isGroup) {
        return [[{
          conversID: c, GroupName: v.GroupName, groupPhoto: null, description: 'Cotisations',
          hideHistoryForNewMembers: v.hide, approveNewMembers: v.approve, memberCount: membres(c).size,
        }]];
      }
    }
    return [[]];
  }],
  [/SELECT 1 FROM conv_participants WHERE conversID = \? AND alanyaID = \?/, ([c, u]) => [membres(c).has(u) ? [{ 1: 1 }] : []]],
  [/SELECT 1 FROM conv_removed_member/, ([c, u]) => [db.removed.has(`${c}:${u}`) ? [{ 1: 1 }] : []]],
  [/SELECT 1 FROM conv_join_request/, ([c, u]) => [db.requests.get(`${c}:${u}`) === 0 ? [{ 1: 1 }] : []]],
  [/INSERT INTO conv_join_request/, ([c, u]) => { db.requests.set(`${c}:${u}`, 0); return [{ affectedRows: 1 }]; }],
  [/UPDATE conv_join_request SET status = 3/, ([c, u]) => {
    if (db.requests.get(`${c}:${u}`) !== 0) return [{ affectedRows: 0 }];
    db.requests.set(`${c}:${u}`, 3);
    return [{ affectedRows: 1 }];
  }],
  [/UPDATE conv_join_request SET status = \?/, ([s, _admin, c, u]) => {
    if (db.requests.get(`${c}:${u}`) !== 0) return [{ affectedRows: 0 }];
    db.requests.set(`${c}:${u}`, s);
    return [{ affectedRows: 1 }];
  }],
  [/FROM conv_join_request r\s+JOIN users/, ([c]) => [[...db.requests]
    .filter(([k, s]) => s === 0 && k.startsWith(`${c}:`) && !membres(c).has(Number(k.split(':')[1])))
    .map(([k]) => { const u = Number(k.split(':')[1]); return { alanyaID: u, nom: db.users.get(u), pseudo: '', avatar_url: 'INDEFINI', createdAt: new Date(0) }; })]],
  [/SELECT COUNT\(\*\) AS n FROM conv_join_request/, ([c]) => [[{ n: [...db.requests]
    .filter(([k, s]) => s === 0 && k.startsWith(`${c}:`) && !membres(c).has(Number(k.split(':')[1]))).length }]]],
  [/SELECT alanyaID FROM conv_participants WHERE conversID = \? AND role >= 1/, ([c]) => [[...membres(c)].filter(([, r]) => r >= 1).map(([u]) => ({ alanyaID: u }))]],
  [/INSERT INTO conv_removed_member/, ([c, u]) => { db.removed.add(`${c}:${u}`); return [{ affectedRows: 1 }]; }],
  [/DELETE FROM conv_removed_member/, ([c, ...us]) => { us.forEach((u) => db.removed.delete(`${c}:${u}`)); return [{ affectedRows: 1 }]; }],
  [/SELECT hideHistoryForNewMembers FROM conversation/, ([c]) => [[{ hideHistoryForNewMembers: db.convs.get(c).hide }]]],
  [/INSERT IGNORE INTO conv_participants/, ([c, u]) => {
    if (membres(c).has(u)) return [{ affectedRows: 0 }];
    membres(c).set(u, 0);
    return [{ affectedRows: 1 }];
  }],
  [/SELECT COUNT\(\*\) AS n FROM conv_participants/, ([c]) => [[{ n: membres(c).size }]]],
  [/SELECT GroupName FROM conversation/, ([c]) => [[{ GroupName: db.convs.get(c).GroupName }]]],
  [/SELECT nom, pseudo FROM users/, ([u]) => [[{ nom: db.users.get(u), pseudo: '' }]]],
];

remplace('../config/db', {
  execute: async (sql, params = []) => {
    for (const [re, fn] of reponses) if (re.test(sql)) return fn(params);
    throw new Error(`SQL non simulé : ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  },
});

const traces = { system: [], pushes: [], emits: [] };
remplace('../utils/systemMessage', {
  postSystemMessage: async (m) => { traces.system.push(m); return { msgID: traces.system.length }; },
  loadUserNames: async (ids) => ({ ids, names: ids.map((i) => db.users.get(i)) }),
  SYSTEM_MESSAGE_TYPE: 6,
});
remplace('../utils/conversationParticipantsCache', { invalidateConversationParticipants: () => {} });
remplace('../services/privacyPrefsService', { contactsAmong: async () => new Set([3]) });
remplace('../services/notificationService', {
  notifyGroupJoinRequest: async (admins, info) => { traces.pushes.push(['request', admins, info]); },
  notifyGroupJoinApproved: async (u, info) => { traces.pushes.push(['approved', u, info]); },
});
remplace('./conversationController', {
  loadEnrichedConversation: async (c, u) => ({ conversID: c, viewer: u, myRole: membres(c).get(u) }),
  emitConversationUpdated: async () => {},
});

const ctrl = require('./groupInviteController');
const svc = require('../services/groupInviteService');
const landing = require('./groupInviteLandingController');

// ── Requête / réponse minimales ────────────────────────────────────────────
const io = { to: (room) => ({ emit: (ev, p) => traces.emits.push([room, ev, p]) }) };
const appeler = async (handler, { user, params = {}, membership, body = {} }) => {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  let erreur = null;
  await handler(
    { user: { alanyaID: user }, params, body, membership, app: { get: () => io } },
    res,
    (e) => { erreur = e; },
  );
  if (erreur) throw erreur;
  return res;
};
const adhesion = (c, u) => ({ conversID: c, role: membres(c).get(u) ?? 0, isGroup: true });

const groupe = (id, opts = {}) => {
  db.convs.set(id, { GroupName: 'Tontine <du> quartier', hide: 1, approve: 0, share: 1, isGroup: 1, ...opts });
  db.members.set(id, new Map([[1, 2], [2, 1]]));
};

(async () => {
  groupe(10);

  // 1. Droit de voir le lien.
  membres(10).set(3, 0);
  let r = await appeler(ctrl.getInviteLink, { user: 3, membership: adhesion(10, 3) });
  assert.strictEqual(r.statusCode, 403, 'membre simple : lien réservé aux admins');
  assert.strictEqual(r.body.code, 'GROUP_INVITE_LINK_ADMIN_ONLY');

  r = await appeler(ctrl.getInviteLink, { user: 2, membership: adhesion(10, 2) });
  assert.strictEqual(r.statusCode, 200);
  const jeton1 = r.body.token;
  assert.ok(svc.TOKEN_RE.test(jeton1), 'jeton de 16 caractères base64url');
  assert.strictEqual(r.body.url, `https://www.alanya237.com/g/${jeton1}`);
  r = await appeler(ctrl.getInviteLink, { user: 1, membership: adhesion(10, 1) });
  assert.strictEqual(r.body.token, jeton1, 'le lien est stable');

  db.convs.get(10).share = 0;
  r = await appeler(ctrl.getInviteLink, { user: 3, membership: adhesion(10, 3) });
  assert.strictEqual(r.statusCode, 200, 'réglage coupé : un membre voit le lien');
  db.convs.get(10).share = 1;
  membres(10).delete(3);

  // 2. Réinitialisation.
  r = await appeler(ctrl.resetInviteLink, { user: 2, membership: adhesion(10, 2) });
  const jeton = r.body.token;
  assert.notStrictEqual(jeton, jeton1);
  assert.strictEqual(traces.system.at(-1).event, 'invite_link_reset');
  r = await appeler(ctrl.previewInvite, { user: 4, params: { token: jeton1 } });
  assert.strictEqual(r.statusCode, 404, 'l\'ancien lien ne marche plus');
  assert.strictEqual(r.body.code, 'INVITE_LINK_INVALID');
  r = await appeler(ctrl.previewInvite, { user: 4, params: { token: '../../etc' } });
  assert.strictEqual(r.statusCode, 404, 'jeton mal formé');

  // 3. Aperçu puis entrée directe.
  r = await appeler(ctrl.previewInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'can_join');
  assert.strictEqual(r.body.group.memberCount, 2);
  assert.strictEqual(r.body.group.hideHistory, true);
  assert.strictEqual(r.body.group.conversID, undefined, 'pas d\'identifiant pour un non-membre');
  assert.ok(!membres(10).has(4), 'l\'aperçu ne fait entrer personne');

  r = await appeler(ctrl.joinByInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'joined');
  assert.strictEqual(membres(10).get(4), 0, 'entré comme simple membre');
  assert.strictEqual(traces.system.at(-1).event, 'member_joined_link');
  assert.strictEqual(traces.system.at(-1).actorID, 4);
  assert.ok(traces.emits.some(([room, ev]) => room === 'user_4' && ev === 'conversation:created'));

  const avant = traces.system.length;
  r = await appeler(ctrl.joinByInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'already_member');
  assert.strictEqual(r.body.conversation.conversID, 10);
  assert.strictEqual(traces.system.length, avant, 'idempotent : pas de second message');

  // 4. Un exclu ne revient pas seul ; un membre qui le rajoute lève l'interdit.
  await svc.noterRetrait(10, 4, 2);
  membres(10).delete(4);
  r = await appeler(ctrl.previewInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'removed');
  r = await appeler(ctrl.joinByInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(r.body.code, 'GROUP_REMOVED');
  await svc.oublierRetrait(10, [4]);
  r = await appeler(ctrl.previewInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'can_join');

  // 5. Approbation.
  db.convs.get(10).approve = 1;
  r = await appeler(ctrl.joinByInvite, { user: 5, params: { token: jeton } });
  assert.strictEqual(r.statusCode, 202);
  assert.strictEqual(r.body.state, 'pending');
  assert.ok(!membres(10).has(5), 'une demande ne fait pas entrer');
  const push = traces.pushes.at(-1);
  assert.deepStrictEqual([push[0], push[1].sort()], ['request', [1, 2]], 'les admins sont prévenus');
  assert.ok(traces.emits.some(([room, ev, p]) => room === 'user_1' && ev === 'group:join_requests' && p.pendingCount === 1));

  r = await appeler(ctrl.previewInvite, { user: 5, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'pending');

  r = await appeler(ctrl.cancelJoinRequest, { user: 5, params: { token: jeton } });
  assert.strictEqual(r.body.cancelled, true);
  r = await appeler(ctrl.joinByInvite, { user: 5, params: { token: jeton } });
  assert.strictEqual(r.body.state, 'pending', 'nouvelle demande après annulation');
  await appeler(ctrl.joinByInvite, { user: 3, params: { token: jeton } });

  r = await appeler(ctrl.listJoinRequests, { user: 2, membership: adhesion(10, 2) });
  assert.deepStrictEqual(r.body.requests.map((x) => [x.alanyaID, x.isContact, x.avatar_url]), [[5, false, null], [3, true, null]]);

  r = await appeler(ctrl.approveJoinRequest, { user: 2, params: { userId: '5' }, membership: adhesion(10, 2) });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(membres(10).get(5), 0);
  assert.strictEqual(traces.system.at(-1).event, 'join_approved');
  assert.strictEqual(traces.system.at(-1).actorID, 2, 'l\'acteur est l\'admin');
  assert.deepStrictEqual(traces.pushes.at(-1).slice(0, 2), ['approved', 5]);
  r = await appeler(ctrl.approveJoinRequest, { user: 1, params: { userId: '5' }, membership: adhesion(10, 1) });
  assert.strictEqual(r.statusCode, 404, 'la première réponse l\'emporte');

  r = await appeler(ctrl.rejectJoinRequest, { user: 1, params: { userId: '3' }, membership: adhesion(10, 1) });
  assert.strictEqual(r.statusCode, 200);
  assert.ok(!membres(10).has(3));
  assert.ok(traces.emits.some(([room, ev, p]) => room === 'user_3' && ev === 'group:join_decided' && p.approved === false));

  // 6. Groupe complet (GROUP_MAX_MEMBERS = 5) : 1, 2, 4? non — 1, 2, 5 + 6, 7.
  db.convs.get(10).approve = 0;
  await appeler(ctrl.joinByInvite, { user: 6, params: { token: jeton } });
  await appeler(ctrl.joinByInvite, { user: 7, params: { token: jeton } });
  assert.strictEqual(membres(10).size, 5);
  r = await appeler(ctrl.joinByInvite, { user: 4, params: { token: jeton } });
  assert.strictEqual(r.statusCode, 409);
  assert.strictEqual(r.body.code, 'GROUP_FULL');

  // 7. Page publique : échappement, pas de fuite, page neutre.
  const html = landing.pageGroupe({ nom: '<script>x</script>', memberCount: 3, token: jeton });
  assert.ok(!html.includes('<script>x'), 'nom échappé');
  assert.ok(html.includes(`alanya://group/${jeton}`));
  assert.ok(html.includes('3 membres'));
  const envoi = (statut) => ({
    statut: null, entetes: {}, html: '',
    status(s) { this.statut = s; return this; },
    set(h) { Object.assign(this.entetes, h); return this; },
    type() { return this; },
    send(h) { this.html = h; return this; },
  });
  let page = envoi();
  await landing.showGroupInviteLanding({ params: { token: jeton } }, page);
  assert.strictEqual(page.statut, 200);
  assert.strictEqual(page.entetes['Cache-Control'], 'no-store');
  assert.ok(page.html.includes('Tontine &lt;du&gt; quartier'));
  page = envoi();
  await landing.showGroupInviteLanding({ params: { token: jeton1 } }, page);
  assert.strictEqual(page.statut, 404, 'lien réinitialisé : page neutre');
  assert.ok(!page.html.includes('Tontine'));

  // 8. Le scan d'un QR de groupe passe par la résolution commune.
  remplace('../services/contactService', {});
  remplace('../utils/userSocketRegistry', {});
  remplace('../socket/state/qrLoginSessions', {});
  remplace('../socket/state/qrContactTokens', {});
  const { resolveQr } = require('./qrController');
  r = await appeler(resolveQr, { user: 4, body: { payload: `https://ancien-domaine.example/g/${jeton}` } });
  assert.strictEqual(r.body.type, 'group');
  assert.strictEqual(r.body.token, jeton);
  assert.strictEqual(r.body.state, 'full');
  r = await appeler(resolveQr, { user: 4, body: { payload: `https://www.alanya237.com/g/${jeton1}` } });
  assert.strictEqual(r.statusCode, 404);

  console.log('groupInvite : tous les tests passent');
})().catch((e) => { console.error(e); process.exit(1); });
