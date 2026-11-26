/**
 * Annuaire des clés publiques du chiffrement de bout en bout.
 *
 * Toutes les routes travaillent sur l'appareil de l'appelant, désigné par
 * `req.user.appareilId` — jamais par un identifiant que le corps de la
 * requête fournirait. Publier les clés d'un autre appareil n'aurait aucun
 * sens (on ne détient pas sa privée) et serait une substitution d'identité.
 */

const { fail } = require('../utils/apiError');
const { BundleInvalide } = require('../utils/e2eeBundle');
const {
  publieBundle,
  tourneSignedPreKey,
  regarnitOneTimePreKeys,
  etatDesCles,
  retireClesAppareils,
} = require('../services/e2eeKeyService');
const {
  serviceBundles,
  normaliseAppareilIds,
} = require('../services/e2eePrekeyStock');
const { appareilsDeConversation } = require('../utils/conversationDevices');
const { activerSiEligible } = require('../services/e2eeActivation');
const pool = require('../config/db');
const { attacheChiffre } = require('../utils/messageEnvelopes');

/**
 * Exige un `appareilId` sur le jeton.
 *
 * Les jetons émis avant la migration 026 n'en portent pas, et le garde
 * d'authentification les accepte toujours pour ne pas déconnecter tout le
 * monde d'un coup. Mais une identité de chiffrement s'ancre sur un appareil :
 * sans `appareilId`, il n'y a rien à quoi l'attacher. On refuse avec un code
 * nommé, que le client traduit par une reconnexion — plutôt que de poser les
 * clés sur une ligne arbitraire.
 */
function exigeAppareil(req, res) {
  const id = req.user && req.user.appareilId;
  if (id == null) {
    fail(res, 409, 'E2EE_APPAREIL_INCONNU',
      'Session trop ancienne pour le chiffrement : reconnectez-vous');
    return null;
  }
  return Number(id);
}

/** Traduit une erreur de validation en 400 nommé, le reste en 500. */
function repondErreur(res, erreur, contexte) {
  if (erreur instanceof BundleInvalide) {
    return fail(res, 400, erreur.code, erreur.message, { champ: erreur.champ });
  }
  console.error(`[E2EE keys] ${contexte}:`, erreur.message);
  return fail(res, 500, 'INTERNAL', 'Erreur interne');
}

/** POST /api/e2ee/keys — publie ou remplace le bundle de cet appareil. */
const postKeys = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  try {
    const r = await publieBundle(appareilId, req.user.alanyaID, req.body || {});
    res.json(r);
  } catch (e) {
    repondErreur(res, e, 'publication');
  }
};

/** POST /api/e2ee/keys/signed-prekey — tourne le signed prekey. */
const postSignedPreKey = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  try {
    const r = await tourneSignedPreKey(appareilId, req.body || {});
    if (!r.tourne) {
      // Ni une erreur ni un succès : le client avait déjà ce prekey en place.
      // 200 avec `tourne: false` le lui dit sans le faire réessayer.
      return res.json({ ...r, raison: 'DEJA_EN_PLACE' });
    }
    res.json(r);
  } catch (e) {
    repondErreur(res, e, 'rotation spk');
  }
};

/** POST /api/e2ee/keys/prekeys — regarnit le stock à usage unique. */
const postOneTimePreKeys = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  try {
    const r = await regarnitOneTimePreKeys(appareilId, req.body || {});
    res.json(r);
  } catch (e) {
    repondErreur(res, e, 'regarnissage');
  }
};

/**
 * GET /api/e2ee/keys/state — bundle publié ? combien de clés en stock ?
 *
 * Rend aussi `appareilId` : l'application ne le connaît pas autrement (il
 * n'est que dans le jeton), et c'est à lui qu'elle attache son coffre local.
 * Un coffre écrit pour un autre appareil — ligne révoquée puis recréée, autre
 * compte sur le même téléphone — doit être jeté, pas republié.
 */
const getKeysState = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  try {
    res.json({ appareilId, ...(await etatDesCles(appareilId)) });
  } catch (e) {
    repondErreur(res, e, 'état');
  }
};

/**
 * DELETE /api/e2ee/keys — retire l'identité de cet appareil.
 *
 * Appelé à la déconnexion, qui vide le coffre local : laisser le bundle
 * publié ferait chiffrer les correspondants pour une identité dont plus
 * personne ne détient la privée (docs/e2ee, chapitre 22). Pas de garde
 * d'interrupteur : retirer est toujours permis, même chiffrement fermé.
 */
const deleteKeys = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  const retires = await retireClesAppareils([appareilId]);
  res.json({ retire: retires > 0 });
};

