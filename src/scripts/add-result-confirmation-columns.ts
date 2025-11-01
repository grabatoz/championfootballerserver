import db from '../modules/database';
import { QueryTypes } from 'sequelize';

async function resolveQuotedTable(): Promise<string> {
  const { sequelize } = db;
  const r1 = await sequelize.query<{ t: string | null }>(
    `SELECT to_regclass('"Matches"') as t`,
    { type: QueryTypes.SELECT }
  );
  if (r1[0]?.t) return `"Matches"`;
  const r2 = await sequelize.query<{ t: string | null }>(
    `SELECT to_regclass('"matches"') as t`,
    { type: QueryTypes.SELECT }
  );
  if (r2[0]?.t) return `"matches"`;
  throw new Error('Neither "Matches" nor "matches" table found');
}


async function run() {
  const { sequelize } = db;
  const table = await resolveQuotedTable();
  console.log('Target table:', table);

  const stmts = [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "archived" boolean NOT NULL DEFAULT false`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "homeCaptainConfirmed" boolean DEFAULT false`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "awayCaptainConfirmed" boolean DEFAULT false`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "resultUploadedAt" timestamp NULL`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "resultPublishedAt" timestamp NULL`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "suggestedHomeGoals" integer NULL`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "suggestedAwayGoals" integer NULL`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "suggestedByCaptainId" uuid NULL`,
  ];

  for (const sql of stmts) {
    console.log('->', sql);
    await sequelize.query(sql);
  }

  console.log('✅ Columns ensured.');
  await sequelize.close();
}

run().catch(async (e) => {
  console.error('❌ Migration failed:', e);
  await db.sequelize.close();
  process.exit(1);
});