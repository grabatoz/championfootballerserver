import db from '../modules/database';
import { QueryTypes } from 'sequelize';

async function resolveUsers(): Promise<string> {
  const { sequelize } = db;
  const r1 = await sequelize.query<{ t: string | null }>(
    `SELECT to_regclass('"users"') as t`,
    { type: QueryTypes.SELECT }
  );
  if (r1[0]?.t) return `"users"`;
  const r2 = await sequelize.query<{ t: string | null }>(
    `SELECT to_regclass('"Users"') as t`,
    { type: QueryTypes.SELECT }
  );
  if (r2[0]?.t) return `"Users"`;
  throw new Error('users table not found');
}


(async () => {
  const { sequelize } = db;
  const table = await resolveUsers();
  const stmts = [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS "providerId" varchar(255) NULL`
  ];
  for (const sql of stmts) {
    console.log('->', sql);
    await sequelize.query(sql);
  }
  console.log('✅ users.providerId ensured');
  await sequelize.close();
})().catch(async (e) => {
  console.error('❌ Update failed:', e);
  await db.sequelize.close();
  process.exit(1);
});