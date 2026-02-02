const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function testXPAward() {
  try {
    // Get the most recent match with 4 goals
    const [matches] = await sequelize.query(`
      SELECT ms.match_id, ms.created_at, m.status, m."homeCaptainConfirmed", m."awayCaptainConfirmed",
             m."homeTeamGoals", m."awayTeamGoals"
      FROM match_statistics ms
      JOIN "Matches" m ON ms.match_id = m.id
      WHERE ms.goals >= 4
      ORDER BY ms.created_at DESC
      LIMIT 1
    `);
    
    if (matches.length === 0) {
      console.log('No match found');
      return;
    }
    
    const matchId = matches[0].match_id;
    console.log('Match ID:', matchId);
    console.log('Status:', matches[0].status);
    console.log('Home Captain Confirmed:', matches[0].homeCaptainConfirmed);
    console.log('Away Captain Confirmed:', matches[0].awayCaptainConfirmed);
    console.log('Score:', matches[0].homeTeamGoals, '-', matches[0].awayTeamGoals);
    
    // Get all stats for this match
    const [stats] = await sequelize.query(`
      SELECT ms.*, u."firstName", u."lastName"
      FROM match_statistics ms
      JOIN users u ON ms.user_id = u.id
      WHERE ms.match_id = $1
    `, { bind: [matchId] });
    
    console.log('\n📊 Stats for this match:');
    stats.forEach(s => {
      console.log(`Player: ${s.firstName} ${s.lastName}`);
      console.log(`  Goals: ${s.goals}, Assists: ${s.assists}`);
      console.log(`  XP Awarded: ${s.xp_awarded}`);
    });
    
    // Get votes for this match
    const [votes] = await sequelize.query(`
      SELECT v.*, u."firstName" as voter_name, u2."firstName" as voted_for_name
      FROM "Votes" v
      JOIN users u ON v."voterId" = u.id
      JOIN users u2 ON v."votedForId" = u2.id
      WHERE v."matchId" = $1
    `, { bind: [matchId] });
    
    console.log('\n🗳️ Votes for this match:');
    votes.forEach(v => {
      console.log(`${v.voter_name} voted for ${v.voted_for_name}`);
    });
    
    // Get homeTeamUsers and awayTeamUsers
    const [homeUsers] = await sequelize.query(`
      SELECT u."firstName", u."lastName", u.id, u.xp
      FROM "UserHomeMatches" uhm
      JOIN users u ON uhm."userId" = u.id
      WHERE uhm."matchId" = $1
    `, { bind: [matchId] });
    
    const [awayUsers] = await sequelize.query(`
      SELECT u."firstName", u."lastName", u.id, u.xp
      FROM "UserAwayMatches" uam
      JOIN users u ON uam."userId" = u.id
      WHERE uam."matchId" = $1
    `, { bind: [matchId] });
    
    console.log('\n🏠 Home Team Users:', homeUsers.length);
    homeUsers.forEach(u => console.log(`  - ${u.firstName} ${u.lastName} (XP: ${u.xp})`));
    
    console.log('\n✈️ Away Team Users:', awayUsers.length);
    awayUsers.forEach(u => console.log(`  - ${u.firstName} ${u.lastName} (XP: ${u.xp})`));
    
  } catch (err) {
    console.error('Error:', err.message);
    console.error(err.stack);
  } finally {
    await sequelize.close();
  }
}

testXPAward();
