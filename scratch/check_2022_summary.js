const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function run() {
  try {
    console.log('--- Inspecting 2022 Users with XP ---');
    const [users] = await sequelize.query(`
      SELECT id, "firstName", "lastName", "createdAt", xp, achievements
      FROM users
      WHERE EXTRACT(YEAR FROM "createdAt") = 2022 AND xp > 0
    `);
    
    console.log(`Found ${users.length} users created in 2022 with XP > 0:`);
    for (const u of users) {
      console.log(`\nUser: ${u.firstName} ${u.lastName} (ID: ${u.id})`);
      console.log(`  Created At: ${u.createdAt}`);
      console.log(`  Stored XP: ${u.xp}`);
      console.log(`  Achievements: ${JSON.stringify(u.achievements)}`);
      
      // Get match counts by year
      const [counts] = await sequelize.query(`
        SELECT EXTRACT(YEAR FROM m.date)::int AS match_year, 
               COUNT(*) AS match_count,
               SUM(ms.xp_awarded) AS total_xp_awarded
        FROM "match_statistics" ms
        JOIN "Matches" m ON ms.match_id = m.id
        WHERE ms.user_id = :userId
        GROUP BY match_year
        ORDER BY match_year
      `, {
        replacements: { userId: u.id }
      });
      
      console.log('  Matches by Year:');
      if (counts.length === 0) {
        console.log('    None');
      } else {
        for (const c of counts) {
          console.log(`    - Year ${c.match_year}: ${c.match_count} matches, XP Awarded: ${c.total_xp_awarded}`);
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
