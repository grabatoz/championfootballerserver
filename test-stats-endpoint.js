const models = require('./src/models').default;
const { Op } = require('sequelize');

const { User: UserModel, Match: MatchModel, MatchStatistics } = models;

async function testGetPlayerStats() {
  try {
    const id = '811af694-cf1c-44e5-844c-4b7349a3856c';
    const leagueId = 'all';
    const year = 'all';

    console.log('Testing getPlayerStats with:');
    console.log('- id:', id);
    console.log('- leagueId:', leagueId);
    console.log('- year:', year);
    console.log('');

    const statsQuery = {
      include: [{
        model: MatchModel,
        as: 'match',
        where: { status: 'RESULT_PUBLISHED' }
      }],
      where: { user_id: id }
    };

    // Only filter by leagueId if it's not "all" and is provided
    if (leagueId && leagueId !== 'all') {
      statsQuery.include[0].where.leagueId = leagueId;
    }

    // Only filter by year if it's not "all" and is provided
    if (year && year !== 'all') {
      statsQuery.include[0].where.year = year;
    }

    console.log('Query:', JSON.stringify(statsQuery, null, 2));
    console.log('');

    const stats = await MatchStatistics.findAll(statsQuery);

    console.log('Found', stats.length, 'stats records');

    const totalStats = {
      goals: 0,
      assists: 0,
      motm: 0,
      rating: 0,
      matches: stats.length
    };

    stats.forEach((stat) => {
      totalStats.goals += stat.goals || 0;
      totalStats.assists += stat.assists || 0;
      totalStats.rating += stat.rating || 0;
    });

    if (stats.length > 0) {
      totalStats.rating = totalStats.rating / stats.length;
    }

    console.log('Result:', totalStats);
    process.exit(0);
  } catch (error) {
    console.error('ERROR fetching player stats:');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

testGetPlayerStats();
