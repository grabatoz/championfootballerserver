// Send test MATCH_ENDED notification
require('dotenv').config();
const { Pool } = require('pg');

// Use DATABASE_URL from .env
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: false
});

async function sendTestNotification() {
  try {
    console.log('🔍 Testing MATCH_ENDED notification system...\n');
    
    // Get first user
    const userResult = await pool.query('SELECT id, email FROM users LIMIT 1');
    if (userResult.rows.length === 0) {
      console.log('❌ No users found');
      await pool.end();
      return;
    }
    
    const user = userResult.rows[0];
    console.log('👤 User ID:', user.id);
    console.log('📧 Email:', user.email);
    
    // Get a recent match
    const matchResult = await pool.query(`
      SELECT id, "homeTeamName", "awayTeamName", "leagueId"
      FROM "Matches"
      WHERE "end" <= NOW()
      ORDER BY "end" DESC 
      LIMIT 1
    `);
    
    if (matchResult.rows.length === 0) {
      console.log('❌ No ended matches found');
      await pool.end();
      return;
    }
    
    const match = matchResult.rows[0];
    console.log('\n⚽ Match:', match.homeTeamName, 'vs', match.awayTeamName);
    console.log('Match ID:', match.id);
    console.log('League ID:', match.leagueId);
    
    // Create MATCH_ENDED notification
    console.log('\n📤 Inserting MATCH_ENDED notification...');
    
    const notifResult = await pool.query(`
      INSERT INTO notifications (user_id, type, title, body, meta, read, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      RETURNING id, type, title
    `, [
      user.id,
      'MATCH_ENDED',
      '⏰ TEST: Match Has Ended!',
      `The match "${match.homeTeamName} vs ${match.awayTeamName}" has ended. Add your stats now!`,
      JSON.stringify({
        matchId: match.id,
        leagueId: match.leagueId,
        matchEndTime: new Date().toISOString()
      }),
      false
    ]);
    
    console.log('\n✅ TEST NOTIFICATION CREATED!');
    console.log('Notification ID:', notifResult.rows[0].id);
    console.log('Type:', notifResult.rows[0].type);
    console.log('Title:', notifResult.rows[0].title);
    console.log('\n📱 NOW CHECK YOUR NOTIFICATION BELL!');
    console.log('You should see:');
    console.log('  - "TEST: Match Has Ended!" notification');
    console.log('  - 📋 "See Details" button');
    console.log('  - ✨ "Add Stats" button');
    
    await pool.end();
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

sendTestNotification();
