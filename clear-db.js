require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();

  const tables = [
    'SeasonPlayers',
    'UserHomeMatches',
    'UserAwayMatches',
    'UserMatchAvailability',
    'match_availabilities',
    'match_statistics',
    'Votes',
    'Sessions',
    'Matches',
    'Seasons',
    'LeagueMember',
    'LeagueAdmin',
    'Leagues',
    'users'
  ];

  console.log('🔄 Deleting all records from tables to avoid deadlocks...');
  
  try {
    await client.query('BEGIN');
    for (const t of tables) {
      console.log(`  Deleting from "${t}"...`);
      await client.query(`DELETE FROM "${t}"`);
    }
    await client.query('COMMIT');
    console.log('✅ All tables successfully cleared!');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rbErr) {}
    console.error('❌ Deletion failed:', error.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
