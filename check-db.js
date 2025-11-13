require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'championfootballer',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

async function checkMatches() {
  try {
    console.log('Current time:', new Date().toISOString());
    
    const result = await pool.query(`
      SELECT id, "homeTeamName", "awayTeamName", "end", status, archived
      FROM matches
      WHERE "end" <= NOW()
      ORDER BY "end" DESC
      LIMIT 10
    `);
    
    console.log('\n=== Recent Ended Matches ===');
    console.table(result.rows);
    
    const published = await pool.query(`
      SELECT id, "homeTeamName", "awayTeamName", "end", status, archived
      FROM matches
      WHERE "end" <= NOW()
      AND status = ''RESULT_PUBLISHED''
      AND archived = false
      LIMIT 5
    `);
    
    console.log('\n=== RESULT_PUBLISHED Matches ===');
    console.table(published.rows);
    
    await pool.end();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkMatches();
