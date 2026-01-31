import { Context } from 'koa';
import models from '../models';
import sequelize from '../config/database';
import { QueryTypes, Op, fn, col } from 'sequelize';
import { v4 as uuidv4 } from 'uuid';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
import { sendCaptainConfirmations, notifyCaptainConfirmed, notifyCaptainRevision } from '../modules/notifications';
import Notification from '../models/Notification';
import Season from '../models/Season';

const { Match, Vote, User, MatchStatistics, League, MatchGuest, MatchAvailability } = models;

const normalizeTeam = (t: any): 'home' | 'away' =>
  String(t).toLowerCase() === 'away' ? 'away' : 'home';

// CREATE MATCH - Always assigns to active season
export const createMatch = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const {
    leagueId,
    date,
    start,
    end,
    location,
    homeTeamName,
    awayTeamName,
    homeTeamImage,
    awayTeamImage,
    notes
  } = ctx.request.body as any;

  if (!leagueId) {
    ctx.throw(400, 'leagueId is required');
    return;
  }

  if (!date || !start || !end) {
    ctx.throw(400, 'date, start and end times are required');
    return;
  }

  try {
    // Find the active season for this league
    const activeSeason = await Season.findOne({
      where: {
        leagueId,
        isActive: true
      }
    });

    if (!activeSeason) {
      ctx.throw(400, 'No active season found for this league. Please create a season first.');
      return;
    }

    console.log(`📅 Creating match for league ${leagueId} in active season ${activeSeason.id} (Season ${activeSeason.seasonNumber})`);

    // Create match with seasonId from active season
    const match = await Match.create({
      id: uuidv4(),
      leagueId,
      seasonId: activeSeason.id, // 🔥 Always use active season
      date: new Date(date),
      start: new Date(start),
      end: new Date(end),
      location: location || '',
      homeTeamName: homeTeamName || 'Home Team',
      awayTeamName: awayTeamName || 'Away Team',
      homeTeamImage: homeTeamImage || null,
      awayTeamImage: awayTeamImage || null,
      notes: notes || null,
      status: 'SCHEDULED',
      homeTeamGoals: 0,
      awayTeamGoals: 0
    });

    console.log(`✅ Match created: ${match.id} in Season ${activeSeason.seasonNumber}`);

    // Clear caches
    try {
      cache.clearPattern(`league_${leagueId}`);
      cache.clearPattern(`matches_league_${leagueId}`);
    } catch (e) {
      console.warn('Cache clear failed', e);
    }

    ctx.status = 201;
    ctx.body = {
      success: true,
      match: {
        id: match.id,
        leagueId: match.leagueId,
        seasonId: match.seasonId,
        date: match.date,
        start: match.start,
        end: match.end,
        location: match.location,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        homeTeamImage: match.homeTeamImage,
        awayTeamImage: match.awayTeamImage,
        notes: match.notes,
        status: match.status
      },
      message: `Match created in Season ${activeSeason.seasonNumber}`
    };
  } catch (err) {
    console.error('Create match error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to create match' };
  }
};

// Resolve player or guest ID to user ID
async function resolveTargetUserIdForMatch(playerOrGuestId: string, matchId: string): Promise<string> {
  const existingUser = await User.findByPk(playerOrGuestId);
  if (existingUser) return String(existingUser.id);

  const guest = await (models as any).MatchGuest.findOne({ where: { id: playerOrGuestId, matchId } });
  if (!guest) {
    throw new Error('Player not found');
  }

  const guestMirror = await User.findOne({ where: { provider: 'guest', providerId: String(guest.id) } });
  if (guestMirror) return String(guestMirror.id);

  const email = `guest_${guest.id}@guest.local`;
  const firstName = String((guest as any).firstName || 'Guest');
  const lastName = String((guest as any).lastName || 'Player');
  const created = await User.create({
    email,
    firstName,
    lastName,
    password: `guest:${String(guest.id)}`,
    provider: 'guest',
    providerId: String(guest.id),
  } as any);
  return String(created.id);
}

