const { Client } = require('pg');
const client = new Client('postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres');
client.connect().then(async () => {
  const res = await client.query(`SELECT id, name FROM "Leagues" WHERE name ILIKE '%SEASON 7%'`);
  console.log('Leagues:', res.rows);
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
