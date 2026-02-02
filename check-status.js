const { Sequelize } = require('sequelize');
require('dotenv').config();
const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function check() {
  // Check recent matches and their status
  const [matches] = await sequelize.query(`
    SELECT id, status, "homeCaptainConfirmed", "awayCaptainConfirmed", "homeTeamGoals", "awayTeamGoals"
    FROM "Matches"
    ORDER BY "updatedAt" DESC
    LIMIT 5
  `);
  
  console.log('Recent Matches:');
  matches.forEach(m => {
    console.log('Match:', m.id.substring(0,8));
    console.log('  Status:', m.status);
    console.log('  Home Captain Confirmed:', m.homeCaptainConfirmed);
    console.log('  Away Captain Confirmed:', m.awayCaptainConfirmed);
    console.log('  Score:', m.homeTeamGoals, '-', m.awayTeamGoals);
    console.log('');
  });
  
  // Check match statistics
  const [stats] = await sequelize.query('SELECT * FROM match_statistics ORDER BY created_at DESC LIMIT 5');
  console.log('\nRecent Stats:');
  stats.forEach(s => {
    console.log('User:', s.user_id.substring(0,8), '| Goals:', s.goals, '| Assists:', s.assists, '| XP Awarded:', s.xp_awarded);
  });
  
  // Check user XP
  const [users] = await sequelize.query('SELECT id, "firstName", xp FROM users WHERE xp > 0');
  console.log('\nUsers with XP:');
  users.forEach(u => console.log(u.firstName, '- XP:', u.xp));
  
  await sequelize.close();
}
check();
