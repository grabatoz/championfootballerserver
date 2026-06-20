import dotenv from 'dotenv';
import path from 'path';
import { Sequelize, QueryTypes } from 'sequelize';

dotenv.config({ path: path.join(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL || '';

async function main() {
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
  });

  await sequelize.authenticate();
  console.log('✅ Connected to database\n');

  // Find Muhib User's ID
  const users = await sequelize.query<any>(
    `SELECT id, "firstName", "lastName" FROM users WHERE "firstName" ILIKE '%Muhib%' OR "lastName" ILIKE '%Muhib%'`,
    { type: QueryTypes.SELECT }
  );

  console.log('Muhib Users found:', users);
  if (users.length === 0) {
    console.log('No Muhib User found.');
    await sequelize.close();
    return;
  }

  const muhibId = users[0].id;

  // Find all matches Muhib played in
  const matches = await sequelize.query<any>(
    `SELECT m.id, m."leagueId", l.name as league_name, m.date, m.status,
            m."homeDefensiveImpactId", m."awayDefensiveImpactId"
     FROM "Matches" m
     JOIN "Leagues" l ON l.id = m."leagueId"
     JOIN match_statistics ms ON ms.match_id = m.id
     WHERE ms.user_id = $1 AND m.deleted = false
     ORDER BY m.date DESC`,
    { bind: [muhibId], type: QueryTypes.SELECT }
  );

  console.log(`\nMatches Muhib played in: ${matches.length}`);
  
  // Find teammates who played with Muhib (same team) and opponents (rivals, opposite team)
  // Let's analyze who has 2 wins with Muhib and 1 loss against Muhib.
  // In our system, a match has a home team and an away team.
  // Let's query all match statistics for matches Muhib played.
  for (const match of matches.slice(0, 10)) {
    console.log(`\nMatch: ${match.id} | League: ${match.league_name} | Date: ${match.date}`);
    const stats = await sequelize.query<any>(
      `SELECT ms.user_id, u."firstName", u."lastName", ms.goals, ms.assists, ms.clean_sheets, ms.defence, ms.impact
       FROM match_statistics ms
       JOIN users u ON u.id = ms.user_id
       WHERE ms.match_id = $1`,
      { bind: [match.id], type: QueryTypes.SELECT }
    );
    console.log(`  Players in match:`);
    for (const s of stats) {
      console.log(`    - ${s.firstName} ${s.lastName} (${s.user_id}): G=${s.goals}, A=${s.assists}, CS=${s.clean_sheets}`);
    }
  }

  await sequelize.close();
}

main().catch(console.error);