// Vote for MOTM
export const voteForMotm = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }
  const matchId = ctx.params.id;
  const voterId = ctx.state.user.userId;
  const { votedForId } = ctx.request.body as { votedForId?: string | null };

  if (!votedForId) {
    await Vote.destroy({ where: { matchId, voterId } });
    try { cache.clearPattern(`match_votes_${matchId}_`); } catch {}
    ctx.status = 200;
    ctx.body = { success: true, message: 'Vote removed.' };
    return;
  }

  if (voterId === votedForId) {
    ctx.throw(400, 'You cannot vote for yourself.');
  }

  await Vote.destroy({ where: { matchId, voterId } });
  await Vote.create({ matchId, voterId, votedForId });

  try {
    const match = await Match.findByPk(matchId);
    if (match && match.leagueId) {
      const cacheKey = `leaderboard_motm_${match.leagueId}_all`;
      cache.updateLeaderboard(cacheKey, { playerId: votedForId, value: 1 });
    }
  } catch (e) {
    console.warn('MOTM leaderboard cache update failed', e);
  }

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', attributes: ['id', 'name'] }]
    });

    if (match) {
      const homePlayerIds = await sequelize.query<{ userId: string }>(
        `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
        { replacements: { matchId }, type: QueryTypes.SELECT }
      );

      const awayPlayerIds = await sequelize.query<{ userId: string }>(
        `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
        { replacements: { matchId }, type: QueryTypes.SELECT }
      );

      const allPlayerIds = [
        ...homePlayerIds.map(p => p.userId),
        ...awayPlayerIds.map(p => p.userId)
      ];

      const uniquePlayerIds = Array.from(new Set(allPlayerIds))
        .filter(id => id !== votedForId);

      const votedForPlayer = await User.findByPk(votedForId);
      const voterPlayer = await User.findByPk(voterId);

      if (votedForPlayer && voterPlayer) {
        const notificationPromises = uniquePlayerIds.map(playerId =>
          Notification.create({
            user_id: playerId,
            type: 'MOTM_VOTE',
            title: 'Man of the Match Vote',
            body: `${voterPlayer.firstName} ${voterPlayer.lastName} voted for ${votedForPlayer.firstName} ${votedForPlayer.lastName} as MOTM`,
            meta: JSON.stringify({
              matchId,
              leagueId: match.leagueId,
              leagueName: (match as any).league?.name,
              voterId,
              votedForId,
              voterName: `${voterPlayer.firstName} ${voterPlayer.lastName}`,
              votedForName: `${votedForPlayer.firstName} ${votedForPlayer.lastName}`
            }),
            read: false
          } as any)
        );

        await Promise.all(notificationPromises);
        console.log(`✅ Sent ${uniquePlayerIds.length} MOTM vote notifications`);
      }
    }
  } catch (notifErr) {
    console.error('Error sending MOTM vote notifications:', notifErr);
  }

  try { cache.clearPattern(`match_votes_${matchId}_`); } catch {}

  ctx.body = { success: true, message: 'Vote recorded successfully' };
};

// Set match availability
export const setMatchAvailability = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const { matchId } = ctx.params;
  const userId = ctx.state.user.userId;
  const { available } = ctx.request.body as { available: boolean };

  if (typeof available !== 'boolean') {
    ctx.throw(400, 'available must be a boolean');
    return;
  }

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const [availability, created] = await MatchAvailability.findOrCreate({
      where: { match_id: matchId, user_id: userId },
      defaults: { match_id: matchId, user_id: userId, status: available ? 'available' : 'unavailable' }
    });

    if (!created) {
      await availability.update({ status: available ? 'available' : 'unavailable' });
    }

    ctx.body = { success: true, message: 'Availability updated', available };
  } catch (err) {
    console.error('Set availability error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to set availability' };
  }
};

// Update match goals
export const updateMatchGoals = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { homeTeamGoals, awayTeamGoals } = ctx.request.body as { homeTeamGoals?: number; awayTeamGoals?: number };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update goals');
      return;
    }

    const updateData: any = {};
    if (typeof homeTeamGoals === 'number') updateData.homeTeamGoals = homeTeamGoals;
    if (typeof awayTeamGoals === 'number') updateData.awayTeamGoals = awayTeamGoals;

    await match.update(updateData);

    // Send notification to both team captains after updating goals
    try {
      console.log('📧 Sending captain confirmation notifications for match:', matchId);
      await sendCaptainConfirmations(match, (match as any).league);
      console.log('✅ Captain notifications sent successfully');
    } catch (notifErr) {
      console.error('❌ Failed to send captain notifications:', notifErr);
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals
      }
    };
  } catch (err) {
    console.error('Update goals error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update goals' };
  }
};

// Update match note
export const updateMatchNote = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { note } = ctx.request.body as { note?: string };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    await match.update({ note: note || null } as any);

    ctx.body = {
      success: true,
      match: { id: match.id, note: (match as any).note }
    };
  } catch (err) {
    console.error('Update note error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update note' };
  }
};

