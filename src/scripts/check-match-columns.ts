import db from '../modules/database';
import { QueryTypes } from 'sequelize';

(async () => {
  const { sequelize } = db;
  const recs = await sequelize.query<{ t: string | null }>(
    `SELECT (CASE WHEN to_regclass('"Matches"') IS NULL THEN '"matches"' ELSE '"Matches"' END) AS t`,
    { type: QueryTypes.SELECT }
  );
  const quoted = recs[0].t!;
  const plain = quoted.replace(/"/g, '');

  const rows = await sequelize.query<{ column_name: string }>(
    `SELECT column_name 
       FROM information_schema.columns 
      WHERE table_schema='public' AND table_name = :name
      ORDER BY column_name`,
    { type: QueryTypes.SELECT, replacements: { name: plain } }
  );

  console.log('Table:', quoted);
  console.log('Columns:', rows.map(r => r.column_name));
  await sequelize.close();
})();