const { Sequelize, QueryTypes } = require('sequelize');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  logging: false
});

async function main() {
  try {
    await sequelize.authenticate();
    const userId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'; // Ru Uddin
    const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4'; // Season 7 FNF

    // 1. Query played match IDs (either from lineup or stats) just like getPlayerProfile does:
    const [homeMatches, awayMatches, statRows] = await Promise.all([
      sequelize.query(
        `SELECT "matchId" FROM "UserHomeMatches" WHERE "userId" = :userId`,
        { replacements: { userId }, type: QueryTypes.SELECT }
      ),
      sequelize.query(
        `SELECT "matchId" FROM "UserAwayMatches" WHERE "userId" = :userId`,
        { replacements: { userId }, type: QueryTypes.SELECT }
      ),
      sequelize.query(
        `SELECT id, match_id, goals, assists, clean_sheets, type, impact FROM match_statistics WHERE user_id = :userId`,
        { replacements: { userId }, type: QueryTypes.SELECT }
      )
    ]);

    const userHomeMatchIds = new Set(homeMatches.map(row => String(row.matchId)));
    const userAwayMatchIds = new Set(awayMatches.map(row => String(row.matchId)));
    const uniqueMatchIdsFromStats = new Set(statRows.map(row => String(row.match_id)));

    const uniqueMatchIds = Array.from(new Set([
      ...userHomeMatchIds,
      ...userAwayMatchIds,
      ...uniqueMatchIdsFromStats
    ])).filter(Boolean);

    // 2. Fetch matches in Season 7 FNF among those uniqueMatchIds
    const matches = await sequelize.query(
      `SELECT id, date, status, "homeTeamGoals", "awayTeamGoals"
       FROM "Matches"
       WHERE id IN (:uniqueMatchIds)
         AND "leagueId" = :leagueId
         AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
         AND archived = false
       ORDER BY date ASC`,
      { replacements: { uniqueMatchIds, leagueId }, type: QueryTypes.SELECT }
    );

    console.log(`Profile API returned ${matches.length} matches for Ru Uddin.`);

    // 3. Build matches array with playerStats (containing id if it exists)
    const statsByMatchId = {};
    statRows.forEach(row => {
      statsByMatchId[String(row.match_id)] = row;
    });

    const matchesPayload = matches.map(match => {
      const stat = statsByMatchId[String(match.id)];
      const isHomePlayer = userHomeMatchIds.has(String(match.id));
      const isAwayPlayer = userAwayMatchIds.has(String(match.id));
      const playerTeam = isHomePlayer ? 'home' : (isAwayPlayer ? 'away' : null);
      
      const homeGoals = match.homeTeamGoals !== null ? Number(match.homeTeamGoals) : 0;
      const awayGoals = match.awayTeamGoals !== null ? Number(match.awayTeamGoals) : 0;
      const teamGoals = isHomePlayer ? homeGoals : awayGoals;
      const oppGoals = isHomePlayer ? awayGoals : homeGoals;
      const result = teamGoals === oppGoals ? 'D' : (teamGoals > oppGoals ? 'W' : 'L');

      return {
        id: match.id,
        date: match.date,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        playerStats: {
          id: stat ? stat.id : undefined, // NEW: stat id exposed!
          goals: stat ? stat.goals : 0,
          assists: stat ? stat.assists : 0,
          cleanSheets: stat ? stat.clean_sheets : 0,
          type: playerTeam,
          result: result
        }
      };
    });

    // 4. Calculate with OLD frontend logic: const arr = matchesPayload.filter(m => !!m.playerStats) (which counts all 15 matches)
    const oldArr = matchesPayload.filter(m => !!m.playerStats);
    const oldN = oldArr.length;
    let oldWins = 0;
    oldArr.forEach(m => {
      if (m.playerStats.result === 'W') oldWins++;
    });
    const oldGoals = oldArr.reduce((s, m) => s + (m.playerStats.goals || 0), 0);
    const oldAssists = oldArr.reduce((s, m) => s + (m.playerStats.assists || 0), 0);

    console.log('\n=== OLD CLIENT CALCULATION (WITHOUT STAT ID FILTER) ===');
    console.log(`Matches played (n): ${oldN}`);
    console.log(`Win rate: ${((oldWins / oldN) * 100).toFixed(0)}%`);
    console.log(`Expected to score (xG): ${(oldGoals / oldN).toFixed(1)}`);
    console.log(`Expected to assist (xA): ${(oldAssists / oldN).toFixed(1)}`);

    // 5. Calculate with NEW frontend logic: const arr = matchesPayload.filter(m => !!m.playerStats && !!m.playerStats.id)
    const newArr = matchesPayload.filter(m => !!m.playerStats && !!m.playerStats.id);
    const newN = newArr.length;
    let newWins = 0;
    newArr.forEach(m => {
      if (m.playerStats.result === 'W') newWins++;
    });
    const newGoals = newArr.reduce((s, m) => s + (m.playerStats.goals || 0), 0);
    const newAssists = newArr.reduce((s, m) => s + (m.playerStats.assists || 0), 0);

    console.log('\n=== NEW CLIENT CALCULATION (WITH STAT ID FILTER) ===');
    console.log(`Matches played (n): ${newN}`);
    console.log(`Win rate: ${((newWins / newN) * 100).toFixed(0)}%`);
    console.log(`Expected to score (xG): ${(newGoals / newN).toFixed(1)}`);
    console.log(`Expected to assist (xA): ${(newAssists / newN).toFixed(1)}`);

  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

main();
