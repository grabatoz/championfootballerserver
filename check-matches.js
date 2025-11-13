// Check ended matches that should trigger notifications
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkMatches() {
  try {
    console.log('Current time:', new Date().toISOString());
    console.log('\n🔍 Checking matches...\n');
    
    // Check ended matches
    const result = await pool.query(`
      SELECT 
        id, 
        "homeTeamName", 
        "awayTeamName", 
        "end", 
        status, 
        archived
      FROM "Matches"
      WHERE "end" <= NOW()
      ORDER BY "end" DESC
      LIMIT 10
    `);
    
    console.log('📊 Total ended matches:', result.rows.length);
    console.table(result.rows);
    
    // Check matches that SHOULD trigger notification
    const shouldNotifyResult = await pool.query(`
      SELECT 
        id, 
        "homeTeamName", 
        "awayTeamName", 
        "end", 
        status, 
        archived
      FROM "Matches"
      WHERE "end" <= NOW()
      AND status IN ('SCHEDULED', 'RESULT_PUBLISHED')
      AND archived = false
      LIMIT 5
    `);
    
    console.log('\n✅ Matches that SHOULD trigger notification:', shouldNotifyResult.rows.length);
    console.table(shouldNotifyResult.rows);
    
    if (shouldNotifyResult.rows.length > 0) {
      const testMatch = shouldNotifyResult.rows[0];
      console.log('\n🔍 Checking available players for match:', testMatch.id);
      
      // Check availabilities
      const availResult = await pool.query(`
        SELECT id, user_id, status
        FROM match_availabilities
        WHERE match_id = $1
        AND status = 'available'
      `, [testMatch.id]);
      
      console.log('👥 Available players:', availResult.rows.length);
      console.table(availResult.rows);
      
      if (availResult.rows.length === 0) {
        console.log('\n❌ NO AVAILABLE PLAYERS! Notifications will NOT be sent.');
        console.log('Solution: Players must mark availability as "available" for this match');
      } else {
        console.log('\n✅ Should send', availResult.rows.length, 'notifications');
        console.log('❌ But scheduler is NOT running or has already notified this match');
      }
    } else {
      console.log('\n❌ NO matches found that meet criteria:');
      console.log('  - end time <= NOW()');
      console.log('  - status = SCHEDULED or RESULT_PUBLISHED');
      console.log('  - archived = false');
    }
    
    await pool.end();
  } catch (error) {
    console.error('ERROR:', error.message);
    await pool.end();
  }
}

checkMatches();
