/**
 * Appareils à qui chiffrer, pour une conversation donnée.
 *
 * C'est la question que l'émetteur pose avant chaque premier message :
 * « pour qui dois-je sceller la clé de contenu ? ». La réponse est la liste
 * des appareils actifs de tous les autres participants, PLUS mes autres
 * appareils — sans ces derniers, mon second téléphone ne verrait pas ce que
 * j'écris depuis le premier.
 *
 * ── Pourquoi un appareil sans bundle ne bloque pas toujours ──
 *
 * Deux cas qui n'ont pas le même poids :
 *
 *  - Un appareil d'un AUTRE participant sans bundle publié : chiffrer
 *    reviendrait à lui envoyer un message qu'il ne pourra jamais lire, sans
 *    qu'il le sache. La conversation n'est donc pas chiffrable, et l'émetteur
 *    envoie en clair — comme aujourd'hui, et sans cadenas affiché.
 *
 *  - Un de MES autres appareils sans bundle : il manquera ce message, mais le
 *    destinataire, lui, le recevra chiffré. Renoncer au chiffrement pour
 *    toute la conversation parce que ma tablette n'a pas encore publié ses
 *    clés serait disproportionné. L'appareil est signalé à part
 *    (`mesAppareilsSansCles`) pour que l'application puisse le dire, et le
 *    manque se résorbe de lui-même à son prochain démarrage.
 *
 * C'est la règle de bascule d'une flotte mixte : tant qu'un correspondant n'a
 * pas mis à jour, on continue en clair, et le cadenas ne mentira jamais.
 */

const pool = require('./../config/db');

/**
 * Assemble la réponse à partir des lignes lues. Fonction pure : c'est elle
 * que le test couvre, sans base.
 *
 * @param {object}   p
 * @param {Array}    p.appareils      `{ id, alanyaID }` actifs des participants
 * @param {Set|Array} p.avecCles      identifiants d'appareils ayant un bundle
 * @param {number}   p.moiId          compte appelant
 * @param {number}   p.monAppareilId  appareil appelant (exclu des cibles)
 * @param {Map}      [p.details]      appareilId → `{ identityKey, capacite }`,
 *   recopiés sur chaque cible quand ils sont fournis
 */
function evalueCibles({ appareils, avecCles, moiId, monAppareilId, details }) {
  const cles = avecCles instanceof Set ? avecCles : new Set((avecCles || []).map(Number));
  const moi = Number(moiId);
  const monAppareil = Number(monAppareilId);

  const cibles = [];
  const autresSansCles = [];
  const mesAppareilsSansCles = [];

  for (const a of appareils) {
    const appareilId = Number(a.id);
    // L'appareil qui demande détient déjà le clair : il n'est jamais sa
    // propre cible.
    if (appareilId === monAppareil) continue;

    const alanyaID = Number(a.alanyaID);
    const estMoi = alanyaID === moi;
    const aDesCles = cles.has(appareilId);

    if (aDesCles) {
      const d = details && details.get(appareilId);
      cibles.push(d
        ? { appareilId, alanyaID, estMoi, identityKey: d.identityKey, capacite: d.capacite }
        : { appareilId, alanyaID, estMoi });
    } else if (estMoi) {
      mesAppareilsSansCles.push(appareilId);
    } else {
      autresSansCles.push(appareilId);
    }
  }

  return {
    cibles,
    autresSansCles,
    mesAppareilsSansCles,
    // Un seul appareil tiers sans bundle suffit à renoncer. Et une
    // conversation sans AUCUNE cible tierce — correspondant qui n'a plus
    // d'appareil actif — n'est pas « chiffrable » : il n'y a personne à
    // chiffrer, et afficher un cadenas serait un mensonge par omission.
    chiffrable: autresSansCles.length === 0
      && cibles.some((c) => !c.estMoi),
  };
}

/**
 * Lit les appareils cibles d'une conversation.
 *
 * Rend `null` si l'appelant n'est pas participant — le contrôleur en fait un
 * 404, comme `join_conversation` : exister et ne pas être autorisé doivent se
 * ressembler, sinon la réponse dit qui parle à qui.
 */
