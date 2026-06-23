require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'salman1209',
  password: process.env.DB_PASSWORD || 'Malik,g12',
});

async function main() {
  try {
    const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4'; // Season 7 FNF League
    const ruId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe'; // Ru Uddin

    // 1. Get league name
    const leagueRes = await pool.query('SELECT name FROM "Leagues" WHERE id = $1', [leagueId]);
    console.log(`League: ${leagueRes.rows[0]?.name} (${leagueId})`);

    // 2. Fetch all matches in this league
    const matchesRes = await pool.query(`
      SELECT id, "homeTeamName", "awayTeamName", "homeTeamGoals", "awayTeamGoals", status, date, "seasonId"
      FROM "Matches"
      WHERE "leagueId" = $1 AND archived = false
      ORDER BY date ASC
    `, [leagueId]);
    console.log(`\nTotal matches in Season 7 FNF: ${matchesRes.rows.length}`);
    
    // Count matches by status
    const statusCounts = {};
    matchesRes.rows.forEach(m => {
      statusCounts[m.status] = (statusCounts[m.status] || 0) + 1;
    });
    console.log('Match status counts:', statusCounts);

    // 3. Fetch Ru Uddin's matches in this league
    const ruMatchesRes = await pool.query(`
      SELECT 
        m.id AS match_id,
        m.date,
        m.status,
        m."homeTeamName",
        m."awayTeamName",
        m."homeTeamGoals",
        m."awayTeamGoals",
        ms.goals,
        ms.assists,
        ms.clean_sheets,
        ms.impact,
        ms.defence,
        uhm."userId" AS home_user,
        uam."userId" AS away_user
      FROM "Matches" m
      LEFT JOIN match_statistics ms ON ms.match_id = m.id AND ms.user_id = $1
      LEFT JOIN "UserHomeMatches" uhm ON uhm."matchId" = m.id AND uhm."userId" = $1
      LEFT JOIN "UserAwayMatches" uam ON uam."matchId" = m.id AND uam."userId" = $1
      WHERE m."leagueId" = $2
        AND m.archived = false
      ORDER BY m.date ASC
    `, [ruId, leagueId]);

    console.log(`\nRu Uddin's matches in Season 7 FNF (total row count from LEFT joins): ${ruMatchesRes.rows.length}`);

    const playedMatches = [];
    ruMatchesRes.rows.forEach(m => {
      // A match is played if the user is in UserHomeMatches, UserAwayMatches, or has statistics
      const isHome = m.home_user !== null;
      const isAway = m.away_user !== null;
      const hasStats = m.goals !== null || m.assists !== null || m.clean_sheets !== null || m.impact > 0;
      if (isHome || isAway || hasStats) {
        playedMatches.push(m);
      }
    });

    console.log(`Played matches (in home/away lineup or has stats): ${playedMatches.length}`);

    // Print all played matches with details
    console.table(playedMatches.map(m => {
      const isHome = m.home_user !== null;
      const isAway = m.away_user !== null;
      const homeGoals = m.homeTeamGoals !== null ? Number(m.homeTeamGoals) : 0;
      const awayGoals = m.awayTeamGoals !== null ? Number(m.awayTeamGoals) : 0;
      const teamGoals = isHome ? homeGoals : (isAway ? awayGoals : 0);
      const oppGoals = isHome ? awayGoals : (isAway ? homeGoals : 0);
      let result = 'D';
      if (teamGoals > oppGoals) result = 'W';
      else if (teamGoals < oppGoals) result = 'L';

      return {
        id: m.match_id.substring(0, 8),
        date: new Date(m.date).toLocaleDateString(),
        matchup: `${m.homeTeamName} vs ${m.awayTeamName}`,
        score: `${m.homeTeamGoals} - ${m.awayTeamGoals}`,
        status: m.status,
        role: isHome ? 'Home' : (isAway ? 'Away' : 'Unknown'),
        goals: m.goals,
        assists: m.assists,
        clean_sheets: m.clean_sheets,
        impact: m.impact,
        result
      };
    }));

    // Calculate Ru Uddin's totals
    let totalGoals = 0;
    let totalAssists = 0;
    let totalCleanSheets = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let playedCompleted = 0;

    playedMatches.forEach(m => {
      if (m.status !== 'RESULT_PUBLISHED' && m.status !== 'RESULT_UPLOADED' && m.status !== 'REVISION_REQUESTED') {
        return;
      }
      playedCompleted++;
      totalGoals += Number(m.goals || 0);
      totalAssists += Number(m.assists || 0);
      totalCleanSheets += Number(m.clean_sheets || 0);

      const isHome = m.home_user !== null;
      const isAway = m.away_user !== null;
      const homeGoals = m.homeTeamGoals !== null ? Number(m.homeTeamGoals) : 0;
      const awayGoals = m.awayTeamGoals !== null ? Number(m.awayTeamGoals) : 0;
      const teamGoals = isHome ? homeGoals : (isAway ? awayGoals : 0);
      const oppGoals = isHome ? awayGoals : (isAway ? homeGoals : 0);

      if (teamGoals > oppGoals) wins++;
      else if (teamGoals < oppGoals) losses++;
      else draws++;
    });

    console.log(`\nRu Uddin's stats (for completed matches: RESULT_PUBLISHED, RESULT_UPLOADED, REVISION_REQUESTED):`);
    console.log(`  Completed Matches Played: ${playedCompleted}`);
    console.log(`  Goals: ${totalGoals}`);
    console.log(`  Assists: ${totalAssists}`);
    console.log(`  Clean Sheets: ${totalCleanSheets}`);
    console.log(`  Wins: ${wins}, Draws: ${draws}, Losses: ${losses}`);

    // Divisor is playedCompleted matches
    console.log(`\n  --- OPTION A: Divisor = Player's Played Matches (${playedCompleted}) ---`);
    console.log(`  Expected Goals (xG): ${(totalGoals / playedCompleted).toFixed(1)}`);
    console.log(`  Expected Assists (xA): ${(totalAssists / playedCompleted).toFixed(1)}`);
    console.log(`  Expected Clean Sheets (xCS): ${(totalCleanSheets / playedCompleted).toFixed(1)}`);
    console.log(`  Win Rate: ${((wins / playedCompleted) * 100).toFixed(0)}%`);

    // Let's see what happens if we divide by another number like 15
    console.log(`\n  --- OPTION B: Divisor = 15 matches ---`);
    console.log(`  Expected Goals (xG): ${(totalGoals / 15).toFixed(1)}`);
    console.log(`  Expected Assists (xA): ${(totalAssists / 15).toFixed(1)}`);
    console.log(`  Expected Clean Sheets (xCS): ${(totalCleanSheets / 15).toFixed(1)}`);
    console.log(`  Win Rate: ${((wins / 15) * 100).toFixed(0)}%`);

    // Fetch total completed matches in the entire Season 7 FNF league
    const leagueCompletedMatches = await pool.query(`
      SELECT COUNT(*)::int AS count FROM "Matches"
      WHERE "leagueId" = $1 AND archived = false AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
    `, [leagueId]);
    const leagueCompletedCount = leagueCompletedMatches.rows[0].count;
    console.log(`\nTotal completed matches in the Season 7 FNF league: ${leagueCompletedCount}`);

    await pool.end();
  } catch (err) {
    console.error(err);
    await pool.end();
  }
}
main();
