const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const models = require('../dist/models').default;
const { User, League, Season } = models;
const { getLeagueById } = require('../dist/controllers/leagueController.full');

async function testApiForUser(userId, label) {
  const leagueId = '3983779f-c42f-40cd-a8bd-b9460a594585'; // Local Champions
  console.log(`\n================== TESTING AS ${label} (${userId}) ==================`);
  
  const ctx = {
    params: { id: leagueId },
    query: { includeMatches: '1' },
    state: {
      user: { userId }
    },
    set(name, value) {
      // console.log(`  Header: ${name} = ${value}`);
    }
  };

  await getLeagueById(ctx);

  if (ctx.status) {
    console.log(`  HTTP STATUS: ${ctx.status}`);
    console.log(`  BODY:`, JSON.stringify(ctx.body, null, 2));
  } else {
    console.log(`  SUCCESS:`, ctx.body?.success);
    if (ctx.body?.success) {
      const l = ctx.body.league;
      console.log(`  League ID:`, l.id);
      console.log(`  League Name:`, l.name);
      console.log(`  Is Admin:`, l.isAdmin);
      console.log(`  Admin ID:`, l.adminId);
      console.log(`  Members Count:`, l.members?.length);
      console.log(`  Administrators Count:`, l.administrators?.length);
      console.log(`  Seasons Count:`, l.seasons?.length);
      if (l.seasons && l.seasons.length > 0) {
        console.log(`  First Season JSON:`, JSON.stringify(l.seasons[0], null, 2));
      }
    } else {
      console.log(`  BODY:`, ctx.body);
    }
  }
}

async function main() {
  try {
    // Ruhel Uddin (member of Local Champions)
    await testApiForUser('f0f2a5fd-580f-4746-84dd-432f43b3ea86', 'MEMBER: Ruhel Uddin');

    // Find admin user for Local Champions
    const leagueId = '3983779f-c42f-40cd-a8bd-b9460a594585';
    const detailedLeague = await League.findByPk(leagueId, {
      include: [
        { model: User, as: 'administeredLeagues', attributes: ['id', 'firstName', 'lastName'] }
      ]
    });
    const admins = detailedLeague?.administeredLeagues || [];
    console.log('\nAdmins for Local Champions in DB:', admins.map(a => `${a.firstName} ${a.lastName} (${a.id})`));

    if (admins.length > 0) {
      await testApiForUser(admins[0].id, `ADMIN: ${admins[0].firstName} ${admins[0].lastName}`);
    } else {
      // Try to find ANY admin user or the first user in administrators
      const fallbackLeague = await League.findByPk(leagueId, {
        include: [{ model: User, as: 'administrators', attributes: ['id', 'firstName'] }]
      });
      const fallbackAdmins = fallbackLeague?.administrators || [];
      console.log('Fallback Administrators in DB:', fallbackAdmins.map(a => `${a.firstName} (${a.id})`));
      if (fallbackAdmins.length > 0) {
        await testApiForUser(fallbackAdmins[0].id, `ADMIN (from administrators): ${fallbackAdmins[0].firstName}`);
      }
    }

  } catch (err) {
    console.error('Error:', err);
  } finally {
    const db = require('../dist/config/database').default;
    if (db) await db.close();
  }
}

main();
