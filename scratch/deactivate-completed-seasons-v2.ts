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

  // Find all active, non-deleted seasons and their leagues
  const activeSeasons = await sequelize.query<any>(
    `SELECT s.id as "seasonId", s.name as "seasonName", s."maxGames" as "seasonMaxGames", 
            l.id as "leagueId", l.name as "leagueName", l."maxGames" as "leagueMaxGames"
     FROM "${seasonTable}" s
     JOIN "${leagueTable}" l ON s."leagueId" = l.id
     WHERE s."isActive" = true AND s.deleted = false`,
    { type: QueryTypes.SELECT }
  );

  console.log(`Found ${activeSeasons.length} active seasons in DB.`);
  console.log('Checking which ones have reached their limits (season limit or league limit fallback)...\n');

  let updatedCount = 0;

  for (const item of activeSeasons) {
    const sMaxGames = item.seasonMaxGames != null ? Number(item.seasonMaxGames) : null;
    const lMaxGames = item.leagueMaxGames != null ? Number(item.leagueMaxGames) : null;
    const maxGames = sMaxGames ?? lMaxGames ?? 0;

    if (maxGames <= 0) {
      console.log(`Season "${item.seasonName}" of League "${item.leagueName}" has no maxGames limit set (Season: ${sMaxGames}, League: ${lMaxGames}). Skipping.`);
      continue;
    }

    // Count completed matches in this season
    const [matchCountResult] = await sequelize.query<any>(
      `SELECT COUNT(*)::int AS count 
       FROM "${matchTable}" 
       WHERE "seasonId" = $1 
         AND status IN ('RESULT_PUBLISHED', 'RESULT_UPLOADED') 
         AND deleted = false`,
      { bind: [item.seasonId], type: QueryTypes.SELECT }
    );
    const completedCount = Number(matchCountResult?.count ?? 0);

    console.log(`League: "${item.leagueName}" -> Season: "${item.seasonName}" (ID: ${item.seasonId}): completed matches = ${completedCount}, effective maxGames = ${maxGames} (from ${sMaxGames != null ? 'Season' : 'League Fallback'})`);

    if (completedCount >= maxGames) {
      console.log(`👉 Limit reached (${completedCount}/${maxGames}). Deactivating season...`);
      
      const now = new Date();
      await sequelize.query(
        `UPDATE "${seasonTable}" 
         SET "isActive" = false, "endDate" = $2, "updatedAt" = $2 
         WHERE id = $1`,
        { bind: [item.seasonId, now] }
      );
      
      console.log(`✅ Season "${item.seasonName}" is now INACTIVE.\n`);
      updatedCount++;
    } else {
      console.log(`Matches limit not reached. Kept ACTIVE.\n`);
    }
  }

  console.log(`\nDone. Updated ${updatedCount} season(s) to inactive.`);
  await sequelize.close();
}

main().catch(console.error);
