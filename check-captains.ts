import 'dotenv/config';
import sequelize from './src/config/database';
import Match from './src/models/Match';

async function checkCaptains() {
  try {
    console.log('🔍 Checking matches for captain IDs...\n');
    
    const matches = await Match.findAll({
      attributes: ['id', 'homeTeamName', 'awayTeamName', 'homeCaptainId', 'awayCaptainId', 'homeTeamGoals', 'awayTeamGoals'],
      limit: 10,
      order: [['date', 'DESC']]
    });

    if (matches.length === 0) {
      console.log('❌ No matches found');
      return;
    }

    console.log(`Found ${matches.length} recent matches:\n`);
    
    matches.forEach((match, index) => {
      console.log(`Match ${index + 1}:`);
      console.log(`  ID: ${match.id}`);
      console.log(`  Teams: ${match.homeTeamName} vs ${match.awayTeamName}`);
      console.log(`  Score: ${match.homeTeamGoals} - ${match.awayTeamGoals}`);
      console.log(`  Home Captain ID: ${match.homeCaptainId || '❌ NOT SET'}`);
      console.log(`  Away Captain ID: ${match.awayCaptainId || '❌ NOT SET'}`);
      console.log('');
    });

    const withCaptains = matches.filter(m => m.homeCaptainId || m.awayCaptainId).length;
    const withoutCaptains = matches.length - withCaptains;

    console.log(`\n📊 Summary:`);
    console.log(`  Matches with captains: ${withCaptains}`);
    console.log(`  Matches without captains: ${withoutCaptains}`);
    
    if (withoutCaptains > 0) {
      console.log('\n⚠️  WARNING: Some matches do not have captain IDs set!');
      console.log('   Notifications cannot be sent without captain IDs.');
      console.log('   Captain IDs must be set when creating or updating matches.');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
}

checkCaptains();
