/**
 * Comprehensive notification system diagnostic
 */

const { Sequelize, DataTypes } = require('sequelize');
require('dotenv').config();

// Database setup
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

// Notification Model
const Notification = sequelize.define('Notification', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true
  },
  user_id: {
    type: DataTypes.UUID,
    allowNull: false
  },
  type: {
    type: DataTypes.STRING,
    allowNull: false
  },
  title: {
    type: DataTypes.STRING,
    allowNull: false
  },
  body: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  meta: {
    type: DataTypes.JSONB,
    allowNull: true
  },
  read: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'notifications',
  timestamps: false
});

// User Model
const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    primaryKey: true
  },
  name: DataTypes.STRING,
  email: DataTypes.STRING
}, {
  tableName: 'users',
  timestamps: false
});

async function diagnose() {
  try {
    console.log('🔍 NOTIFICATION SYSTEM DIAGNOSTIC\n');
    console.log('=' .repeat(60));
    
    // Step 1: Database Connection
    console.log('\n📊 Step 1: Testing Database Connection...');
    await sequelize.authenticate();
    console.log('✅ Database connected successfully');

    // Step 2: Check total notifications
    console.log('\n📊 Step 2: Checking Total Notifications...');
    const totalNotifs = await Notification.count();
    console.log(`   Total notifications in database: ${totalNotifs}`);
    
    // Step 3: Check MOTM_VOTE notifications
    console.log('\n📊 Step 3: Checking MOTM_VOTE Notifications...');
    const motmCount = await Notification.count({ where: { type: 'MOTM_VOTE' } });
    console.log(`   MOTM_VOTE notifications: ${motmCount}`);
    
    // Step 4: Check notifications by type
    console.log('\n📊 Step 4: Notifications by Type...');
    const types = await sequelize.query(
      `SELECT type, COUNT(*) as count FROM notifications GROUP BY type ORDER BY count DESC`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    types.forEach(t => {
      console.log(`   ${t.type}: ${t.count}`);
    });
    
    // Step 5: Check recent notifications (last 10)
    console.log('\n📊 Step 5: Recent Notifications (Last 10)...');
    const recent = await Notification.findAll({
      order: [['created_at', 'DESC']],
      limit: 10,
      include: [{
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email']
      }]
    });
    
    if (recent.length === 0) {
      console.log('   ⚠️ No notifications found');
    } else {
      recent.forEach((n, i) => {
        console.log(`\n   ${i + 1}. ${n.type} - ${n.title}`);
        console.log(`      User: ${n.user_id}`);
        console.log(`      Read: ${n.read}`);
        console.log(`      Created: ${new Date(n.created_at).toLocaleString()}`);
      });
    }
    
    // Step 6: Check users with MOTM_VOTE notifications
    console.log('\n📊 Step 6: Users with MOTM_VOTE Notifications...');
    const usersWithMotm = await sequelize.query(
      `SELECT u.id, u.name, u.email, COUNT(n.id) as notif_count
       FROM users u
       JOIN notifications n ON n.user_id = u.id
       WHERE n.type = 'MOTM_VOTE'
       GROUP BY u.id, u.name, u.email
       ORDER BY notif_count DESC`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    
    if (usersWithMotm.length === 0) {
      console.log('   ⚠️ No users have MOTM_VOTE notifications');
    } else {
      usersWithMotm.forEach(u => {
        console.log(`   ${u.name} (${u.email}): ${u.notif_count} notifications`);
      });
    }
    
    // Step 7: Test API query simulation
    console.log('\n📊 Step 7: Simulating API Query (Limit 50)...');
    const testUserId = usersWithMotm[0]?.id;
    if (testUserId) {
      console.log(`   Testing with user: ${usersWithMotm[0].name} (${testUserId})`);
      
      const apiSimulation = await Notification.findAll({
        where: { user_id: testUserId },
        order: [['created_at', 'DESC']],
        limit: 50
      });
      
      console.log(`   Total notifications for user: ${apiSimulation.length}`);
      
      const motmInApi = apiSimulation.filter(n => n.type === 'MOTM_VOTE').length;
      console.log(`   MOTM_VOTE notifications in response: ${motmInApi}`);
      
      if (motmInApi === 0 && motmCount > 0) {
        console.log('   ⚠️ PROBLEM: MOTM_VOTE notifications exist but not in API response!');
        console.log('   This means they are beyond the 50-notification limit.');
      } else if (motmInApi > 0) {
        console.log('   ✅ MOTM_VOTE notifications ARE in API response');
      }
    }
    
    // Step 8: Check notification age
    console.log('\n📊 Step 8: Checking Notification Age...');
    const oldestMotm = await Notification.findOne({
      where: { type: 'MOTM_VOTE' },
      order: [['created_at', 'ASC']]
    });
    
    const newestMotm = await Notification.findOne({
      where: { type: 'MOTM_VOTE' },
      order: [['created_at', 'DESC']]
    });
    
    if (oldestMotm && newestMotm) {
      console.log(`   Oldest MOTM notification: ${new Date(oldestMotm.created_at).toLocaleString()}`);
      console.log(`   Newest MOTM notification: ${new Date(newestMotm.created_at).toLocaleString()}`);
    }
    
    // Final Summary
    console.log('\n' + '='.repeat(60));
    console.log('📋 DIAGNOSTIC SUMMARY');
    console.log('='.repeat(60));
    console.log(`✅ Database: Connected`);
    console.log(`📊 Total Notifications: ${totalNotifs}`);
    console.log(`🏆 MOTM_VOTE Notifications: ${motmCount}`);
    console.log(`👥 Users with MOTM notifications: ${usersWithMotm.length}`);
    
    if (motmCount > 0 && usersWithMotm.length > 0) {
      console.log('\n💡 RECOMMENDATIONS:');
      console.log('   1. Ensure backend server is running on http://localhost:5000');
      console.log('   2. Check browser console for API errors');
      console.log('   3. Verify auth token is valid');
      console.log('   4. Increase notification limit to 100 if notifications are beyond 50');
    }
    
    await sequelize.close();
    
  } catch (error) {
    console.error('\n❌ Error during diagnosis:', error);
  }
}

diagnose();
