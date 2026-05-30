const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function run() {
  try {
    const userId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'; // Ru Uddin
    console.log('--- Inspecting Ru Uddin User Record ---');
    
    const [users] = await sequelize.query(`
      SELECT *
      FROM users
      WHERE id = :userId
    `, {
      replacements: { userId }
    });
    
    console.log('User:', JSON.stringify(users[0], null, 2));
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

run();
