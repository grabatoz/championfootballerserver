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

    // 1. Get all matches for Ru Uddin
    const matches = await sequelize.query(
      `SELECT m.id, m.date, m.status, m."leagueId", m."seasonId", m."homeTeamGoals", m."awayTeamGoals",
              l.name as league_name, s.name as season_name,
              ms.goals, ms.assists, ms.clean_sheets, ms.type
       FROM "Matches" m
       JOIN "match_statistics" ms ON ms.match_id = m.id
       JOIN "Leagues" l ON m."leagueId" = l.id
       LEFT JOIN "Seasons" s ON m."seasonId" = s.id
       WHERE ms.user_id = :userId 
         AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );

    // Group matches by league/season combination
    const combinations = {};
    matches.forEach(m => {
      const key = `${m.leagueId || 'null'}_${m.seasonId || 'null'}`;
      if (!combinations[key]) {
        combinations[key] = {
          leagueName: m.league_name,
          seasonName: m.season_name || 'all',
          matches: []
        };
      }
      combinations[key].matches.push(m);
    });

    console.log('--- COMBINATION STATS ---');
    Object.values(combinations).forEach(c => {
      let wins = 0;
      let goals = 0;
      let assists = 0;
      let cleanSheets = 0;
      c.matches.forEach(m => {
        goals += (m.goals || 0);
        assists += (m.assists || 0);
        cleanSheets += (m.clean_sheets || 0);
        
        const isHome = m.type === 'home';
        const teamGoals = isHome ? m.homeTeamGoals : m.awayTeamGoals;
        const oppGoals = isHome ? m.awayTeamGoals : m.homeTeamGoals;
        if (teamGoals > oppGoals) {
          wins++;
        }
      });
      const n = c.matches.length;
      const winRate = n > 0 ? (wins / n * 100).toFixed(0) : 0;
      const xG = n > 0 ? (goals / n).toFixed(1) : 0;
      const xA = n > 0 ? (assists / n).toFixed(1) : 0;
      
      console.log(`League: ${c.leagueName} | Season: ${c.seasonName}`);
      console.log(`  Matches (n): ${n}, Wins: ${wins}, WinRate: ${winRate}%, Goals: ${goals}, Assists: ${assists}`);
      console.log(`  xG: ${xG}, xA: ${xA}, xCS: 0`);
    });

  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

main();
