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
  const [season] = await sequelize.query<any>(
    `SELECT * FROM "Seasons" WHERE id = $1`,
    { bind: [seasonId], type: QueryTypes.SELECT }
  );

  if (!season) {
    console.log('Season not found');
    await sequelize.close();
    return;
  }

  console.log('Season:', season);

  const [league] = await sequelize.query<any>(
    `SELECT * FROM "Leagues" WHERE id = $1`,
    { bind: [season.leagueId], type: QueryTypes.SELECT }
  );
  console.log('League:', league);

  const matches = await sequelize.query<any>(
    `SELECT id, status, deleted, "homeTeamGoals", "awayTeamGoals" FROM "Matches" WHERE "seasonId" = $1`,
    { bind: [seasonId], type: QueryTypes.SELECT }
  );
  console.log('Matches Count:', matches.length);
  console.log('Matches:', matches);

  await sequelize.close();
}

main().catch(console.error);
