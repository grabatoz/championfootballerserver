const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log,
  dialectOptions: {
    ssl: false
  }
});

async function runSeasonSettingsMigration() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established');

    // Check if columns already exist
    const [existingColumns] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='Seasons' 
        AND column_name IN ('maxGames', 'showPoints');
    `);

    const existing = existingColumns.map(row => row.column_name);
    console.log(`📊 Found ${existing.length}/2 columns already exist:`, existing);

    if (existing.length === 2) {
      console.log('✅ All season settings columns already exist in Seasons table');
      await sequelize.close();
      return;
    }

    console.log('🔄 Adding season settings columns to Seasons table...');

    // Add maxGames column if it doesn't exist
    if (!existing.includes('maxGames')) {
      await sequelize.query(`
        ALTER TABLE "Seasons" 
        ADD COLUMN "maxGames" INTEGER;
      `);
      console.log('✅ Added maxGames column');
    }

    // Add showPoints column if it doesn't exist
    if (!existing.includes('showPoints')) {
      await sequelize.query(`
        ALTER TABLE "Seasons" 
        ADD COLUMN "showPoints" BOOLEAN DEFAULT false;
      `);
      console.log('✅ Added showPoints column');
    }

    console.log('✅ Season settings migration completed successfully!');
    await sequelize.close();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    await sequelize.close();
    process.exit(1);
  }
}

// Run migration
runSeasonSettingsMigration();
