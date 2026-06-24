require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'salman1209',
  password: process.env.DB_PASSWORD || 'Malik,g12',
});

async function main() {
  const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4';
  const res = await pool.query(`
    SELECT id, "homeDefensiveImpactId", "awayDefensiveImpactId"
    FROM "Matches"
    WHERE "leagueId" = $1
      AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
      AND archived = false
  `, [leagueId]);
  
  console.log('Matches count:', res.rows.length);
  const homeNonNull = res.rows.filter(r => r.homeDefensiveImpactId !== null).length;
  const awayNonNull = res.rows.filter(r => r.awayDefensiveImpactId !== null).length;
  console.log('Home defensive impact picks count:', homeNonNull);
  console.log('Away defensive impact picks count:', awayNonNull);
  console.log('Sample rows:', res.rows.slice(0, 5));
  
  await pool.end();
}
main();
