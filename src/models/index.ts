import User from './User';
import League from './League';
import Match from './Match';
import MatchStatistics from './MatchStatistics';
import Session from './Session';
import Vote from './Vote';

interface ModelWithAssociate {
  associate?: (models: any) => void;
}

// Initialize models first
const models = {
  User,
  League,
  Match,
  MatchStatistics,
  Session,
  Vote,
} as Record<string, ModelWithAssociate>;

// Then set up associations
Object.values(models).forEach((model) => {
  if (model.associate) {
    model.associate(models);
  }
});

export {
  User,
  League,
  Match,
  MatchStatistics,
  Session,
  Vote,
};

// Export default for easier imports
export default {
  User,
  League,
  Match,
  MatchStatistics,
  Session,
  Vote,
}; 