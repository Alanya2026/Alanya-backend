/**
 * Acheminement des enveloppes : une émission par appareil, et chacun ne
 * reçoit que la sienne.
 *
 * ── Pourquoi pas une seule émission vers `user_<id>` ──
 *
 * C'est ce que fait le chemin en clair, et c'est très bien : le payload est
 * identique pour tous, socket.io ne le sérialise qu'une fois, et un groupe de
 * 200 coûte une émission.
 *
 * Un message chiffré n'a pas cette propriété. Le CORPS est commun, mais la
 * clé de contenu est scellée séparément pour chaque appareil : le payload
 * diffère donc par destinataire. Diffuser le tout à tout le monde aurait deux
 * défauts. Le premier, fonctionnel : chaque appareil devrait trier N
 * enveloppes pour trouver la sienne. Le second, et c'est lui qui tranche :
 * cela révélerait à chacun COMBIEN d'appareils ont ses correspondants. Rien
 * d'exploitable, mais une métadonnée qu'il n'a pas à connaître — et le propre
 * du chiffrement de bout en bout est de n'en donner aucune qui ne soit
 * nécessaire.
 *
 * ── Deux événements, et le serveur seul décide lequel ──
 *
 * `message:sent` vers les AUTRES appareils de l'expéditeur : c'est son propre
 * message, il s'affiche chez lui côté droit, déjà acquitté.
 * `message:received` vers les appareils des destinataires.
 *
 * Le choix ne peut pas être délégué au client. Étiqueter l'appareil d'un
 * correspondant comme « le mien » lui ferait afficher un message entrant
 * comme un message qu'il aurait écrit — une bulle attribuée au mauvais
 * auteur, que rien de son côté ne permettrait de détecter.
 */

const pool = require('../../../config/db');
const {
  getCachedSenderDevices,
  setCachedSenderDevices,
} = require('../../../utils/senderDevicesCache');

/** Appareils actifs de l'expéditeur, par le cache 60 s. */
async function chargeMesAppareils(senderID) {
  const cache = getCachedSenderDevices(senderID);
  if (cache) return cache;
  const [lignes] = await pool.execute(
    'SELECT id FROM appareils WHERE alanyaID = ? AND revoked_at IS NULL',
    [senderID],
  );
  const ids = new Set(lignes.map((l) => Number(l.id)));
  setCachedSenderDevices(senderID, ids);
  return ids;
}

/**
 * Décide, pour chaque enveloppe, la room et l'événement. Fonction pure :
 * c'est elle que le test couvre.
 *
 * L'appareil émetteur est écarté s'il se présente : il a déjà reçu son accusé
 * par `socket.emit`, et lui renvoyer le corps scellé le ferait déchiffrer un
 * message dont il détient le clair.
 */
function planRoutage({ enveloppes, mesAppareils, monAppareilId }) {
  const miens = mesAppareils instanceof Set
    ? mesAppareils : new Set((mesAppareils || []).map(Number));
  const moi = monAppareilId == null ? null : Number(monAppareilId);

  const plan = [];
  for (const env of enveloppes || []) {
    const appareilId = Number(env.appareilId);
    if (moi != null && appareilId === moi) continue;
    plan.push({
      appareilId,
      room: `appareil_${appareilId}`,
      event: miens.has(appareilId) ? 'message:sent' : 'message:received',
    });
  }
  return plan;
}

/**
 * Émet le message chiffré, une fois par appareil cible.
 *
 * `body` est répété dans chaque payload : il est commun, mais le client
 * attend un message complet et non deux morceaux à recoller. Un corps pèse
 * quelques centaines d'octets pour du texte — le prix est sans rapport avec
 * la complexité qu'un assemblage en deux temps ajouterait des deux côtés.
 *
 * @returns {number} nombre d'émissions
 */
function emetEnveloppes(io, { payload, chiffre, plan }) {
  const body = {
    ct: chiffre.body.toString('base64'),
    nonce: chiffre.nonce.toString('base64'),
    senderAppareilId: chiffre.emetteurAppareilId ?? null,
  };
  const parAppareil = new Map(
    chiffre.enveloppes.map((e) => [Number(e.appareilId), e]),
  );

  let emis = 0;
  for (const cible of plan) {
    const env = parAppareil.get(cible.appareilId);
    if (!env) continue;
    io.to(cible.room).emit(cible.event, {
      ...payload,
      body,
      envelope: {
        appareilId: cible.appareilId,
        header: env.header,
        envType: env.envType,
        wrappedKey: env.wrappedKey ? env.wrappedKey.toString('base64') : null,
      },
    });
    emis += 1;
  }
  return emis;
}

module.exports = { chargeMesAppareils, planRoutage, emetEnveloppes };
