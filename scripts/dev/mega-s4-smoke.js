/**
 * Essai de MEGA S4 pour un futur coffre-fort — `npm run smoke:mega-s4`.
 *
 * Indépendant du serveur : ne touche ni à la base, ni à `mediaStorage.js`.
 * Exerce, sur le vrai bucket, ce qu'un coffre-fort demanderait : dossiers
 * (préfixes), navigation, fichiers aux noms accentués, métadonnées, lecture
 * partielle, déplacement, renommage de dossier, suppression groupée, gros
 * fichier en plusieurs morceaux, liens signés d'envoi et de lecture, et
 * confidentialité (pas de lecture sans signature, lien expiré refusé).
 *
 * Deux sortes de lignes :
 *   ✓ / ✗  une ÉTAPE : ce qu'il faut pour un coffre-fort ; un ✗ est bloquant.
 *   ·      une SONDE : ce que MEGA accepte ou non, pour savoir comment coder.
 *
 * Tout est déposé sous `essai-coffre-<horodatage>/` et supprimé à la fin,
 * même si une étape échoue. Un bucket `alanya-essai-<horodatage>` est créé
 * puis supprimé pour la sonde « créer un bucket ».
 *
 * Réglages lus dans `.env` :
 *   MEGA_S4_ENDPOINT  ex. s3.eu-luxembourg-1.megas4.com (https:// facultatif)
 *   MEGA_S4_KEY_ID    clé d'accès
 *   MEGA_S4_SECRET    clé secrète
 *   MEGA_S4_BUCKET    nom du bucket ; absent : la liste des buckets est affichée
 *   MEGA_S4_REGION    facultatif ; par défaut, tirée du point d'accès
 */

require('dotenv').config();

const crypto = require('crypto');
const {
  S3Client,
  ListBucketsCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  ListPartsCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  GetBucketVersioningCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketCorsCommand,
  GetBucketPolicyCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const OK = '✓';
const KO = '✗';
const INFO = '·';
const LARGEUR = 34;

const brut = (process.env.MEGA_S4_ENDPOINT || '').trim();
const ENDPOINT = brut && !/^https?:\/\//.test(brut) ? `https://${brut}` : brut.replace(/\/+$/, '');
const KEY_ID = (process.env.MEGA_S4_KEY_ID || '').trim();
const SECRET = (process.env.MEGA_S4_SECRET || '').trim();
const BUCKET = (process.env.MEGA_S4_BUCKET || '').trim();
const REGION = (process.env.MEGA_S4_REGION || '').trim()
  || (ENDPOINT ? new URL(ENDPOINT).hostname.split('.')[1] : '')
  || 'us-east-1';

const s3 = new S3Client({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET },
  forcePathStyle: true,
  // MEGA S4 ne connaît que Content-MD5 : pas de sommes CRC32 ajoutées d'office.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

const etapes = [];
const sondes = [];

function messageDe(e) {
  const statut = e.$metadata?.httpStatusCode;
  let m = `${e.Code || e.name}${statut ? ` (${statut})` : ''} : ${e.message}`;
  if (e.Region) m += ` — région attendue par le serveur : « ${e.Region} »`;
  return m;
}

async function etape(nom, fn) {
  try {
    const detail = await fn();
    etapes.push({ nom, ok: true });
    console.log(`${OK} ${nom.padEnd(LARGEUR)} ${detail || ''}`);
    return true;
  } catch (e) {
    etapes.push({ nom, ok: false, erreur: messageDe(e) });
    console.log(`${KO} ${nom.padEnd(LARGEUR)} ${messageDe(e)}`);
    return false;
  }
}

// Une sonde renvoie son verdict en texte ; une exception devient « non ».
async function sonde(nom, fn) {
  let verdict;
  try {
    verdict = await fn();
  } catch (e) {
    verdict = `non — ${messageDe(e)}`;
  }
  sondes.push({ nom, verdict });
  console.log(`${INFO} ${nom.padEnd(LARGEUR)} ${verdict}`);
}

const corps = async (rep) => Buffer.from(await rep.Body.transformToByteArray());
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const mbits = (octets, ms) => ((octets * 8) / (ms / 1000) / 1e6).toFixed(1);

function absent(e) {
  return e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey';
}

async function existe(cle) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: cle }));
    return true;
  } catch (e) {
    if (absent(e)) return false;
    throw e;
  }
}

