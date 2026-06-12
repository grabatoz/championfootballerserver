require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcrypt');

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  });
  await client.connect();

  const otpCode = '123456';
  const hashedCode = await bcrypt.hash(otpCode, 10);
  const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await client.query(
    'UPDATE users SET "resetCode" = $1, "resetCodeExpiry" = $2 WHERE email = $3',
    [hashedCode, expiry, 'ru.uddin@hotmail.com']
  );

  console.log(`✅ OTP for ru.uddin@hotmail.com set to: ${otpCode} (Expires in 1 hour)`);

  await client.end();
}

main().catch(console.error);
