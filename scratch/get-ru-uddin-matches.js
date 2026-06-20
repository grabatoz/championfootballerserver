const { Sequelize } = require('sequelize');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL || 'postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres';
const sequelize = new Sequelize(databaseUrl, { logging: false });

async function main() {
  try {
    const userId = 'a60adc4b-9054-453f-bc5b-af02e06fb4fe';
    const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4'; // Season 7 FNF

    // Query matches where this user is in UserHomeMatches or UserAwayMatches for this league
    const [homeMatches] = await sequelize.query(`
      SELECT m.id, m.date, m."seasonId"
      FROM "UserHomeMatches" uhm
      JOIN "Matches" m ON uhm."matchId" = m.id
      WHERE uhm."userId" = :userId AND m."leagueId" = :leagueId
    `, {
      replacements: { userId, leagueId }
    });

    const [awayMatches] = await sequelize.query(`
      SELECT m.id, m.date, m."seasonId"
      FROM "UserAwayMatches" uam
      JOIN "Matches" m ON uam."matchId" = m.id
      WHERE uam."userId" = :userId AND m."leagueId" = :leagueId
    `, {
      replacements: { userId, leagueId }
    });

    const totalMatchesCount = homeMatches.length + awayMatches.length;
    console.log(`Ru Uddin matches in Season 7 FNF join tables: ${totalMatchesCount}`);
    console.log(`Home matches: ${homeMatches.length}, Away matches: ${awayMatches.length}`);

    // Wait! Let's check how many total matches are fetched for Ru Uddin's frontend page.
    // The query is /players/:playerId/matches. Let's see what matches that endpoint returns or how it aggregates.
    // Let's write a script to find all matches in Matches table where leagueId = Season 7 FNF and user is in home or away team.
    
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await sequelize.close();
  }
}

main();
