/**
 * Lot 0 du coffre-fort — `npm run smoke:mega-s4:lot0`.
 *
 * Vérifie sur le vrai bucket la méthode d'envoi retenue pour le coffre
 * (docs/conception/coffre-fort.html, section 03) : un fichier est découpé en
 * BLOCS INDÉPENDANTS, un objet S4 par bloc, chacun envoyé par un PUT signé à sa
 * taille exacte. Une coupure ne fait perdre que le bloc en cours.
 *
 * Pourquoi pas l'envoi en morceaux (multipart) de S3 : le 15/10/2026, deux
 * coupures sur cinq ont fait abandonner par S4 l'envoi entier (NoSuchUpload),
 * morceaux déjà reçus compris. Sur un réseau mobile, 1 Go repartirait de zéro.
 *
 *   A. Envoi de 4 blocs par liens signés, le 2e coupé au milieu puis renvoyé.
 *   B. Fin d'envoi vérifiée par la liste des blocs (ListObjectsV2).
 *   C. Lecture bloc par bloc, le 3e coupé au milieu puis repris par Range.
 *
 * Les blocs font LOT0_BLOC_KIO Kio (512 par défaut, pour ménager la ligne ;
 * 8192 dans le coffre). Trafic de ce poste : environ 4 fois la taille d'un bloc
 * dans chaque sens.
 *
 * Deux sortes de lignes, comme `smoke:mega-s4` :
 *   ✓ / ✗  une ÉTAPE : ce que le coffre suppose ; un ✗ oblige à revoir la conception.
 *   ·      une SONDE : ce que MEGA fait, pour savoir comment coder.
 *
 * Tout est déposé sous `essai-lot0-<horodatage>/` et supprimé à la fin, même si
 * une étape échoue. Réglages lus dans `.env` : ceux de `smoke:mega-s4`.
 */

require('dotenv').config();

const crypto = require('crypto');
const https = require('https');
const {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const OK = '✓';
const KO = '✗';
const INFO = '·';
const LARGEUR = 40;
const Kio = 1024;
const Mio = 1024 * Kio;

const brut = (process.env.MEGA_S4_ENDPOINT || '').trim();
const ENDPOINT = brut && !/^https?:\/\//.test(brut) ? `https://${brut}` : brut.replace(/\/+$/, '');
const KEY_ID = (process.env.MEGA_S4_KEY_ID || '').trim();
const SECRET = (process.env.MEGA_S4_SECRET || '').trim();
const BUCKET = (process.env.MEGA_S4_BUCKET || '').trim();
const REGION = (process.env.MEGA_S4_REGION || '').trim()
  || (ENDPOINT ? new URL(ENDPOINT).hostname.split('.')[1] : '')
  || 'us-east-1';
const BLOC = Number(process.env.LOT0_BLOC_KIO || 512) * Kio;

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
const trafic = { envoye: 0, recu: 0 };

function messageDe(e) {
  const statut = e.$metadata?.httpStatusCode;
  return `${e.Code || e.name}${statut ? ` (${statut})` : ''} : ${e.message}`;
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
  console.log(`${INFO} ${nom.padEnd(LARGEUR)} ${verdict}`);
}

const ko = (octets) => `${Math.round(octets / Kio)} Kio`;
const mo = (octets) => `${(octets / Mio).toFixed(1)} Mo`;
const secondes = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Lien signé d'un bloc, à sa taille exacte — ce que le serveur donnera au téléphone. */
function lienEnvoi(Key, taille) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key, ContentLength: taille }), {
    expiresIn: 900, signableHeaders: new Set(['content-length']),
  });
}

const lienLecture = (Key) => getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key }), { expiresIn: 900 });

const reprises = [];

/**
 * Envoi d'un bloc, renvoyé jusqu'à trois fois après une erreur réseau, comme le
 * fera l'application. Chaque reprise est notée avec sa cause.
 */
async function envoyer(Key, corps) {
  for (let essai = 1; ; essai += 1) {
    try {
      const rep = await fetch(await lienEnvoi(Key, corps.length), { method: 'PUT', body: corps });
      trafic.envoye += corps.length;
      if (rep.status !== 200) throw new Error(`statut ${rep.status} : ${(await rep.text()).slice(0, 200)}`);
      return essai;
    } catch (e) {
      const cause = e.cause?.code || e.cause?.message || e.message;
      if (essai >= 3 || !(e instanceof TypeError)) throw new Error(`${e.message} (${cause}), essai ${essai}`);
      reprises.push(`${Key.split('/').pop()} : ${cause}`);
      await new Promise((r) => { setTimeout(r, 1000 * essai); });
    }
  }
}

