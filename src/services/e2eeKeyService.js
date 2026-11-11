/**
 * Écriture et lecture de l'annuaire des clés publiques E2EE (migration 091).
 *
 * Le serveur n'est ici qu'un annuaire. Il ne chiffre rien, ne déchiffre rien,
 * et ne détient aucune clé privée. Tout ce qu'il peut faire de mal, c'est
 * servir la mauvaise clé publique — d'où l'empreinte que les correspondants
 * comparent entre eux dans l'écran de vérification, qui rend cette
 * substitution visible.
 */

const pool = require('../config/db');
const { normaliseBundle, normaliseSignedPreKey, normaliseOneTimePreKeys } =
  require('../utils/e2eeBundle');

/**
 * Sous ce stock de clés à usage unique, le serveur réclame un regarnissage.
 *
 * C'est le SERVEUR qui réclame, et le client qui obéit (docs/e2ee, chapitres
 * 5 et 10) : un stock vide ne gêne pas son propriétaire, ce sont les autres
 * qui n'arrivent plus à amorcer une session — panne muette s'il en est.
 */
const SEUIL_REGARNISSAGE = 20;

/**
 * Insère un lot de clés à usage unique.
 *
 * `ON DUPLICATE KEY UPDATE` sur `public_key` plutôt qu'`IGNORE` : un client
 * qui rejoue son envoi (accusé perdu, reconnexion) doit retrouver son stock
 * intact, et `IGNORE` masquerait aussi les vraies erreurs. Mais `claimed_at`
 * n'est JAMAIS remis à NULL ici : republier un `keyId` déjà servi ne doit pas
 * le rendre servable une seconde fois, sinon la propriété « à usage unique »
 * tombe — et avec elle la protection du premier message.
 */
async function insereOneTimePreKeys(conn, appareilId, cles) {
  if (cles.length === 0) return 0;
  const valeurs = [];
  const params = [];
  for (const c of cles) {
    valeurs.push('(?, ?, ?)');
    params.push(appareilId, c.keyId, c.publicKey);
  }
  const [r] = await conn.query(
    `INSERT INTO e2ee_one_time_prekeys (appareil_id, key_id, public_key)
     VALUES ${valeurs.join(', ')}
     ON DUPLICATE KEY UPDATE public_key = VALUES(public_key)`,
    params,
  );
  return r.affectedRows;
}

/**
 * Publie (ou remplace) le bundle de cet appareil et dépose ses clés à usage
 * unique, en une transaction.
 *
 * ── Pourquoi un REPLACE et pas un refus si le bundle existe ──
 *
 * Une réinstallation sur le même appareil physique réutilise la même ligne de
 * `appareils` (contrainte UNIQUE alanyaID+device_id). Refuser la publication
 * laisserait l'appareil avec une identité qu'il ne détient plus : ses
 * correspondants chiffreraient pour une clé dont il a perdu la privée, et
 * chaque message serait illisible sans que rien ne l'explique.
 *
 * Le `registrationId`, tiré au hasard à chaque installation, est ce qui
 * permet au correspondant de constater le changement et de jeter sa session.
 *
 * ── Pourquoi l'ancien stock est effacé ──
 *
 * Les clés à usage unique de l'installation précédente n'ont plus de privée
 * correspondante. Les laisser en place, c'est garantir que le prochain
 * correspondant en consomme une et produise un amorçage indéchiffrable.
 */
