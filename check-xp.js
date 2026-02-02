const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DATABASE_URL, { logging: false });

async function checkXP() {
  try {
    // First list all tables
    const [tables] = await sequelize.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    console.log('📋 Tables in database:');
    tables.forEach(t => console.log(' -', t.tablename));
    
    // Find the match statistics table
    const statsTable = tables.find(t => t.tablename.toLowerCase().includes('matchstat') || t.tablename.toLowerCase().includes('match_stat'));
    console.log('\n🔍 Stats table found:', statsTable ? statsTable.tablename : 'NOT FOUND');
    
    if (!statsTable) {
      console.log('Looking for match_statistics table directly...');
      // Try common names
      const testNames = ['match_statistics', 'matchstatistics', 'MatchStatistics', 'match-statistics'];
      for (const name of testNames) {
        try {
          const [test] = await sequelize.query(`SELECT COUNT(*) as cnt FROM "${name}"`);
          console.log(`Table ${name} has ${test[0].cnt} records`);
        } catch (e) {
          // table doesn't exist
        }
      }
      return;
    }
    
    // Get recent match statistics with high goals/assists
    const tableName = statsTable.tablename;
    const [stats] = await sequelize.query(`
      SELECT ms.*, 
             u."firstName", u."lastName", u.xp as user_total_xp,
             m."homeTeamGoals", m."awayTeamGoals", m.status,
             m."homeCaptainConfirmed", m."awayCaptainConfirmed"
      FROM "${tableName}" ms
      JOIN users u ON ms.user_id = u.id
      JOIN "Matches" m ON ms.match_id = m.id
      ORDER BY ms.created_at DESC
      LIMIT 10
    `);
    
    console.log('\n📊 Recent match statistics:');
    console.log('Found', stats.length, 'records\n');
    
    stats.forEach(s => {
      console.log('---');
      console.log('Player:', s.firstName, s.lastName);
      console.log('Goals:', s.goals, '| Assists:', s.assists, '| Clean Sheets:', s.cleanSheets);
      console.log('Defence:', s.defence, '| Impact:', s.impact);
      console.log('XP Awarded for this match:', s.xpAwarded);
      console.log('User Total XP:', s.user_total_xp);
      console.log('Match Score: Home', s.homeTeamGoals, '-', s.awayTeamGoals, 'Away');
      console.log('Match Status:', s.status);
      console.log('Captains Confirmed:', s.homeCaptainConfirmed, '/', s.awayCaptainConfirmed);
    });

    // Check if there's a player with 4 goals and 3 assists
    console.log('\n\n🔍 Looking for player with 4 goals and 3 assists...');
    const [specific] = await sequelize.query(`
      SELECT ms.*, u."firstName", u."lastName"
      FROM "MatchStatistics" ms
      JOIN users u ON ms.user_id = u.id
      WHERE ms.goals = 4 AND ms.assists = 3
    `);
    
    if (specific.length > 0) {
      console.log('Found player:', specific[0].firstName, specific[0].lastName);
      console.log('XP Awarded:', specific[0].xpAwarded);
    } else {
      console.log('No player found with exactly 4 goals and 3 assists');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await sequelize.close();
  }
}

checkXP();