/**
 * Coupure réseau au milieu d'un bloc : l'en-tête annonce la taille entière,
 * on n'en envoie que `envoyes` octets, puis la connexion est arrachée.
 */
async function envoiCoupe(Key, corps, envoyes) {
  const lien = await lienEnvoi(Key, corps.length);
  return new Promise((resolve) => {
    const req = https.request(lien, { method: 'PUT', headers: { 'content-length': corps.length } });
    req.on('error', () => resolve(null));
    req.on('response', (rep) => { rep.resume(); resolve(rep.statusCode); });
    req.write(corps.subarray(0, envoyes), () => {
      trafic.envoye += envoyes;
      setTimeout(() => req.destroy(new Error('coupure simulée')), 300);
    });
  });
}

/**
 * Lecture d'un bloc, ou de sa fin à partir de `debut`. Après une erreur réseau,
 * reprend par Range là où les octets se sont arrêtés, jusqu'à trois fois.
 */
async function lire(Key, debut = 0) {
  const morceaux = [];
  let deja = 0;
  for (let essai = 1; ; essai += 1) {
    const depuis = debut + deja;
    try {
      const headers = depuis ? { range: `bytes=${depuis}-` } : {};
      const rep = await fetch(await lienLecture(Key), { headers });
      const attendu = depuis ? 206 : 200;
      if (rep.status !== attendu) throw new Error(`statut ${rep.status} au lieu de ${attendu}`);
      for await (const bout of rep.body) {
        morceaux.push(Buffer.from(bout));
        deja += bout.length;
        trafic.recu += bout.length;
      }
      return Buffer.concat(morceaux);
    } catch (e) {
      const cause = e.cause?.code || e.cause?.message || e.message;
      if (essai >= 3 || !(e instanceof TypeError)) throw new Error(`${e.message} (${cause}), essai ${essai}, ${deja} octets reçus`);
      reprises.push(`lecture ${Key.split('/').pop()} : ${cause} après ${deja} octets`);
      await new Promise((r) => { setTimeout(r, 1000 * essai); });
    }
  }
}

/** Lecture d'un bloc coupée dès que `avant` octets sont arrivés. */
async function lectureCoupee(Key, avant) {
  const lien = await lienLecture(Key);
  return new Promise((resolve, reject) => {
    const morceaux = [];
    let recus = 0;
    const req = https.get(lien, (rep) => {
      if (rep.statusCode !== 200) { rep.resume(); reject(new Error(`statut ${rep.statusCode}`)); return; }
      rep.on('data', (bout) => {
        morceaux.push(bout);
        recus += bout.length;
        if (recus >= avant) req.destroy();
      });
      rep.on('close', () => { trafic.recu += recus; resolve(Buffer.concat(morceaux)); });
    });
    req.on('error', () => {});
  });
}

async function lister(prefixe) {
  const objets = [];
  let jeton;
  do {
    const rep = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefixe, ContinuationToken: jeton }));
    for (const o of rep.Contents || []) objets.push({ cle: o.Key, taille: Number(o.Size) });
    jeton = rep.IsTruncated ? rep.NextContinuationToken : undefined;
  } while (jeton);
  return objets;
}

