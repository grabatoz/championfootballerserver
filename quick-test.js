// Simpler test - just insert notification
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

async function quickTest() {
  try {
    // Get your user ID
    const userResult = await pool.query('SELECT id FROM users LIMIT 1');
    const userId = userResult.rows[0].id;
    
    console.log('Creating test MATCH_ENDED notification for user:', userId);
    
    // Insert notification
    await pool.query(`
      INSERT INTO notifications (user_id, type, title, body, meta, read, created_at)
      VALUES ($1, 'MATCH_ENDED', '⏰ TEST NOTIFICATION', 'Match ended! Check buttons.', '{"matchId":"test123","leagueId":"test456"}', false, NOW())
    `, [userId]);
    
    console.log('✅ SUCCESS! Check your notification bell now!');
    console.log('You should see "See Details" and "Add Stats" buttons');
    
    await pool.end();
  } catch (error) {
    console.error('ERROR:', error.message);
  }
}

quickTest();
