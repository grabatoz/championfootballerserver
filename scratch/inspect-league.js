const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const models = require('../dist/models').default;
const { User, League, Season } = models;

async function main() {
  try {
    const leagues = await League.findAll({
      attributes: ['id', 'name', 'active', 'archived'],
      limit: 10
    });
    console.log('\n--- Leagues ---');
    console.log(leagues.map(l => l.toJSON()));

    for (const league of leagues) {
      console.log(`\n================== LEAGUE: ${league.name} (${league.id}) ==================`);
      
      // Fetch members
      const detailedLeague = await League.findByPk(league.id, {
        include: [
          { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName'] },
          { model: Season, as: 'seasons', attributes: ['id', 'seasonNumber', 'name', 'isActive', 'archived'] }
        ]
      });

      const members = detailedLeague.members || [];
      console.log(`  Members Count: ${members.length}`);
      console.log('  Members:', members.map(m => `${m.firstName} ${m.lastName} (${m.id})`));

      const seasons = detailedLeague.seasons || [];
      console.log(`  Seasons Count: ${seasons.length}`);
      
      for (const season of seasons) {
        // Fetch players for each season by finding the season with its players
        const detailedSeason = await Season.findByPk(season.id, {
          include: [{ model: User, as: 'players', attributes: ['id', 'firstName', 'lastName'] }]
        });
        const players = detailedSeason.players || [];
        console.log(`    Season ${season.seasonNumber} ("${season.name}") - Players Count: ${players.length}`);
        console.log('    Players:', players.map(p => `${p.firstName} ${p.lastName} (${p.id})`));
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
