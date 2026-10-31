/**
 * Passe toutes les clés de fichiers du coffre sous la clé maîtresse en
 * service (trousseau, src/services/safebox/keys.js) : après un changement de
 * clé maîtresse, et une fois pour mettre les anciennes clés « SK1 » au format
 * numéroté.
 *
 * Rien chez MEGA ne change : seules les clés rangées en base sont
 * rechiffrées (safebox_blob.wrapped_key, safebox_note.audio_wrapped_key).
 *
 * ── Changer de clé maîtresse, dans l'ordre ──
 *
 *   1. openssl rand -base64 32 > ~/secrets/safebox-2.key  (chmod 600), et la
 *      sauvegarder hors du serveur avant toute chose.
 *   2. Dans le .env : SAFEBOX_KEY_1_FILE=<l'ancienne>, SAFEBOX_KEY_FILE=<la
 *      nouvelle>, SAFEBOX_KEY_ID=2. Redémarrer : les nouvelles clés partent
 *      sous la n° 2, les anciennes se lisent encore.
 *   3. node scripts/maintenance/safebox-rechiffrer-cles.js           # simulation
 *      node scripts/maintenance/safebox-rechiffrer-cles.js --apply   # rechiffre
 *   4. La n° 1 reste au trousseau pour les empreintes. Après une fuite
 *      seulement, la retirer : la sauvegarde automatique renverra alors tout.
 *
 * Par défaut : simulation. Rejouable : relancer ne touche que ce qui reste.
 */

require('dotenv').config({ quiet: true });

const pool = require('../../src/config/db');
const { rewrapFileKey, wrappedKeyNumber } = require('../../src/services/safebox/keys');

const APPLY = process.argv.includes('--apply');
const LOT = 500;

const ligne = (etiquette, valeur) => console.log(`  ${etiquette.padEnd(38, '.')} ${valeur}`);

/** Parcourt une table par lots ; rend { total, parNumero, aRechiffrer, rechiffrees, echecs }. */
async function parcourir({ table, id, colonne, aad }) {
  const res = { total: 0, parNumero: new Map(), aRechiffrer: 0, rechiffrees: 0, echecs: 0 };
  let apres = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT ${id} AS id, ${colonne} AS cle FROM ${table}
        WHERE ${colonne} IS NOT NULL AND ${id} > ? ORDER BY ${id} LIMIT ${LOT}`,
      [apres],
    );
    if (!rows.length) return res;
    for (const r of rows) {
      apres = r.id;
      res.total += 1;
      try {
        const n = wrappedKeyNumber(r.cle);
        res.parNumero.set(n, (res.parNumero.get(n) ?? 0) + 1);
        const neuve = rewrapFileKey(r.cle, aad(r.id));
        if (!neuve) continue;
        res.aRechiffrer += 1;
        if (!APPLY) continue;
        // Seulement si personne ne l'a changée entre-temps.
        const [u] = await pool.query(
          `UPDATE ${table} SET ${colonne} = ? WHERE ${id} = ? AND ${colonne} = ?`,
          [neuve, r.id, r.cle],
        );
        if (u.affectedRows === 1) res.rechiffrees += 1;
      } catch (e) {
        res.echecs += 1;
        console.error(`  ✗ ${table} ${r.id} : ${e.message}`);
      }
    }
  }
}

function compteRendu(titre, res) {
  console.log(titre);
  ligne('clés', res.total);
  for (const [n, c] of [...res.parNumero].sort((a, b) => a[0] - b[0])) ligne(`  sous la clé n° ${n}`, c);
  ligne('à rechiffrer', res.aRechiffrer);
  if (APPLY) ligne('rechiffrées', res.rechiffrees);
  ligne('échecs', res.echecs);
}

(async () => {
  console.log(APPLY ? 'APPLICATION\n' : 'SIMULATION — rien ne sera écrit.\n');
  try {
    const blocs = await parcourir({ table: 'safebox_blob', id: 'id', colonne: 'wrapped_key', aad: (id) => id });
    compteRendu('Fichiers (safebox_blob)', blocs);
    const notes = await parcourir({
      table: 'safebox_note', id: 'file_id', colonne: 'audio_wrapped_key', aad: (id) => `note-${id}`,
    });
    compteRendu('\nCommentaires audio (safebox_note)', notes);
    const reste = blocs.aRechiffrer + notes.aRechiffrer - (APPLY ? blocs.rechiffrees + notes.rechiffrees : 0);
    if (blocs.echecs + notes.echecs > 0) {
      console.log('\nDes clés n\'ont pas pu être lues : une clé du trousseau manque ? Ne retirer aucune ancienne clé.');
      process.exitCode = 1;
    } else if (!APPLY) {
      console.log('\nSIMULATION — rien n\'a été écrit. Relancer avec --apply pour appliquer.');
    } else if (reste > 0) {
      console.log('\nIncomplet : relancer avec --apply.');
      process.exitCode = 1;
    } else {
      console.log('\nToutes les clés sont sous la clé en service.');
    }
  } catch (e) {
    console.error(`\nÉchec : ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
