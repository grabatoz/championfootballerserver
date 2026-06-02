const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL;
console.log('Connecting to:', DATABASE_URL ? DATABASE_URL.replace(/:[^:@]+@/, ':***@') : 'undefined');

if (!DATABASE_URL) {
  process.exit(1);
}

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: { ssl: { require: true, rejectUnauthorized: false } }
});

async function main() {
  try {
    await sequelize.authenticate();
    console.log('DB Connected!');
    
    // Find the league named "Season 3 Sun-Fairlop"
    const leagues = await sequelize.query(
      'SELECT id, name FROM "Leagues" WHERE name ILIKE \'%Season 3 Sun-Fairlop%\'', 
      { type: Sequelize.QueryTypes.SELECT }
    );
    console.log('\n--- Leagues matching "Season 3 Sun-Fairlop" ---');
    console.log(leagues);

    if (leagues.length === 0) {
      console.log('No league found!');
      return;
    }

    const leagueId = leagues[0].id;
    console.log(`\nLeague ID is: ${leagueId}`);

    // Query matches in this league
    const matches = await sequelize.query(
      'SELECT id, date, status FROM "Matches" WHERE "leagueId" = :leagueId',
      { replacements: { leagueId }, type: Sequelize.QueryTypes.SELECT }
    );
    console.log(`\nFound ${matches.length} matches in this league:`);
    console.log(matches.slice(0, 5));

    // Query match statistics for these matches
    const statsCount = await sequelize.query(
      'SELECT COUNT(*), SUM(goals) as total_goals, SUM(assists) as total_assists FROM "match_statistics" ms JOIN "Matches" m ON ms.match_id = m.id WHERE m."leagueId" = :leagueId',
      { replacements: { leagueId }, type: Sequelize.QueryTypes.SELECT }
    );
    console.log('\n--- Match Statistics in this league (snake_case table) ---');
    console.log(statsCount);

    const statsCountPascal = await sequelize.query(
      'SELECT COUNT(*), SUM(goals) as total_goals, SUM(assists) as total_assists FROM "MatchStatistics" ms JOIN "Matches" m ON ms.match_id = m.id WHERE m."leagueId" = :leagueId',
      { replacements: { leagueId }, type: Sequelize.QueryTypes.SELECT }
    ).catch(e => e.message);
    console.log('\n--- Match Statistics in this league (PascalCase table) ---');
    console.log(statsCountPascal);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

main();