async function publieBundle(appareilId, alanyaID, corps) {
  const b = normaliseBundle(corps);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existant] = await conn.execute(
      `SELECT registration_id, identity_key FROM e2ee_device_keys
        WHERE appareil_id = ? FOR UPDATE`,
      [appareilId],
    );
    // L'un OU l'autre suffit à conclure. Le `registrationId` est tiré au
    // hasard et pourrait, très rarement, retomber sur la même valeur ; la clé
    // d'identité, elle, ne se répète jamais. Les comparer tous les deux évite
    // de laisser passer la réinstallation qui aurait eu cette malchance.
    const nouvelleInstallation = existant.length > 0 && (
      Number(existant[0].registration_id) !== b.registrationId
      || !existant[0].identity_key.equals(b.identityKey)
    );

    await conn.execute(
      `INSERT INTO e2ee_device_keys
         (appareil_id, alanyaID, registration_id,
          identity_key, capacite,
          signed_prekey_id, signed_prekey, signed_prekey_sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         registration_id        = VALUES(registration_id),
         identity_key           = VALUES(identity_key),
         capacite               = VALUES(capacite),
         signed_prekey_id       = VALUES(signed_prekey_id),
         signed_prekey          = VALUES(signed_prekey),
         signed_prekey_sig      = VALUES(signed_prekey_sig),
         prev_signed_prekey_id  = NULL,
         prev_signed_prekey     = NULL,
         prev_signed_prekey_sig = NULL,
         prev_retired_at        = NULL`,
      [
        appareilId, alanyaID, b.registrationId,
        b.identityKey, b.capacite,
        b.signedPreKey.keyId, b.signedPreKey.publicKey, b.signedPreKey.signature,
      ],
    );

    if (nouvelleInstallation) {
      await conn.execute(
        'DELETE FROM e2ee_one_time_prekeys WHERE appareil_id = ?',
        [appareilId],
      );
    }

    await insereOneTimePreKeys(conn, appareilId, b.oneTimePreKeys);

    const [[stock]] = await conn.execute(
      `SELECT COUNT(*) AS libres FROM e2ee_one_time_prekeys
        WHERE appareil_id = ? AND claimed_at IS NULL`,
      [appareilId],
    );

    await conn.commit();
    return {
      appareilId,
      registrationId: b.registrationId,
      nouvelleInstallation,
      ...etatDuStock(Number(stock.libres)),
    };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Tourne le signed prekey : l'actuel passe en `prev_*`, le nouveau prend sa
 * place.
 *
 * Décaler au lieu d'écraser est ce qui sauve les amorçages en vol : un
 * correspondant qui a lu le bundle avant la rotation calcule son X3DH sur
 * l'ancien prekey, et le destinataire doit encore en détenir la privée pour
 * le déchiffrer. Le client garde l'ancienne privée 60 jours de son côté.
 *
 * Rotation vers un `keyId` déjà en place : sans effet (on ne décale pas un
 * prekey sur lui-même, ce qui ferait perdre le vrai précédent).
 */
async function tourneSignedPreKey(appareilId, corps) {
  const spk = normaliseSignedPreKey(corps && corps.signedPreKey);
  const [r] = await pool.execute(
    `UPDATE e2ee_device_keys
        SET prev_signed_prekey_id  = signed_prekey_id,
            prev_signed_prekey     = signed_prekey,
            prev_signed_prekey_sig = signed_prekey_sig,
            prev_retired_at        = NOW(),
            signed_prekey_id       = ?,
            signed_prekey          = ?,
            signed_prekey_sig      = ?
      WHERE appareil_id = ? AND signed_prekey_id <> ?`,
    [spk.keyId, spk.publicKey, spk.signature, appareilId, spk.keyId],
  );
  return { tourne: r.affectedRows > 0, keyId: spk.keyId };
}

