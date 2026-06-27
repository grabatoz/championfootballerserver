import sequelize from '../config/database';
import models from '../models';

const { Match, User } = models as any;

async function run() {
  try {
    const matchId = '9cae3689-65ee-4225-bde3-9014331e0fb7'; // a completed match
    const match = await Match.findByPk(matchId, {
      include: [
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'xp'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'xp'] },
      ],
    });

    if (!match) {
      console.log("Match not found.");
      process.exit(0);
    }

    console.log("Match details:", {
      id: match.id,
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
    });
    
    console.log("Home team users count:", match.homeTeamUsers ? match.homeTeamUsers.length : 0);
    console.log("Home team users sample:", match.homeTeamUsers ? match.homeTeamUsers.slice(0, 5) : []);
    
    console.log("Away team users count:", match.awayTeamUsers ? match.awayTeamUsers.length : 0);
    console.log("Away team users sample:", match.awayTeamUsers ? match.awayTeamUsers.slice(0, 5) : []);

  } catch (err) {
    console.error(err);
  } finally {
    process.exit(0);
  }
}
run();
