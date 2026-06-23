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
    const userRes = await pool.query(`
      SELECT id, "firstName", "lastName" FROM users 
      WHERE "firstName" ILIKE '%Ru%' OR "lastName" ILIKE '%Uddin%' OR "firstName" ILIKE '%Uddin%'
    `);
    
    for (const user of userRes.rows) {
      const ruUddinId = user.id;
      const name = `${user.firstName} ${user.lastName}`;
      
      const matchesRes = await pool.query(`
        SELECT 
          m.id AS match_id,
          m.date,
          m.status,
          m."homeTeamName",
          m."awayTeamName",
          m."homeTeamGoals",
          m."awayTeamGoals",
          m."seasonId",
          s.name AS season_name,
          s."seasonNumber" AS season_num,
          ms.goals,
          ms.assists,
          ms.clean_sheets AS "cleanSheets",
          ms.impact,
          ms.defence,
          uhm."userId" AS home_user,
          uam."userId" AS away_user
        FROM "Matches" m
        LEFT JOIN "Seasons" s ON m."seasonId" = s.id
        LEFT JOIN match_statistics ms ON ms.match_id = m.id AND ms.user_id = $1
        LEFT JOIN "UserHomeMatches" uhm ON uhm."matchId" = m.id AND uhm."userId" = $1
        LEFT JOIN "UserAwayMatches" uam ON uam."matchId" = m.id AND uam."userId" = $1
        WHERE (ms.id IS NOT NULL OR uhm."userId" IS NOT NULL OR uam."userId" IS NOT NULL)
          AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED')
          AND m.archived = false
        ORDER BY m.date ASC
      `, [ruUddinId]);

      if (matchesRes.rows.length === 0) {
        continue;
      }

      console.log(`\n======================================================`);
      console.log(`Matches for Player: ${name} (ID: ${ruUddinId})`);
      console.log(`======================================================`);
      console.log(`Found ${matchesRes.rows.length} matches.`);

      // Group matches by season
      const seasonsMap = {};
      matchesRes.rows.forEach(m => {
        const sId = m.seasonId || 'no-season';
        const sName = m.season_name || 'No Season';
        if (!seasonsMap[sId]) {
          seasonsMap[sId] = {
            id: sId,
            name: sName,
            num: m.season_num,
            matches: []
          };
        }
        seasonsMap[sId].matches.push(m);
      });

      for (const sId in seasonsMap) {
        const season = seasonsMap[sId];
        console.log(`\n-----------------------------------------`);
        console.log(`Season: ${season.name} (Num: ${season.num}, ID: ${season.id})`);
        console.log(`-----------------------------------------`);
        
        let totalGoals = 0;
        let totalAssists = 0;
        let totalCleanSheets = 0;
        let wins = 0;
        let draws = 0;
        let losses = 0;
        let playedCount = 0;

        const tableData = season.matches.map(m => {
          const isHome = m.home_user !== null;
          const isAway = m.away_user !== null;
          
          let played = isHome || isAway;
          
          // If not in home/away list but has stats, count as played
          if (m.goals !== null || m.assists !== null) played = true;

          if (played) playedCount++;

          const homeGoals = m.homeTeamGoals !== null ? Number(m.homeTeamGoals) : 0;
          const awayGoals = m.awayTeamGoals !== null ? Number(m.awayTeamGoals) : 0;
          const teamGoals = isHome ? homeGoals : (isAway ? awayGoals : null);
          const oppGoals = isHome ? awayGoals : (isAway ? homeGoals : null);

          let result = null;
          if (teamGoals !== null && oppGoals !== null) {
            if (teamGoals > oppGoals) {
              result = 'W';
              wins++;
            } else if (teamGoals < oppGoals) {
              result = 'L';
              losses++;
            } else {
              result = 'D';
              draws++;
            }
          }

          totalGoals += Number(m.goals || 0);
          totalAssists += Number(m.assists || 0);
          totalCleanSheets += Number(m.cleanSheets || 0);

          return {
            match_id: m.match_id.substring(0, 8),
            date: new Date(m.date).toLocaleDateString(),
            team: isHome ? 'Home' : (isAway ? 'Away' : 'Unknown'),
            score: `${m.homeTeamGoals} - ${m.awayTeamGoals}`,
            goals: m.goals,
            assists: m.assists,
            cleanSheets: m.cleanSheets,
            result: result || 'N/A'
          };
        });

        console.table(tableData.slice(0, 15)); // print first 15 matches of the season
        if (tableData.length > 15) {
          console.log(`... and ${tableData.length - 15} more matches`);
        }
        console.log(`Summary for ${season.name}:`);
        console.log(`  Played Matches: ${playedCount}`);
        console.log(`  Total Goals: ${totalGoals}`);
        console.log(`  Total Assists: ${totalAssists}`);
        console.log(`  Total Clean Sheets: ${totalCleanSheets}`);
        console.log(`  Wins: ${wins}, Draws: ${draws}, Losses: ${losses}`);
        const wr = playedCount ? ((wins / playedCount) * 100).toFixed(1) : 0;
        console.log(`  Calculated Stats Per Match:`);
        console.log(`    xG (Goals/Played): ${(totalGoals / playedCount).toFixed(2)}`);
        console.log(`    xA (Assists/Played): ${(totalAssists / playedCount).toFixed(2)}`);
        console.log(`    xCS (Clean Sheets/Played): ${(totalCleanSheets / playedCount).toFixed(2)}`);
        console.log(`    Win Rate: ${wr}%`);

        // Fetch total matches in this season:
        const totalSeasonMatchesRes = await pool.query(`
          SELECT COUNT(*)::int AS count FROM "Matches" 
          WHERE "seasonId" = $1 AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED', 'REVISION_REQUESTED') AND archived = false
        `, [season.id]);
        const totalSeasonMatches = totalSeasonMatchesRes.rows[0].count;
        console.log(`  Total Season Matches: ${totalSeasonMatches}`);
        console.log(`  Stats Divided by Season Matches (${totalSeasonMatches}):`);
        console.log(`    xG (Goals/SeasonMatches): ${(totalGoals / totalSeasonMatches).toFixed(2)}`);
        console.log(`    xA (Assists/SeasonMatches): ${(totalAssists / totalSeasonMatches).toFixed(2)}`);
        console.log(`    xCS (Clean Sheets/SeasonMatches): ${(totalCleanSheets / totalSeasonMatches).toFixed(2)}`);
        console.log(`    Win Rate: ${((wins / totalSeasonMatches) * 100).toFixed(1)}%`);
      }
    }

    await pool.end();
  } catch (error) {
    console.error('Error running script:', error);
    if (pool) await pool.end();
  }
}

main();
