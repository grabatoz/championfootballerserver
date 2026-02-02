const { Sequelize } = require('sequelize');
require('dotenv').config();
const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function testXP() {
  console.log('🧪 Testing XP System...\n');
  
  // 1. Check if awardXPForMatch function exists in code
  try {
    const fs = require('fs');
    const code = fs.readFileSync('./src/utils/xpAchievementsEngine.ts', 'utf8');
    const hasFunction = code.includes('export async function awardXPForMatch');
    console.log('1️⃣ awardXPForMatch function exists in code:', hasFunction ? '✅ YES' : '❌ NO');
  } catch(e) {
    console.log('1️⃣ Could not check code file:', e.message);
  }
  
  // 2. Check recent stats
  const [stats] = await sequelize.query('SELECT xp_awarded, goals, assists FROM match_statistics ORDER BY created_at DESC LIMIT 3');
  console.log('\n2️⃣ Recent Match Statistics:');
  stats.forEach((s, i) => {
    console.log('   Match ' + (i+1) + ': Goals=' + s.goals + ', Assists=' + s.assists + ', XP Awarded=' + s.xp_awarded);
  });
  
  // 3. Check users XP
  const [users] = await sequelize.query('SELECT "firstName", xp FROM users ORDER BY xp DESC LIMIT 5');
  console.log('\n3️⃣ Top Users by XP:');
  users.forEach(u => console.log('   ' + u.firstName + ': ' + u.xp + ' XP'));
  
  // 4. Check if there are any matches with xp_awarded = 0 but both captains confirmed
  const [pending] = await sequelize.query(`
    SELECT COUNT(*) as cnt FROM match_statistics ms
    JOIN "Matches" m ON ms.match_id = m.id
    WHERE m."homeCaptainConfirmed" = true 
      AND m."awayCaptainConfirmed" = true
      AND ms.xp_awarded = 0
  `);
  console.log('\n4️⃣ Matches with missing XP awards:', pending[0].cnt);
  
  if (parseInt(pending[0].cnt) > 0) {
    console.log('   ⚠️ There are matches needing XP - run: node award-missing-xp.js');
  } else {
    console.log('   ✅ All confirmed matches have XP awarded!');
  }
  
  await sequelize.close();
  console.log('\n✅ Test complete!');
}
testXP();
