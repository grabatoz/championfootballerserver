import League from './League';
import Match from './Match';
import MatchGuest from './MatchGuest';
import MatchStatistics from './MatchStatistics';
import Session from './Session';
import User from './User';
import Vote from './Vote';

// Guests per match
Match.hasMany(MatchGuest, { as: 'guestPlayers', foreignKey: 'matchId', onDelete: 'CASCADE' });
MatchGuest.belongsTo(Match, { as: 'match', foreignKey: 'matchId' });

// Initialize models
const models = { User, League, Match, MatchGuest, MatchStatistics, Session, Vote };

// Handle associations if defined
Object.values(models).forEach((model: any) => {
  if (model.associate) {
    model.associate(models);
  }
});

export default models;










// import League from './League';
// import Match from './Match';
// import MatchStatistics from './MatchStatistics';
// import Session from './Session';
// import { User } from './User';
// import Vote from './Vote';

// interface ModelWithAssociate {
//   associate?: (models: any) => void;
// }

// // Initialize models first
// const models = {
//   User,
//   League,
//   Match,
//   MatchStatistics,
//   Session,
//   Vote,
// } as Record<string, ModelWithAssociate>;

// // Then set up associations
// Object.values(models).forEach((model) => {
//   if (model.associate) {
//     model.associate(models);
//   }
// });

// export {
//   User,
//   League,
//   Match,
//   MatchStatistics,
//   Session,
//   Vote,
// };

// // Export default for easier imports
// export default {
//   User,
//   League,
//   Match,
//   MatchStatistics,
//   Session,
//   Vote,
// };