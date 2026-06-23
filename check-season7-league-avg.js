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

    // Get all columns of the users table
    const usersCols = await pool.query(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'users';
    `);
    const cols = usersCols.rows.map(c => c.column_name);
    console.log('User columns:', cols);

    const statsRes = await pool.query(`
      SELECT 
        ms.user_id,
        u."firstName",
        u."lastName",
        u.email,
        COUNT(ms.id)::int AS stat_matches,
        SUM(ms.goals)::int AS total_goals,
        SUM(ms.assists)::int AS total_assists,
        SUM(ms.clean_sheets)::int AS total_clean_sheets
      FROM match_statistics ms
      JOIN "Matches" m ON ms.match_id = m.id
      JOIN users u ON ms.user_id = u.id
      WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
      GROUP BY ms.user_id, u."firstName", u."lastName", u.email
    `, [leagueId]);

    // Let's calculate the played matches count for each player by looking at lineups (UserHomeMatches and UserAwayMatches) as well
    const lineupsRes = await pool.query(`
      SELECT 
        u.id AS user_id,
        u."firstName",
        u."lastName",
        u.email,
        COUNT(DISTINCT m.id)::int AS played_matches
      FROM users u
      LEFT JOIN "UserHomeMatches" uhm ON uhm."userId" = u.id
      LEFT JOIN "UserAwayMatches" uam ON uam."userId" = u.id
      JOIN "Matches" m ON (uhm."matchId" = m.id OR uam."matchId" = m.id)
      WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
      GROUP BY u.id, u."firstName", u."lastName", u.email
    `, [leagueId]);

    // Combine them to get actual played matches (lineup + stats) and stats totals
    const playersMap = {};
    
    // Seed from stats
    statsRes.rows.forEach(r => {
      playersMap[r.user_id] = {
        id: r.user_id,
        name: `${r.firstName} ${r.lastName}`,
        email: r.email,
        goals: r.total_goals || 0,
        assists: r.total_assists || 0,
        cleanSheets: r.total_clean_sheets || 0,
        matches: r.stat_matches,
        wins: 0,
        draws: 0,
        losses: 0
      };
    });

    // Add lineup matches if they are higher, or add missing players
    lineupsRes.rows.forEach(r => {
      if (!playersMap[r.user_id]) {
        playersMap[r.user_id] = {
          id: r.user_id,
          name: `${r.firstName} ${r.lastName}`,
          email: r.email,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          matches: r.played_matches,
          wins: 0,
          draws: 0,
          losses: 0
        };
      } else {
        if (r.played_matches > playersMap[r.user_id].matches) {
          playersMap[r.user_id].matches = r.played_matches;
        }
      }
    });

    // Let's resolve wins for each player.
    // To do this, we need to know the outcome of each match they played.
    // Let's query all matches in the league and the players in the lineups
    const allMatchesRes = await pool.query(`
      SELECT 
        m.id AS match_id,
        m."homeTeamGoals",
        m."awayTeamGoals",
        array_agg(uhm."userId") FILTER (WHERE uhm."userId" IS NOT NULL) AS home_users,
        array_agg(uam."userId") FILTER (WHERE uam."userId" IS NOT NULL) AS away_users
      FROM "Matches" m
      LEFT JOIN "UserHomeMatches" uhm ON uhm."matchId" = m.id
      LEFT JOIN "UserAwayMatches" uam ON uam."matchId" = m.id
      WHERE m."leagueId" = $1 AND m.archived = false AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
      GROUP BY m.id, m."homeTeamGoals", m."awayTeamGoals"
    `, [leagueId]);

    allMatchesRes.rows.forEach(m => {
      const homeGoals = m.homeTeamGoals !== null ? Number(m.homeTeamGoals) : 0;
      const awayGoals = m.awayTeamGoals !== null ? Number(m.awayTeamGoals) : 0;
      
      const homeUsers = m.home_users || [];
      const awayUsers = m.away_users || [];

      const uniqueHomeUsers = [...new Set(homeUsers)];
      const uniqueAwayUsers = [...new Set(awayUsers)];

      uniqueHomeUsers.forEach(uid => {
        if (playersMap[uid]) {
          if (homeGoals > awayGoals) playersMap[uid].wins++;
          else if (homeGoals < awayGoals) playersMap[uid].losses++;
          else playersMap[uid].draws++;
        }
      });

      uniqueAwayUsers.forEach(uid => {
        if (playersMap[uid]) {
          if (awayGoals > homeGoals) playersMap[uid].wins++;
          else if (awayGoals < homeGoals) playersMap[uid].losses++;
          else playersMap[uid].draws++;
        }
      });
    });

    // Filter out guest players
    const activePlayers = Object.values(playersMap).filter(p => {
      if (!p.email) return false;
      if (p.email.toLowerCase().includes('guest')) return false;
      if (p.name.toLowerCase().includes('guest')) return false;
      return true;
    });

    console.log('\n--- Active Players Summary (Season 7 FNF) ---');
    console.table(activePlayers);

    // Calculate League Averages:
    let sumMatches = 0;
    let sumGoals = 0;
    let sumAssists = 0;
    let sumCleanSheets = 0;
    let sumWins = 0;

    activePlayers.forEach(p => {
      sumMatches += p.matches;
      sumGoals += p.goals;
      sumAssists += p.assists;
      sumCleanSheets += p.cleanSheets;
      sumWins += p.wins;
    });

    console.log(`\nLeague Totals (excl. guests):`);
    console.log(`  Total Player-Matches: ${sumMatches}`);
    console.log(`  Total Goals: ${sumGoals}`);
    console.log(`  Total Assists: ${sumAssists}`);
    console.log(`  Total Clean Sheets: ${sumCleanSheets}`);
    console.log(`  Total Wins: ${sumWins}`);

    console.log(`\nLeague Averages:`);
    console.log(`  Expected Goals (xG): ${(sumGoals / sumMatches).toFixed(2)} (or ${(sumGoals / sumMatches).toFixed(1)})`);
    console.log(`  Expected Assists (xA): ${(sumAssists / sumMatches).toFixed(2)} (or ${(sumAssists / sumMatches).toFixed(1)})`);
    console.log(`  Expected Clean Sheets (xCS): ${(sumCleanSheets / sumMatches).toFixed(2)} (or ${(sumCleanSheets / sumMatches).toFixed(1)})`);
    console.log(`  Win Rate: ${((sumWins / sumMatches) * 100).toFixed(1)}% (or ${((sumWins / sumMatches) * 100).toFixed(0)}%)`);

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
main();
