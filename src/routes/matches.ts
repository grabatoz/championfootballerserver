import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
const { Match, Vote, User } = models;

const router = new Router({ prefix: '/matches' });

router.post('/:id/votes', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }
    const matchId = ctx.params.id;
    const voterId = ctx.state.user.userId;
    const { votedForId } = ctx.request.body as { votedForId: string };

    if (voterId === votedForId) {
        ctx.throw(400, "You cannot vote for yourself.");
    }

    // Remove any previous vote by this user for this match
    await Vote.destroy({
        where: {
            matchId,
            voterId,
        },
    });

    // Create the new vote
    await Vote.create({
        matchId,
        voterId,
        votedForId,
    });

    // Update leaderboard cache for MOTM
    const match = await Match.findByPk(matchId);
    if (match && match.leagueId) {
      const cacheKey = `leaderboard_motm_${match.leagueId}_all`;
      const newStats = {
        playerId: votedForId,
        value: 1 // Increment vote count
      };
      cache.updateLeaderboard(cacheKey, newStats);
    }

    ctx.status = 200;
    ctx.body = { success: true, message: "Vote cast successfully." };
});

router.post('/:matchId/availability', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }
    const { action } = ctx.request.query;
    console.log('action',action);
    
    const match = await Match.findByPk(ctx.params.matchId, {
        include: [{ model: User, as: 'availableUsers' }]
    });
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }
    const user = await User.findByPk(ctx.state.user.userId);
    if (!user) {
        ctx.throw(404, 'User not found');
        return;
    }
    if (action === 'available') {
        const isAlreadyAvailable = match.availableUsers?.some(u => u.id === user.id);
        if (!isAlreadyAvailable) {
            await match.addAvailableUser(user);
        }
    } else if (action === 'unavailable') {
        await match.removeAvailableUser(user);
    }
    // Fetch the updated match with availableUsers
    const updatedMatch = await Match.findByPk(ctx.params.matchId, {
        include: [{ model: User, as: 'availableUsers' }]
    });

    // Update matches cache
    const updatedMatchData = {
      id: ctx.params.matchId,
      homeTeamGoals: updatedMatch?.homeTeamGoals,
      awayTeamGoals: updatedMatch?.awayTeamGoals,
      status: updatedMatch?.status,
      date: updatedMatch?.date,
      leagueId: updatedMatch?.leagueId,
      availableUsers: updatedMatch?.availableUsers || []
    };
    cache.updateArray('matches_all', updatedMatchData);

    ctx.status = 200;
    ctx.body = { success: true, match: updatedMatch };
});

// PATCH endpoint to update match goals
router.patch('/:matchId/goals', required, async (ctx) => {
    const { homeGoals, awayGoals } = ctx.request.body;
    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId);
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }
    match.homeTeamGoals = homeGoals;
    match.awayTeamGoals = awayGoals;
    await match.save();

    // Update matches cache
    const updatedMatchData = {
      id: matchId,
      homeTeamGoals: homeGoals,
      awayTeamGoals: awayGoals,
      status: match.status,
      date: match.date,
      leagueId: match.leagueId
    };
    cache.updateArray('matches_all', updatedMatchData);

    ctx.body = { success: true };
});

// PATCH endpoint to update match note
router.patch('/:matchId/note', required, async (ctx) => {
    const { note } = ctx.request.body;
    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId);
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }
    match.notes = note;
    await match.save();

    // Update matches cache
    const updatedMatchData = {
      id: matchId,
      homeTeamGoals: match.homeTeamGoals,
      awayTeamGoals: match.awayTeamGoals,
      status: match.status,
      date: match.date,
      leagueId: match.leagueId,
      notes: note
    };
    cache.updateArray('matches_all', updatedMatchData);

    ctx.body = { success: true };
});

