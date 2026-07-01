
const { Client } = require('pg');
const client = new Client('postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres');
client.connect().then(async () => {
  const res = await client.query('SELECT COUNT(*)::int AS c FROM 'LeagueMember' lm2 JOIN users u ON lm2.'userId' = u.id');
  console.log('Count:', res.rows[0]);
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});

