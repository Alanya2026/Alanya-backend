/**
 * Stockage du coffre-fort chez MEGA S4 (bucket `safebox`).
 *
 * Le serveur ne transporte aucun octet de fichier : il signe des adresses, le
 * téléphone envoie et télécharge directement chez MEGA. Le serveur ne parle à
 * MEGA que pour lister les blocs reçus et supprimer.
 *
 * Ce que S4 ne fait pas, vérifié le 14 et le 15/10/2026 : ni versions, ni
 * cycle de vie, ni CORS (501), et son envoi en morceaux abandonne parfois tout
 * après une coupure. D'où des blocs indépendants et un ménage fait par le
 * backend (`purge.js`).
 *
 * Réglages : MEGA_S4_ENDPOINT, MEGA_S4_BUCKET, MEGA_S4_KEY_ID, MEGA_S4_SECRET,
 * MEGA_S4_REGION (facultatif, par défaut le 2e mot du point d'accès).
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function configFrom(env = process.env) {
  const brut = (env.MEGA_S4_ENDPOINT || '').trim();
  const endpoint = brut && !/^https?:\/\//.test(brut) ? `https://${brut}` : brut.replace(/\/+$/, '');
  const bucket = (env.MEGA_S4_BUCKET || '').trim();
  const keyId = (env.MEGA_S4_KEY_ID || '').trim();
  const secret = (env.MEGA_S4_SECRET || '').trim();
  if (!endpoint || !bucket || !keyId || !secret) return null;
  let region = (env.MEGA_S4_REGION || '').trim();
  if (!region) {
    try { region = new URL(endpoint).hostname.split('.')[1] || 'us-east-1'; } catch { region = 'us-east-1'; }
  }
  return { endpoint, bucket, keyId, secret, region };
}

function storageConfigured(env = process.env) {
  return Boolean(configFrom(env));
}

/**
 * Un stockage sur un client S3 donné. Les tests passent un faux client ; le
 * serveur, celui de `defaultStorage()`.
 */
function createStorage({ client, bucket, sign = getSignedUrl }) {
  /** Adresse d'envoi d'un objet, à sa taille exacte : un corps plus gros est refusé (403). */
  function uploadUrl(key, size, ttlSeconds) {
    return sign(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: size }), {
      expiresIn: ttlSeconds,
      signableHeaders: new Set(['content-length']),
    });
  }

  function downloadUrl(key, ttlSeconds) {
    return sign(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds });
  }

  /** Objets sous un préfixe : `[{ key, size }]`. */
  async function list(prefix) {
    const out = [];
    let jeton;
    do {
      const rep = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: jeton,
      }));
      for (const o of rep.Contents || []) out.push({ key: o.Key, size: Number(o.Size) });
      jeton = rep.IsTruncated ? rep.NextContinuationToken : undefined;
    } while (jeton);
    return out;
  }

  /**
   * Supprime tout ce qui est sous un préfixe et renvoie le nombre d'objets
   * supprimés. Suppression groupée d'abord ; si S4 la refuse, un par un.
   * Lève si quelque chose reste : l'appelant réessaiera au prochain passage.
   */
  async function removePrefix(prefix) {
    const objets = await list(prefix);
    for (let i = 0; i < objets.length; i += 1000) {
      const lot = objets.slice(i, i + 1000);
      try {
        const rep = await client.send(new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: lot.map((o) => ({ Key: o.key })), Quiet: true },
        }));
        if ((rep.Errors || []).length) throw new Error(`${rep.Errors.length} échec(s)`);
      } catch {
        for (const o of lot) {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: o.key }));
        }
      }
    }
    const restants = await list(prefix);
    if (restants.length) throw new Error(`${restants.length} objet(s) encore présents sous ${prefix}`);
    return objets.length;
  }

  return { uploadUrl, downloadUrl, list, removePrefix };
}

let _defaut = null;

/** Le stockage du serveur, construit au premier appel. Null si MEGA S4 n'est pas configuré. */
function defaultStorage(env = process.env) {
  if (_defaut) return _defaut;
  const cfg = configFrom(env);
  if (!cfg) return null;
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
    forcePathStyle: true,
    // MEGA S4 ne connaît que Content-MD5 : pas de sommes CRC32 ajoutées d'office.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  _defaut = createStorage({ client, bucket: cfg.bucket });
  return _defaut;
}

module.exports = { configFrom, storageConfigured, createStorage, defaultStorage };