/** Regarnit le stock de clés à usage unique de cet appareil. */
async function regarnitOneTimePreKeys(appareilId, corps) {
  const cles = normaliseOneTimePreKeys(corps && corps.oneTimePreKeys);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await insereOneTimePreKeys(conn, appareilId, cles);
    const [[stock]] = await conn.execute(
      `SELECT COUNT(*) AS libres FROM e2ee_one_time_prekeys
        WHERE appareil_id = ? AND claimed_at IS NULL`,
      [appareilId],
    );
    await conn.commit();
    return { deposees: cles.length, ...etatDuStock(Number(stock.libres)) };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/** Le stock, et ce que le client doit en faire. */
function etatDuStock(libres) {
  return {
    otpkLibres: libres,
    seuil: SEUIL_REGARNISSAGE,
    regarnissageNecessaire: libres < SEUIL_REGARNISSAGE,
  };
}

/**
 * État du stock de cet appareil.
 *
 * `publie` dit si un bundle existe : c'est ce qui permet au client de savoir
 * qu'il doit publier (première ouverture après mise à jour, ou appareil que le
 * serveur a oublié — docs/e2ee, chapitre 22) sans tenter une publication à
 * chaque démarrage. `identityKey` lui permet de vérifier que le bundle publié
 * est bien le SIEN : après une réinstallation qui aurait gardé la même ligne
 * d'appareil, le serveur détiendrait encore l'identité précédente.
 */
async function etatDesCles(appareilId) {
  const [[ligne]] = await pool.execute(
    `SELECT k.registration_id, k.identity_key, k.capacite, k.signed_prekey_id,
            k.updated_at,
            (SELECT COUNT(*) FROM e2ee_one_time_prekeys o
              WHERE o.appareil_id = k.appareil_id AND o.claimed_at IS NULL) AS libres
       FROM e2ee_device_keys k
      WHERE k.appareil_id = ?`,
    [appareilId],
  );
  if (!ligne) return { publie: false, ...etatDuStock(0) };
  return {
    publie: true,
    registrationId: Number(ligne.registration_id),
    identityKey: ligne.identity_key.toString('base64'),
    capacite: Number(ligne.capacite),
    signedPreKeyId: Number(ligne.signed_prekey_id),
    publieLe: ligne.updated_at,
    ...etatDuStock(Number(ligne.libres)),
  };
}

/**
 * Retire l'identité de chiffrement d'appareils révoqués.
 *
 * Appelé par les trois chemins qui révoquent (« Appareils connectés », la
 * réinitialisation du mot de passe, la suppression programmée du compte). Les
 * lectures écartent déjà les appareils révoqués ; retirer leurs clés ferme la
 * porte pour de bon et libère le stock (docs/e2ee, chapitres 1 et 22).
 *
 * Ne lève JAMAIS : une révocation est un geste de sécurité — le téléphone
 * volé — et elle ne doit pas échouer parce que les tables du chiffrement
 * n'existent pas encore (migration 091 non jouée) ou qu'une suppression a
 * buté. L'échec est journalisé ; l'appareil reste révoqué, donc ignoré.
 */
async function retireClesAppareils(appareilIds) {
  const ids = [...new Set((appareilIds || []).map(Number))]
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return 0;
  const marques = ids.map(() => '?').join(',');
  try {
    await pool.execute(`DELETE FROM e2ee_one_time_prekeys WHERE appareil_id IN (${marques})`, ids);
    const [r] = await pool.execute(`DELETE FROM e2ee_device_keys WHERE appareil_id IN (${marques})`, ids);
    return (r && r.affectedRows) || 0;
  } catch (e) {
    if (e.code !== 'ER_NO_SUCH_TABLE') {
      console.warn('[E2EE] retrait des clés impossible :', e.message);
    }
    return 0;
  }
}

/**
 * Cet appareil a-t-il un bundle publié ? Ne lève jamais : table absente ou
 * base indisponible valent « non ».
 */
async function appareilPublie(appareilId) {
  if (appareilId == null) return false;
  try {
    const [rows] = await pool.execute(
      'SELECT 1 FROM e2ee_device_keys WHERE appareil_id = ? LIMIT 1',
      [appareilId],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

module.exports = {
  SEUIL_REGARNISSAGE,
  appareilPublie,
  etatDuStock,
  retireClesAppareils,
  insereOneTimePreKeys,
  publieBundle,
  tourneSignedPreKey,
  regarnitOneTimePreKeys,
  etatDesCles,
};
