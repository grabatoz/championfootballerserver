/**
 * Test specific user's notifications to find MOTM_VOTE
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

const User = sequelize.define('User', {
  id: { type: DataTypes.UUID, primaryKey: true },
  name: DataTypes.STRING,
  email: DataTypes.STRING
}, {
  tableName: 'users',
  timestamps: false
});

async function testUserNotifications() {
  try {
    // User from logs: 811af694-cf1c-44e5-844c-4b7349a3856c
    const userId = '811af694-cf1c-44e5-844c-4b7349a3856c';
    
    console.log('🔍 ANALYZING USER NOTIFICATIONS\n');
    console.log('=' .repeat(70));
    
    await sequelize.authenticate();
    console.log('✅ Database connected\n');
    
    // Get user info
    const user = await User.findByPk(userId);
    if (user) {
      console.log(`👤 User: ${user.name} (${user.email})`);
      console.log(`   User ID: ${userId}\n`);
    }
    
    // Get ALL notifications for this user
    console.log('📊 Fetching ALL notifications for this user...\n');
    const allNotifs = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']]
    });
    
    console.log(`📬 Total notifications: ${allNotifs.length}`);
    
    // Count by type
    const typeCount = {};
    allNotifs.forEach(n => {
      typeCount[n.type] = (typeCount[n.type] || 0) + 1;
    });
    
    console.log('\n📊 Notifications by Type:');
    Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .forEach(([type, count]) => {
        console.log(`   ${type}: ${count}`);
      });
    
    // Check MOTM_VOTE notifications
    const motmNotifs = allNotifs.filter(n => n.type === 'MOTM_VOTE');
    console.log(`\n🏆 MOTM_VOTE Notifications: ${motmNotifs.length}`);
    
    if (motmNotifs.length > 0) {
      console.log('\n📋 MOTM_VOTE Details:');
      motmNotifs.forEach((n, i) => {
        console.log(`\n   ${i + 1}. ${n.title}`);
        console.log(`      Body: ${n.body}`);
        console.log(`      Created: ${new Date(n.created_at).toLocaleString()}`);
        console.log(`      Read: ${n.read}`);
        console.log(`      Position in list: #${allNotifs.findIndex(x => x.id === n.id) + 1}`);
      });
    }
    
    // Test with different limits
    console.log('\n' + '='.repeat(70));
    console.log('🧪 TESTING DIFFERENT LIMITS\n');
    
    for (const limit of [50, 100, 150, 200]) {
      const limited = await Notification.findAll({
        where: { user_id: userId },
        order: [['created_at', 'DESC']],
        limit: limit
      });
      
      const motmInLimit = limited.filter(n => n.type === 'MOTM_VOTE').length;
      const icon = motmInLimit > 0 ? '✅' : '❌';
      
      console.log(`${icon} Limit ${limit}: ${limited.length} total, ${motmInLimit} MOTM_VOTE`);
    }
    
    // Find position of first MOTM_VOTE
    if (motmNotifs.length > 0) {
      const firstMotmPos = allNotifs.findIndex(n => n.type === 'MOTM_VOTE') + 1;
      console.log(`\n📍 First MOTM_VOTE is at position: #${firstMotmPos}`);
      
      if (firstMotmPos > 50) {
        console.log(`   ⚠️ PROBLEM: First MOTM is beyond position 50!`);
        console.log(`   ✅ SOLUTION: Backend limit changed to 200 will fix this`);
      } else {
        console.log(`   ✅ Within first 50 notifications`);
      }
    }
    
    // Show recent notifications to understand what's filling the list
    console.log('\n' + '='.repeat(70));
    console.log('📋 RECENT NOTIFICATIONS (First 10):\n');
    
    const recent10 = allNotifs.slice(0, 10);
    recent10.forEach((n, i) => {
      console.log(`${i + 1}. [${n.type}] ${n.title}`);
      console.log(`   Created: ${new Date(n.created_at).toLocaleString()}`);
    });
    
    console.log('\n' + '='.repeat(70));
    console.log('📋 SOLUTION SUMMARY\n');
    console.log('✅ Backend limit increased: 50 → 200');
    console.log('🔄 Server needs restart to apply changes');
    console.log('💾 File: src/routes/notifications.ts (line 24)');
    console.log('\n📝 NEXT STEPS:');
    console.log('   1. Stop backend server (Ctrl+C)');
    console.log('   2. Restart: npm run dev');
    console.log('   3. Refresh browser (Ctrl+Shift+R)');
    console.log('   4. Click notification bell 🔔\n');
    
    await sequelize.close();
    
  } catch (error) {
    console.error('\n❌ Error:', error);
  }
}

testUserNotifications();
