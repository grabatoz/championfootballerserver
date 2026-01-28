const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log
});

async function runMigration() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established');

    // Check if seasonId column already exists
    const [results] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='Matches' AND column_name='seasonId';
    `);

    if (results.length > 0) {
      console.log('✅ seasonId column already exists in Matches table');
      process.exit(0);
    }

    console.log('🔄 Running migration to add seasonId column...');

    // Load and run the migration
    const migration = require('./migrations/20250124-add-seasons.js');
    await migration.up(sequelize.getQueryInterface(), Sequelize);

    console.log('✅ Migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
