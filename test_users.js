const { Client } = require('pg');
const client = new Client('postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres');
client.connect().then(async () => {
  const res = await client.query(`SELECT u.email, u.provider, u."firstName", u."lastName" FROM "LeagueMember" lm2 JOIN "users" u ON lm2."userId" = u.id WHERE lm2."leagueId" = '560f68b4-86f9-49be-b60f-f5391f7b26e4' LIMIT 10`);
  console.log('Users:', res.rows);
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
