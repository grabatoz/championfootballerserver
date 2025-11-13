const { Sequelize, Op } = require('sequelize');
const path = require('path');

// Setup database connection
const sequelize = new Sequelize({
  dialect: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'championfootballer',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  logging: false,
});

async function checkMatches() {
  try {
    const now = new Date();
    console.log('Current time:', now.toISOString());
    
    // Check for ended matches
    const [results] = await sequelize.query(`
      SELECT id, "homeTeamName", "awayTeamName", "end", status, archived
      FROM matches
      WHERE "end" <= NOW()
      AND status = 'RESULT_PUBLISHED'
      AND archived = false
      ORDER BY "end" DESC
      LIMIT 5
    `);
    
    console.log('\n=== Ended Matches (RESULT_PUBLISHED) ===');
    if (results.length === 0) {
      console.log('No matches found with status RESULT_PUBLISHED that have ended');
    } else {
      console.table(results);
    }
    
    // Check all recent matches
    const [allRecent] = await sequelize.query(`
      SELECT id, "homeTeamName", "awayTeamName", "end", status, archived
      FROM matches
      WHERE "end" <= NOW()
      ORDER BY "end" DESC
      LIMIT 10
    `);
    
    console.log('\n=== All Recent Ended Matches ===');
    console.table(allRecent);
    
    await sequelize.close();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkMatches();
