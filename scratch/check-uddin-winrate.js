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

    const matches = await sequelize.query(
      `SELECT m.id, m.date, m.status, m."homeTeamGoals", m."awayTeamGoals",
              ms.goals, ms.assists, ms.clean_sheets, ms.type
       FROM "Matches" m
       JOIN "match_statistics" ms ON ms.match_id = m.id
       WHERE ms.user_id = :userId 
         AND m."leagueId" = :leagueId
         AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
       ORDER BY m.date ASC`,
      { replacements: { userId, leagueId }, type: QueryTypes.SELECT }
    );

    console.log(`Ru Uddin Season 7 matches (${matches.length}):`);
    let wins = 0;
    let draws = 0;
    let losses = 0;

    matches.forEach((m, idx) => {
      const isHome = m.type === 'home';
      const teamGoals = isHome ? m.homeTeamGoals : m.awayTeamGoals;
      const oppGoals = isHome ? m.awayTeamGoals : m.homeTeamGoals;
      let result = 'D';
      if (teamGoals > oppGoals) {
        result = 'W';
        wins++;
      } else if (teamGoals < oppGoals) {
        result = 'L';
        losses++;
      } else {
        draws++;
      }
      console.log(`[${idx+1}] Date: ${m.date.toISOString().slice(0,10)}, Type: ${m.type}, Score: ${m.homeTeamGoals}-${m.awayTeamGoals}, Result: ${result}, G: ${m.goals}, A: ${m.assists}`);
    });

    const total = matches.length;
    console.log(`\nWins: ${wins}, Draws: ${draws}, Losses: ${losses}`);
    console.log(`Win Rate: ${total > 0 ? (wins / total * 100).toFixed(1) : 0}%`);

  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

main();
