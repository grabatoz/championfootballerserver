import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import sequelize from '../src/config/database';

async function main() {
  const playerId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';

  console.log('--- 1. Explain User findByPk ---');
  const q1 = `SELECT "id", "firstName", "lastName", "profilePicture", "xp", "position", "positionType", "shirtNumber", "email" FROM "users" AS "User" WHERE "User"."id" = :playerId;`;
  const res1: any[] = await sequelize.query(`EXPLAIN ANALYZE ${q1}`, { replacements: { playerId }, type: 'SELECT' as any });
  res1.forEach(row => console.log(Object.values(row)[0]));

  console.log('\n--- 2. Explain Leagues association query ---');
  // How does Sequelize fetch the associated leagues?
  // Let's write the query Sequelize does:
  const q2 = `
    SELECT 
      "League"."id", "League"."name", "League"."image", 
      "LeagueMember"."userId" AS "LeagueMember.userId", 
      "LeagueMember"."leagueId" AS "LeagueMember.leagueId", 
      "LeagueMember"."createdAt" AS "LeagueMember.createdAt", 
      "LeagueMember"."updatedAt" AS "LeagueMember.updatedAt" 
    FROM "Leagues" AS "League" 
    INNER JOIN "LeagueMember" AS "LeagueMember" 
      ON "League"."id" = "LeagueMember"."leagueId" 
      AND "LeagueMember"."userId" = :playerId;
  `;
  const res2: any[] = await sequelize.query(`EXPLAIN ANALYZE ${q2}`, { replacements: { playerId }, type: 'SELECT' as any });
  res2.forEach(row => console.log(Object.values(row)[0]));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
