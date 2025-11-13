/**
 * Simple test - just check notification positions
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

async function simpleTest() {
  try {
    const userId = '811af694-cf1c-44e5-844c-4b7349a3856c';
    
    console.log('🔍 SIMPLE NOTIFICATION TEST\n');
    console.log('User ID:', userId, '\n');
    
    await sequelize.authenticate();
    
    // Get all notifications
    const allNotifs = await Notification.findAll({
      where: { user_id: userId },
      order: [['created_at', 'DESC']]
    });
    
    console.log(`📊 Total notifications: ${allNotifs.length}\n`);
    
    // Find MOTM_VOTE notifications
    const motmNotifs = allNotifs.filter(n => n.type === 'MOTM_VOTE');
    console.log(`🏆 MOTM_VOTE notifications: ${motmNotifs.length}\n`);
    
    if (motmNotifs.length > 0) {
      console.log('📍 MOTM_VOTE Positions:');
      motmNotifs.forEach(n => {
        const position = allNotifs.findIndex(x => x.id === n.id) + 1;
        console.log(`   Position #${position}: ${n.title}`);
        console.log(`      Created: ${new Date(n.created_at).toLocaleString()}`);
      });
      
      const firstPosition = allNotifs.findIndex(n => n.type === 'MOTM_VOTE') + 1;
      console.log(`\n📍 First MOTM_VOTE at position: #${firstPosition}`);
      
      if (firstPosition > 50) {
        console.log(`   ❌ PROBLEM: Beyond limit 50! (backend was returning only 50)`);
        console.log(`   ✅ SOLUTION: Backend limit now 200 (will include MOTM votes)`);
      } else {
        console.log(`   ✅ Within first 50 - should be visible`);
      }
    }
    
    // Test limits
    console.log('\n🧪 Testing different limits:\n');
    
    for (const limit of [50, 100, 200]) {
      const limited = await Notification.findAll({
        where: { user_id: userId },
        order: [['created_at', 'DESC']],
        limit: limit
      });
      
      const motmCount = limited.filter(n => n.type === 'MOTM_VOTE').length;
      const icon = motmCount > 0 ? '✅' : '❌';
      console.log(`${icon} Limit ${limit}: ${motmCount} MOTM_VOTE notifications`);
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('📋 ACTION REQUIRED:\n');
    console.log('✅ Backend file updated (limit: 200)');
    console.log('🔄 RESTART backend server now!');
    console.log('   Stop server (Ctrl+C)');
    console.log('   Start: npm run dev');
    console.log('\n💡 After restart, logs should show:');
    console.log('   "📬 Found 200 notifications" (not 50)');
    console.log('   "🏆 Including X MOTM_VOTE notifications"\n');
    
    await sequelize.close();
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

simpleTest();
