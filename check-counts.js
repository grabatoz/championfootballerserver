require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();

  const tables = [
    'users',
    'Leagues',
    'Seasons',
    'Matches',
    'Sessions',
    'Votes',
    'match_statistics',
    'LeagueMember',
    'LeagueAdmin',
    'SeasonPlayers'
  ];

  console.log('=== Database Table Counts ===');
  for (const t of tables) {
    try {
      const res = await client.query(`SELECT COUNT(*) FROM "${t}"`);
      console.log(`${t}: ${res.rows[0].count}`);
    } catch (e) {
      // Try lowercase
      try {
        const res = await client.query(`SELECT COUNT(*) FROM ${t.toLowerCase()}`);
        console.log(`${t}: ${res.rows[0].count}`);
      } catch (err) {
        console.log(`${t}: ERROR (${err.message})`);
      }
    }
  }

  await client.end();
}

main().catch(console.error);
