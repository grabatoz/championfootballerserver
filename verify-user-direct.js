require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();

  await client.query(
    'UPDATE users SET "isVerified" = true, "resetCode" = null, "resetCodeExpiry" = null WHERE email = $1',
    ['ru.uddin@hotmail.com']
  );

  console.log('✅ User ru.uddin@hotmail.com directly verified in the database!');

  await client.end();
}

main().catch(console.error);
