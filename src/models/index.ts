import sequelize from '../config/database';
import User from './User';
import League from './League';
import Match from './Match';
import { MatchAvailability } from './MatchAvailability';
import MatchStatistics from './MatchStatistics';
import Session from './Session';
import Vote from './Vote';
import MatchGuest from './MatchGuest';
import  Notification  from './Notification';

// Initialize models that need it
MatchAvailability.initModel(sequelize);
Notification.initModel(sequelize);


// Guests per match
Match.hasMany(MatchGuest, { as: 'guestPlayers', foreignKey: 'matchId', onDelete: 'CASCADE' });
MatchGuest.belongsTo(Match, { as: 'match', foreignKey: 'matchId' });

const models = { User, League, Match, MatchGuest, MatchStatistics, Session, Vote, MatchAvailability, Notification };

// MINIMAL associations to avoid conflicts
Match.hasMany(MatchAvailability, { as: 'availabilityRecords', foreignKey: 'match_id' });
MatchAvailability.belongsTo(Match, { as: 'matchRecord', foreignKey: 'match_id' });
MatchAvailability.belongsTo(User, { as: 'userRecord', foreignKey: 'user_id' });

// Handle associations if defined
Object.values(models).forEach((model: any) => {
  if (model.associate) {
    model.associate(models);
  }
});

export default models;
export { User, League, Match, MatchGuest, MatchStatistics, Session, Vote, MatchAvailability, Notification };
export { default as MatchPlayerLayout } from './MatchPlayerLayout';