// Confirm match result (for captains)
export const confirmMatchResult = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', attributes: ['id', 'name'] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    // Check if user is a captain
    const isHomeCaptain = match.homeCaptainId === userId;
    const isAwayCaptain = match.awayCaptainId === userId;

    if (!isHomeCaptain && !isAwayCaptain) {
      ctx.throw(403, 'Only team captains can confirm results');
      return;
    }

    // Update confirmation status
    const updateData: any = {};
    if (isHomeCaptain) {
      updateData.homeCaptainConfirmed = true;
      console.log(`✅ Home captain ${userId} confirmed result for match ${matchId}`);
    }
    if (isAwayCaptain) {
      updateData.awayCaptainConfirmed = true;
      console.log(`✅ Away captain ${userId} confirmed result for match ${matchId}`);
    }

    await match.update(updateData);

    // Check if both captains have confirmed
    const bothConfirmed = 
      (isHomeCaptain ? true : match.homeCaptainConfirmed) && 
      (isAwayCaptain ? true : match.awayCaptainConfirmed);

    if (bothConfirmed) {
      // Update match status to RESULT_PUBLISHED
      await match.update({ 
        status: 'RESULT_PUBLISHED',
        resultPublishedAt: new Date()
      });
      console.log(`🎉 Both captains confirmed - Match ${matchId} status updated to RESULT_PUBLISHED`);

      // Award XP to all players in this match
      try {
        const { awardXPForMatch } = await import('../utils/xpAchievementsEngine');
        await awardXPForMatch(matchId);
        console.log(`💰 XP awarded to players for match ${matchId}`);
      } catch (xpErr) {
        console.error('Failed to award XP for match:', xpErr);
      }

      // Send confirmation notification to the captain who just confirmed
      try {
        await notifyCaptainConfirmed(match, userId);
      } catch (notifErr) {
        console.error('Failed to send confirmation notification:', notifErr);
      }
    }

    ctx.body = {
      success: true,
      message: bothConfirmed ? 'Result confirmed by both captains' : 'Result confirmed',
      confirmed: true,
      bothConfirmed,
      match: {
        id: match.id,
        status: match.status,
        homeCaptainConfirmed: match.homeCaptainConfirmed,
        awayCaptainConfirmed: match.awayCaptainConfirmed
      }
    };
  } catch (err) {
    console.error('Confirm result error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to confirm result' };
  }
};

// Get stats window for match
export const getStatsWindow = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const statsWindow = await MatchStatistics.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position'] }]
    });

    ctx.body = {
      success: true,
      stats: statsWindow.map(s => ({
        userId: s.user_id,
        goals: s.goals,
        assists: s.assists,
        cleanSheets: s.cleanSheets,
        user: (s as any).user
      }))
    };
  } catch (err) {
    console.error('Get stats window error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch stats' };
  }
};

