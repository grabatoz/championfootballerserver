const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function check() {
  try {
    // Get all users with their XP
    const users = await sequelize.query(
      `SELECT id, "firstName", "lastName", xp FROM users WHERE xp > 0 ORDER BY xp DESC LIMIT 10`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    
    console.log('\n👤 Top 10 Users by XP:');
    if (users.length === 0) {
      console.log('   ⚠️ No users with XP > 0 found!');
    } else {
      users.forEach((u, i) => {
        console.log(`   ${i+1}. ${u.firstName} ${u.lastName}: ${u.xp} XP`);
      });
    }

    // Check recent match stats
    const recentStats = await sequelize.query(
      `SELECT ms.*, u."firstName", u."lastName", m.status as match_status
       FROM "MatchStatistics" ms
       JOIN users u ON ms.user_id = u.id
       JOIN "Matches" m ON ms.match_id = m.id
       ORDER BY ms."createdAt" DESC LIMIT 5`,
      { type: Sequelize.QueryTypes.SELECT }
    );
    
    console.log('\n📊 Recent Match Stats:');
    if (recentStats.length === 0) {
      console.log('   ⚠️ No match stats found!');
    } else {
      recentStats.forEach(s => {
        console.log(`   Player: ${s.firstName} ${s.lastName}`);
        console.log(`   Goals: ${s.goals}, Assists: ${s.assists}, CleanSheets: ${s.cleanSheets}`);
        console.log(`   XP Awarded: ${s.xpAwarded || 0}`);
        console.log(`   Match Status: ${s.match_status}`);
        console.log('   ---');
      });
    }

    await sequelize.close();
  } catch (err) {
    console.error('Error:', err.message);
    await sequelize.close();
  }
}

check();
