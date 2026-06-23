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
  // Query leagues
  const leagues = await pool.query('SELECT id, name FROM "Leagues";');
  console.log('--- Leagues ---');
  console.table(leagues.rows);

  // Query seasons matching any name
  const seasons = await pool.query(`
    SELECT s.id, s.name, s."seasonNumber", s."leagueId", l.name as league_name
    FROM "Seasons" s
    LEFT JOIN "Leagues" l ON s."leagueId" = l.id
    ORDER BY l.name, s.name
  `);
  console.log('--- Seasons ---');
  console.table(seasons.rows);

  await pool.end();
}
main();
