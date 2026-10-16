/**
 * Notifications de l'abonnement : relance, échéance, purge, paiement.
 *
 * Le texte est composé ici, en français, comme pour les trajets : quand
 * l'application est tuée, personne côté client n'est là pour traduire. Aucune
 * ne passe outre « Ne pas déranger » — ce privilège reste aux alertes de
 * sûreté des trajets.
 */

const { sendToUser } = require('../notificationService');
const { buildBillingPayload } = require('../../notifications/notificationContract');
const { getBillingIo } = require('./subscriptions');
const { formatDisplay } = require('../../utils/alanyaPhone');
const { BILLING_MODEL } = require('../../constants/billing');
const { fmtDay } = require('./billingTexts');

const isTrial = (model) => Number(model) === BILLING_MODEL.TRIAL;

/**
 * @param {number} alanyaID
 * @param {{ type: string, title: string, body: string }} message
 * @param {{ skipIfDeviceOnline?: boolean }} [options]  vrai quand l'écran
 *   ouvert dit déjà la même chose (l'attente d'un paiement, par ex.)
 */
async function pushBilling(alanyaID, { type, title, body, deeplink }, { skipIfDeviceOnline = false } = {}) {
  try {
    await sendToUser(alanyaID, buildBillingPayload({ type, title, body, deeplink }), {
      io: getBillingIo(),
      skipIfDeviceOnline,
    });
  } catch (err) {
    console.error(`[billing] notification ${type} → ${alanyaID} :`, err.message);
  }
}

const FAILURE_TEXT = {
  INSUFFICIENT_FUNDS: 'Solde insuffisant : aucun abonnement n\'a été activé.',
  USER_DECLINED: 'Le paiement a été refusé sur le téléphone.',
  TIMEOUT: 'Aucune confirmation n\'est arrivée à temps.',
};

/** Même chose pour l'achat d'un numéro : ce qui n'a pas eu lieu, c'est le changement. */
const PHONE_FAILURE_TEXT = {
  INSUFFICIENT_FUNDS: 'Solde insuffisant : votre numéro Alanya n\'a pas changé.',
  USER_DECLINED: 'Le paiement a été refusé sur le téléphone. Votre numéro Alanya n\'a pas changé.',
  TIMEOUT: 'Aucune confirmation n\'est arrivée à temps. Votre numéro Alanya n\'a pas changé.',
};

const messages = {
  reminder: ({ daysLeft, autoRenew, model }) => (isTrial(model)
    ? {
      type: 'billing_reminder',
      title: daysLeft <= 1 ? 'Votre abonnement Alanya prend fin demain' : `Votre abonnement Alanya prend fin dans ${daysLeft} jours`,
      body: 'Prenez un nouveau code sur le site pour continuer à envoyer des messages et à appeler.',
    }
    : {
      type: 'billing_reminder',
      title: daysLeft <= 1 ? 'Alanya Plus prend fin demain' : `Alanya Plus prend fin dans ${daysLeft} jours`,
      body: autoRenew
        ? 'Le renouvellement automatique vous demandera de confirmer le paiement la veille.'
        : 'Renouvelez pour garder vos fonctionnalités et votre coche.',
    }),
  // Régime essai. Pas de type neuf : l'application ouvre déjà l'écran de
  // l'abonnement sur `billing_reminder` et `billing_expired`.
  trialEnding: ({ daysLeft, endsAt }) => ({
    type: 'billing_reminder',
    title: daysLeft <= 1 ? 'Votre essai gratuit se termine demain' : `Votre essai gratuit se termine dans ${daysLeft} jours`,
    body: `Après le ${fmtDay(endsAt)}, vous recevrez toujours vos messages et vos appels, mais il faudra un abonnement pour envoyer et appeler. Vous pouvez le prendre dès maintenant : il commencera à la fin de l'essai.`,
  }),
  trialEnded: () => ({
    type: 'billing_expired',
    title: 'Votre essai gratuit est terminé',
    body: 'Vous recevez toujours vos messages et vos appels. Pour envoyer des messages et appeler de nouveau, activez un abonnement.',
  }),
  renewalRequested: ({ brand, amount }) => ({
    type: 'billing_reminder',
    title: 'Renouvellement d\'Alanya Plus',
    body: `${brand} vous demande de confirmer ${amount} F avec votre code.`,
  }),
  expired: ({ purgeAfter, model }) => (isTrial(model)
    ? {
      type: 'billing_expired',
      title: 'Votre abonnement Alanya a pris fin',
      body: `Vous recevez toujours vos messages et vos appels, mais vous ne pouvez plus envoyer ni appeler. Entrez un nouveau code pour reprendre. Vos réglages et votre historique sont conservés jusqu'au ${fmtDay(purgeAfter)}.`,
    }
    : {
      type: 'billing_expired',
      title: 'Alanya Plus a pris fin',
      body: `Vos réglages et votre historique sont conservés jusqu'au ${fmtDay(purgeAfter)}. Réabonnez-vous pour tout retrouver.`,
    }),
  purgeWarning: ({ purgeAfter }) => ({
    type: 'billing_purge_warning',
    title: `Vos données Alanya Plus seront effacées le ${fmtDay(purgeAfter)}`,
    body: 'Historique des trajets, sonneries par liste, anciens médias gardés sur le serveur, '
      + 'et fichiers du coffre-fort au-delà de l\'espace gratuit (les plus récents d\'abord). '
      + 'Réabonnez-vous d\'ici là pour les garder.',
  }),
  paymentSucceeded: ({ until }) => ({
    type: 'payment_succeeded',
    title: 'Paiement confirmé',
    body: `Alanya Plus est actif jusqu'au ${fmtDay(until)}.`,
  }),
  paymentFailed: ({ failureCode, product = 'plus' }) => ({
    type: 'payment_failed',
    title: 'Paiement non abouti',
    body: product === 'phone'
      ? PHONE_FAILURE_TEXT[failureCode] || 'Le paiement n\'a pas pu aboutir. Votre numéro Alanya n\'a pas changé.'
      : FAILURE_TEXT[failureCode] || 'Le paiement n\'a pas pu aboutir. Vous pouvez réessayer.',
  }),
  phoneChanged: ({ phone }) => ({
    type: 'payment_succeeded',
    title: 'Nouveau numéro Alanya',
    body: `Votre numéro est maintenant le ${formatDisplay(phone)}. C'est lui qui sert à vous connecter.`,
  }),
  phoneCredit: () => ({
    type: 'payment_succeeded',
    title: 'Paiement confirmé',
    body: 'Le numéro choisi a été pris entre-temps. Choisissez-en un autre : rien ne vous sera redemandé.',
  }),

  // Vérification d'identité : un seul type, le texte dit la décision.
  verificationApproved: () => ({
    type: 'verification_update',
    deeplink: 'alanya://verification',
    title: 'Identité vérifiée',
    body: 'Votre coche s\'affiche désormais à côté de votre nom.',
  }),
  verificationRefused: ({ reason }) => ({
    type: 'verification_update',
    deeplink: 'alanya://verification',
    title: 'Vérification refusée',
    body: `Motif : ${reason}`,
  }),
  verificationDocumentRequested: ({ reason }) => ({
    type: 'verification_update',
    deeplink: 'alanya://verification',
    title: 'Une pièce manque à votre dossier',
    body: reason,
  }),
  verificationRevoked: ({ reason }) => ({
    type: 'verification_update',
    title: 'Votre coche a été retirée',
    body: `Motif : ${reason}`,
  }),
};

module.exports = { pushBilling, messages, fmtDay };
