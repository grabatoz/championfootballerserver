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
      `SELECT ms.goals, ms.assists, ms.clean_sheets, ms.match_id, m.date, m.status
       FROM "match_statistics" ms
       JOIN "Matches" m ON ms.match_id = m.id
       WHERE ms.user_id = :userId 
         AND m."leagueId" = '560f68b4-86f9-49be-b60f-f5391f7b26e4'
         AND m.status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED')
       ORDER BY m.date DESC`,
      { replacements: { userId }, type: QueryTypes.SELECT }
    );

    console.log(`Ru Uddin's matches in Season 7 FNF (Count: ${rows.length}):`);
    console.log(rows);

    const totalGoals = rows.reduce((s, r) => s + (r.goals || 0), 0);
    const totalAssists = rows.reduce((s, r) => s + (r.assists || 0), 0);
    console.log(`Totals -> Goals: ${totalGoals}, Assists: ${totalAssists}`);
  } catch (err) {
    console.error(err);
  } finally {
    await sequelize.close();
  }
}

main();
