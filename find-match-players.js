// Find where match players are stored
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

(async () => {
  try {
    // Get table names
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name LIKE '%match%'
      ORDER BY table_name
    `);
    
    console.log('📊 Match-related tables:');
    tables.rows.forEach(row => console.log('  -', row.table_name));
    
    // Check latest match
    const matchId = 'e8ef71da-fed9-4717-83a4-2c5455eb2415';
    
    console.log('\n🔍 Checking match players...\n');
    
    // Check match_players table
    try {
      const players = await pool.query(`
        SELECT * FROM match_players WHERE match_id = $1 LIMIT 5
      `, [matchId]);
      console.log('match_players table:');
      console.table(players.rows);
    } catch (e) {
      console.log('❌ match_players table not found or error:', e.message);
    }
    
    // Check Matches table for team data
    try {
      const match = await pool.query(`
        SELECT 
          id, 
          "homeTeam", 
          "awayTeam",
          "homeTeamPlayers",
          "awayTeamPlayers"
        FROM "Matches" 
        WHERE id = $1
      `, [matchId]);
      console.log('\nMatch teams data:');
      console.log(match.rows[0]);
    } catch (e) {
      console.log('❌ Error getting match teams:', e.message);
    }
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    await pool.end();
  }
})();