// Submit match stats
export const submitMatchStats = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const body = ctx.request.body as any;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  // Handle both single stats object and array of stats
  // Frontend sends single object: { playerId?, goals, assists, ... }
  // Or array: [{ playerId, goals, assists, ... }]
  let statsArray: Array<any>;
  
  if (Array.isArray(body.stats)) {
    // Legacy format: { stats: [...] }
    statsArray = body.stats;
  } else if (Array.isArray(body)) {
    // Array format: [...]
    statsArray = body;
  } else if (body.playerId || body.goals !== undefined) {
    // Single object format: { playerId, goals, assists, ... }
    // If no playerId, it's the current user submitting their own stats
    statsArray = [body];
  } else {
    ctx.throw(400, 'Invalid stats format');
    return;
  }

  try {
    const match = await Match.findByPk(matchId, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    
    // Allow both admins and players to submit their own stats
    const currentUserId = String(ctx.state.user.userId);
    
    for (const stat of statsArray) {
      // Determine target user: if playerId provided, use it; otherwise use current user
      const targetPlayerId = stat.playerId || currentUserId;
      const userId = await resolveTargetUserIdForMatch(targetPlayerId, matchId);
      
      // Check permissions: admins can edit anyone, players can only edit themselves
      if (!isAdmin && userId !== currentUserId) {
        ctx.throw(403, 'You can only submit your own stats');
        return;
      }
      
      const [statRecord] = await MatchStatistics.findOrCreate({
        where: { match_id: matchId, user_id: userId },
        defaults: {
          match_id: matchId,
          user_id: userId,
          goals: stat.goals || 0,
          assists: stat.assists || 0,
          cleanSheets: stat.cleanSheets || stat.cleanSheet || 0,
          penalties: stat.penalties || 0,
          freeKicks: stat.freeKicks || 0,
          yellowCards: stat.yellowCards || 0,
          redCards: stat.redCards || 0,
          defence: stat.defence || 0,
          impact: stat.impact || 0,
          minutesPlayed: stat.minutesPlayed || 0,
          rating: stat.rating || 0,
          xpAwarded: 0
        }
      });

      await statRecord.update({
        goals: stat.goals || 0,
        assists: stat.assists || 0,
        cleanSheets: stat.cleanSheets || stat.cleanSheet || 0,
        penalties: stat.penalties || 0,
        freeKicks: stat.freeKicks || 0,
        defence: stat.defence || 0,
        impact: stat.impact || 0
      });

      // Update cache
      try {
        cache.updateLeaderboard(`leaderboard_goals_${match.leagueId}_all`, { playerId: userId, value: stat.goals || 0 });
        cache.updateLeaderboard(`leaderboard_assists_${match.leagueId}_all`, { playerId: userId, value: stat.assists || 0 });
        if (stat.cleanSheet) {
          cache.updateLeaderboard(`leaderboard_cleanSheet_${match.leagueId}_all`, { playerId: userId, value: 1 });
        }
      } catch {}
    }

    ctx.body = { success: true, message: 'Stats submitted successfully' };
  } catch (err) {
    console.error('Submit stats error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to submit stats' };
  }
};

