const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log
});

async function addSeasonIdColumn() {
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

    console.log('🔄 Adding seasonId column to Matches table...');

    // Just add the column, don't worry about the rest
    await sequelize.query(`
      ALTER TABLE "Matches" 
      ADD COLUMN "seasonId" UUID 
      REFERENCES "Seasons"(id) 
      ON DELETE SET NULL 
      ON UPDATE CASCADE;
    `);

    console.log('✅ seasonId column added successfully!');

    // Add index
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS "matches_season_id_index" 
      ON "Matches" ("seasonId");
    `);

    console.log('✅ Index created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    process.exit(1);
  }
}

addSeasonIdColumn();
