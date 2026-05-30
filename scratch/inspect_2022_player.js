const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function run() {
  try {
    console.log('--- Inspecting Users Created in 2022 ---');
    
    // Find users created in 2022
    const [users] = await sequelize.query(`
      SELECT id, "firstName", "lastName", "createdAt", xp, achievements
      FROM users
      WHERE EXTRACT(YEAR FROM "createdAt") = 2022
    `);
    
    console.log(`Found ${users.length} users created in 2022.`);
    for (const u of users) {
      // Let's check matches played by this user
      const [matches] = await sequelize.query(`
        SELECT ms.*, m.date, m.status
        FROM "match_statistics" ms
        JOIN "Matches" m ON ms.match_id = m.id
        WHERE ms.user_id = :userId
      `, {
        replacements: { userId: u.id }
      });
      
      // Only print users that actually have XP or matches to keep output size readable
      if (u.xp > 0 || matches.length > 0) {
        console.log(`\nUser: ${u.firstName} ${u.lastName} (ID: ${u.id})`);
        console.log(`Created At: ${u.createdAt}`);
        console.log(`Total XP stored in user table: ${u.xp}`);
        console.log(`Achievements: ${JSON.stringify(u.achievements)}`);
        console.log(`Total matches in statistics: ${matches.length}`);
        for (const m of matches) {
          console.log(`  - Match ID: ${m.match_id}, Date: ${m.date}, Status: ${m.status}, XP Awarded: ${m.xp_awarded ?? m.xpAwarded}`);
        }
      }
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

run();