async function main() {
  const manque = ['MEGA_S4_ENDPOINT', 'MEGA_S4_KEY_ID', 'MEGA_S4_SECRET', 'MEGA_S4_BUCKET']
    .filter((v) => !(process.env[v] || '').trim());
  if (manque.length) {
    console.error(`${KO} réglage(s) manquant(s) dans .env : ${manque.join(', ')}`);
    process.exit(1);
  }

  console.log(`MEGA S4 — lot 0 du coffre-fort, sur ${BUCKET} (${ENDPOINT}, région ${REGION})`);
  console.log(`Blocs de ${ko(BLOC)}. Trafic de ce poste : environ ${mo(4 * BLOC)} envoyés et autant reçus.\n`);

  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (e) {
    console.error(`${KO} bucket « ${BUCKET} » inaccessible : ${messageDe(e)}`);
    console.error('  Le coffre utilise le bucket safebox : vérifier MEGA_S4_BUCKET dans .env.');
    process.exit(1);
  }

  const R = `essai-lot0-${Date.now()}/`;
  const F = `${R}fichier/`;
  // Trois blocs pleins et un dernier plus court, comme un vrai fichier.
  const blocs = [BLOC, BLOC, BLOC, Math.floor(BLOC / 2)].map((n) => crypto.randomBytes(n));
  const cle = (i) => `${F}${String(i + 1).padStart(5, '0')}`;

  try {
    // ── A. Envoi ──
    console.log('A. Envoi en blocs indépendants (liens signés)');
    await etape('bloc 1', async () => {
      const t0 = Date.now();
      await envoyer(cle(0), blocs[0]);
      return `200 en ${secondes(Date.now() - t0)}`;
    });

    await etape('bloc 2 coupé à mi-chemin : rien ne reste', async () => {
      const statut = await envoiCoupe(cle(1), blocs[1], blocs[1].length / 2);
      if (statut === 200) throw new Error('S4 a répondu 200 à un bloc incomplet');
      await new Promise((r) => { setTimeout(r, 1500); });
      try {
        const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: cle(1) }));
        throw new Error(`un objet de ${h.ContentLength} octets est resté`);
      } catch (e) {
        if (e.$metadata?.httpStatusCode !== 404 && e.name !== 'NotFound') throw e;
      }
      return 'bloc absent : le téléphone sait qu\'il doit le renvoyer';
    });

    await etape('bloc 2 renvoyé, blocs 3 et 4', async () => {
      const essais = [await envoyer(cle(1), blocs[1]), await envoyer(cle(2), blocs[2]), await envoyer(cle(3), blocs[3])];
      const total = essais.reduce((a, b) => a + b, 0);
      return total === 3 ? '200 × 3, du premier coup' : `200 × 3 après ${total - 3} reprise(s) : ${reprises.join(' ; ')}`;
    });

    await sonde('bloc plus gros que sa taille signée', async () => {
      const lien = await lienEnvoi(`${R}trop-gros`, Kio);
      const rep = await fetch(lien, { method: 'PUT', body: crypto.randomBytes(2 * Kio) });
      trafic.envoye += 2 * Kio;
      return rep.status === 403
        ? 'refusé (403) — l\'espace réservé ne peut pas être dépassé'
        : `ATTENTION — statut ${rep.status} : vérifier la taille à la fin de l'envoi`;
    });

    // ── B. Fin d'envoi ──
    console.log('\nB. Fin d\'envoi');
    await etape('blocs comptés par ListObjectsV2', async () => {
      const objets = await lister(F);
      const attendus = blocs.map((b, i) => `${cle(i)}:${b.length}`).join(' ');
      const recus = objets.map((o) => `${o.cle}:${o.taille}`).join(' ');
      if (recus !== attendus) throw new Error(`reçu « ${recus} »`);
      const total = blocs.reduce((s, b) => s + b.length, 0);
      return `${objets.length} blocs, ${ko(total)}, dans l'ordre et à la bonne taille`;
    });

    // ── C. Lecture ──
    console.log('\nC. Lecture bloc par bloc');
    await etape('lecture, 3e bloc coupé puis repris', async () => {
      const lus = [];
      for (const [i] of blocs.entries()) {
        if (i === 2) {
          const avant = await lectureCoupee(cle(i), blocs[i].length / 4);
          if (avant.length >= blocs[i].length) throw new Error('la coupure n\'a rien coupé');
          const apres = await lire(cle(i), avant.length);
          lus.push(Buffer.concat([avant, apres]));
        } else {
          lus.push(await lire(cle(i)));
        }
      }
      if (!Buffer.concat(lus).equals(Buffer.concat(blocs))) throw new Error('le fichier recollé diffère');
      const lectures = reprises.filter((r) => r.startsWith('lecture'));
      return `fichier recollé identique, reprise par Range${lectures.length ? ` (reprises réseau : ${lectures.join(' ; ')})` : ''}`;
    });
  } finally {
    // ── Ménage ──
    console.log('\nMénage');
    let restants = [];
    try {
      for (const o of await lister(R)) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.cle })).catch(() => {});
      }
      restants = (await lister(R)).map((o) => o.cle);
    } catch (e) {
      console.log(`${KO} liste impossible pour le ménage : ${messageDe(e)}`);
      restants = [R];
    }
    console.log(restants.length
      ? `${KO} reste(nt) à supprimer à la main : ${restants.join(', ')}`
      : `${OK} ${R} vidé`);
    console.log(`Trafic de ce poste : ${mo(trafic.envoye)} envoyés, ${mo(trafic.recu)} reçus.`);
  }

  const echecs = etapes.filter((x) => !x.ok);
  console.log(`\n${etapes.length - echecs.length}/${etapes.length} étapes réussies.`);
  if (echecs.length) {
    for (const x of echecs) console.log(`  ${KO} ${x.nom} — ${x.erreur}`);
    process.exit(1);
  }
  console.log('L\'envoi en blocs indépendants fonctionne sur ce bucket.');
}

main().catch((e) => {
  console.error(`${KO} ${messageDe(e)}`);
  process.exit(1);
});
