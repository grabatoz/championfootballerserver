const { Client } = require('pg');
const client = new Client('postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres');
client.connect().then(async () => {
  const res = await client.query(`SELECT COUNT(*)::int AS c FROM "LeagueMember" lm2 JOIN "users" u_count ON lm2."userId" = u_count.id WHERE lm2."leagueId" = '560f68b4-86f9-49be-b60f-f5391f7b26e4' AND COALESCE(u_count.email, '') NOT ILIKE '%guest%'`);
  console.log('Count exactly as in app:', res.rows[0]);
  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
