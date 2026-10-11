/**
 * Sémaphore à file d'attente COURTE, pour les encodages WebP animés (V1c).
 *
 * Un encodage animé coûte 3 à 6 s de CPU (jusqu'à ~15 s dans le pire cas, spike
 * T5.0, A16) : on n'en fait qu'UN à la fois par processus. Les autres demandes
 * attendent un moment, dans une file bornée ; passé le délai, ou si la file est
 * déjà pleine, elles sont refusées tout de suite par un `503 SERVICE_UNAVAILABLE`
 * retryable (le client réessaie, rien n'est marqué en échec définitif).
 *
 * Aucun état à reprendre au redémarrage de pm2 : une `Map` ou un compteur de
 * processus n'a de sens que le temps d'un encodage, et un redémarrage les remet
 * à zéro, ce qui est exactement ce qu'on veut (plus aucun encodage en cours).
 * La limite est PAR PROCESSUS : avec N instances pm2 en cluster, N encodages
 * peuvent tourner en même temps (voir DEPLOIEMENT.md).
 */

/** Refus de capacité : file pleine ou délai d'attente dépassé. */
class SlotOccupe extends Error {
  constructor(raison, retryAfterS) {
    super('Service temporairement indisponible');
    this.name = 'SlotOccupe';
    this.code = 'SERVICE_UNAVAILABLE';
    this.status = 503;
    this.raison = raison; // 'file_pleine' | 'delai' — pour les journaux, jamais pour le client
    this.retryAfterS = retryAfterS;
  }
}

/**
 * @param {object} [o]
 * @param {number} [o.max=1]          encodages simultanés
 * @param {number} [o.fileMax=3]      demandes en attente au plus
 * @param {number} [o.attenteMs=8000] délai d'attente maximal dans la file
 * @param {number} [o.retryAfterS=10] valeur suggérée au client
 */
function creerSemaphore({
  max = 1, fileMax = 3, attenteMs = 8000, retryAfterS = 10,
} = {}) {
  let actifs = 0;
  const file = []; // { donner, timer }

  const liberer = () => {
    const suivant = file.shift();
    if (suivant) {
      clearTimeout(suivant.timer);
      // Le créneau passe directement au suivant : `actifs` ne bouge pas.
      suivant.donner();
    } else {
      actifs -= 1;
    }
  };

  /** Rend `release()` (idempotent), ou lève `SlotOccupe`. */
  const acquerir = () => new Promise((resolve, reject) => {
    const remettre = () => {
      let rendu = false;
      return () => {
        if (rendu) return;
        rendu = true;
        liberer();
      };
    };
    if (actifs < max) {
      actifs += 1;
      resolve(remettre());
      return;
    }
    if (file.length >= fileMax) {
      reject(new SlotOccupe('file_pleine', retryAfterS));
      return;
    }
    const attente = { donner: null, timer: null };
    attente.donner = () => resolve(remettre());
    attente.timer = setTimeout(() => {
      const i = file.indexOf(attente);
      if (i >= 0) file.splice(i, 1);
      reject(new SlotOccupe('delai', retryAfterS));
    }, attenteMs);
    file.push(attente);
  });

  /** Exécute `fn` dans le créneau ; le créneau est rendu quoi qu'il arrive. */
  const executer = async (fn) => {
    const release = await acquerir();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return {
    acquerir,
    executer,
    stats: () => ({ actifs, enAttente: file.length, max, fileMax, attenteMs }),
  };
}

module.exports = { SlotOccupe, creerSemaphore };
