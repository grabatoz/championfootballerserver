// Check latest match availabilities
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

(async () => {
  const matchId = 'e8ef71da-fed9-4717-83a4-2c5455eb2415'; // Latest ended match
  
  const r = await pool.query(`
    SELECT id, user_id, status
    FROM match_availabilities
    WHERE match_id = $1
  `, [matchId]);
  
  console.log('Availabilities for match:', matchId);
  console.table(r.rows);
  
  const available = r.rows.filter(row => row.status === 'available');
  console.log('\nAvailable players:', available.length);
  
  if (available.length === 0) {
    console.log('\n❌ NO PLAYERS MARKED AS AVAILABLE!');
    console.log('This is why scheduler did NOT send notifications.');
    console.log('\nScheduler only sends notifications to players who marked themselves as "available"');
  }
  
  await pool.end();
})();
