import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import sequelize from '../src/config/database';

async function main() {
  const matchIds = [
    '0ca8cf0a-7d7f-4806-b863-52a698c9b42f',
    '76a3066a-71e4-4b1b-aa0b-22e4ab7ce3d0',
    '7b2ccec5-4a43-4c47-9ddd-c85dd209a8c0',
    '5988f2e2-e4a2-4006-aec6-71686587db06'
  ]; // sample match IDs
  const leagueIds = [
    '3719c415-e4b2-4d9b-873d-4393193b7935',
    '3983779f-c42f-40cd-a8bd-b9460a594585'
  ];

  console.log('--- Explain Query Step 2 (Leagues with members join) ---');
  // How does Sequelize query this? It queries the Leagues, then user associations. Let's look at the join table.
  const q2 = `
    SELECT "userId", "leagueId" FROM "LeagueMember" WHERE "leagueId" IN (:leagueIds);
  `;
  const res2: any[] = await sequelize.query(`EXPLAIN ANALYZE ${q2}`, { replacements: { leagueIds }, type: 'SELECT' as any });
  res2.forEach(row => console.log(Object.values(row)[0]));

  console.log('\n--- Explain Query Step 4 (Home Matches) ---');
  const q4a = `SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" IN (:matchIds);`;
  const res4a: any[] = await sequelize.query(`EXPLAIN ANALYZE ${q4a}`, { replacements: { matchIds }, type: 'SELECT' as any });
  res4a.forEach(row => console.log(Object.values(row)[0]));

  console.log('\n--- Explain Query Step 4 (Away Matches) ---');
  const q4b = `SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" IN (:matchIds);`;
  const res4b: any[] = await sequelize.query(`EXPLAIN ANALYZE ${q4b}`, { replacements: { matchIds }, type: 'SELECT' as any });
  res4b.forEach(row => console.log(Object.values(row)[0]));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
