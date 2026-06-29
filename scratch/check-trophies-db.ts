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

  console.log('Fetching FNF Leagues and their seasons...');
  const leagues = await sequelize.query<any>(
    `SELECT id, name FROM "${leagueTable}" WHERE name ILIKE '%fnf%'`,
    { type: QueryTypes.SELECT }
  );

  for (const l of leagues) {
    const seasons = await sequelize.query<any>(
      `SELECT id, name, "seasonNumber", "isActive", "trophyAwardSnapshot" FROM "${seasonTable}" WHERE "leagueId" = $1`,
      { bind: [l.id], type: QueryTypes.SELECT }
    );

    console.log(`\nLeague: ${l.name} (${l.id})`);
    for (const s of seasons) {
      console.log(`  Season: ${s.name} (Active: ${s.isActive})`);
      console.log(`  Snapshot:`, JSON.stringify(s.trophyAwardSnapshot, null, 2));
    }
  }

  await sequelize.close();
}

main().catch(console.error);
