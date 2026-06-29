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
  const seasonTable = tableNames.find((t: string) => t.toLowerCase() === 'seasons') || 'Seasons';
  const matchTable = tableNames.find((t: string) => t.toLowerCase() === 'matches') || 'Matches';

  // Find all active, non-deleted seasons
  const activeSeasons = await sequelize.query<any>(
    `SELECT id, name, "maxGames", "leagueId" FROM "${seasonTable}" WHERE "isActive" = true AND deleted = false`,
    { type: QueryTypes.SELECT }
  );

  console.log(`Found ${activeSeasons.length} active seasons in DB.`);
  console.log('Checking which active seasons have reached their maxGames limit...\n');

  let updatedCount = 0;

  for (const season of activeSeasons) {
    const maxGames = Number(season.maxGames ?? 0);
    if (maxGames <= 0) {
      console.log(`Season "${season.name}" (ID: ${season.id}) has no maxGames limit set. Skipping.`);
      continue;
    }

    // Count completed matches in this season
    const [matchCountResult] = await sequelize.query<any>(
      `SELECT COUNT(*)::int AS count 
       FROM "${matchTable}" 
       WHERE "seasonId" = $1 
         AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED') 
         AND deleted = false`,
      { bind: [season.id], type: QueryTypes.SELECT }
    );
    const completedCount = Number(matchCountResult?.count ?? 0);

    console.log(`Season "${season.name}" (ID: ${season.id}): completed matches = ${completedCount}, maxGames = ${maxGames}`);

    if (completedCount >= maxGames) {
      console.log(`👉 Season "${season.name}" (ID: ${season.id}) has reached its limit (${completedCount}/${maxGames}). Deactivating...`);
      
      const now = new Date();
      await sequelize.query(
        `UPDATE "${seasonTable}" 
         SET "isActive" = false, "endDate" = $2, "updatedAt" = $2 
         WHERE id = $1`,
        { bind: [season.id, now] }
      );
      
      console.log(`✅ Season "${season.name}" is now INACTIVE.\n`);
      updatedCount++;
    } else {
      console.log(`Season "${season.name}" matches limit not reached. Kept ACTIVE.\n`);
    }
  }

  console.log(`\nDone. Updated ${updatedCount} season(s) to inactive.`);
  await sequelize.close();
}

main().catch(console.error);
