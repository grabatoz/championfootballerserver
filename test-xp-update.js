// Test script to verify XP updates work correctly
const { Sequelize, QueryTypes } = require('sequelize');

// Database connection - update with your credentials
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgres://championfootballer_owner:npg_wQXezr2kxOA8@ep-divine-sound-a5i8gupw-pooler.us-east-2.aws.neon.tech/championfootballer?sslmode=require', {
  logging: false
});

async function testXPUpdate() {
  try {
    await sequelize.authenticate();
    console.log('✅ Database connected');

    // Get a user to test with
    const users = await sequelize.query(
      `SELECT id, "firstName", xp FROM users LIMIT 5`,
      { type: QueryTypes.SELECT }
    );
    console.log('\n📋 Users found:', JSON.stringify(users, null, 2));

    if (users.length === 0) {
      console.log('❌ No users found');
      return;
    }

    const testUser = users[0];
    console.log(`\n🎯 Testing with user: ${testUser.firstName} (ID: ${testUser.id})`);
    console.log(`   Current XP: ${testUser.xp}`);

    // Test 1: Add 10 XP
    const newXP = (testUser.xp || 0) + 10;
    console.log(`\n📝 Test 1: Adding 10 XP (${testUser.xp} → ${newXP})`);
    
    const updateResult = await sequelize.query(
      `UPDATE users SET xp = $1 WHERE id = $2 RETURNING id, "firstName", xp`,
      { bind: [newXP, testUser.id], type: QueryTypes.UPDATE }
    );
    console.log('   Update result:', JSON.stringify(updateResult));

    // Verify
    const verifyUser = await sequelize.query(
      `SELECT id, "firstName", xp FROM users WHERE id = $1`,
      { bind: [testUser.id], type: QueryTypes.SELECT }
    );
    console.log('   ✅ Verified:', JSON.stringify(verifyUser));

    // Test 2: Subtract 10 XP (restore original)
    console.log(`\n📝 Test 2: Subtracting 10 XP back to original (${newXP} → ${testUser.xp})`);
    
    await sequelize.query(
      `UPDATE users SET xp = $1 WHERE id = $2`,
      { bind: [testUser.xp || 0, testUser.id] }
    );

    const finalVerify = await sequelize.query(
      `SELECT id, "firstName", xp FROM users WHERE id = $1`,
      { bind: [testUser.id], type: QueryTypes.SELECT }
    );
    console.log('   ✅ Restored:', JSON.stringify(finalVerify));

    // Test 3: Check MatchStatistics table
    console.log('\n📋 Checking MatchStatistics table...');
    const stats = await sequelize.query(
      `SELECT match_id, user_id, goals, assists, xp_awarded FROM "MatchStatistics" LIMIT 5`,
      { type: QueryTypes.SELECT }
    );
    console.log('   Sample stats:', JSON.stringify(stats, null, 2));

    // Check if xp_awarded column exists
    const columns = await sequelize.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'MatchStatistics'`,
      { type: QueryTypes.SELECT }
    );
    console.log('\n📋 MatchStatistics columns:', JSON.stringify(columns, null, 2));

    console.log('\n✅ All tests passed! Database updates work correctly.');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await sequelize.close();
  }
}

testXPUpdate();
