// Quick test to manually trigger scheduler
require('dotenv').config();
const { Sequelize, Op } = require('sequelize');

// Database connection using DATABASE_URL from .env
const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log,
  dialectOptions: {
    ssl: false
  }
});

async function testScheduler() {
  try {
    console.log('🔍 Testing match end detection...\n');
    
    // Test connection
    await sequelize.authenticate();
    console.log('✅ Database connected\n');
    
    const now = new Date();
    console.log('Current time:', now.toISOString());
    
    // Query matches - same as scheduler
    const [matches] = await sequelize.query(`
      SELECT 
        id, 
        "homeTeamName", 
        "awayTeamName", 
        "end", 
        status, 
        archived,
        "leagueId"
      FROM matches
      WHERE "end" <= NOW()
      ORDER BY "end" DESC
      LIMIT 10
    `);
    
    console.log('\n📊 All ended matches:');
    console.table(matches);
    
    // Filter for RESULT_PUBLISHED
    const publishedMatches = matches.filter(m => m.status === 'RESULT_PUBLISHED' && !m.archived);
    console.log('\n📢 RESULT_PUBLISHED matches (not archived):');
    console.table(publishedMatches);
    
    if (publishedMatches.length > 0) {
      const testMatch = publishedMatches[0];
      console.log('\n🔍 Checking availabilities for match:', testMatch.id);
      
      const [availabilities] = await sequelize.query(`
        SELECT id, user_id, status
        FROM match_availabilities
        WHERE match_id = '${testMatch.id}'
        AND status = 'available'
      `);
      
      console.log('\n👥 Available players:');
      console.table(availabilities);
      
      if (availabilities.length > 0) {
        console.log('\n✅ WOULD SEND NOTIFICATIONS TO:', availabilities.length, 'players');
      } else {
        console.log('\n⚠️  NO AVAILABLE PLAYERS - No notifications would be sent');
      }
    } else {
      console.log('\n⚠️  NO RESULT_PUBLISHED MATCHES FOUND');
      console.log('Check that:');
      console.log('  1. Match end time is in the past');
      console.log('  2. Match status is exactly "RESULT_PUBLISHED"');
      console.log('  3. Match is not archived');
    }
    
    await sequelize.close();
    console.log('\n✅ Test complete');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

testScheduler();
