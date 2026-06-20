/**
 * Verification script: Checks if the league average calculation
 * produces correct results by comparing against raw database data.
 * 
 * Usage: npx ts-node scratch/verify-averages.ts
 */
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

import { Sequelize, QueryTypes } from 'sequelize';

const DATABASE_URL = process.env.DATABASE_URL || '';

async function main() {
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
  });

  await sequelize.authenticate();
  console.log('✅ Connected to database\n');

  // First discover table names
  const tables = await sequelize.query<any>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    { type: QueryTypes.SELECT }
  );
  const tableNames = tables.map((t: any) => t.tablename);
  console.log('All Database Tables:', tableNames);
  
  // Find the right table names
  const leagueTable = tableNames.find((t: string) => t.toLowerCase() === 'leagues') || 'Leagues';
  const matchTable = tableNames.find((t: string) => t.toLowerCase() === 'matches') || 'Matches';
  const statsTable = tableNames.find((t: string) => t.toLowerCase() === 'match_statistics') || 'match_statistics';
  const usersTable = tableNames.find((t: string) => t.toLowerCase() === 'users') || 'users';
  const votesTable = tableNames.find((t: string) => t.toLowerCase() === 'votes') || 'Votes';

  console.log(`Tables: leagues=${leagueTable}, matches=${matchTable}, stats=${statsTable}, users=${usersTable}, votes=${votesTable}\n`);

  // --- Step 1: Pick a league with completed matches ---
  const leagues = await sequelize.query<any>(
    `SELECT l.id, l.name, COUNT(m.id) as match_count
     FROM "${leagueTable}" l
     JOIN "${matchTable}" m ON m."leagueId" = l.id
     WHERE m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
       AND m.deleted = false
     GROUP BY l.id, l.name
     HAVING COUNT(m.id) >= 3
     ORDER BY COUNT(m.id) DESC
     LIMIT 5`,
    { type: QueryTypes.SELECT }
  );

  if (leagues.length === 0) {
    console.log('No leagues with enough completed matches found.');
    process.exit(0);
  }

  console.log('=== LEAGUES WITH COMPLETED MATCHES ===');
  for (const l of leagues) {
    console.log(`  ${l.name} (${l.id}) - ${l.match_count} matches`);
  }

  // Test each league
  for (const league of leagues) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`LEAGUE: ${league.name} (${league.id})`);
    console.log(`${'='.repeat(70)}`);

    // Get completed match IDs
    const matches = await sequelize.query<any>(
      `SELECT id FROM "${matchTable}"
       WHERE "leagueId" = $1
         AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
         AND deleted = false`,
      { bind: [league.id], type: QueryTypes.SELECT }
    );
    const matchIds = matches.map((m: any) => m.id);
    console.log(`\nCompleted matches: ${matchIds.length}`);

    if (matchIds.length === 0) continue;

    // Check which columns exist on users table
    const userCols = await sequelize.query<any>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      { bind: [usersTable], type: QueryTypes.SELECT }
    );
    const userColNames = userCols.map((c: any) => c.column_name);
    const hasIsGuest = userColNames.includes('isGuest');
    const hasEmail = userColNames.includes('email');

    // Build WHERE clause for non-guest users
    let userFilter = '';
    if (hasIsGuest && hasEmail) {
      userFilter = `AND u."isGuest" IS NOT TRUE AND u.email IS NOT NULL AND u.email != ''`;
    } else if (hasEmail) {
      userFilter = `AND u.email IS NOT NULL AND u.email != ''`;
    }

    // Get all match statistics for these matches (excluding guests)
    const stats = await sequelize.query<any>(
      `SELECT ms.user_id, ms.goals, ms.assists, ms.clean_sheets AS "cleanSheets", ms.defence, ms.impact, ms.match_id
       FROM "${statsTable}" ms
       JOIN "${usersTable}" u ON u.id = ms.user_id
       WHERE ms.match_id = ANY($1)
         ${userFilter}`,
      { bind: [matchIds], type: QueryTypes.SELECT }
    );

    // Get MOTM votes
    const votes = await sequelize.query<any>(
      `SELECT v."votedForId"
       FROM "${votesTable}" v
       WHERE v."matchId" = ANY($1)`,
      { bind: [matchIds], type: QueryTypes.SELECT }
    );

    // Get defensive impact votes from match fields
    const defImpacts = await sequelize.query<any>(
      `SELECT "homeDefensiveImpactId", "awayDefensiveImpactId"
       FROM "${matchTable}"
       WHERE id = ANY($1)`,
      { bind: [matchIds], type: QueryTypes.SELECT }
    );

    // Get player names
    const playerNames: Record<string, string> = {};
    const uniquePlayerIds = [...new Set(stats.map((s: any) => String(s.user_id)))];
    if (uniquePlayerIds.length > 0) {
      const nameResults = await sequelize.query<any>(
        `SELECT id, "firstName", "lastName" FROM "${usersTable}" WHERE id = ANY($1)`,
        { bind: [uniquePlayerIds], type: QueryTypes.SELECT }
      );
      for (const nr of nameResults) {
        playerNames[String(nr.id)] = `${nr.firstName || ''} ${nr.lastName || ''}`.trim() || nr.id;
      }
    }

    // Build per-player data
    const playerMap: Record<string, { goals: number; assists: number; cleanSheets: number; defence: number; impact: number; motmVotes: number; defensiveImpactVotes: number; matches: number }> = {};

    const ensurePlayer = (uid: string) => {
      if (!playerMap[uid]) {
        playerMap[uid] = { goals: 0, assists: 0, cleanSheets: 0, defence: 0, impact: 0, motmVotes: 0, defensiveImpactVotes: 0, matches: 0 };
      }
      return playerMap[uid];
    };

    for (const stat of stats) {
      const uid = String(stat.user_id);
      const p = ensurePlayer(uid);
      p.goals += Number(stat.goals) || 0;
      p.assists += Number(stat.assists) || 0;
      p.cleanSheets += Number(stat.cleanSheets) || 0;
      p.defence += Number(stat.defence) || 0;
      p.impact += Number(stat.impact) || 0;
      p.matches += 1;
    }

    for (const vote of votes) {
      const uid = String(vote.votedForId);
      if (playerMap[uid]) {
        playerMap[uid].motmVotes += 1;
      }
    }

    for (const m of defImpacts) {
      if (m.homeDefensiveImpactId && playerMap[String(m.homeDefensiveImpactId)]) {
        playerMap[String(m.homeDefensiveImpactId)].defensiveImpactVotes += 1;
      }
      if (m.awayDefensiveImpactId && playerMap[String(m.awayDefensiveImpactId)]) {
        playerMap[String(m.awayDefensiveImpactId)].defensiveImpactVotes += 1;
      }
    }

    const playerIds = Object.keys(playerMap);
    const totalPlayers = playerIds.length;

    console.log(`Total registered players with stats: ${totalPlayers}`);

    // --- Show each player's data ---
    console.log(`\n--- PER PLAYER DATA ---`);
    console.log(`${'Player Name'.padEnd(25)} | ${'Matches'.padStart(7)} | ${'Goals'.padStart(6)} | ${'Assists'.padStart(7)} | ${'CS'.padStart(4)} | ${'MOTM'.padStart(5)} | ${'DefImp'.padStart(6)} | ${'Impact'.padStart(7)}`);
    console.log('-'.repeat(85));
    for (const uid of playerIds) {
      const p = playerMap[uid];
      const name = (playerNames[uid] || uid.substring(0, 20)).substring(0, 24);
      const mc = Math.max(p.matches, 1);
      console.log(
        `${name.padEnd(25)} | ${String(p.matches).padStart(7)} | ${String(p.goals).padStart(6)} | ${String(p.assists).padStart(7)} | ${String(p.cleanSheets).padStart(4)} | ${String(p.motmVotes).padStart(5)} | ${String(p.defensiveImpactVotes).padStart(6)} | ${String(p.impact).padStart(7)}`
      );
      console.log(
        `${'  (per-match avg)'.padEnd(25)} |         | ${(p.goals / mc).toFixed(2).padStart(6)} | ${(p.assists / mc).toFixed(2).padStart(7)} | ${(p.cleanSheets / mc).toFixed(2).padStart(4)} | ${(p.motmVotes / mc).toFixed(2).padStart(5)} | ${(p.defensiveImpactVotes / mc).toFixed(2).padStart(6)} | ${(p.impact / mc).toFixed(2).padStart(7)}`
      );
    }

    // --- NEW algorithm (per-match avg per player, then avg across players) ---
    const metricKeys = ['goals', 'assists', 'cleanSheets', 'defence', 'motmVotes', 'defensiveImpactVotes', 'impact'] as const;
    const perMatchAvg: Record<string, number> = {};
    for (const key of metricKeys) {
      const playerAvgs = playerIds.map(uid => {
        const p = playerMap[uid];
        const mc = Math.max(p.matches, 1);
        return (p as any)[key] / mc;
      });
      const sumAvg = playerAvgs.reduce((a, b) => a + b, 0);
      perMatchAvg[key] = totalPlayers > 0 ? +(sumAvg / totalPlayers).toFixed(2) : 0;
    }

    // --- Total average (total stats / player count) ---
    const totalAvg: Record<string, number> = {};
    for (const key of metricKeys) {
      const total = playerIds.reduce((sum, uid) => sum + ((playerMap[uid] as any)[key] || 0), 0);
      totalAvg[key] = totalPlayers > 0 ? +(total / totalPlayers).toFixed(2) : 0;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`LEAGUE AVERAGES - TWO METHODS`);
    console.log(`${'='.repeat(60)}`);
    console.log(`\n${'Metric'.padEnd(25)} | ${'Per-Match Avg'.padStart(14)} | ${'Total/Player'.padStart(14)}`);
    console.log('-'.repeat(60));
    for (const key of metricKeys) {
      console.log(`${key.padEnd(25)} | ${String(perMatchAvg[key]).padStart(14)} | ${String(totalAvg[key]).padStart(14)}`);
    }

    console.log(`\n--- ANALYSIS ---`);
    console.log(`The IMPACT table's 2nd half shows "Your Stats" as RAW TOTALS (e.g. Goals=3, MOTM=1).`);
    console.log(`If "League Average" shows PER-MATCH AVG (e.g. 0.5 goals/match), that's an unfair comparison.`);
    console.log(`The "Total/Player" column shows the average TOTAL per player which is a fair comparison.`);
    console.log(`\nFor the 1st IMPACT table (xG/xA/xCS), "Your Stats" shows PER-MATCH rates,`);
    console.log(`so the "Per-Match Avg" column is the correct league average to compare against.\n`);
    console.log(`SOLUTION: Backend should return BOTH values so the frontend can use the right one.`);
  }

  await sequelize.close();
  console.log('\n✅ Done');
}

main().catch(e => { console.error(e); process.exit(1); });
