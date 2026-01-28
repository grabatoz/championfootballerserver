import sequelize from '../config/database';
import User from './User';
import League from './League';
import Match from './Match';
import Season from './Season';
import { MatchAvailability } from './MatchAvailability';
import MatchStatistics from './MatchStatistics';
import Session from './Session';
import Vote from './Vote';
import MatchGuest from './MatchGuest';
import  Notification  from './Notification';
import { realtime } from '../services/realtime';
import { invalidateCache as invalidateServerCache } from '../middleware/memoryCache';

// Initialize models that need it
MatchAvailability.initModel(sequelize);
Notification.initModel(sequelize);


// Guests per match
Match.hasMany(MatchGuest, { as: 'guestPlayers', foreignKey: 'matchId', onDelete: 'CASCADE' });
MatchGuest.belongsTo(Match, { as: 'match', foreignKey: 'matchId' });

const models = { User, League, Match, Season, MatchGuest, MatchStatistics, Session, Vote, MatchAvailability, Notification };

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
export { User, League, Match, Season, MatchGuest, MatchStatistics, Session, Vote, MatchAvailability, Notification };
export { default as MatchPlayerLayout } from './MatchPlayerLayout';

// Root-level realtime hooks (non-destructive): broadcast key entity changes
try {
  Match.addHook('afterCreate', (instance: any) => {
    try { invalidateServerCache('/matches'); invalidateServerCache('/leagues'); } catch {}
    try {
      const payload = JSON.stringify({ id: instance.id, leagueId: instance.leagueId, status: instance.status });
      sequelize.query("NOTIFY match_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('match-created', {
      id: instance.id,
      leagueId: instance.leagueId,
      status: instance.status,
      date: instance.date,
    });
  });
  Match.addHook('afterUpdate', (instance: any) => {
    try { invalidateServerCache('/matches'); invalidateServerCache('/leagues'); } catch {}
    try {
      const payload = JSON.stringify({ id: instance.id, leagueId: instance.leagueId, status: instance.status });
      sequelize.query("NOTIFY match_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('match-updated', {
      id: instance.id,
      leagueId: instance.leagueId,
      status: instance.status,
      date: instance.date,
      homeTeamGoals: instance.homeTeamGoals,
      awayTeamGoals: instance.awayTeamGoals,
    });
  });
  Match.addHook('afterDestroy', (instance: any) => {
    try { invalidateServerCache('/matches'); invalidateServerCache('/leagues'); } catch {}
    try {
      const payload = JSON.stringify({ id: instance.id, leagueId: instance.leagueId, deleted: true });
      sequelize.query("NOTIFY match_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('match-deleted', { id: instance.id, leagueId: instance.leagueId });
  });

  League.addHook('afterCreate', (l: any) => {
    try { invalidateServerCache('/leagues'); } catch {}
    try {
      const payload = JSON.stringify({ id: l.id, name: l.name });
      sequelize.query("NOTIFY league_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('league-created', { id: l.id, name: l.name });
  });
  League.addHook('afterUpdate', (l: any) => {
    try { invalidateServerCache('/leagues'); } catch {}
    try {
      const payload = JSON.stringify({ id: l.id, name: l.name });
      sequelize.query("NOTIFY league_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('league-updated', { id: l.id, name: l.name });
  });
  League.addHook('afterDestroy', (l: any) => {
    try { invalidateServerCache('/leagues'); invalidateServerCache('/matches'); } catch {}
    try {
      const payload = JSON.stringify({ id: l.id, deleted: true });
      sequelize.query("NOTIFY league_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('league-deleted', { id: l.id });
  });

  Notification.addHook('afterCreate', (n: any) => {
    realtime.broadcast('notification-created', { id: n.id, user_id: n.user_id, type: n.type });
  });

  // Votes affect leaderboard and match vote tallies
  Vote.addHook('afterCreate', (v: any) => {
    try { invalidateServerCache('/leaderboard'); invalidateServerCache('/matches'); } catch {}
    try {
      const payload = JSON.stringify({ matchId: v.matchId || v.match_id, voterId: v.voterId || v.voter_id, votedForId: v.votedForId || v.voted_for_id });
      sequelize.query("NOTIFY vote_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('vote-updated', {
      matchId: v.matchId || v.match_id,
      voterId: v.voterId || v.voter_id,
      votedForId: v.votedForId || v.voted_for_id,
      action: 'created'
    });
  });
  Vote.addHook('afterDestroy', (v: any) => {
    try { invalidateServerCache('/leaderboard'); invalidateServerCache('/matches'); } catch {}
    try {
      const payload = JSON.stringify({ matchId: v.matchId || v.match_id, voterId: v.voterId || v.voter_id, votedForId: v.votedForId || v.voted_for_id, deleted: true });
      sequelize.query("NOTIFY vote_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('vote-updated', {
      matchId: v.matchId || v.match_id,
      voterId: v.voterId || v.voter_id,
      votedForId: v.votedForId || v.voted_for_id,
      action: 'deleted'
    });
  });

  // Match statistics updates impact player stats, rankings, and match views
  MatchStatistics.addHook('afterCreate', (s: any) => {
    try { invalidateServerCache('/players'); invalidateServerCache('/world-ranking'); invalidateServerCache('/matches'); } catch {}
    try {
      const payload = JSON.stringify({ matchId: s.matchId || s.match_id, playerId: s.userId || s.user_id, action: 'created' });
      sequelize.query("NOTIFY stats_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('match-stats-updated', {
      matchId: s.matchId || s.match_id,
      playerId: s.userId || s.user_id,
      action: 'created'
    });
  });
  MatchStatistics.addHook('afterUpdate', (s: any) => {
    try { invalidateServerCache('/players'); invalidateServerCache('/world-ranking'); invalidateServerCache('/matches'); } catch {}
    try {
      const payload = JSON.stringify({ matchId: s.matchId || s.match_id, playerId: s.userId || s.user_id, action: 'updated' });
      sequelize.query("NOTIFY stats_updates, '" + payload.replace(/'/g, "''") + "'");
    } catch {}
    realtime.broadcast('match-stats-updated', {
      matchId: s.matchId || s.match_id,
      playerId: s.userId || s.user_id,
      action: 'updated'
    });
  });
} catch (e) {
  // Hooks are best-effort; log but don't crash startup
  console.warn('[Realtime] Failed to attach model hooks:', e);
}