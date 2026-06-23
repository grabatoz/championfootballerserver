require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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

    // 1. Get all matches in this league
    const matchesRes = await pool.query(`
      SELECT id, "homeTeamGoals", "awayTeamGoals", date
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

    // 2. Fetch home and away lineups
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

    // 3. Fetch match statistics
    const statsRes = await pool.query(`
      SELECT user_id, match_id, type, goals, assists, clean_sheets
      FROM match_statistics
      WHERE match_id = ANY($1)
    `, [matchIds]);

    // 4. Get player names
    const candidateUserIds = [...new Set(statsRes.rows.map(s => s.user_id))];
    const usersRes = await pool.query(`
      SELECT id, "firstName", "lastName", email FROM users
      WHERE id = ANY($1) AND email IS NOT NULL AND email NOT ILIKE '%guest%' AND "firstName" NOT ILIKE '%guest%'
    `, [candidateUserIds]);
    
    const userMap = {};
    usersRes.rows.forEach(u => {
      userMap[u.id] = {
        name: `${u.firstName} ${u.lastName}`,
        email: u.email
      };
    });

    // Calculate players stats
    const playersData = {};
    statsRes.rows.forEach(stat => {
      const uid = stat.user_id;
      if (!userMap[uid]) return; // Exclude guests

      if (!playersData[uid]) {
        playersData[uid] = {
          name: userMap[uid].name,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          playedMatches: 0,
          wins: 0,
          draws: 0,
          losses: 0
        };
      }

      const p = playersData[uid];
      p.playedMatches += 1;
      p.goals += Number(stat.goals) || 0;
      p.assists += Number(stat.assists) || 0;
      p.cleanSheets += Number(stat.clean_sheets) || 0;

      const mResult = matchResultMap[stat.match_id];
      if (mResult) {
        let isHome = stat.type === 'home';
        const teamFromMap = playerTeamMap[`${stat.match_id}_${uid}`];
        if (teamFromMap) {
          isHome = teamFromMap === 'home';
        }
        const teamGoals = isHome ? mResult.homeGoals : mResult.awayGoals;
        const oppGoals = isHome ? mResult.awayGoals : mResult.homeGoals;
        if (teamGoals > oppGoals) {
          p.wins += 1;
        } else if (teamGoals < oppGoals) {
          p.losses += 1;
        } else {
          p.draws += 1;
        }
      }
    });

    const rows = Object.values(playersData).sort((a, b) => b.goals - a.goals || b.assists - a.assists);

    // Write to a markdown table file in the artifacts directory
    let md = `# Season 7 FNF Player Calculations Sheet\n\n`;
    md += `Use this sheet to verify the calculations for player stats and league averages under Season 7 FNF.\n\n`;
    md += `## Individual Player Stats\n`;
    md += `Calculations for **Your Stats** columns (filtering out matches the player didn't play):\n\n`;
    md += `| Player | Played (N) | Goals (G) | Assists (A) | Clean Sheets (CS) | Wins (W) | Draws (D) | Losses (L) | xG (G/N) | xA (A/N) | xCS (CS/N) | Win Rate (W/N) |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |\n`;

    rows.forEach(p => {
      const xG = (p.goals / p.playedMatches).toFixed(1);
      const xA = (p.assists / p.playedMatches).toFixed(1);
      const xCS = (p.cleanSheets / p.playedMatches).toFixed(1);
      const winRate = ((p.wins / p.playedMatches) * 100).toFixed(0) + '%';
      
      md += `| **${p.name}** | ${p.playedMatches} | ${p.goals} | ${p.assists} | ${p.cleanSheets} | ${p.wins} | ${p.draws} | ${p.losses} | **${xG}** | **${xA}** | **${xCS}** | **${winRate}** |\n`;
    });

    md += `\n## League Totals and Averages\n`;
    md += `Calculations for **League Average** columns (based on sum of player totals divided by sum of player matches):\n\n`;

    let sumMatches = 0;
    let sumGoals = 0;
    let sumAssists = 0;
    let sumCleanSheets = 0;
    let sumWins = 0;

    rows.forEach(p => {
      sumMatches += p.playedMatches;
      sumGoals += p.goals;
      sumAssists += p.assists;
      sumCleanSheets += p.cleanSheets;
      sumWins += p.wins;
    });

    md += `* **Total Player-Matches:** ${sumMatches}\n`;
    md += `* **Total League Goals:** ${sumGoals}\n`;
    md += `* **Total League Assists:** ${sumAssists}\n`;
    md += `* **Total League Clean Sheets:** ${sumCleanSheets}\n`;
    md += `* **Total League Wins:** ${sumWins}\n\n`;

    md += `| Metric | Total | Divisor (Player-Matches) | Calculated Average | Rounded Display |\n`;
    md += `| :--- | :---: | :---: | :---: | :---: |\n`;
    md += `| **Expected Goals (xG)** | ${sumGoals} | ${sumMatches} | ${(sumGoals / sumMatches).toFixed(3)} | **${(sumGoals / sumMatches).toFixed(1)}** |\n`;
    md += `| **Expected Assists (xA)** | ${sumAssists} | ${sumMatches} | ${(sumAssists / sumMatches).toFixed(3)} | **${(sumAssists / sumMatches).toFixed(1)}** |\n`;
    md += `| **Expected Clean Sheets (xCS)** | ${sumCleanSheets} | ${sumMatches} | ${(sumCleanSheets / sumMatches).toFixed(3)} | **${(sumCleanSheets / sumMatches).toFixed(1)}** |\n`;
    md += `| **Win Rate** | ${sumWins} | ${sumMatches} | ${((sumWins / sumMatches) * 100).toFixed(2)}% | **${((sumWins / sumMatches) * 100).toFixed(0)}%** |\n`;

    const artDir = 'C:\\Users\\tech solutionor\\.gemini\\antigravity-ide\brain\\0353d65c-ba72-4b44-8e09-942890bed694';
    // Ensure absolute path using forward slashes or raw windows paths
    const targetPath = path.join('C:\\Users\\tech solutionor\\.gemini\\antigravity-ide\\brain\\0353d65c-ba72-4b44-8e09-942890bed694', 'season7_verification_sheet.md');
    fs.writeFileSync(targetPath, md, 'utf8');
    console.log(`Successfully generated verification sheet at ${targetPath}`);

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
main();
