const { Sequelize } = require('sequelize');
require('dotenv').config();
const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function verify() {
  const [users] = await sequelize.query('SELECT "firstName", "lastName", xp FROM users WHERE xp > 0');
  console.log('Users with XP:');
  users.forEach(u => console.log(`  ${u.firstName} ${u.lastName} - XP: ${u.xp}`));
  
  const [stats] = await sequelize.query('SELECT ms.xp_awarded, ms.goals, ms.assists, u."firstName" FROM match_statistics ms JOIN users u ON ms.user_id = u.id');
  console.log('\nMatch Statistics XP:');
  stats.forEach(s => console.log(`  ${s.firstName} - Goals: ${s.goals}, Assists: ${s.assists}, XP Awarded: ${s.xp_awarded}`));
  
  await sequelize.close();
}
verify();
