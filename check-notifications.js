// Check if notification was created in database
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function checkNotifications() {
  try {
    console.log('Checking notifications in database...\n');
    
    // Check latest notifications
    const result = await pool.query(`
      SELECT id, user_id, type, title, read, created_at, meta
      FROM notifications
      ORDER BY created_at DESC
      LIMIT 5
    `);
    
    console.log('📊 Latest 5 Notifications:');
    console.table(result.rows);
    
    // Check MATCH_ENDED specifically
    const matchEndedResult = await pool.query(`
      SELECT id, user_id, type, title, read, created_at, meta
      FROM notifications
      WHERE type = 'MATCH_ENDED'
      ORDER BY created_at DESC
      LIMIT 3
    `);
    
    console.log('\n⏰ MATCH_ENDED Notifications:');
    console.table(matchEndedResult.rows);
    
    if (matchEndedResult.rows.length === 0) {
      console.log('\n❌ NO MATCH_ENDED notifications found!');
      console.log('This means scheduler is NOT creating notifications.');
    } else {
      console.log('\n✅ MATCH_ENDED notifications exist in database');
      console.log('Problem might be in frontend fetching/displaying');
    }
    
    await pool.end();
  } catch (error) {
    console.error('ERROR:', error.message);
    await pool.end();
  }
}

checkNotifications();