async function lister(prefixe, delimiteur) {
  const cles = [];
  const dossiers = [];
  let jeton;
  do {
    const rep = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefixe, Delimiter: delimiteur, ContinuationToken: jeton,
    }));
    for (const o of rep.Contents || []) cles.push(o.Key);
    for (const p of rep.CommonPrefixes || []) dossiers.push(p.Prefix);
    jeton = rep.IsTruncated ? rep.NextContinuationToken : undefined;
  } while (jeton);
  return { cles, dossiers };
}

async function deposer(cle, texte, nomOriginal) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: cle,
    Body: texte,
    ContentType: 'text/plain; charset=utf-8',
    // Les en-têtes HTTP sont en ASCII : le nom d'origine voyage encodé.
    Metadata: nomOriginal ? { 'nom-original': encodeURIComponent(nomOriginal) } : undefined,
  }));
}

// Déplacer = copier puis supprimer : S3 n'a pas de « renommer ».
async function deplacer(source, destination) {
  await s3.send(new CopyObjectCommand({
    Bucket: BUCKET,
    Key: destination,
    CopySource: `${BUCKET}/${source.split('/').map(encodeURIComponent).join('/')}`,
  }));
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: source }));
}

// Remplace les sommes CRC32 du SDK par un Content-MD5, seule somme que MEGA
// S4 documente — utile si DeleteObjects est refusé tel quel.
function avecContentMd5(commande) {
  commande.middlewareStack.addRelativeTo((next) => async (args) => {
    const { headers, body } = args.request;
    for (const h of Object.keys(headers)) {
      const b = h.toLowerCase();
      if (b.startsWith('x-amz-checksum-') || b === 'x-amz-sdk-checksum-algorithm') delete headers[h];
    }
    headers['content-md5'] = crypto.createHash('md5').update(body).digest('base64');
    return next(args);
  }, { relation: 'before', toMiddleware: 'httpSigningMiddleware', name: 'contentMd5MegaS4' });
  return commande;
}

function urlNonSignee(cle) {
  return `${ENDPOINT}/${BUCKET}/${cle.split('/').map(encodeURIComponent).join('/')}`;
}

async function capacite(nom, commande, codesVides) {
  await sonde(nom, async () => {
    try {
      await s3.send(commande);
      return 'oui';
    } catch (e) {
      if (codesVides.includes(e.name) || codesVides.includes(e.Code)) return 'oui (rien de réglé)';
      throw e;
    }
  });
}