// Get match votes
export const getMatchVotes = async (ctx: Context) => {
  const { id: matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId || ctx.state.user.id;
  const cacheKey = `match_votes_${matchId}_${userId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }

  try {
    // Get all votes grouped by votedForId
    const votes = await Vote.findAll({
      where: { matchId },
      attributes: ['votedForId', [fn('COUNT', col('id')), 'count']],
      group: ['votedForId']
    });

    // Convert to object format { playerId: count }
    const votesObject: Record<string, number> = {};
    votes.forEach((v: any) => {
      votesObject[v.votedForId] = Number(v.get('count'));
    });

    // Get current user's vote
    const userVote = await Vote.findOne({
      where: { matchId, voterId: userId },
      attributes: ['votedForId']
    });

    const result = {
      success: true,
      votes: votesObject,
      userVote: userVote?.votedForId || null
    };

    cache.set(cacheKey, result, 60); // Cache for 1 minute
    ctx.body = result;
  } catch (err) {
    console.error('Get votes error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch votes' };
  }
};

// Get match by ID
export const getMatchById = async (ctx: Context) => {
  const { matchId } = ctx.params;

  try {
    console.log('🔍 Fetching match with ID:', matchId);
    
    const match = await Match.findByPk(matchId, {
      include: [
        { model: League, as: 'league', attributes: ['id', 'name'] },
        { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'shirtNumber', 'position'] }
      ]
    });

    console.log('🔍 Match query result:', match ? 'Found' : 'Not found');

    if (!match) {
      console.log('❌ Match not found in database');
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        date: match.date,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        status: match.status,
        league: (match as any).league,
        homeTeamUsers: (match as any).homeTeamUsers,
        awayTeamUsers: (match as any).awayTeamUsers
      }
    };
  } catch (err) {
    console.error('❌ Get match error:', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch match', error: err instanceof Error ? err.message : String(err) };
  }
};

// Get all matches
export const getAllMatches = async (ctx: Context) => {
  try {
    const matches = await Match.findAll({
      include: [
        { model: League, as: 'league', attributes: ['id', 'name'] }
      ],
      order: [['date', 'DESC']]
    });

    ctx.body = {
      success: true,
      matches: matches.map(m => ({
        id: m.id,
        date: m.date,
        status: m.status,
        homeTeamGoals: m.homeTeamGoals,
        awayTeamGoals: m.awayTeamGoals,
        league: (m as any).league
      }))
    };
  } catch (err) {
    console.error('Get all matches error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch matches' };
  }
};

// Get match stats
export const getMatchStats = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const stats = await MatchStatistics.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'profilePicture'] }]
    });

    ctx.body = {
      success: true,
      stats: stats.map(s => ({
        userId: s.user_id,
        goals: s.goals,
        assists: s.assists,
        cleanSheets: s.cleanSheets,
        user: (s as any).user
      }))
    };
  } catch (err) {
    console.error('Get match stats error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch stats' };
  }
};

// Get match availability
export const getMatchAvailability = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const availability = await MatchAvailability.findAll({
      where: { match_id: matchId },
      include: [{ model: User, as: 'userRecord', attributes: ['id', 'firstName', 'lastName', 'profilePicture'] }]
    });

    ctx.body = {
      success: true,
      availability: availability.map(a => ({
        userId: a.user_id,
        available: a.status === 'available',
        user: (a as any).userRecord
      })),
      // Also return just the available user IDs for simpler client consumption
      availableUserIds: availability
        .filter(a => a.status === 'available')
        .map(a => a.user_id)
    };
  } catch (err) {
    console.error('Get availability error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch availability' };
  }
};

// Update match
export const updateMatch = async (ctx: Context) => {
  const { id } = ctx.params;
  const { date, status, homeTeamGoals, awayTeamGoals } = ctx.request.body as any;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(id, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can update matches');
      return;
    }

    const updateData: any = {};
    if (date) updateData.date = new Date(date);
    if (status) updateData.status = status;
    if (typeof homeTeamGoals === 'number') updateData.homeTeamGoals = homeTeamGoals;
    if (typeof awayTeamGoals === 'number') updateData.awayTeamGoals = awayTeamGoals;

    await match.update(updateData);

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        date: match.date,
        status: match.status,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals
      }
    };
  } catch (err) {
    console.error('Update match error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to update match' };
  }
};

// Delete match
export const deleteMatch = async (ctx: Context) => {
  const { id } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const match = await Match.findByPk(id, {
      include: [{ model: League, as: 'league', include: [{ model: User, as: 'administeredLeagues', attributes: ['id'] }] }]
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    const isAdmin = (match as any).league?.administeredLeagues?.some((a: any) => String(a.id) === String(ctx.state.user.userId));
    if (!isAdmin) {
      ctx.throw(403, 'Only league admins can delete matches');
      return;
    }

    await match.destroy();

    ctx.body = {
      success: true,
      message: 'Match deleted successfully'
    };
  } catch (err) {
    console.error('Delete match error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to delete match' };
  }
};

// Check if match has stats
export const hasMatchStats = async (ctx: Context) => {
  const { id } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    const count = await MatchStatistics.count({ where: { match_id: id } });
    
    ctx.body = {
      success: true,
      hasStats: count > 0,
      count
    };
  } catch (err) {
    console.error('Check stats error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to check stats' };
  }
};

// Get captain picks
export const getCaptainPicks = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const cacheKey = `captain_picks_${matchId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    const result = {
      success: true,
      home: {
        defence: match.homeDefensiveImpactId || null,
        influence: match.homeMentalityId || null
      },
      away: {
        defence: match.awayDefensiveImpactId || null,
        influence: match.awayMentalityId || null
      }
    };

    cache.set(cacheKey, result, 300);
    ctx.body = result;
  } catch (err) {
    console.error('Get captain picks error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch captain picks' };
  }
};

// Submit captain picks (Defensive Impact and Mentality)
export const submitCaptainPicks = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const { category, playerId } = ctx.request.body as { category: 'defence' | 'influence'; playerId: string };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId || ctx.state.user.id;

  try {
    const match = await Match.findByPk(matchId);
    if (!match) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }

    // Check if user is a captain
    const isHomeCaptain = match.homeCaptainId === userId;
    const isAwayCaptain = match.awayCaptainId === userId;

    if (!isHomeCaptain && !isAwayCaptain) {
      ctx.status = 403;
      ctx.body = { success: false, message: 'Only team captains can save picks' };
      return;
    }

    // Update appropriate field based on team and category
    if (isHomeCaptain) {
      if (category === 'defence') {
        await match.update({ homeDefensiveImpactId: playerId });
      } else if (category === 'influence') {
        await match.update({ homeMentalityId: playerId });
      }
    } else if (isAwayCaptain) {
      if (category === 'defence') {
        await match.update({ awayDefensiveImpactId: playerId });
      } else if (category === 'influence') {
        await match.update({ awayMentalityId: playerId });
      }
    }

    // Clear cache
    cache.del(`captain_picks_${matchId}`);
    cache.del(`match_${matchId}`);

    ctx.body = {
      success: true,
      message: 'Captain pick saved'
    };
  } catch (err) {
    console.error('Submit captain pick error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to submit captain pick' };
  }
};

