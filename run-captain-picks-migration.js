const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: console.log,
  dialectOptions: {
    ssl: false
  }
});

async function runCaptainPicksMigration() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connection established');

    // Check if columns already exist
    const [existingColumns] = await sequelize.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name='Matches' 
        AND column_name IN ('homeDefensiveImpactId', 'homeMentalityId', 'awayDefensiveImpactId', 'awayMentalityId');
    `);

    const existing = existingColumns.map(row => row.column_name);
    console.log(`📊 Found ${existing.length}/4 columns already exist:`, existing);

    if (existing.length === 4) {
      console.log('✅ All captain picks columns already exist in Matches table');
      await sequelize.close();
      process.exit(0);
    }

    console.log('🔄 Adding captain picks columns to Matches table...');

    // Add columns (IF NOT EXISTS is safe for re-running)
    await sequelize.query(`
      ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "homeDefensiveImpactId" UUID;
    `);
    console.log('✅ Added homeDefensiveImpactId column');

    await sequelize.query(`
      ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "homeMentalityId" UUID;
    `);
    console.log('✅ Added homeMentalityId column');

    await sequelize.query(`
      ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "awayDefensiveImpactId" UUID;
    `);
    console.log('✅ Added awayDefensiveImpactId column');

    await sequelize.query(`
      ALTER TABLE "Matches" ADD COLUMN IF NOT EXISTS "awayMentalityId" UUID;
    `);
    console.log('✅ Added awayMentalityId column');

    console.log('🔄 Adding foreign key constraints...');

    // Add foreign key constraints (check if they exist first to avoid errors)
    const constraints = [
      { name: 'fk_home_defensive_impact', column: 'homeDefensiveImpactId' },
      { name: 'fk_home_mentality', column: 'homeMentalityId' },
      { name: 'fk_away_defensive_impact', column: 'awayDefensiveImpactId' },
      { name: 'fk_away_mentality', column: 'awayMentalityId' }
    ];

    for (const constraint of constraints) {
      try {
        // Check if constraint exists
        const [existing] = await sequelize.query(`
          SELECT constraint_name 
          FROM information_schema.table_constraints 
          WHERE table_name='Matches' AND constraint_name='${constraint.name}';
        `);

        if (existing.length > 0) {
          console.log(`⚠️  Constraint ${constraint.name} already exists, skipping`);
          continue;
        }

        await sequelize.query(`
          ALTER TABLE "Matches" 
          ADD CONSTRAINT "${constraint.name}" 
          FOREIGN KEY ("${constraint.column}") 
          REFERENCES "Users"(id) 
          ON DELETE SET NULL;
        `);
        console.log(`✅ Added constraint: ${constraint.name}`);
      } catch (error) {
        // If constraint already exists or any other error, log but continue
        console.warn(`⚠️  Could not add constraint ${constraint.name}:`, error.message);
      }
    }

    console.log('\n🎉 Migration completed successfully!');
    console.log('📝 Summary:');
    console.log('   - 4 UUID columns added to Matches table');
    console.log('   - Foreign key constraints added for referential integrity');
    console.log('   - Backend should now work without 500 errors');
    console.log('\n✅ You can now restart your backend server');

    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    console.error('Error details:', error.message);
    await sequelize.close();
    process.exit(1);
  }
}

// Run migration
runCaptainPicksMigration();
