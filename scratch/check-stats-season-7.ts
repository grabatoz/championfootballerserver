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

  const seasonId = '81c903e8-e3f8-4dec-81a5-78681f5d1710';

  // Get MatchStatistics with clean_sheets > 0 for this season's matches
  const stats = await sequelize.query<any>(
    `SELECT ms.user_id, u."firstName", u."lastName", SUM(ms.clean_sheets) as total_cs
     FROM "match_statistics" ms
     JOIN "users" u ON ms.user_id = u.id
     JOIN "Matches" m ON ms.match_id = m.id
     WHERE m."seasonId" = $1
     GROUP BY ms.user_id, u."firstName", u."lastName"
     HAVING SUM(ms.clean_sheets) > 0
     ORDER BY total_cs DESC`,
    { bind: [seasonId], type: QueryTypes.SELECT }
  );

  console.log('Clean Sheets from MatchStatistics for Season 7 FNF:');
  console.log(stats);

  await sequelize.close();
}

main().catch(console.error);
