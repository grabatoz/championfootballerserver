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

  // Get old vote to subtract XP from previous voted player
  const oldVote = await Vote.findOne({ where: { matchId, voterId } });
  const oldVotedForId = oldVote?.votedForId;

  if (!votedForId) {
    // Removing vote - subtract XP from previously voted player
    if (oldVotedForId) {
      try {
        const match = await Match.findByPk(matchId);
        if (match) {
          const homeGoals = match.homeTeamGoals ?? 0;
          const awayGoals = match.awayTeamGoals ?? 0;
          const homeTeamUserIds = await sequelize.query<{ userId: string }>(
            `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = $1`,
            { bind: [matchId], type: QueryTypes.SELECT }
          );
          const awayTeamUserIds = await sequelize.query<{ userId: string }>(
            `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = $1`,
            { bind: [matchId], type: QueryTypes.SELECT }
          );
          const isHome = homeTeamUserIds.some(u => String(u.userId) === String(oldVotedForId));
          const isAway = awayTeamUserIds.some(u => String(u.userId) === String(oldVotedForId));
          let teamResult: 'win' | 'draw' | 'lose' = 'lose';
          if (isHome && homeGoals > awayGoals) teamResult = 'win';
          else if (isAway && awayGoals > homeGoals) teamResult = 'win';
          else if (homeGoals === awayGoals) teamResult = 'draw';
          
          const voteXP = teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose;
          const userResult = await sequelize.query(
            `SELECT id, "firstName", xp FROM users WHERE id = $1`,
            { bind: [oldVotedForId], type: QueryTypes.SELECT }
          );
          if (userResult.length > 0) {
            const user = userResult[0] as any;
            const newXP = Math.max(0, (user.xp || 0) - voteXP);
            await sequelize.query(`UPDATE users SET xp = $1 WHERE id = $2`, { bind: [newXP, oldVotedForId] });
            console.log(`🗳️ Vote removed - ${user.firstName} lost -${voteXP} XP`);
          }
        }
      } catch (e) { console.error('Error removing vote XP:', e); }
    }
    await Vote.destroy({ where: { matchId, voterId } });
    try { cache.clearPattern(`match_votes_${matchId}_`); } catch {}
    ctx.status = 200;
    ctx.body = { success: true, message: 'Vote removed.' };
    return;
  }

  if (voterId === votedForId) {
    ctx.throw(400, 'You cannot vote for yourself.');
  }

  // If changing vote, subtract XP from old voted player first
  if (oldVotedForId && oldVotedForId !== votedForId) {
    try {
      const match = await Match.findByPk(matchId);
      if (match) {
        const homeGoals = match.homeTeamGoals ?? 0;
        const awayGoals = match.awayTeamGoals ?? 0;
        const homeTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = $1`,
          { bind: [matchId], type: QueryTypes.SELECT }
        );
        const awayTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = $1`,
          { bind: [matchId], type: QueryTypes.SELECT }
        );
        const isHome = homeTeamUserIds.some(u => String(u.userId) === String(oldVotedForId));
        const isAway = awayTeamUserIds.some(u => String(u.userId) === String(oldVotedForId));
        let teamResult: 'win' | 'draw' | 'lose' = 'lose';
        if (isHome && homeGoals > awayGoals) teamResult = 'win';
        else if (isAway && awayGoals > homeGoals) teamResult = 'win';
        else if (homeGoals === awayGoals) teamResult = 'draw';
        
        const voteXP = teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose;
        const userResult = await sequelize.query(
          `SELECT id, "firstName", xp FROM users WHERE id = $1`,
          { bind: [oldVotedForId], type: QueryTypes.SELECT }
        );
        if (userResult.length > 0) {
          const user = userResult[0] as any;
          const newXP = Math.max(0, (user.xp || 0) - voteXP);
          await sequelize.query(`UPDATE users SET xp = $1 WHERE id = $2`, { bind: [newXP, oldVotedForId] });
          console.log(`🗳️ Vote changed - ${user.firstName} lost -${voteXP} XP`);
        }
      }
    } catch (e) { console.error('Error removing old vote XP:', e); }
  }

  await Vote.destroy({ where: { matchId, voterId } });
  await Vote.create({ matchId, voterId, votedForId });

  console.log(`🗳️ Vote created - voterId: ${voterId}, votedForId: ${votedForId}, matchId: ${matchId}`);
  console.log(`🗳️ Old vote was for: ${oldVotedForId || 'none'}`);

  // 🗳️ Award XP to the voted player immediately (skip if same player)
  if (!oldVotedForId || oldVotedForId !== votedForId) {
    console.log(`🗳️ Processing XP award for ${votedForId}...`);
    try {
      const match = await Match.findByPk(matchId);
      console.log(`🗳️ Match found: ${match ? 'YES' : 'NO'}`);
      
      if (match) {
        // Determine if voted player's team won, lost, or drew
        const homeGoals = match.homeTeamGoals ?? 0;
        const awayGoals = match.awayTeamGoals ?? 0;
        console.log(`🗳️ Score: Home ${homeGoals} - Away ${awayGoals}`);
        
        // Check if voted player is in home or away team
        const homeTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = $1`,
          { bind: [matchId], type: QueryTypes.SELECT }
        );
        const awayTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = $1`,
          { bind: [matchId], type: QueryTypes.SELECT }
        );
        
        console.log(`🗳️ Home team users: ${JSON.stringify(homeTeamUserIds)}`);
        console.log(`🗳️ Away team users: ${JSON.stringify(awayTeamUserIds)}`);
        
        const isHome = homeTeamUserIds.some(u => String(u.userId) === String(votedForId));
        const isAway = awayTeamUserIds.some(u => String(u.userId) === String(votedForId));
        console.log(`🗳️ VotedFor isHome: ${isHome}, isAway: ${isAway}`);
      
        let teamResult: 'win' | 'draw' | 'lose' = 'lose';
        if (isHome && homeGoals > awayGoals) teamResult = 'win';
        else if (isAway && awayGoals > homeGoals) teamResult = 'win';
        else if (homeGoals === awayGoals) teamResult = 'draw';
        console.log(`🗳️ Team result: ${teamResult}`);
        
        // Award motmVote XP for this single vote
        const voteXP = teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose;
        console.log(`🗳️ Vote XP to award: ${voteXP}`);
        
        // Get current user XP and add vote XP
        const userResult = await sequelize.query(
          `SELECT id, "firstName", xp FROM users WHERE id = $1`,
          { bind: [votedForId], type: QueryTypes.SELECT }
        );
        console.log(`🗳️ User query result: ${JSON.stringify(userResult)}`);
        
        if (userResult.length > 0) {
          const user = userResult[0] as any;
          const currentXP = user.xp || 0;
          const newXP = currentXP + voteXP;
          
          console.log(`🗳️ Updating user XP: ${currentXP} + ${voteXP} = ${newXP}`);
          
          const updateResult = await sequelize.query(
            `UPDATE users SET xp = $1 WHERE id = $2 RETURNING id, xp`,
            { bind: [newXP, votedForId], type: QueryTypes.UPDATE }
          );
          console.log(`🗳️ Update result: ${JSON.stringify(updateResult)}`);
          
          // Verify the update
          const verifyResult = await sequelize.query(
            `SELECT id, "firstName", xp FROM users WHERE id = $1`,
            { bind: [votedForId], type: QueryTypes.SELECT }
          );
          console.log(`🗳️ VERIFIED - User XP after update: ${JSON.stringify(verifyResult)}`);
          
          console.log(`✅ MOTM Vote XP awarded! ${user.firstName} received +${voteXP} XP (${currentXP} → ${newXP})`);
        } else {
          console.log(`❌ User not found with id: ${votedForId}`);
        }
      }
    } catch (voteXpErr: any) {
      console.error('⚠️ Error awarding vote XP:', voteXpErr);
      console.error('⚠️ Error message:', voteXpErr?.message);
      console.error('⚠️ Error stack:', voteXpErr?.stack);
    }
  } else {
    console.log(`🗳️ Skipping XP - same player voted again`);
  }

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
  const body = ctx.request.body as { available?: boolean | string };
  
  // Check for action in query params first (client sends ?action=available or ?action=unavailable)
  const actionQuery = ctx.query.action as string | undefined;
  
  // Handle both query param and body
  let available: boolean;
  if (actionQuery) {
    // Query param takes precedence
    available = actionQuery.toLowerCase() === 'available';
  } else if (typeof body.available === 'boolean') {
    available = body.available;
  } else if (typeof body.available === 'string') {
    available = body.available.toLowerCase() === 'true' || body.available.toLowerCase() === 'available';
  } else {
    // Default to true if nothing provided
    available = true;
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

    console.log(`🔍 Captain confirmation check for match ${matchId}:`);
    console.log(`   isHomeCaptain: ${isHomeCaptain}, isAwayCaptain: ${isAwayCaptain}`);
    console.log(`   homeCaptainConfirmed: ${match.homeCaptainConfirmed}, awayCaptainConfirmed: ${match.awayCaptainConfirmed}`);
    console.log(`   bothConfirmed: ${bothConfirmed}`);

    if (bothConfirmed) {
      // Update match status to RESULT_PUBLISHED
      await match.update({ 
        status: 'RESULT_PUBLISHED',
        resultPublishedAt: new Date()
      });
      console.log(`🎉 Both captains confirmed - Match ${matchId} status updated to RESULT_PUBLISHED`);

      // NOTE: XP is now awarded IMMEDIATELY when stats are submitted (in submitMatchStats)
      // NO MORE XP awarding here to prevent DOUBLE XP
      console.log(`ℹ️ XP already awarded during stats submission - skipping here to prevent double XP`);

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
    
    console.log(`📊 Stats submission - Request body:`, JSON.stringify(statsArray, null, 2));
    
    for (const stat of statsArray) {
      // Determine target user: if playerId provided, use it; otherwise use current user
      const targetPlayerId = stat.playerId || currentUserId;
      const userId = await resolveTargetUserIdForMatch(targetPlayerId, matchId);
      
      console.log(`📊 Processing stats for user ${userId}:`, {
        goals: stat.goals,
        assists: stat.assists,
        cleanSheets: stat.cleanSheets || stat.cleanSheet,
        defence: stat.defence,
        impact: stat.impact
      });
      
      // Check permissions: admins can edit anyone, players can only edit themselves
      if (!isAdmin && userId !== currentUserId) {
        ctx.throw(403, 'You can only submit your own stats');
        return;
      }
      
      const [statRecord, created] = await MatchStatistics.findOrCreate({
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

      console.log(`📊 Stats record ${created ? 'CREATED' : 'FOUND'} for user ${userId}`);

      const updateData = {
        goals: stat.goals || 0,
        assists: stat.assists || 0,
        cleanSheets: stat.cleanSheets || stat.cleanSheet || 0,
        penalties: stat.penalties || 0,
        freeKicks: stat.freeKicks || 0,
        defence: stat.defence || 0,
        impact: stat.impact || 0
      };
      
      console.log(`📊 Updating stats for user ${userId}:`, updateData);
      
      await statRecord.update(updateData);
      
      // Verify stats were saved correctly
      const verifyStats = await MatchStatistics.findOne({
        where: { match_id: matchId, user_id: userId }
      });
      console.log(`✅ Stats VERIFIED in DB for user ${userId}:`, {
        match_id: verifyStats?.match_id,
        user_id: verifyStats?.user_id,
        goals: verifyStats?.goals,
        assists: verifyStats?.assists,
        cleanSheets: verifyStats?.cleanSheets
      });

      // 🎮 IMMEDIATELY AWARD XP when stats are submitted (or UPDATE if stats changed)
      try {
        const homeTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserHomeMatches" WHERE "matchId" = :matchId`,
          { replacements: { matchId }, type: QueryTypes.SELECT }
        );
        const awayTeamUserIds = await sequelize.query<{ userId: string }>(
          `SELECT DISTINCT "userId" FROM "UserAwayMatches" WHERE "matchId" = :matchId`,
          { replacements: { matchId }, type: QueryTypes.SELECT }
        );
        
        const isHome = homeTeamUserIds.some(u => u.userId === userId);
        const isAway = awayTeamUserIds.some(u => u.userId === userId);
        const homeGoals = match.homeTeamGoals ?? 0;
        const awayGoals = match.awayTeamGoals ?? 0;
        
        let teamResult: 'win' | 'draw' | 'lose' = 'lose';
        if (isHome && homeGoals > awayGoals) teamResult = 'win';
        else if (isAway && awayGoals > homeGoals) teamResult = 'win';
        else if (homeGoals === awayGoals) teamResult = 'draw';
        
        let newXpToAward = 0;
        const breakdown: string[] = [];
        
        // Win/Draw/Loss
        if (teamResult === 'win') {
          newXpToAward += xpPointsTable.winningTeam;
          breakdown.push(`Win: +${xpPointsTable.winningTeam}`);
        } else if (teamResult === 'draw') {
          newXpToAward += xpPointsTable.draw;
          breakdown.push(`Draw: +${xpPointsTable.draw}`);
        } else {
          newXpToAward += xpPointsTable.losingTeam;
          breakdown.push(`Loss: +${xpPointsTable.losingTeam}`);
        }
        
        // Goals
        if (stat.goals > 0) {
          const goalXP = (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals;
          newXpToAward += goalXP;
          breakdown.push(`Goals (${stat.goals}): +${goalXP}`);
        }
        
        // Assists
        if (stat.assists > 0) {
          const assistXP = (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists;
          newXpToAward += assistXP;
          breakdown.push(`Assists (${stat.assists}): +${assistXP}`);
        }
        
        // Clean Sheets
        const cleanSheets = stat.cleanSheets || stat.cleanSheet || 0;
        if (cleanSheets > 0) {
          const cleanSheetXP = xpPointsTable.cleanSheet * cleanSheets;
          newXpToAward += cleanSheetXP;
          breakdown.push(`Clean Sheets (${cleanSheets}): +${cleanSheetXP}`);
        }
        
        // � MOTM (Man of the Match) XP - Check votes received by this user
        try {
          // Get all votes for this match where this user was voted for
          const votesResult = await sequelize.query(
            `SELECT COUNT(*) as vote_count FROM "Votes" WHERE "matchId" = $1 AND "votedForId" = $2`,
            { bind: [matchId, userId], type: QueryTypes.SELECT }
          );
          
          const voteCount = parseInt((votesResult[0] as any)?.vote_count || '0', 10);
          
          if (voteCount > 0) {
            // Individual vote XP (motmVote) - XP for each vote received
            const voteXP = (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCount;
            newXpToAward += voteXP;
            breakdown.push(`MOTM Votes (${voteCount}): +${voteXP}`);
            console.log(`🗳️ User ${userId} received ${voteCount} MOTM votes - +${voteXP} XP`);
            
            // Check if this user has the MOST votes (is the actual MOTM winner)
            const mostVotesResult = await sequelize.query(
              `SELECT "votedForId", COUNT(*) as vote_count 
               FROM "Votes" 
               WHERE "matchId" = $1 
               GROUP BY "votedForId" 
               ORDER BY vote_count DESC 
               LIMIT 1`,
              { bind: [matchId], type: QueryTypes.SELECT }
            );
            
            // MOTM Winner bonus removed - only individual votes count
          }
        } catch (motmErr) {
          console.error('⚠️ Error checking MOTM votes:', motmErr);
        }
        
        // �🏆 CAPTAIN PICKS XP - Check if this user was selected for captain picks
        try {
          // Get captain picks for this match (both home and away teams)
          // Table name is "Matches" (with capital M) in database
          const captainPicksResult = await sequelize.query(
            `SELECT "homeDefensiveImpactId", "awayDefensiveImpactId", "homeMentalityId", "awayMentalityId" FROM "Matches" WHERE id = $1`,
            { bind: [matchId], type: QueryTypes.SELECT }
          );
          
          if (captainPicksResult.length > 0) {
            const picks = captainPicksResult[0] as any;
            console.log(`🏆 Captain Picks for match ${matchId}:`, JSON.stringify(picks));
            
            // Defensive Impact XP - check both home and away picks
            const isDefensivePick = 
              (picks.homeDefensiveImpactId && String(picks.homeDefensiveImpactId) === String(userId)) ||
              (picks.awayDefensiveImpactId && String(picks.awayDefensiveImpactId) === String(userId));
            
            if (isDefensivePick) {
              const defenseXP = teamResult === 'win' ? xpPointsTable.defensiveImpact.win : xpPointsTable.defensiveImpact.lose;
              newXpToAward += defenseXP;
              breakdown.push(`Defensive Impact (Captain Pick): +${defenseXP}`);
              console.log(`🛡️ User ${userId} selected for Defensive Impact - +${defenseXP} XP`);
            }
            
            // Mentality XP - check both home and away picks
            const isMentalityPick = 
              (picks.homeMentalityId && String(picks.homeMentalityId) === String(userId)) ||
              (picks.awayMentalityId && String(picks.awayMentalityId) === String(userId));
            
            if (isMentalityPick) {
              const mentalityXP = teamResult === 'win' ? xpPointsTable.mentality.win : xpPointsTable.mentality.lose;
              newXpToAward += mentalityXP;
              breakdown.push(`Mentality (Captain Pick): +${mentalityXP}`);
              console.log(`💪 User ${userId} selected for Mentality - +${mentalityXP} XP`);
            }
          }
        } catch (captainErr) {
          console.error('⚠️ Error checking captain picks:', captainErr);
        }
        
        console.log(`🎮 XP CALCULATION for user ${userId}:`);
        console.log(`   Team Result: ${teamResult.toUpperCase()}`);
        console.log(`   Breakdown: ${breakdown.join(', ')}`);
        console.log(`   New XP to award: +${newXpToAward}`);
        
        // 💰 CHECK IF XP WAS ALREADY AWARDED (for stat updates)
        // Table name is "match_statistics" (snake_case) in database
        console.log(`🔍 Checking existing XP for matchId=${matchId}, userId=${userId}`);
        
        const existingXPResult = await sequelize.query(
          `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
          { bind: [matchId, userId], type: QueryTypes.SELECT }
        );
        
        console.log(`🔍 Existing XP Query Result:`, JSON.stringify(existingXPResult));
        
        const previouslyAwardedXP = (existingXPResult[0] as any)?.xp_awarded || 0;
        const xpDifference = newXpToAward - previouslyAwardedXP;
        
        console.log(`📊 XP UPDATE CHECK:`);
        console.log(`   Previously awarded XP: ${previouslyAwardedXP}`);
        console.log(`   New XP to award: ${newXpToAward}`);
        console.log(`   Difference (to add/subtract): ${xpDifference > 0 ? '+' : ''}${xpDifference}`);
        
        // Get current user XP
        const userResult = await sequelize.query(
          `SELECT id, "firstName", xp FROM users WHERE id = $1`,
          { bind: [userId], type: QueryTypes.SELECT }
        );
        
        console.log(`🔍 User Query Result:`, JSON.stringify(userResult));
        
        if (userResult.length > 0) {
          const user = userResult[0] as any;
          const currentXP = user.xp || 0;
          const finalXP = Math.max(0, currentXP + xpDifference); // Ensure XP doesn't go negative
          
          console.log(`📝 Updating user XP: ${currentXP} + (${xpDifference}) = ${finalXP}`);
          
          // Update user XP using raw SQL (add or subtract the difference)
          const updateUserResult = await sequelize.query(
            `UPDATE users SET xp = $1 WHERE id = $2 RETURNING xp`,
            { bind: [finalXP, userId], type: QueryTypes.UPDATE }
          );
          console.log(`📝 User XP Update Result:`, JSON.stringify(updateUserResult));
          
          // Update match_statistics with new xp_awarded value
          const updateStatsResult = await sequelize.query(
            `UPDATE match_statistics SET xp_awarded = $1 WHERE match_id = $2 AND user_id = $3 RETURNING xp_awarded`,
            { bind: [newXpToAward, matchId, userId], type: QueryTypes.UPDATE }
          );
          console.log(`📝 match_statistics Update Result:`, JSON.stringify(updateStatsResult));
          
          if (xpDifference > 0) {
            console.log(`💰 XP ADDED! User ${userId} (${user.firstName}): +${xpDifference} XP`);
          } else if (xpDifference < 0) {
            console.log(`📉 XP REDUCED! User ${userId} (${user.firstName}): ${xpDifference} XP`);
          } else {
            console.log(`⚖️ XP UNCHANGED! User ${userId} (${user.firstName}): No change`);
          }
          console.log(`   Total XP: ${currentXP} → ${finalXP}`);
          
          // Verify both tables
          const verifyUser = await sequelize.query(
            `SELECT xp FROM users WHERE id = $1`,
            { bind: [userId], type: QueryTypes.SELECT }
          );
          const verifyStats = await sequelize.query(
            `SELECT xp_awarded FROM match_statistics WHERE match_id = $1 AND user_id = $2`,
            { bind: [matchId, userId], type: QueryTypes.SELECT }
          );
          console.log(`   ✅ VERIFIED - users.xp: ${(verifyUser[0] as any)?.xp}`);
          console.log(`   ✅ VERIFIED - match_statistics.xp_awarded: ${(verifyStats[0] as any)?.xp_awarded}`);
        } else {
          console.log(`❌ User not found with id: ${userId}`);
        }
      } catch (xpErr: any) {
        console.error('⚠️ Could not award XP - FULL ERROR:', xpErr);
        console.error('⚠️ Error message:', xpErr?.message);
        console.error('⚠️ Error stack:', xpErr?.stack);
      }

      console.log(`🏁 XP Processing complete for user ${userId}`);

      // Update cache
      try {
        cache.updateLeaderboard(`leaderboard_goals_${match.leagueId}_all`, { playerId: userId, value: stat.goals || 0 });
        cache.updateLeaderboard(`leaderboard_assists_${match.leagueId}_all`, { playerId: userId, value: stat.assists || 0 });
        if (stat.cleanSheet) {
          cache.updateLeaderboard(`leaderboard_cleanSheet_${match.leagueId}_all`, { playerId: userId, value: 1 });
        }
      } catch {}
    }

    console.log(`✅ Stats submission complete - sending response`);
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
  const { playerId } = ctx.query as { playerId?: string };

  if (!ctx.state.user) {
    ctx.throw(401, 'Unauthorized');
    return;
  }

  try {
    // If playerId is provided, get stats for that specific player only
    if (playerId) {
      const stat = await MatchStatistics.findOne({
        where: { match_id: matchId, user_id: playerId },
        include: [{ model: User, as: 'user', attributes: ['id', 'firstName', 'lastName', 'profilePicture'] }]
      });

      if (stat) {
        ctx.body = {
          success: true,
          stats: {
            userId: stat.user_id,
            goals: stat.goals,
            assists: stat.assists,
            cleanSheets: stat.cleanSheets,
            penalties: stat.penalties,
            freeKicks: stat.freeKicks,
            defence: stat.defence,
            impact: stat.impact,
            user: (stat as any).user
          }
        };
      } else {
        ctx.body = {
          success: true,
          stats: null
        };
      }
      return;
    }

    // Otherwise, get all stats for the match
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
        penalties: s.penalties,
        freeKicks: s.freeKicks,
        defence: s.defence,
        impact: s.impact,
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
  const { date, status, homeTeamGoals, awayTeamGoals, archived } = ctx.request.body as any;

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
    if (typeof archived === 'boolean') updateData.archived = archived;

    await match.update(updateData);

    ctx.body = {
      success: true,
      match: {
        id: match.id,
        date: match.date,
        status: match.status,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        archived: match.archived
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

// ============================================================================
// DEBUG: Get XP breakdown for a match - shows who got what XP and why
// ============================================================================
export const getMatchXPBreakdown = async (ctx: Context) => {
  const { matchId } = ctx.params;
  
  console.log('📊 [XP DEBUG] Getting XP breakdown for match:', matchId);
  
  try {
    // 1. Get match details
    const match = await sequelize.query(`
      SELECT m.id, m."homeTeamGoals", m."awayTeamGoals", m.status,
             m."homeCaptainId", m."awayCaptainId",
             m."homeDefensiveImpactId", m."awayDefensiveImpactId",
             m."homeMentalityId", m."awayMentalityId",
             m."homeTeamName", m."awayTeamName"
      FROM "Matches" m
      WHERE m.id = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    if (!match || match.length === 0) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'Match not found' };
      return;
    }
    
    const matchData = match[0] as any;
    console.log('📊 [XP DEBUG] Match data:', matchData);
    
    // 2. Determine match result
    const homeGoals = matchData.homeTeamGoals || 0;
    const awayGoals = matchData.awayTeamGoals || 0;
    let matchResult = 'draw';
    if (homeGoals > awayGoals) matchResult = 'home_win';
    else if (awayGoals > homeGoals) matchResult = 'away_win';
    
    // 3. Get all match statistics for this match
    const stats = await sequelize.query(`
      SELECT ms.*, u."firstName", u."lastName", u.xp as "currentUserXP"
      FROM match_statistics ms
      JOIN users u ON ms."userId" = u.id
      WHERE ms."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    console.log('📊 [XP DEBUG] Found stats for', stats.length, 'players');
    
    // 4. Get home and away team users
    const homeUsers = await sequelize.query(`
      SELECT u.id, u."firstName", u."lastName", u.xp
      FROM users u
      JOIN "UserHomeMatches" uhm ON u.id = uhm."userId"
      WHERE uhm."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    const awayUsers = await sequelize.query(`
      SELECT u.id, u."firstName", u."lastName", u.xp
      FROM users u
      JOIN "UserAwayMatches" uam ON u.id = uam."userId"
      WHERE uam."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    // 5. Get MOTM votes
    const votes = await sequelize.query(`
      SELECT v.*, 
             voter."firstName" as "voterFirstName", voter."lastName" as "voterLastName",
             voted."firstName" as "votedFirstName", voted."lastName" as "votedLastName"
      FROM "Votes" v
      JOIN users voter ON v."voterId" = voter.id
      JOIN users voted ON v."votedForId" = voted.id
      WHERE v."matchId" = :matchId
    `, {
      replacements: { matchId },
      type: QueryTypes.SELECT
    });
    
    // 6. Count votes per player
    const voteCountMap: Record<string, number> = {};
    for (const v of votes as any[]) {
      const votedId = String(v.votedForId);
      voteCountMap[votedId] = (voteCountMap[votedId] || 0) + 1;
    }
    
    // Find MOTM winner (most votes)
    let motmWinnerId: string | null = null;
    let maxVotes = 0;
    for (const [userId, count] of Object.entries(voteCountMap)) {
      if (count > maxVotes) {
        maxVotes = count;
        motmWinnerId = userId;
      }
    }
    
    // 7. XP Points Table (hardcoded for reference)
    const xpTable = {
      winningTeam: 30,
      draw: 15,
      losingTeam: 10,
      cleanSheet: 5,
      goal: { win: 3, lose: 2 },
      assist: { win: 2, lose: 1 },
      motmVote: { win: 2, lose: 1 },
      defensiveImpact: { win: 2, lose: 1 },
      mentality: { win: 2, lose: 2 }
    };
    
    // 8. Build detailed breakdown for each player
    const playerBreakdown: any[] = [];
    
    // Process home team
    for (const user of homeUsers as any[]) {
      const userId = String(user.id);
      const playerStats = (stats as any[]).find(s => String(s.userId) === userId);
      const isWinningTeam = matchResult === 'home_win';
      const isLosingTeam = matchResult === 'away_win';
      const isDraw = matchResult === 'draw';
      
      const breakdown: any = {
        id: userId,
        name: `${user.firstName} ${user.lastName}`,
        team: 'home',
        currentXP: user.xp,
        xpAwardedInMatch: playerStats?.xp_awarded || 0,
        stats: playerStats ? {
          goals: playerStats.goals || 0,
          assists: playerStats.assists || 0,
          cleanSheets: playerStats.cleanSheets || 0
        } : null,
        xpBreakdown: {
          teamResult: {
            type: isWinningTeam ? 'WIN' : (isDraw ? 'DRAW' : 'LOSS'),
            xp: isWinningTeam ? xpTable.winningTeam : (isDraw ? xpTable.draw : xpTable.losingTeam)
          },
          goals: playerStats ? {
            count: playerStats.goals || 0,
            xpPerGoal: isWinningTeam ? xpTable.goal.win : xpTable.goal.lose,
            totalXP: (playerStats.goals || 0) * (isWinningTeam ? xpTable.goal.win : xpTable.goal.lose)
          } : null,
          assists: playerStats ? {
            count: playerStats.assists || 0,
            xpPerAssist: isWinningTeam ? xpTable.assist.win : xpTable.assist.lose,
            totalXP: (playerStats.assists || 0) * (isWinningTeam ? xpTable.assist.win : xpTable.assist.lose)
          } : null,
          cleanSheets: playerStats ? {
            count: playerStats.cleanSheets || 0,
            xpPerCleanSheet: xpTable.cleanSheet,
            totalXP: (playerStats.cleanSheets || 0) * xpTable.cleanSheet
          } : null,
          motmVotes: {
            received: voteCountMap[userId] || 0,
            xpPerVote: isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose,
            totalXP: (voteCountMap[userId] || 0) * (isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose)
          },
          captainPicks: {
            defensiveImpact: String(matchData.homeDefensiveImpactId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.defensiveImpact.win : xpTable.defensiveImpact.lose
            } : null,
            mentality: String(matchData.homeMentalityId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.mentality.win : xpTable.mentality.lose
            } : null
          }
        },
        calculatedTotalXP: 0
      };
      
      // Calculate total
      let total = breakdown.xpBreakdown.teamResult.xp;
      if (breakdown.xpBreakdown.goals) total += breakdown.xpBreakdown.goals.totalXP;
      if (breakdown.xpBreakdown.assists) total += breakdown.xpBreakdown.assists.totalXP;
      if (breakdown.xpBreakdown.cleanSheets) total += breakdown.xpBreakdown.cleanSheets.totalXP;
      total += breakdown.xpBreakdown.motmVotes.totalXP;
      if (breakdown.xpBreakdown.captainPicks.defensiveImpact) total += breakdown.xpBreakdown.captainPicks.defensiveImpact.xp;
      if (breakdown.xpBreakdown.captainPicks.mentality) total += breakdown.xpBreakdown.captainPicks.mentality.xp;
      breakdown.calculatedTotalXP = total;
      
      playerBreakdown.push(breakdown);
    }
    
    // Process away team
    for (const user of awayUsers as any[]) {
      const userId = String(user.id);
      const playerStats = (stats as any[]).find(s => String(s.userId) === userId);
      const isWinningTeam = matchResult === 'away_win';
      const isLosingTeam = matchResult === 'home_win';
      const isDraw = matchResult === 'draw';
      
      const breakdown: any = {
        id: userId,
        name: `${user.firstName} ${user.lastName}`,
        team: 'away',
        currentXP: user.xp,
        xpAwardedInMatch: playerStats?.xp_awarded || 0,
        stats: playerStats ? {
          goals: playerStats.goals || 0,
          assists: playerStats.assists || 0,
          cleanSheets: playerStats.cleanSheets || 0
        } : null,
        xpBreakdown: {
          teamResult: {
            type: isWinningTeam ? 'WIN' : (isDraw ? 'DRAW' : 'LOSS'),
            xp: isWinningTeam ? xpTable.winningTeam : (isDraw ? xpTable.draw : xpTable.losingTeam)
          },
          goals: playerStats ? {
            count: playerStats.goals || 0,
            xpPerGoal: isWinningTeam ? xpTable.goal.win : xpTable.goal.lose,
            totalXP: (playerStats.goals || 0) * (isWinningTeam ? xpTable.goal.win : xpTable.goal.lose)
          } : null,
          assists: playerStats ? {
            count: playerStats.assists || 0,
            xpPerAssist: isWinningTeam ? xpTable.assist.win : xpTable.assist.lose,
            totalXP: (playerStats.assists || 0) * (isWinningTeam ? xpTable.assist.win : xpTable.assist.lose)
          } : null,
          cleanSheets: playerStats ? {
            count: playerStats.cleanSheets || 0,
            xpPerCleanSheet: xpTable.cleanSheet,
            totalXP: (playerStats.cleanSheets || 0) * xpTable.cleanSheet
          } : null,
          motmVotes: {
            received: voteCountMap[userId] || 0,
            xpPerVote: isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose,
            totalXP: (voteCountMap[userId] || 0) * (isWinningTeam ? xpTable.motmVote.win : xpTable.motmVote.lose)
          },
          captainPicks: {
            defensiveImpact: String(matchData.awayDefensiveImpactId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.defensiveImpact.win : xpTable.defensiveImpact.lose
            } : null,
            mentality: String(matchData.awayMentalityId) === userId ? {
              selected: true,
              xp: isWinningTeam ? xpTable.mentality.win : xpTable.mentality.lose
            } : null
          }
        },
        calculatedTotalXP: 0
      };
      
      // Calculate total
      let total = breakdown.xpBreakdown.teamResult.xp;
      if (breakdown.xpBreakdown.goals) total += breakdown.xpBreakdown.goals.totalXP;
      if (breakdown.xpBreakdown.assists) total += breakdown.xpBreakdown.assists.totalXP;
      if (breakdown.xpBreakdown.cleanSheets) total += breakdown.xpBreakdown.cleanSheets.totalXP;
      total += breakdown.xpBreakdown.motmVotes.totalXP;
      if (breakdown.xpBreakdown.captainPicks.defensiveImpact) total += breakdown.xpBreakdown.captainPicks.defensiveImpact.xp;
      if (breakdown.xpBreakdown.captainPicks.mentality) total += breakdown.xpBreakdown.captainPicks.mentality.xp;
      breakdown.calculatedTotalXP = total;
      
      playerBreakdown.push(breakdown);
    }
    
    ctx.body = {
      success: true,
      matchId,
      matchInfo: {
        homeTeam: matchData.homeTeamName,
        awayTeam: matchData.awayTeamName,
        homeGoals,
        awayGoals,
        result: matchResult,
        status: matchData.status,
        homeCaptainId: matchData.homeCaptainId,
        awayCaptainId: matchData.awayCaptainId,
        captainPicks: {
          homeDefensiveImpactId: matchData.homeDefensiveImpactId,
          awayDefensiveImpactId: matchData.awayDefensiveImpactId,
          homeMentalityId: matchData.homeMentalityId,
          awayMentalityId: matchData.awayMentalityId
        }
      },
      xpPointsTable: xpTable,
      // motmWinner removed - only individual votes count
      votes: votes,
      voteCountByPlayer: voteCountMap,
      homeTeamPlayers: homeUsers,
      awayTeamPlayers: awayUsers,
      playerXPBreakdown: playerBreakdown,
      summary: {
        totalPlayersWithStats: stats.length,
        totalVotes: (votes as any[]).length
      }
    };
    
  } catch (err) {
    console.error('📊 [XP DEBUG] Error:', err);
    ctx.status = 500;
    ctx.body = { 
      success: false, 
      message: 'Failed to get XP breakdown',
      error: err instanceof Error ? err.message : String(err)
    };
  }
};

// Export all functions
export {
  // All exported above
};