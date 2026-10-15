/**
 * Applique une migration sur la base de production EN PASSANT PAR LE VPS, en
 * une commande lancée depuis son poste :
 *
 *   node scripts/maintenance/migration-distante.js migrations/101_safebox.sql \
 *     | ssh ubuntu@www.alanya237.com 'cd ~/Alanya-backend && node -'
 *
 * Pourquoi : la base n'accepte que les connexions du VPS (constaté le
 * 15/10/2026 : depuis un poste, MySQL coupe avant même la poignée de main), et
 * le VPS n'a pas de client `mysql`. Ce script ne se connecte à rien : il écrit
 * sur sa sortie un petit programme Node qui contient le SQL de la migration.
 * Le VPS l'exécute avec `mysql2` et les identifiants de SON `.env`. Aucun
 * fichier copié, rien à installer, seul le mot de passe SSH est demandé.
 *
 * Le programme affiche ensuite, pour chaque table que la migration crée, si
 * elle existe bien. Une migration écrite pour être rejouée (CREATE TABLE IF
 * NOT EXISTS, INSERT IGNORE) peut être relancée sans risque.
 */

const fs = require('fs');
const path = require('path');

const fichier = process.argv[2];
if (!fichier || !fs.existsSync(fichier)) {
  console.error('Usage : node scripts/maintenance/migration-distante.js migrations/<fichier>.sql | ssh … \'cd ~/Alanya-backend && node -\'');
  process.exit(1);
}

const sql = fs.readFileSync(fichier, 'utf8');
// Le nom doit être suivi de sa parenthèse : « CREATE TABLE IF NOT EXISTS » cité
// dans un commentaire ne compte pas.
const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?([A-Za-z0-9_]+)`?\s*\(/gi)].map((m) => m[1]);

// Le programme exécuté sur le VPS. Il ne reçoit rien d'autre que ce texte.
process.stdout.write(`
require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');
const SQL = ${JSON.stringify(sql)};
const TABLES = ${JSON.stringify(tables)};
(async () => {
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME, multipleStatements: true,
  });
  try {
    console.log('Base : ' + process.env.DB_NAME + ' — migration ${path.basename(fichier)}');
    await c.query(SQL);
    console.log('✓ migration appliquée');
    for (const t of TABLES) {
      const [r] = await c.query(
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [t]);
      console.log((r[0].n ? '✓ ' : '✗ ') + t + (r[0].n ? '' : ' ABSENTE'));
    }
  } finally {
    await c.end();
  }
})().catch((e) => { console.error('✗ échec : ' + e.message); process.exit(1); });
`);
