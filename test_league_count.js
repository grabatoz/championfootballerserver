const { Client } = require('pg');
const client = new Client('postgresql://salman1209:Malik,g12@38.49.208.233:5432/postgres');
client.connect().then(async () => {
  const res = await client.query(`SELECT COUNT(*)::int AS c FROM "LeagueMember" lm2 JOIN "users" u ON lm2."userId" = u.id WHERE lm2."leagueId" = '560f68b4-86f9-49be-b60f-f5391f7b26e4'`);
  console.log('Count with JOIN:', res.rows[0]);
  
  const res2 = await client.query(`SELECT COUNT(*)::int AS c FROM "LeagueMember" lm2 WHERE lm2."leagueId" = '560f68b4-86f9-49be-b60f-f5391f7b26e4'`);
  console.log('Count WITHOUT JOIN:', res2.rows[0]);

  process.exit(0);
}).catch(err => {
  console.error(err.message);
  process.exit(1);
});
