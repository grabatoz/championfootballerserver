/**
 * Test if MOTM_VOTE notifications are within top 100 notifications
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
  meta: { type: DataTypes.JSONB },
  read: { type: DataTypes.BOOLEAN, defaultValue: false },
  created_at: { type: DataTypes.DATE }
}, {
  tableName: 'notifications',
  timestamps: false
});

async function testNotificationLimit() {
  try {
    console.log('🧪 Testing Notification Limit Fix\n');
    console.log('=' .repeat(60));
    
    await sequelize.authenticate();
    console.log('✅ Database connected\n');
    
    // Get a user with MOTM_VOTE notifications
    const motmNotif = await Notification.findOne({
      where: { type: 'MOTM_VOTE' },
      order: [['created_at', 'DESC']]
    });
    
    if (!motmNotif) {
      console.log('❌ No MOTM_VOTE notifications found');
      return;
    }
    
    const userId = motmNotif.user_id;
    console.log(`📊 Testing with user ID: ${userId}\n`);
    
    // Test with limit 50 (old)
    console.log('📊 Test 1: With limit 50 (OLD LIMIT)');
    const notifs50 = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit: 50
    });
    
    const motm50 = notifs50.filter(n => n.type === 'MOTM_VOTE').length;
    console.log(`   Total notifications: ${notifs50.length}`);
    console.log(`   MOTM_VOTE notifications: ${motm50}`);
    console.log(`   ${motm50 > 0 ? '✅' : '❌'} MOTM votes ${motm50 > 0 ? 'FOUND' : 'NOT FOUND'}\n`);
    
    // Test with limit 100 (new)
    console.log('📊 Test 2: With limit 100 (NEW LIMIT)');
    const notifs100 = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']],
      limit: 100
    });
    
    const motm100 = notifs100.filter(n => n.type === 'MOTM_VOTE').length;
    console.log(`   Total notifications: ${notifs100.length}`);
    console.log(`   MOTM_VOTE notifications: ${motm100}`);
    console.log(`   ${motm100 > 0 ? '✅' : '❌'} MOTM votes ${motm100 > 0 ? 'FOUND' : 'NOT FOUND'}\n`);
    
    // Summary
    console.log('=' .repeat(60));
    console.log('📋 SUMMARY\n');
    
    if (motm50 === 0 && motm100 > 0) {
      console.log('✅ FIX CONFIRMED: Increasing limit from 50 to 100 will show MOTM votes!');
      console.log(`   - Old limit (50): ${motm50} MOTM votes`);
      console.log(`   - New limit (100): ${motm100} MOTM votes`);
      console.log(`   - Difference: +${motm100 - motm50} MOTM vote notifications visible\n`);
    } else if (motm50 > 0) {
      console.log('✅ MOTM votes already visible within top 50 notifications');
    } else {
      console.log('⚠️ MOTM votes not found in either limit - may need higher limit');
    }
    
    console.log('📝 NEXT STEPS:');
    console.log('   1. ✅ Backend updated (limit: 50 → 100)');
    console.log('   2. 🔄 Restart backend server');
    console.log('   3. 🔄 Refresh frontend browser');
    console.log('   4. 🔔 Check notification bell\n');
    
    await sequelize.close();
    
  } catch (error) {
    console.error('❌ Error:', error);
  }
}

testNotificationLimit();
