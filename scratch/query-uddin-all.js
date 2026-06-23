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

    const rows = await sequelize.query(
      `SELECT ms.goals, ms.assists, ms.clean_sheets, ms.match_id, m.date, m.status, l.name as league_name
       FROM "match_statistics" ms
       JOIN "Matches" m ON ms.match_id = m.id
       JOIN "Leagues" l ON m."leagueId" = l.id
       WHERE ms.user_id = :userId 
         AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
       ORDER BY m.date DESC`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );

    console.log(`Ru Uddin's matches across ALL leagues (Count: ${rows.length}):`);
    rows.forEach(r => {
      console.log(`- League: ${r.league_name}, Date: ${r.date.toISOString().slice(0,10)}, Goals: ${r.goals}, Assists: ${r.assists}`);
    });
  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

main();
