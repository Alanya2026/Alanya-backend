#!/usr/bin/env node
/**
 * Charge un pack de stickers officiel exporté, par le MÊME pipeline que
 * l'administration (utils/stickerAsset : contrôle réel, ré-encodage WebP,
 * liste de blocage, empreinte) — plan §8.
 *
 *   node scripts/load_sticker_pack.js <dossier-du-pack> [options]
 *
 *   <dossier-du-pack>   stickers-export/<pack>/ : pack.json + les .webp
 *   --i18n <fichier>    traductions (défaut : ../i18n.json à côté du pack)
 *   --created-by <id>   alanyaID de l'auteur de la création (défaut : 0)
 *   --dry-run           passe chaque fichier par le pipeline, n'écrit RIEN
 *                       (ni base, ni stockage)
 *   --publish           publie le pack (défaut : brouillon — la publication est
 *                       un acte super-admin, plan §6.4)
 *
 * Fusionne pack.json (français) et i18n.json (en, zh) : une traduction absente
 * n'est pas stockée, le repli en → fr se fait à la lecture.
 *
 * Réexécutable : un pack déjà chargé n'est pas dupliqué (le pack est retrouvé
 * par son code, un sticker déjà présent à sa position avec la même empreinte
 * est sauté). Exige la migration 097 jouée et, hors --dry-run, le stockage
 * public (`B2_PROFILEMEDIA_*`) configuré.
 */

const fs = require('fs');
const path = require('path');
const { construirePack } = require('../src/utils/stickerPackLoad');
const { preparerAsset } = require('../src/utils/stickerAsset');

function lireArgs(argv) {
  const args = { dossier: null, i18n: null, createdBy: 0, dryRun: false, publish: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--publish') args.publish = true;
    else if (a === '--i18n') args.i18n = argv[++i];
    else if (a === '--created-by') args.createdBy = Number.parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('--')) throw new Error(`option inconnue : ${a}`);
    else if (!args.dossier) args.dossier = a;
    else throw new Error(`argument en trop : ${a}`);
  }
  if (!args.dossier) throw new Error('usage : node scripts/load_sticker_pack.js <dossier-du-pack> [--i18n f] [--created-by id] [--dry-run] [--publish]');
  return args;
}

const lireJson = (chemin) => JSON.parse(fs.readFileSync(chemin, 'utf8'));

async function main() {
  const args = lireArgs(process.argv.slice(2));
  const dossier = path.resolve(args.dossier);
  const pack = lireJson(path.join(dossier, 'pack.json'));
  const fichierI18n = args.i18n ? path.resolve(args.i18n) : path.join(dossier, '..', 'i18n.json');
  let i18n = {};
  if (fs.existsSync(fichierI18n)) i18n = lireJson(fichierI18n);
  else console.warn(`i18n introuvable (${fichierI18n}) : français seul`);

  const def = construirePack(pack, i18n);
  console.log(`pack ${def.code} : ${def.stickers.length} stickers, ${def.is_premium ? 'Plus' : 'gratuit'}${args.dryRun ? ' (dry-run)' : ''}`);

  // Étapes 2 à 4 sur chaque fichier d'abord : si UN fichier est refusé, rien
  // n'est écrit — pas de pack à moitié chargé.
  const octets = new Map();
  for (const s of def.stickers) {
    const chemin = path.join(dossier, s.fichier);
    const buffer = fs.readFileSync(chemin);
    // Blocage et quotas seront rejoués par le service, avec la base ; ici, le
    // contrôle réel suffit à tout refuser d'avance.
    const pret = await preparerAsset(buffer, { ownerId: 0, animeAutorise: true });
    octets.set(s.id, buffer);
    console.log(`  ok  ${s.fichier.padEnd(22)} ${String(pret.bytes).padStart(6)} o  q${pret.qualite}`);
  }
  if (args.dryRun) {
    console.log('dry-run : rien écrit.');
    return;
  }

  const pool = require('../src/config/db');
  const storage = require('../src/services/mediaStorage');
  const { creerStickerOfficiel } = require('../src/services/stickerAssetService');
  if (!storage.isB2Enabled()) throw new Error('stockage non configuré (B2_*) : rien ne peut être déposé');

  try {
    // Pack : retrouvé par son code, sinon créé en brouillon.
    await pool.execute(
      `INSERT IGNORE INTO sticker_pack
         (code, owner_id, name_i18n, description_i18n, is_premium, visibility, status, created_by)
       VALUES (?, NULL, ?, ?, ?, 0, 0, ?)`,
      [
        def.code,
        JSON.stringify(def.name_i18n),
        def.description_i18n ? JSON.stringify(def.description_i18n) : null,
        def.is_premium,
        args.createdBy,
      ],
    );
    const [[row]] = await pool.execute(
      'SELECT id, visibility, owner_id FROM sticker_pack WHERE code = ?', [def.code],
    );
    if (Number(row.visibility) !== 0 || row.owner_id !== null) {
      throw new Error(`le code ${def.code} désigne un pack qui n'est pas officiel`);
    }
    const packId = row.id;

    const ids = new Map();
    for (const s of def.stickers) {
      const [dejaLa] = await pool.execute(
        `SELECT s.id, a.sha256 FROM sticker s JOIN sticker_asset a ON a.id = s.asset_id
          WHERE s.pack_id = ? AND s.position = ?`,
        [packId, s.position],
      );
      const pret = await preparerAsset(octets.get(s.id), { ownerId: 0, animeAutorise: true });
      if (dejaLa.length) {
        if (dejaLa[0].sha256 !== pret.sha256) {
          throw new Error(`position ${s.position} (${s.id}) déjà occupée par un autre fichier : un fichier officiel ne se remplace pas, il se retire`);
        }
        ids.set(s.id, dejaLa[0].id);
        console.log(`  =   ${s.fichier} déjà chargé`);
        continue;
      }
      const r = await creerStickerOfficiel({
        buffer: octets.get(s.id),
        packId,
        packCode: def.code,
        position: s.position,
        emoji: s.emoji,
        nameI18n: Object.keys(s.name_i18n).length ? s.name_i18n : null,
      });
      ids.set(s.id, r.stickerId);
      console.log(`  +   ${s.fichier} -> sticker ${r.stickerId}${r.reutilise ? ' (fichier réutilisé)' : ''}`);
    }

    await pool.execute(
      `UPDATE sticker_pack SET cover_sticker_id = ?,
              status = IF(? = 1, 1, status),
              published_at = IF(? = 1 AND published_at IS NULL, NOW(3), published_at)
        WHERE id = ?`,
      [ids.get(def.coverId), args.publish ? 1 : 0, args.publish ? 1 : 0, packId],
    );
    console.log(`pack ${def.code} chargé (${args.publish ? 'publié' : 'brouillon'}).`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