/**
 * POST /api/e2ee/bundles — sert les bundles demandés, une clé à usage unique
 * réservée pour chacun.
 *
 * POST et non GET malgré la lecture : la requête consomme des clés à usage
 * unique, donc elle n'est ni rejouable sans effet ni cachable. Un GET que les
 * intermédiaires réessaient ou mettent en cache viderait des stocks sans que
 * personne l'ait demandé.
 */
const postBundles = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  let ids;
  try {
    ids = normaliseAppareilIds((req.body || {}).appareilIds);
  } catch (e) {
    return fail(res, 400, e.code || 'E2EE_APPAREILS_INVALIDE', e.message);
  }
  try {
    // L'appareil appelant ne se chiffre pas à lui-même : il détient déjà le
    // clair. L'écarter ici évite de lui consommer une clé pour rien, et de
    // laisser le client croire qu'il doit s'écrire.
    const demandes = ids.filter((id) => id !== appareilId);
    if (demandes.length === 0) {
      return res.json({ bundles: [], sansCles: [], refuses: [] });
    }
    res.json(await serviceBundles(req.user.alanyaID, demandes));
  } catch (e) {
    repondErreur(res, e, 'service des bundles');
  }
};

/**
 * GET /api/e2ee/devices?conversationID=… — pour qui chiffrer dans ce fil.
 *
 * GET et non POST : contrairement à `/bundles`, cet appel ne consomme rien.
 * Le client l'interroge à chaque ouverture de conversation et à chaque
 * changement de composition d'un groupe.
 */
const getConversationDevices = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;

  const conversationID = parseInt(req.query.conversationID, 10);
  if (!conversationID || conversationID < 1) {
    return fail(res, 400, 'VALIDATION_FAILED', 'conversationID requis');
  }

  try {
    const r = await appareilsDeConversation(
      conversationID, req.user.alanyaID, appareilId,
    );
    // Non participant et conversation inexistante rendent la même chose :
    // distinguer les deux dirait qui parle à qui.
    if (!r) {
      return fail(res, 404, 'NOT_A_MEMBER', 'Conversation introuvable ou non autorisée');
    }
    // C'est ici que la conversation passe en chiffré, quand elle le peut : le
    // moment où un appareil demande pour qui chiffrer est le seul où la
    // question se pose. `e2eeSince` nul : on écrit en clair, comme avant.
    const { e2eeSince } = await activerSiEligible(conversationID, {
      io: req.app.get('io'),
    });
    res.json({ ...r, e2eeSince });
  } catch (e) {
    repondErreur(res, e, 'appareils de conversation');
  }
};

/** Une page de rattrapage : assez pour une longue absence, borné quand même. */
const EN_ATTENTE_MAX = 100;

/**
 * GET /api/e2ee/en-attente?apres=<msgID> — les messages chiffrés dont
 * l'enveloppe de CET appareil n'est pas encore remise.
 *
 * C'est le filet de tout ce qui se perd en direct : un message chiffré émis
 * pendant que la socket était tombée, mais surtout une MODIFICATION ou un
 * RENVOI (`e2ee:resceller`) d'un message que l'appareil connaît déjà. La
 * synchronisation par curseur ne ramène que les messages plus récents que
 * le dernier connu ; un message modifié pendant une absence n'y repasse
 * jamais. Ici si : le rescellement a posé une enveloppe neuve, non remise.
 *
 * Servir n'est pas remettre : l'appareil acquitte par `e2ee:ack` une fois le
 * message rangé, comme pour l'historique.
 */
const getEnAttente = async (req, res) => {
  const appareilId = exigeAppareil(req, res);
  if (appareilId == null) return;
  const apres = Math.max(0, parseInt(req.query.apres, 10) || 0);
  try {
    const [lignes] = await pool.query(
      `SELECT m.*
         FROM message_envelope v
         JOIN message m ON m.msgID = v.msgID
         JOIN conv_participants p ON p.conversID = m.conversationID AND p.alanyaID = ?
        WHERE v.appareil_id = ? AND v.delivered_at IS NULL
          AND m.isDeleted = 0 AND m.enc_version = 1 AND m.msgID > ?
        ORDER BY m.msgID
        LIMIT ?`,
      [req.user.alanyaID, appareilId, apres, EN_ATTENTE_MAX + 1],
    );
    const hasMore = lignes.length > EN_ATTENTE_MAX;
    const page = hasMore ? lignes.slice(0, EN_ATTENTE_MAX) : lignes;
    await attacheChiffre(pool, page, appareilId);
    res.json({
      messages: page,
      hasMore,
      cursor: page.length > 0 ? Number(page[page.length - 1].msgID) : apres,
    });
  } catch (e) {
    repondErreur(res, e, 'enveloppes en attente');
  }
};

module.exports = {
  getEnAttente,
  deleteKeys,
  postKeys,
  postSignedPreKey,
  postOneTimePreKeys,
  getKeysState,
  postBundles,
  getConversationDevices,
};
