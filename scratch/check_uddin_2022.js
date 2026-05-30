const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function run() {
  try {
    const userId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'; // Ru Uddin
    console.log('--- Inspecting Ru Uddin 2022 Match ---');
    
    const [matches] = await sequelize.query(`
      SELECT ms.*, m.date, m.status, m."homeTeamGoals", m."awayTeamGoals"
      FROM "match_statistics" ms
      JOIN "Matches" m ON ms.match_id = m.id
      WHERE ms.user_id = :userId AND EXTRACT(YEAR FROM m.date) = 2022
    `, {
      replacements: { userId }
    });
    
    console.log('Matches:', JSON.stringify(matches, null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

run();
