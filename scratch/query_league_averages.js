const { Sequelize } = require('sequelize');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres';
const sequelize = new Sequelize(databaseUrl, { logging: false });

async function main() {
  try {
    const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4'; // Season 7 FNF

    // Let's inspect the matches in this league to see the averages
    const [matches] = await sequelize.query(`
      SELECT COUNT(*) as count FROM "Matches" WHERE "leagueId" = :leagueId
    `, { replacements: { leagueId } });
    console.log('Total matches in league:', matches[0].count);

    // Let's compute average goals, assists per match from match_statistics
    const [averages] = await sequelize.query(`
      SELECT 
        AVG(goals) as avg_goals,
        AVG(assists) as avg_assists,
        AVG(clean_sheets) as avg_clean_sheets
      FROM match_statistics ms
      JOIN "Matches" m ON ms.match_id = m.id
      WHERE m."leagueId" = :leagueId
    `, { replacements: { leagueId } });
    
    console.log('Averages of all rows in match_statistics for this league:');
    console.table(averages);

    // Wait! Let's check if there is an explicit league average table or column in Leagues?
    const [[league]] = await sequelize.query(`
      SELECT * FROM "Leagues" WHERE id = :leagueId
    `, { replacements: { leagueId } });
    console.log('League columns:');
    console.log(Object.keys(league).filter(k => k.includes('avg') || k.includes('Avg') || k.includes('xp') || k.includes('goal')));

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

main();