async function appareilsDeConversation(conversationID, moiId, monAppareilId) {
  const [membre] = await pool.execute(
    'SELECT 1 FROM conv_participants WHERE conversID = ? AND alanyaID = ? LIMIT 1',
    [conversationID, moiId],
  );
  if (membre.length === 0) return null;
  return lireCibles(conversationID, moiId, monAppareilId);
}

/**
 * Les cibles, sans contrôle d'appartenance : l'appelant l'a déjà fait.
 *
 * Une seule requête : les appareils actifs de tous les participants, et
 * pour chacun la présence d'un bundle. La jointure gauche sur
 * `e2ee_device_keys` évite une seconde lecture pour distinguer
 * « appareil connu sans clés » de « appareil absent ».
 *
 * La clé d'identité et la capacité viennent avec, et c'est voulu : elles
 * sont publiques, et elles permettent au client de ne demander un bundle —
 * donc de ne consommer une clé à usage unique — que pour les appareils
 * sans session, ou dont l'identité a changé depuis (réinstallation). Sans
 * elles, il faudrait demander le bundle pour savoir, c'est-à-dire
 * consommer pour lire (docs/e2ee, chapitre 13).
 */
async function lireCibles(conversationID, moiId, monAppareilId) {
  const [appareils] = await pool.execute(
    `SELECT a.id, a.alanyaID, (k.appareil_id IS NOT NULL) AS a_des_cles,
            k.identity_key, k.capacite
       FROM conv_participants p
       JOIN appareils a ON a.alanyaID = p.alanyaID AND a.revoked_at IS NULL
       LEFT JOIN e2ee_device_keys k ON k.appareil_id = a.id
      WHERE p.conversID = ?`,
    [conversationID],
  );

  const avecCles = new Set(
    appareils.filter((a) => Number(a.a_des_cles) === 1).map((a) => Number(a.id)),
  );
  const details = new Map(
    appareils
      .filter((a) => Number(a.a_des_cles) === 1 && a.identity_key)
      .map((a) => [Number(a.id), {
        identityKey: a.identity_key.toString('base64'),
        capacite: Number(a.capacite),
      }]),
  );

  return {
    conversationID: Number(conversationID),
    ...evalueCibles({ appareils, avecCles, moiId, monAppareilId, details }),
  };
}

/**
 * Écart entre les enveloppes d'un envoi et les appareils qui doivent en
 * recevoir une. Fonction pure.
 *
 * C'est ce contrôle qui permet au client de NE PAS redemander la liste
 * d'appareils avant chaque message : il chiffre avec celle qu'il a en
 * mémoire, et si elle a vieilli — un appareil ajouté, un autre révoqué — le
 * serveur le voit ici et refuse, liste à jour jointe. Sans lui, un appareil
 * apparu depuis la dernière liste ne recevrait rien, sans que personne le
 * sache.
 *
 * @returns {{ manquants: number[], enTrop: number[] }}
 */
function ecartCouverture({ cibles, enveloppes }) {
  const attendus = new Set((cibles || []).map((c) => Number(c.appareilId)));
  const recus = new Set((enveloppes || []).map((e) => Number(e.appareilId)));
  return {
    manquants: [...attendus].filter((id) => !recus.has(id)).sort((a, b) => a - b),
    enTrop: [...recus].filter((id) => !attendus.has(id)).sort((a, b) => a - b),
  };
}

/**
 * Contrôle de couverture d'un envoi chiffré à DEUX (les groupes passeront
 * par les chaînes d'expéditeur, où chaque message n'a pas d'enveloppe par
 * appareil).
 *
 * Rend `null` quand les enveloppes couvrent exactement les appareils
 * attendus, sinon le refus à renvoyer au client : `manquants`, `enTrop`, et
 * la liste à jour (`appareils`, même forme que `GET /api/e2ee/devices`),
 * pour que le client chiffre à nouveau sans un aller-retour de plus.
 */
async function refusCouverture({ conversationID, senderID, monAppareilId, enveloppes, e2eeSince = null }) {
  const appareils = await lireCibles(conversationID, senderID, monAppareilId);
  const ecart = ecartCouverture({ cibles: appareils.cibles, enveloppes });
  if (ecart.manquants.length === 0 && ecart.enTrop.length === 0) return null;
  return { ...ecart, appareils: { ...appareils, e2eeSince } };
}

module.exports = {
  evalueCibles, appareilsDeConversation, lireCibles, ecartCouverture, refusCouverture,
};