router.post('/:matchId/stats', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }
    const { matchId } = ctx.params;
    const userId = ctx.state.user.userId;
    const { goals, assists, cleanSheets, penalties, freeKicks, defence, impact } = ctx.request.body as {
        goals: number;
        assists: number;
        cleanSheets: number;
        penalties: number;
        freeKicks: number;
        defence: number;
        impact: number;
    };

    const match = await Match.findByPk(matchId);
    if (!match) {
        ctx.throw(404, 'Match not found');
        return;
    }

    if (match.status !== 'completed') {
        ctx.throw(400, 'Statistics can only be added for completed matches.');
    }

    // Find existing stats or create a new record
    const [stats, created] = await models.MatchStatistics.findOrCreate({
        where: { user_id: userId, match_id: matchId },
        defaults: {
            user_id: userId,
            match_id: matchId,
            goals,
            assists,
            cleanSheets,
            penalties,
            freeKicks,
            defence,
            impact,
            yellowCards: 0,
            redCards: 0,
            minutesPlayed: 0,
            rating: 0,
            xpAwarded: 0,
        }
    });

    if (!created) {
        // If stats existed, update them
        stats.goals = goals;
        stats.assists = assists;
        stats.cleanSheets = cleanSheets;
        stats.penalties = penalties;
        stats.freeKicks = freeKicks;
        stats.defence = defence;
        stats.impact = impact;
            await stats.save();
  }

  // Update cache with new stats
  const updatedMatchData = {
    id: matchId,
    homeTeamGoals: match.homeTeamGoals,
    awayTeamGoals: match.awayTeamGoals,
    status: match.status,
    date: match.date,
    leagueId: match.leagueId
  };

  // Update matches cache
  cache.updateArray('matches_all', updatedMatchData);
  
  // Update leaderboard cache for all metrics
  const leaderboardKeys = ['goals', 'assists', 'defence', 'motm', 'impact', 'cleanSheet'];
  leaderboardKeys.forEach(metric => {
    const cacheKey = `leaderboard_${metric}_all_all`;
    let value = 0;
    if (metric === 'defence') value = stats.defence || 0;
    else if (metric === 'cleanSheet') value = stats.cleanSheets || 0;
    else if (metric === 'goals') value = stats.goals || 0;
    else if (metric === 'assists') value = stats.assists || 0;
    else if (metric === 'impact') value = stats.impact || 0;
    else if (metric === 'motm') value = 0; // MOTM is calculated separately
    
    const newStats = {
      playerId: userId,
      value
    };
    cache.updateLeaderboard(cacheKey, newStats);
  });

  // XP calculation for this user
    // Get teams and votes for XP logic
    const matchWithTeams = await Match.findByPk(matchId, {
        include: [
            { model: User, as: 'homeTeamUsers' },
            { model: User, as: 'awayTeamUsers' }
        ]
    });
    const homeTeamUsers = ((matchWithTeams as any)?.homeTeamUsers || []);
    const awayTeamUsers = ((matchWithTeams as any)?.awayTeamUsers || []);
    const isHome = homeTeamUsers.some((u: any) => u.id === userId);
    const isAway = awayTeamUsers.some((u: any) => u.id === userId);
    const homeGoals = matchWithTeams?.homeTeamGoals ?? 0;
    const awayGoals = matchWithTeams?.awayTeamGoals ?? 0;
    let teamResult: 'win' | 'draw' | 'lose' = 'lose';
    if (isHome && homeGoals > awayGoals) teamResult = 'win';
    else if (isAway && awayGoals > homeGoals) teamResult = 'win';
    else if (homeGoals === awayGoals) teamResult = 'draw';
    let matchXP = 0;
    if (teamResult === 'win') matchXP += xpPointsTable.winningTeam;
    else if (teamResult === 'draw') matchXP += xpPointsTable.draw;
    else matchXP += xpPointsTable.losingTeam;
    // Get votes for this match
    const votes = await Vote.findAll({ where: { matchId } });
    const voteCounts: Record<string, number> = {};
    votes.forEach(vote => {
        const id = String(vote.votedForId);
        voteCounts[id] = (voteCounts[id] || 0) + 1;
    });
    let motmId: string | null = null;
    let maxVotes = 0;
    Object.entries(voteCounts).forEach(([id, count]) => {
        if (count > maxVotes) {
            motmId = id;
            maxVotes = count;
        }
    });
    // XP for stats
    if (stats.goals) matchXP += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stats.goals;
    if (stats.assists) matchXP += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stats.assists;
    if (stats.cleanSheets) matchXP += xpPointsTable.cleanSheet * stats.cleanSheets;
    // MOTM
    if (motmId === String(userId)) matchXP += (teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
    // MOTM Votes
    if (voteCounts[String(userId)]) matchXP += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[String(userId)];
    // Save XP for this match
    stats.xpAwarded = matchXP;
    await stats.save();
    // Update user's total XP (sum of all xpAwarded)
    const allStats = await models.MatchStatistics.findAll({ where: { user_id: userId } });
    const totalXP = allStats.reduce((sum, s) => sum + (s.xpAwarded || 0), 0);
    const user = await models.User.findByPk(userId);
    if (user) {
        user.xp = totalXP;
        await user.save();
    }

    ctx.status = 200;
    ctx.body = { success: true, message: 'Statistics and XP saved successfully.' };
});

// GET route to fetch votes for each player in a match
router.get('/:id/votes', required, async (ctx) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, 'Unauthorized');
    return;
  }
  const matchId = ctx.params.id;
  const userId = ctx.state.user.userId;
  const votes = await Vote.findAll({
    where: { matchId },
    attributes: ['votedForId', 'voterId'],
  });
  const voteCounts: Record<string, number> = {};
  let userVote: string | null = null;
  votes.forEach(vote => {
    const id = String(vote.votedForId);
    voteCounts[id] = (voteCounts[id] || 0) + 1;
    if (String(vote.voterId) === String(userId)) {
      userVote = id;
    }
  });
  ctx.body = { success: true, votes: voteCounts, userVote };
});

