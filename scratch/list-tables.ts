import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

import sequelize from '../src/config/database';

async function main() {
  console.log('Fetching database tables and their row counts...');
  
  const tables: any[] = await sequelize.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;`,
    { type: 'SELECT' as any }
  );

  console.log('Tables found:', tables);

  for (const t of tables) {
    const tableName = t.table_name || t.TABLE_NAME;
    if (!tableName) {
      console.log('Skipping empty table name for entry:', t);
      continue;
    }
    try {
      const [countResult]: any[] = await sequelize.query(`SELECT COUNT(*) as count FROM "${tableName}"`, { type: 'SELECT' as any });
      console.log(`- Table "${tableName}": ${countResult.count} rows`);
    } catch (err: any) {
      console.error(`Failed to get count for table "${tableName}":`, err.message);
    }
    
    try {
      // Get indexes for this table
      const indexes: any[] = await sequelize.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = :tableName;`,
        { replacements: { tableName }, type: 'SELECT' as any }
      );
      for (const idx of indexes) {
        console.log(`    Index: ${idx.indexname} -> ${idx.indexdef}`);
      }
    } catch (err: any) {
      console.error(`Failed to get indexes for table "${tableName}":`, err.message);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
