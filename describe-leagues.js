require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();

  const res = await client.query(`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'Leagues'
  `);
  console.log('=== Indexes on Leagues ===');
  console.log(res.rows);

  const cons = await client.query(`
    SELECT conname, pg_get_constraintdef(oid) 
    FROM pg_constraint 
    WHERE conrelid = '"Leagues"'::regclass
  `);
  console.log('=== Constraints on Leagues ===');
  console.log(cons.rows);

  await client.end();
}

main().catch(console.error);
