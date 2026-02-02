const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function checkColumns() {
  try {
    const [cols] = await sequelize.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'match_statistics'`);
    console.log('Columns in match_statistics:');
    cols.forEach(c => console.log(' -', c.column_name));
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await sequelize.close();
  }
}

checkColumns();
