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
  const leagueId = '560f68b4-86f9-49be-b60f-f5391f7b26e4';
  
  // 1. Members of the League (LeagueMember join table)
  const leagueMembers = await pool.query(`
    SELECT u.id, u."firstName", u."lastName", u.email, u.provider
    FROM users u
    JOIN "LeagueMember" lm ON lm."userId" = u.id
    WHERE lm."leagueId" = $1
  `, [leagueId]);
  
  console.log(`Total members in LeagueMember: ${leagueMembers.rows.length}`);
  
  // 2. Members of Seasons associated with this league
  const seasonPlayers = await pool.query(`
    SELECT DISTINCT u.id, u."firstName", u."lastName", u.email, u.provider, s.name as season_name
    FROM users u
    JOIN "SeasonPlayers" sp ON sp."userId" = u.id
    JOIN "Seasons" s ON s.id = sp."seasonId"
    WHERE s."leagueId" = $1 AND s.deleted = false
  `, [leagueId]);
  
  console.log(`Distinct players in UserSeasons (active seasons): ${seasonPlayers.rows.length}`);
  
  // Look at guest-like accounts
  const guestMembers = leagueMembers.rows.filter(u => {
    const email = (u.email || '').toLowerCase();
    const name = `${u.firstName || ''} ${u.lastName || ''}`.toLowerCase();
    return email.includes('guest') || name.includes('guest') || u.provider === 'guest' || email.endsWith('@local.invalid');
  });
  
  console.log(`Guest-like/migrated-guest members in UserLeagues: ${guestMembers.length}`);
  if (guestMembers.length > 0) {
    console.table(guestMembers);
  } else {
    console.log('No guest-like or migrated-guest members found.');
  }
  
  console.log('Listing all 50 members for manual verification:');
  console.table(leagueMembers.rows.map((r, i) => ({
    index: i,
    name: `${r.firstName} ${r.lastName}`,
    email: r.email,
    provider: r.provider
  })));
  
  await pool.end();
}
main();
