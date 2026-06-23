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

    // 1. Get matches
    const matchesRes = await pool.query(`
      SELECT id, "homeTeamGoals", "awayTeamGoals"
      FROM "Matches"
      WHERE "leagueId" = $1 AND archived = false AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
    `, [leagueId]);
    const matchIds = matchesRes.rows.map(m => m.id);

    const matchResultMap = {};
    matchesRes.rows.forEach(m => {
      matchResultMap[m.id] = {
        homeGoals: Number(m.homeTeamGoals) || 0,
        awayGoals: Number(m.awayTeamGoals) || 0,
      };
    });

    // 2. Fetch match statistics
    const statsRes = await pool.query(`
      SELECT user_id, match_id, type, goals, assists, clean_sheets
      FROM match_statistics
      WHERE match_id = ANY($1)
    `, [matchIds]);

    // 3. Fetch home and away lineups
    const homeMatches = await pool.query(`
      SELECT "matchId", "userId" FROM "UserHomeMatches" WHERE "matchId" = ANY($1)
    `, [matchIds]);
    const awayMatches = await pool.query(`
      SELECT "matchId", "userId" FROM "UserAwayMatches" WHERE "matchId" = ANY($1)
    `, [matchIds]);

    const playerTeamMap = {};
    homeMatches.rows.forEach(row => {
      playerTeamMap[`${row.matchId}_${row.userId}`] = 'home';
    });
    awayMatches.rows.forEach(row => {
      playerTeamMap[`${row.matchId}_${row.userId}`] = 'away';
    });

    // Let's filter out guests (assuming we only want active players or all stats rows)
    // In backend: candidateUserIds -> find nonGuests from users table.
    const candidateUserIds = [...new Set(statsRes.rows.map(s => s.user_id))];
    const nonGuestsRes = await pool.query(`
      SELECT id FROM users
      WHERE id = ANY($1) AND email IS NOT NULL AND email NOT ILIKE '%guest%' AND "firstName" NOT ILIKE '%guest%'
    `, [candidateUserIds]);
    const nonGuestUserIds = new Set(nonGuestsRes.rows.map(u => u.id));

    // Calculate player wins and matches
    const playerMap = {};
    statsRes.rows.forEach(stat => {
      const uid = stat.user_id;
      if (!nonGuestUserIds.has(uid)) return;

      if (!playerMap[uid]) {
        playerMap[uid] = {
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          matches: 0,
          wins: 0,
          winsWrong: 0,
        };
      }

      const p = playerMap[uid];
      p.goals += Number(stat.goals) || 0;
      p.assists += Number(stat.assists) || 0;
      p.cleanSheets += Number(stat.clean_sheets) || 0;
      p.matches += 1;

      const mResult = matchResultMap[stat.match_id];
      if (mResult) {
        // Option 1: Wrong logic (fallback only to stat.type which is null)
        const isHomeWrong = stat.type === 'home';
        const teamGoalsWrong = isHomeWrong ? mResult.homeGoals : mResult.awayGoals;
        const oppGoalsWrong = isHomeWrong ? mResult.awayGoals : mResult.homeGoals;
        if (teamGoalsWrong > oppGoalsWrong) {
          p.winsWrong += 1;
        }

        // Option 2: Correct logic (check playerTeamMap first)
        let isHome = stat.type === 'home';
        const teamFromMap = playerTeamMap[`${stat.match_id}_${uid}`];
        if (teamFromMap) {
          isHome = teamFromMap === 'home';
        }
        const teamGoals = isHome ? mResult.homeGoals : mResult.awayGoals;
        const oppGoals = isHome ? mResult.awayGoals : mResult.homeGoals;
        if (teamGoals > oppGoals) {
          p.wins += 1;
        }
      }
    });

    // Print totals
    let totalMatches = 0;
    let totalWinsCorrect = 0;
    let totalWinsWrong = 0;
    let totalGoals = 0;
    let totalAssists = 0;
    let totalCleanSheets = 0;

    Object.values(playerMap).forEach(p => {
      totalMatches += p.matches;
      totalWinsCorrect += p.wins;
      totalWinsWrong += p.winsWrong;
      totalGoals += p.goals;
      totalAssists += p.assists;
      totalCleanSheets += p.cleanSheets;
    });

    console.log(`Totals with WRONG win logic:`);
    console.log(`  Total Player-Matches: ${totalMatches}`);
    console.log(`  Total Wins: ${totalWinsWrong}`);
    console.log(`  Win Rate: ${((totalWinsWrong / totalMatches) * 100).toFixed(1)}%`);

    console.log(`\nTotals with CORRECT win logic:`);
    console.log(`  Total Player-Matches: ${totalMatches}`);
    console.log(`  Total Wins: ${totalWinsCorrect}`);
    console.log(`  Win Rate: ${((totalWinsCorrect / totalMatches) * 100).toFixed(1)}%`);

    console.log(`\nTotals of expected stats:`);
    console.log(`  Goals: ${totalGoals}`);
    console.log(`  Assists: ${totalAssists}`);
    console.log(`  Clean Sheets: ${totalCleanSheets}`);
    console.log(`  Total Matches: ${matchesRes.rows.length}`); // 20

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
main();