// Add XP calculation when match is completed
// router.patch('/:matchId/complete', required, async (ctx) => {
//   const { matchId } = ctx.params;
//   const match = await Match.findByPk(matchId, {
//     include: [
//       { model: User, as: 'homeTeamUsers' },
//       { model: User, as: 'awayTeamUsers' }
//     ]
//   });

//   if (!match) {
//     ctx.throw(404, 'Match not found');
//     return;
//   }

//   // Mark match as completed
//   await match.update({ status: 'completed' });

//   // Calculate and save per-match XP for each user
//   const homeTeamUsers = ((match as any).homeTeamUsers || []);
//   const awayTeamUsers = ((match as any).awayTeamUsers || []);
//   const allPlayers = [...homeTeamUsers, ...awayTeamUsers];
//   const homeGoals = match.homeTeamGoals ?? 0;
//   const awayGoals = match.awayTeamGoals ?? 0;
//   // Fetch all votes for this match
//   const votes = await Vote.findAll({ where: { matchId } });
//   const voteCounts: Record<string, number> = {};
//   votes.forEach(vote => {
//     const id = String(vote.votedForId);
//     voteCounts[id] = (voteCounts[id] || 0) + 1;
//   });
//   let motmId: string | null = null;
//   let maxVotes = 0;
//   Object.entries(voteCounts).forEach(([id, count]) => {
//     if (count > maxVotes) {
//       motmId = id;
//       maxVotes = count;
//     }
//   });
//   for (const player of allPlayers) {
//     // Only count the user once per match
//     const isHome = homeTeamUsers.some((u: any) => u.id === player.id);
//     const isAway = awayTeamUsers.some((u: any) => u.id === player.id);
//     let teamResult: 'win' | 'draw' | 'lose' = 'lose';
//     if (isHome && homeGoals > awayGoals) teamResult = 'win';
//     else if (isAway && awayGoals > homeGoals) teamResult = 'win';
//     else if (homeGoals === awayGoals) teamResult = 'draw';
//     let matchXP = 0;
//     if (teamResult === 'win') matchXP += xpPointsTable.winningTeam;
//     else if (teamResult === 'draw') matchXP += xpPointsTable.draw;
//     else matchXP += xpPointsTable.losingTeam;
//     // Get stats for this user in this match
//     const stat = await models.MatchStatistics.findOne({ where: { user_id: player.id, match_id: match.id } });
//     if (stat) {
//       if (stat.goals) matchXP += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals;
//       if (stat.assists) matchXP += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists;
//       if (stat.cleanSheets) matchXP += xpPointsTable.cleanSheet * stat.cleanSheets;
//       // MOTM
//       if (motmId === player.id) matchXP += (teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
//       // MOTM Votes
//       if (voteCounts[player.id]) matchXP += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[player.id];
//       // Save XP for this match
//       stat.xpAwarded = matchXP;
//       await stat.save();
//       // Update user's total XP (sum of all xpAwarded)
//       const allStats = await models.MatchStatistics.findAll({ where: { user_id: player.id } });
//       const totalXP = allStats.reduce((sum, s) => sum + (s.xpAwarded || 0), 0);
//       const user = await models.User.findByPk(player.id);
//       if (user) {
//         user.xp = totalXP;
//         await user.save();
//       }
//     }
//   }

//   ctx.status = 200;
//   ctx.body = { success: true, message: 'Match completed and XP saved.' };
// });

// GET /matches/:matchId - fetch a match by ID with teams and users and match-specific stats
router.get('/:matchId', async (ctx) => {
    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId, {
        include: [
            {
                model: User,
                as: 'homeTeamUsers',
                include: [
                    {
                        model: models.MatchStatistics,
                        as: 'statistics',
                        where: { match_id: matchId },
                        required: false
                    }
                ]
            },
            {
                model: User,
                as: 'awayTeamUsers',
                include: [
                    {
                        model: models.MatchStatistics,
                        as: 'statistics',
                        where: { match_id: matchId },
                        required: false
                    }
                ]
            },
            { model: User, as: 'availableUsers' }
        ]
    });
    if (!match) {
        ctx.status = 404;
        ctx.body = { success: false, message: 'Match not found' };
        return;
    }
    ctx.body = { success: true, match };
});

router.get('/', async (ctx) => {
  const cacheKey = 'matches_all';
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }
  try {
    // Existing DB fetch logic
    const matches = await Match.findAll({
      include: [
        { model: User, as: 'homeTeamUsers' },
        { model: User, as: 'awayTeamUsers' },
        { model: Vote, as: 'votes' },
      ],
    });
    const result = { success: true, matches };
    cache.set(cacheKey, result, 600); // cache for 30 seconds
    ctx.body = result;
  } catch (error) {
    console.error('Error fetching matches:', error);
    ctx.throw(500, 'Failed to fetch matches.');
  }
});

export default router;
