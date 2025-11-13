// Check latest MATCH_ENDED notification
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false
});

(async () => {
  const result = await pool.query(`
    SELECT type, title, body, meta, created_at
    FROM notifications
    WHERE type = 'MATCH_ENDED'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  
  console.log('Latest MATCH_ENDED notification:');
  console.log(JSON.stringify(result.rows[0], null, 2));
  
  await pool.end();
})();
