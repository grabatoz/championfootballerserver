import dotenv from 'dotenv';
import path from 'path';
import { Sequelize, QueryTypes } from 'sequelize';

dotenv.config({ path: path.join(__dirname, '../.env') });

const DATABASE_URL = process.env.DATABASE_URL || '';

async function main() {
  const sequelize = new Sequelize(DATABASE_URL, {
    dialect: 'postgres',
    logging: false,
  });

  await sequelize.authenticate();
  console.log('✅ Connected to database\n');

  // Discover tables
  const tables = await sequelize.query<any>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    { type: QueryTypes.SELECT }
  );
  const tableNames = tables.map((t: any) => t.tablename);
  const leagueTable = tableNames.find((t: string) => t.toLowerCase() === 'leagues') || 'Leagues';
  const seasonTable = tableNames.find((t: string) => t.toLowerCase() === 'seasons') || 'Seasons';
  const matchTable = tableNames.find((t: string) => t.toLowerCase() === 'matches') || 'Matches';

  console.log('Searching for leagues matching "fnf" or seasons matching "fnf"...');
  const leagues = await sequelize.query<any>(
    `SELECT id, name, active, archived FROM "${leagueTable}" WHERE name ILIKE '%fnf%'`,
    { type: QueryTypes.SELECT }
  );

  console.log(`Leagues found:`, leagues);

  for (const league of leagues) {
    console.log(`\nChecking seasons for League: "${league.name}" (ID: ${league.id})`);
    const seasons = await sequelize.query<any>(
      `SELECT id, name, "seasonNumber", "isActive", archived, "maxGames", deleted 
       FROM "${seasonTable}" 
       WHERE "leagueId" = $1`,
      { bind: [league.id], type: QueryTypes.SELECT }
    );

    for (const season of seasons) {
      // Total matches associated with this season
      const [allMatches] = await sequelize.query<any>(
        `SELECT COUNT(*)::int AS count FROM "${matchTable}" WHERE "seasonId" = $1 AND deleted = false`,
        { bind: [season.id], type: QueryTypes.SELECT }
      );

      // Completed matches
      const [completedMatches] = await sequelize.query<any>(
        `SELECT COUNT(*)::int AS count FROM "${matchTable}" WHERE "seasonId" = $1 AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED') AND deleted = false`,
        { bind: [season.id], type: QueryTypes.SELECT }
      );

      console.log(`- Season: "${season.name}" (Num: ${season.seasonNumber}, ID: ${season.id})
        isActive: ${season.isActive}, archived: ${season.archived}, deleted: ${season.deleted}
        maxGames (limit): ${season.maxGames}
        Total Matches (not deleted): ${allMatches.count}
        Completed Matches (published/uploaded): ${completedMatches.count}`);
    }
  }

  // Also search for seasons matching "fnf" directly if league search doesn't show it
  const seasonsDirect = await sequelize.query<any>(
    `SELECT s.id, s.name, s."isActive", s."maxGames", l.name as "leagueName"
     FROM "${seasonTable}" s
     JOIN "${leagueTable}" l ON s."leagueId" = l.id
     WHERE s.name ILIKE '%fnf%'`,
    { type: QueryTypes.SELECT }
  );
  if (seasonsDirect.length > 0) {
    console.log('\nDirect season matches for "fnf":', seasonsDirect);
  }

  await sequelize.close();
}

main().catch(console.error);
