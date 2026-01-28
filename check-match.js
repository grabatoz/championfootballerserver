const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false
});

async function checkMatch() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established');

    const matchId = '5fd0b6c8-ea61-4fd9-9aec-ac61b161cd42';

    // Check if match exists
    const [matches] = await sequelize.query(`
      SELECT id, "leagueId", "seasonId", "homeTeamName", "awayTeamName", status
      FROM "Matches" 
      WHERE id = :matchId;
    `, {
      replacements: { matchId }
    });

    if (matches.length === 0) {
      console.log('❌ Match does not exist in database');
    } else {
      console.log('✅ Match found:', matches[0]);
    }

    // Check all matches in database
    const [allMatches] = await sequelize.query(`
      SELECT COUNT(*) as count FROM "Matches";
    `);
    console.log(`\nTotal matches in database: ${allMatches[0].count}`);

    // Check if Seasons table exists
    const [seasons] = await sequelize.query(`
      SELECT COUNT(*) as count FROM "Seasons";
    `);
    console.log(`Total seasons in database: ${seasons[0].count}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

checkMatch();
