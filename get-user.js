require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();

  const res = await client.query('SELECT * FROM users WHERE email = $1', ['ru.uddin@hotmail.com']);
  console.log(res.rows[0]);

  await client.end();
}

main().catch(console.error);