// Get match prediction
export const getMatchPrediction = async (ctx: Context) => {
  const { matchId } = ctx.params;

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;

  try {
    const MatchPrediction = (models as any).MatchPrediction;
    if (!MatchPrediction) {
      ctx.throw(404, 'MatchPrediction model not found');
      return;
    }
    const prediction = await MatchPrediction.findOne({
      where: { matchId, userId }
    });

    if (!prediction) {
      ctx.body = { success: true, prediction: null };
      return;
    }

    ctx.body = {
      success: true,
      prediction: {
        homeGoals: prediction.homeGoals,
        awayGoals: prediction.awayGoals,
        correct: prediction.correct
      }
    };
  } catch (err) {
    console.error('Get prediction error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch prediction' };
  }
};

// Submit match prediction (supports both goal predictions and team strength analysis)
export const submitMatchPrediction = async (ctx: Context) => {
  const { matchId } = ctx.params;
  const body = ctx.request.body as { 
    homeGoals?: number | string; 
    awayGoals?: number | string;
    homeIds?: string[];
    awayIds?: string[];
    homeTotal?: number;
    awayTotal?: number;
  };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  const userId = ctx.state.user.userId;

  // Check if this is a team strength analysis request (homeIds/awayIds provided)
  if (body.homeIds !== undefined || body.awayIds !== undefined) {
    try {
      const homeIds = body.homeIds || [];
      const awayIds = body.awayIds || [];
      const homeTotal = body.homeTotal || homeIds.length;
      const awayTotal = body.awayTotal || awayIds.length;

      // Calculate team strength based on player XP/stats
      let homeXPSum = 0;
      let awayXPSum = 0;

      // Fetch XP for home team players
      if (homeIds.length > 0) {
        const homePlayers = await User.findAll({
          where: { id: { [Op.in]: homeIds } },
          attributes: ['id', 'xp']
        });
        homeXPSum = homePlayers.reduce((sum: number, p: any) => sum + (p.xp || 0), 0);
      }

      // Fetch XP for away team players
      if (awayIds.length > 0) {
        const awayPlayers = await User.findAll({
          where: { id: { [Op.in]: awayIds } },
          attributes: ['id', 'xp']
        });
        awayXPSum = awayPlayers.reduce((sum: number, p: any) => sum + (p.xp || 0), 0);
      }

      // Calculate averages
      const homeAvg = homeTotal > 0 ? homeXPSum / homeTotal : 0;
      const awayAvg = awayTotal > 0 ? awayXPSum / awayTotal : 0;

      // Calculate win percentages
      const total = homeAvg + awayAvg;
      const homeWinPct = total > 0 ? Math.round((homeAvg / total) * 100) : 50;
      const awayWinPct = total > 0 ? Math.round((awayAvg / total) * 100) : 50;

      ctx.body = {
        success: true,
        home: {
          average: homeAvg,
          winPct: homeWinPct
        },
        away: {
          average: awayAvg,
          winPct: awayWinPct
        }
      };
      return;
    } catch (err) {
      console.error('Team strength analysis error:', err);
      ctx.status = 500;
      ctx.body = { success: false, message: 'Failed to calculate team strength' };
      return;
    }
  }
  
  // Otherwise, handle goal prediction
  const homeGoals = typeof body.homeGoals === 'number' ? body.homeGoals : parseInt(String(body.homeGoals), 10);
  const awayGoals = typeof body.awayGoals === 'number' ? body.awayGoals : parseInt(String(body.awayGoals), 10);

  if (isNaN(homeGoals) || isNaN(awayGoals)) {
    ctx.throw(400, 'homeGoals and awayGoals must be valid numbers');
    return;
  }

  try {
    const MatchPrediction = (models as any).MatchPrediction;
    if (!MatchPrediction) {
      ctx.throw(404, 'MatchPrediction model not found');
      return;
    }
    const [prediction, created] = await MatchPrediction.findOrCreate({
      where: { matchId, userId },
      defaults: { matchId, userId, homeGoals, awayGoals, correct: false }
    });

    if (!created) {
      await prediction.update({ homeGoals, awayGoals });
    }

    ctx.body = {
      success: true,
      message: 'Prediction submitted',
      prediction: { homeGoals, awayGoals }
    };
  } catch (err) {
    console.error('Submit prediction error', err);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to submit prediction' };
  }
};

// Export all functions
export {
  // All exported above
};