async function main() {
  if (!ENDPOINT || !KEY_ID || !SECRET) {
    console.error(`${KO} Réglages manquants dans .env : MEGA_S4_ENDPOINT, MEGA_S4_KEY_ID, MEGA_S4_SECRET`);
    console.error('  (et MEGA_S4_BUCKET). Voir .env.example, section « MEGA S4 ».');
    process.exit(1);
  }

  console.log(`Point d'accès : ${ENDPOINT}`);
  console.log(`Région        : ${REGION}${process.env.MEGA_S4_REGION ? '' : ' (tirée du point d\'accès)'}`);
  console.log(`Bucket        : ${BUCKET || '(non précisé)'}`);
  console.log('');

  // ── Accès ──
  let buckets = null;
  await sonde('lister les buckets du compte', async () => {
    const rep = await s3.send(new ListBucketsCommand({}));
    buckets = (rep.Buckets || []).map((b) => b.Name);
    return `oui — ${buckets.length} : ${buckets.join(', ') || '(aucun)'}`;
  });

  if (!BUCKET) {
    console.log('\nAjoute MEGA_S4_BUCKET=<nom> dans .env (voir la liste ci-dessus) et relance.');
    process.exit(buckets ? 0 : 1);
  }

  const accessible = await etape('accès au bucket (HEAD)', async () => {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return 'clé et bucket reconnus';
  });
  if (!accessible) {
    console.error('\nArrêt : sans accès au bucket, rien d\'autre ne peut marcher. Pistes : nom du');
    console.error('bucket, clé d\'un autre compte ou sans droit, région de signature (MEGA_S4_REGION).');
    process.exit(1);
  }

  const instant = Date.now();
  const R = `essai-coffre-${instant}/`;
  const ACCENTUE = `${R}Photos/été 2026/reçu n°1 – essai.txt`;
  const textes = {
    [`${R}racine.txt`]: 'fichier à la racine du coffre\n',
    [`${R}Documents/note.txt`]: 'une note\n',
    [`${R}Documents/Factures/facture-2026-10.txt`]: 'facture d\'octobre\n',
    [`${R}Documents/Factures/facture-2026-09.txt`]: 'facture de septembre\n',
    [ACCENTUE]: 'nom accentué, espaces et tiret long\n',
  };
  let bucketEssai = null;
  let envoiEnCours = null;

  try {
    // ── Dossiers ──
    console.log('\nDossiers et fichiers');
    await sonde('dossier vide (objet « x/ »)', async () => {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${R}Vide/`, Body: '', ContentLength: 0 }));
      return 'oui — un dossier peut exister sans fichier';
    });

    await etape('dépôt de fichiers imbriqués', async () => {
      for (const [cle, texte] of Object.entries(textes)) {
        await deposer(cle, texte, cle.slice(cle.lastIndexOf('/') + 1));
      }
      return `${Object.keys(textes).length} fichiers sur 3 niveaux`;
    });

    await etape('contenu de la racine', async () => {
      const { cles, dossiers } = await lister(R, '/');
      const noms = dossiers.map((d) => d.slice(R.length));
      for (const attendu of ['Documents/', 'Photos/']) {
        if (!noms.includes(attendu)) throw new Error(`dossier ${attendu} absent : ${noms.join(', ')}`);
      }
      if (!cles.includes(`${R}racine.txt`)) throw new Error('racine.txt absent de la liste');
      return `dossiers : ${noms.join(', ')} — fichiers : ${cles.map((c) => c.slice(R.length)).join(', ')}`;
    });

    await etape('contenu d\'un sous-dossier', async () => {
      const { cles, dossiers } = await lister(`${R}Documents/`, '/');
      if (dossiers.length !== 1 || cles.length !== 1) {
        throw new Error(`attendu 1 dossier et 1 fichier, reçu ${dossiers.length} et ${cles.length}`);
      }
      return `Documents/ → ${dossiers[0].slice(R.length)} + ${cles[0].slice(R.length)}`;
    });

    await etape('relecture d\'un nom accentué', async () => {
      const lu = await corps(await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: ACCENTUE })));
      if (lu.toString() !== textes[ACCENTUE]) throw new Error('contenu différent');
      return ACCENTUE.slice(R.length);
    });

    await etape('métadonnées (type, nom d\'origine)', async () => {
      const rep = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: ACCENTUE }));
      const nom = decodeURIComponent(rep.Metadata?.['nom-original'] || '');
      if (!nom.startsWith('reçu')) throw new Error(`nom d'origine perdu : « ${nom} »`);
      return `${rep.ContentType} — « ${nom} »`;
    });

    await etape('lecture partielle (Range)', async () => {
      const rep = await s3.send(new GetObjectCommand({
        Bucket: BUCKET, Key: `${R}racine.txt`, Range: 'bytes=0-6',
      }));
      const lu = await corps(rep);
      if (lu.toString() !== 'fichier') throw new Error(`reçu « ${lu} »`);
      return `${rep.$metadata.httpStatusCode}, ${rep.ContentRange}`;
    });

    await etape('déplacer un fichier', async () => {
      await deplacer(`${R}racine.txt`, `${R}Documents/racine.txt`);
      if (await existe(`${R}racine.txt`)) throw new Error('l\'original est toujours là');
      if (!(await existe(`${R}Documents/racine.txt`))) throw new Error('la copie est absente');
      return 'racine.txt → Documents/racine.txt';
    });

    await etape('renommer un dossier', async () => {
      const { cles } = await lister(`${R}Photos/`);
      for (const cle of cles) await deplacer(cle, `${R}Images/${cle.slice(`${R}Photos/`.length)}`);
      const restants = (await lister(`${R}Photos/`)).cles.length;
      const arrives = (await lister(`${R}Images/`)).cles.length;
      if (restants !== 0 || arrives !== cles.length) {
        throw new Error(`${restants} restant(s) sous Photos/, ${arrives}/${cles.length} sous Images/`);
      }
      return `Photos/ → Images/ (${cles.length} objet(s) copiés puis supprimés)`;
    });

    const factures = (await lister(`${R}Documents/Factures/`)).cles;
    const groupe = { Bucket: BUCKET, Delete: { Objects: factures.map((Key) => ({ Key })), Quiet: true } };
    await sonde('suppression groupée (DeleteObjects)', async () => {
      try {
        const rep = await s3.send(new DeleteObjectsCommand(groupe));
        if (rep.Errors?.length) throw new Error(rep.Errors.map((x) => `${x.Key} : ${x.Code}`).join(' ; '));
        return `oui — ${factures.length} fichiers en un appel`;
      } catch (e) {
        const rep = await s3.send(avecContentMd5(new DeleteObjectsCommand(groupe)));
        if (rep.Errors?.length) throw new Error(rep.Errors.map((x) => `${x.Key} : ${x.Code}`).join(' ; '));
        return `oui, mais avec Content-MD5 seulement (sans : ${messageDe(e)})`;
      }
    });

    // ── Gros fichier ──
    console.log('\nGros fichier (envoi en plusieurs morceaux)');
    const gros = `${R}Videos/gros-fichier.bin`;
    const morceaux = [crypto.randomBytes(5 * 1024 * 1024), crypto.randomBytes(512 * 1024)];
    const entier = Buffer.concat(morceaux);
    await etape('envoi en 2 morceaux (multipart)', async () => {
      const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
        Bucket: BUCKET, Key: gros, ContentType: 'application/octet-stream',
      }));
      envoiEnCours = { Key: gros, UploadId };
      const t0 = Date.now();
      const parts = [];
      for (const [i, Body] of morceaux.entries()) {
        const { ETag } = await s3.send(new UploadPartCommand({
          Bucket: BUCKET, Key: gros, UploadId, PartNumber: i + 1, Body,
        }));
        parts.push({ ETag, PartNumber: i + 1 });
      }
      const duree = Date.now() - t0;
      const listes = await s3.send(new ListPartsCommand({ Bucket: BUCKET, Key: gros, UploadId }));
      if ((listes.Parts || []).length !== 2) throw new Error(`ListParts : ${(listes.Parts || []).length} morceau(x)`);
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: BUCKET, Key: gros, UploadId, MultipartUpload: { Parts: parts },
      }));
      envoiEnCours = null;
      return `${(entier.length / 1048576).toFixed(1)} Mo en ${(duree / 1000).toFixed(1)} s ≈ ${mbits(entier.length, duree)} Mbit/s`;
    });

    await etape('relecture intégrale du gros fichier', async () => {
      const t0 = Date.now();
      const lu = await corps(await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: gros })));
      const duree = Date.now() - t0;
      if (sha(lu) !== sha(entier)) throw new Error(`contenu différent (${lu.length} octets lus)`);
      return `identique, ${(duree / 1000).toFixed(1)} s ≈ ${mbits(lu.length, duree)} Mbit/s`;
    });

    await etape('abandon d\'un envoi (Abort)', async () => {
      const cle = `${R}Videos/abandonne.bin`;
      const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: cle }));
      await s3.send(new UploadPartCommand({
        Bucket: BUCKET, Key: cle, UploadId, PartNumber: 1, Body: crypto.randomBytes(1024),
      }));
      await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, Key: cle, UploadId }));
      const rep = await s3.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: R }));
      const restants = (rep.Uploads || []).filter((u) => u.UploadId === UploadId);
      if (restants.length) throw new Error('l\'envoi abandonné est encore listé');
      if (await existe(cle)) throw new Error('un objet a été créé malgré l\'abandon');
      return 'rien ne reste';
    });

    // ── Liens signés : l'app envoie et lit directement, sans passer par le serveur ──
    console.log('\nLiens signés et confidentialité');
    const viaLien = `${R}Documents/envoye-par-lien.txt`;
    const contenuLien = Buffer.from('envoyé directement par l\'application\n');
    const lienEnvoi = (taille) => getSignedUrl(s3, new PutObjectCommand({
      Bucket: BUCKET, Key: viaLien, ContentType: 'text/plain', ContentLength: taille,
    }), { expiresIn: 600, signableHeaders: new Set(['content-type', 'content-length']) });

    await etape('envoi par lien signé (PUT)', async () => {
      const rep = await fetch(await lienEnvoi(contenuLien.length), {
        method: 'PUT', body: contenuLien, headers: { 'content-type': 'text/plain' },
      });
      if (rep.status !== 200) throw new Error(`statut ${rep.status} : ${(await rep.text()).slice(0, 300)}`);
      return `${rep.status}, ${contenuLien.length} octets`;
    });

    await sonde('taille signée imposée', async () => {
      const rep = await fetch(await lienEnvoi(contenuLien.length), {
        method: 'PUT', body: Buffer.concat([contenuLien, contenuLien]), headers: { 'content-type': 'text/plain' },
      });
      return rep.status === 403
        ? 'oui — un envoi plus gros que déclaré est refusé (403)'
        : `NON — statut ${rep.status} : le quota du coffre devra être vérifié après coup`;
    });

    await etape('lecture par lien signé (GET)', async () => {
      const lien = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: viaLien }), { expiresIn: 600 });
      const rep = await fetch(lien);
      const lu = Buffer.from(await rep.arrayBuffer());
      if (rep.status !== 200 || !lu.equals(contenuLien)) throw new Error(`statut ${rep.status}, ${lu.length} octets`);
      return `${rep.status}, type ${rep.headers.get('content-type')}`;
    });

    await etape('lecture sans signature refusée', async () => {
      const rep = await fetch(urlNonSignee(viaLien));
      if (rep.status === 200) throw new Error('FICHIER LISIBLE PAR TOUT LE MONDE — bucket public ?');
      return `${rep.status} — le bucket est bien privé`;
    });

    await sonde('lien expiré refusé', async () => {
      const lien = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: viaLien }), { expiresIn: 1 });
      await new Promise((r) => { setTimeout(r, 2500); });
      const rep = await fetch(lien);
      return rep.status === 403 ? 'oui (403)' : `NON — statut ${rep.status}`;
    });

    // ── Ce que le bucket sait faire (lecture seule : rien n'est modifié) ──
    console.log('\nRéglages du bucket (lecture seule)');
    await sonde('versions (Versioning)', async () => {
      const rep = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
      return `réponse : ${rep.Status || 'jamais activé'}`;
    });
    await capacite('cycle de vie (Lifecycle)', new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }),
      ['NoSuchLifecycleConfiguration']);
    await capacite('CORS', new GetBucketCorsCommand({ Bucket: BUCKET }), ['NoSuchCORSConfiguration']);
    await capacite('règles d\'accès (Policy)', new GetBucketPolicyCommand({ Bucket: BUCKET }), ['NoSuchBucketPolicy']);

    // ── Buckets ──
    console.log('\nBuckets');
    await sonde('créer puis supprimer un bucket', async () => {
      const nom = `alanya-essai-${instant}`;
      await s3.send(new CreateBucketCommand({ Bucket: nom }));
      bucketEssai = nom;
      await s3.send(new HeadBucketCommand({ Bucket: nom }));
      await s3.send(new DeleteBucketCommand({ Bucket: nom }));
      bucketEssai = null;
      return `oui (${nom})`;
    });
  } finally {
    // ── Ménage ──
    console.log('\nMénage');
    if (envoiEnCours) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: BUCKET, ...envoiEnCours })).catch(() => {});
    }
    let restants = [];
    try {
      const { cles } = await lister(R);
      for (const cle of cles) {
        try {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: cle }));
        } catch (e) {
          restants.push(cle);
        }
      }
      restants = restants.concat((await lister(R)).cles.filter((c) => !restants.includes(c)));
    } catch (e) {
      console.log(`${KO} liste impossible pour le ménage : ${messageDe(e)}`);
      restants = [R];
    }
    if (bucketEssai) {
      await s3.send(new DeleteBucketCommand({ Bucket: bucketEssai })).catch((e) => {
        console.log(`${KO} bucket ${bucketEssai} à supprimer à la main : ${messageDe(e)}`);
      });
    }
    console.log(restants.length
      ? `${KO} reste(nt) à supprimer à la main : ${restants.join(', ')}`
      : `${OK} ${R} vidé`);
  }

  const echecs = etapes.filter((x) => !x.ok);
  console.log(`\n${etapes.length - echecs.length}/${etapes.length} étapes réussies.`);
  if (echecs.length) {
    for (const x of echecs) console.log(`  ${KO} ${x.nom} — ${x.erreur}`);
    process.exit(1);
  }
  console.log('Tout ce qu\'un coffre-fort demande fonctionne sur ce bucket.');
}

main().catch((e) => {
  console.error(`${KO} ${messageDe(e)}`);
  process.exit(1);
});
