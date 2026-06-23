require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'salman1209',
  password: process.env.DB_PASSWORD || 'Malik,g12',
});

async function main() {
  const res = await pool.query('SELECT id, name, "seasonNumber" FROM "Seasons" ORDER BY name;');
  console.table(res.rows);
  await pool.end();
}
main();
