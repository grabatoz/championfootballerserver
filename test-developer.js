/**
 * Test Developer user who SHOULD have MOTM notifications
 */

const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  },
  logging: false
});

const Notification = sequelize.define('Notification', {
  id: { type: DataTypes.UUID, primaryKey: true },
  user_id: { type: DataTypes.UUID, allowNull: false },
  type: { type: DataTypes.STRING, allowNull: false },
  title: { type: DataTypes.STRING, allowNull: false },
  body: { type: DataTypes.TEXT },
  created_at: { type: DataTypes.DATE }
}, {
  tableName: 'notifications',
  timestamps: false
});

async function testDeveloperUser() {
  try {
    // Developer user who received MOTM notifications
    const userId = '08078495-1587-4a51-808d-834cb549ffa5';
    
    console.log('🧪 Testing Developer User (Should have MOTM notifications)\n');
    console.log('=' .repeat(70));
    
    await sequelize.authenticate();
    
    // Get all notifications with LIMIT 50 (old limit)
    console.log('\n📊 Test 1: OLD LIMIT (50 notifications)');
    const notifs50 = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit: 50
    });
    
    const motm50 = notifs50.filter(n => n.type === 'MOTM_VOTE');
    console.log(`   Total: ${notifs50.length}`);
    console.log(`   MOTM_VOTE: ${motm50.length}`);
    console.log(`   ${motm50.length > 0 ? '✅ FOUND' : '❌ NOT FOUND'}`);
    
    if (motm50.length > 0) {
      motm50.forEach((n, i) => {
        const pos = notifs50.findIndex(x => x.id === n.id) + 1;
        console.log(`      #${pos}: ${n.body}`);
      });
    }
    
    // Get all notifications with LIMIT 200 (new limit)
    console.log('\n📊 Test 2: NEW LIMIT (200 notifications)');
    const notifs200 = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit: 200
    });
    
    const motm200 = notifs200.filter(n => n.type === 'MOTM_VOTE');
    console.log(`   Total: ${notifs200.length}`);
    console.log(`   MOTM_VOTE: ${motm200.length}`);
    console.log(`   ${motm200.length > 0 ? '✅ FOUND' : '❌ NOT FOUND'}`);
    
    if (motm200.length > 0) {
      motm200.forEach((n, i) => {
        const pos = notifs200.findIndex(x => x.id === n.id) + 1;
        console.log(`      #${pos}: ${n.body}`);
      });
    }
    
    console.log('\n' + '=' .repeat(70));
    console.log('📋 DIAGNOSIS:\n');
    
    if (motm50.length === motm200.length && motm50.length > 0) {
      console.log('✅ MOTM notifications ARE within first 50!');
      console.log('   This means the problem is NOT the limit.');
      console.log('   Problem might be:');
      console.log('   1. Backend server running old code (not restarted)');
      console.log('   2. Frontend not fetching correctly');
      console.log('   3. Frontend rendering issue\n');
    } else if (motm50.length === 0 && motm200.length > 0) {
      console.log('❌ MOTM notifications are BEYOND position 50!');
      console.log('   ✅ Solution: Increase limit to 200 (already done)');
      console.log('   🔄 Action: Restart backend server\n');
    } else {
      console.log('⚠️ No MOTM notifications found for this user\n');
    }
    
    console.log('🔄 NEXT STEPS:');
    console.log('   1. Backend file updated: src/routes/notifications.ts (limit: 200)');
    console.log('   2. RESTART backend server (Ctrl+C then npm run dev)');
    console.log('   3. Check backend logs for:');
    console.log('      "📬 Found X notifications" (should show ~100+, not 50)');
    console.log('      "🏆 Including X MOTM_VOTE notifications"');
    console.log('   4. Refresh frontend browser (Ctrl+Shift+R)');
    console.log('   5. Click notification bell 🔔\n');
    
    await sequelize.close();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testDeveloperUser();
