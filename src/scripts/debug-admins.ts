import sequelize from '../config/database';
import { QueryTypes } from 'sequelize';

async function run() {
  try {
    // 1. Get all matches
    const matches: any[] = await sequelize.query(`
      SELECT id, "homeTeamGoals", "awayTeamGoals", "leagueId" FROM "Matches"
      WHERE status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
    `, { type: QueryTypes.SELECT });
    console.log(`Total completed matches in DB: ${matches.length}`);

    const matchMap = new Map(matches.map(m => [String(m.id), m]));
    const matchIds = matches.map(m => String(m.id));

    if (matchIds.length === 0) {
      console.log("No matches found.");
      process.exit(0);
    }

    // 2. Get all lineup entries
    const homeLineups: any[] = await sequelize.query(`
      SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" IN (:matchIds)
    `, { replacements: { matchIds }, type: QueryTypes.SELECT });

    const awayLineups: any[] = await sequelize.query(`
      SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" IN (:matchIds)
    `, { replacements: { matchIds }, type: QueryTypes.SELECT });

    const allLineups: any[] = [];
    homeLineups.forEach((l: any) => allLineups.push({ matchId: String(l.matchId), userId: String(l.userId), team: 'home' }));
    awayLineups.forEach((l: any) => allLineups.push({ matchId: String(l.matchId), userId: String(l.userId), team: 'away' }));

    console.log(`Total lineup entries in DB: ${allLineups.length}`);

    // 3. Get all match statistics
    const stats: any[] = await sequelize.query(`
      SELECT match_id, user_id FROM match_statistics WHERE match_id IN (:matchIds)
    `, { replacements: { matchIds }, type: QueryTypes.SELECT });

    const statsSet = new Set(stats.map((s: any) => `${s.match_id}_${s.user_id}`));
    console.log(`Total stats entries in DB: ${stats.length}`);

    let missingCount = 0;
    const missingByLeague: Record<string, number> = {};

    for (const line of allLineups) {
      const key = `${line.matchId}_${line.userId}`;
      if (!statsSet.has(key)) {
        missingCount++;
        const matchObj = matchMap.get(line.matchId);
        if (matchObj) {
          const lId = String(matchObj.leagueId);
          missingByLeague[lId] = (missingByLeague[lId] || 0) + 1;
        }
      }
    }

    console.log(`Total lineup entries missing match_statistics in entire DB: ${missingCount}`);
    
    // Print league names for missing stats
    for (const [lId, count] of Object.entries(missingByLeague)) {
      const league: any[] = await sequelize.query(`
        SELECT name FROM "Leagues" WHERE id = :lId
      `, { replacements: { lId }, type: QueryTypes.SELECT });
      const name = league.length > 0 ? league[0].name : 'Unknown';
      console.log(`- League "${name}" (${lId}): ${count} missing stats`);
    }

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
run();
