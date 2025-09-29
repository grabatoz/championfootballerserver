import Router from '@koa/router';
import models from '../models';
import { required } from '../modules/auth';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
const { Match, Vote, User, MatchStatistics, League } = models;

const router = new Router({ prefix: '/matches' });

interface LeagueWithAdmins {
    id: string;
    name: string;
    administrators: Array<{
        id: string;
        firstName: string;
        lastName: string;
    }>;
}

interface MatchWithLeague {
    id: string;
    leagueId: string;
    homeTeamGoals?: number;
    awayTeamGoals?: number;
    status: string;
    date: string;
    archived?: boolean;
    league?: LeagueWithAdmins;
    update: (data: any) => Promise<any>;
    destroy: () => Promise<void>;
    toJSON: () => any;
}

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
    console.log('action', action);

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

router.post('/:matchId/stats', required, async (ctx, next) => {
    // If a playerId is provided in body, defer to the admin-capable handler below
    if ((ctx.request.body as any)?.playerId) {
        await next();
        return;
    }
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

    // Bust per-player match stats cache so subsequent reads reflect latest values
    try { cache.del(`match_stats_${matchId}_${userId}_ultra_fast`); } catch { }

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

// GET /matches/:matchId/stats - Get stats for a specific player in a match - ULTRA FAST
router.get('/:matchId/stats', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }

    const { matchId } = ctx.params;
    const { playerId } = ctx.query;

    if (!playerId) {
        ctx.throw(400, 'playerId is required');
        return;
    }

    const cacheKey = `match_stats_${matchId}_${playerId}_ultra_fast`;
    const cached = cache.get(cacheKey);
    if (cached) {
        ctx.set('X-Cache', 'HIT');
        ctx.body = cached;
        return;
    }

    try {
        const stats = await MatchStatistics.findOne({
            where: {
                match_id: matchId,
                user_id: playerId
            },
            attributes: ['goals', 'assists', 'cleanSheets', 'penalties', 'freeKicks', 'defence', 'impact']
        });

        const result = {
            success: true,
            stats: stats ? {
                goals: stats.goals || 0,
                assists: stats.assists || 0,
                cleanSheets: stats.cleanSheets || 0,
                penalties: stats.penalties || 0,
                freeKicks: stats.freeKicks || 0,
                defence: stats.defence || 0,
                impact: stats.impact || 0,
            } : {
                goals: 0,
                assists: 0,
                cleanSheets: 0,
                penalties: 0,
                freeKicks: 0,
                defence: 0,
                impact: 0,
            }
        };

        cache.set(cacheKey, result, 600); // 10 min cache for stats
        ctx.set('X-Cache', 'MISS');
        ctx.body = result;
    } catch (error) {
        console.error('Error fetching stats:', error);
        ctx.throw(500, 'Failed to fetch stats');
    }
});

// POST /matches/:matchId/stats - Save or update stats for a player in a match
router.post('/:matchId/stats', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }

    const { matchId } = ctx.params;
    const { playerId, goals, assists, cleanSheets, penalties, freeKicks, defence, impact } = ctx.request.body;

    if (!playerId) {
        ctx.throw(400, 'playerId is required');
        return;
    }

    try {
        // Check if stats already exist for this player in this match
        let stats = await MatchStatistics.findOne({
            where: {
                match_id: matchId,
                user_id: playerId
            }
        });

        if (stats) {
            // Update existing stats
            await stats.update({
                goals: goals || 0,
                assists: assists || 0,
                cleanSheets: cleanSheets || 0,
                penalties: penalties || 0,
                freeKicks: freeKicks || 0,
                defence: defence || 0,
                impact: impact || 0,
            });
        } else {
            // Create new stats
            stats = await MatchStatistics.create({
                match_id: matchId,
                user_id: playerId,
                goals: goals || 0,
                assists: assists || 0,
                cleanSheets: cleanSheets || 0,
                penalties: penalties || 0,
                freeKicks: freeKicks || 0,
                defence: defence || 0,
                impact: impact || 0,
                yellowCards: 0,
                redCards: 0,
                minutesPlayed: 0,
                rating: 0,
                xpAwarded: 0,
            });
        }

        // Invalidate cached stats for this player+match so reads get fresh impact
        try { cache.del(`match_stats_${matchId}_${playerId}_ultra_fast`); } catch { }

        // Update leaderboard cache
        const match = await Match.findByPk(matchId);
        if (match && match.leagueId) {
            const updatedStats = {
                goals: stats.goals,
                assists: stats.assists,
                cleanSheets: stats.cleanSheets,
                penalties: stats.penalties,
                freeKicks: stats.freeKicks,
                defence: stats.defence,
                impact: stats.impact,
            };

            // Update cache for each stat
            Object.entries(updatedStats).forEach(([metric, value]) => {
                if (typeof value === 'number' && value > 0) {
                    const cacheKey = `leaderboard_${metric}_${match.leagueId}_all`;
                    cache.updateLeaderboard(cacheKey, {
                        playerId: playerId,
                        value: value
                    });
                }
            });
        }

        ctx.body = {
            success: true,
            message: 'Stats saved successfully',
            playerId: playerId,
            updatedStats: {
                goals: stats.goals,
                assists: stats.assists,
                cleanSheets: stats.cleanSheets,
                penalties: stats.penalties,
                freeKicks: stats.freeKicks,
                defence: stats.defence,
                impact: stats.impact,
            }
        };
    } catch (error) {
        console.error('Error saving stats:', error);
        ctx.throw(500, 'Failed to save stats');
    }
});

// GET /matches/:matchId/votes - Get votes for a match - ULTRA FAST
router.get('/:matchId/votes', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }

    const { matchId } = ctx.params;
    const userId = ctx.state.user.userId;

    const cacheKey = `match_votes_${matchId}_${userId}_ultra_fast`;
    const cached = cache.get(cacheKey);
    if (cached) {
        ctx.set('X-Cache', 'HIT');
        ctx.body = cached;
        return;
    }

    try {
        // Get all votes for this match - optimized query
        const votes = await Vote.findAll({
            where: { matchId },
            attributes: ['votedForId', [sequelize.fn('COUNT', sequelize.col('votedForId')), 'voteCount']],
            group: ['votedForId'],
            limit: 20 // Limit for ultra speed
        });

        // Get current user's vote - fast lookup
        const userVote = await Vote.findOne({
            where: { matchId, voterId: userId },
            attributes: ['votedForId']
        });

        // Convert to object format
        const votesObject: Record<string, number> = {};
        votes.forEach((vote: any) => {
            votesObject[vote.votedForId] = parseInt(vote.get('voteCount'));
        });

        const result = {
            success: true,
            votes: votesObject,
            userVote: userVote?.votedForId || null
        };

        cache.set(cacheKey, result, 300); // 5 min cache for votes
        ctx.set('X-Cache', 'MISS');
        ctx.body = result;
    } catch (error) {
        console.error('Error fetching votes:', error);
        ctx.throw(500, 'Failed to fetch votes');
    }
});

// GET availability for a match (who marked themselves available)
router.get('/:matchId/availability', required, async (ctx) => {
    if (!ctx.state.user?.userId) {
        ctx.throw(401, 'Unauthorized');
        return;
    }

    const { matchId } = ctx.params;

    try {
        const match = await Match.findByPk(matchId, {
            include: [{ model: User, as: 'availableUsers' }]
        });

        if (!match) {
            ctx.throw(404, 'Match not found');
            return;
        }

        // Minimal payload (IDs only) + full list if needed
        const availableUsers = (match as any).availableUsers || [];
        const userIds = availableUsers.map((u: any) => u.id);

        ctx.status = 200;
        ctx.body = {
            success: true,
            matchId,
            availableUserIds: userIds,
            availableUsers // full user objects (you can remove this if not needed)
        };
    } catch (e) {
        console.error('GET /matches/:matchId/availability error', e);
        ctx.throw(500, 'Failed to load availability');
    }
});

// Archive/Restore match (PATCH)
router.patch('/:id', required, async (ctx) => {
    console.log('=== PATCH ROUTE STARTED ===');
    console.log('Match ID:', ctx.params.id);
    console.log('Request body:', ctx.request.body);
    
    try {
        const { id } = ctx.params;
        const { archived } = ctx.request.body as { archived?: boolean };

        if (!ctx.state.user?.userId) {
            console.log('No user ID found');
            ctx.status = 401;
            ctx.body = { success: false, message: 'Unauthorized' };
            return;
        }

        // Get match first
        const match = await Match.findByPk(id);
        if (!match) {
            console.log('Match not found');
            ctx.status = 404;
            ctx.body = { success: false, message: 'Match not found' };
            return;
        }

        console.log('Current match archived status:', match.archived);
        console.log('Requested archived status:', archived);

        // Update the match
        if (archived !== undefined) {
            await match.update({ archived });
            console.log('Match updated successfully to archived:', archived);
            
            ctx.body = { 
                success: true, 
                message: archived ? 'Match archived successfully' : 'Match restored successfully',
                match: {
                    id: match.id,
                    archived: archived,
                    homeTeamGoals: match.homeTeamGoals,
                    awayTeamGoals: match.awayTeamGoals,
                    status: match.status,
                    date: match.date,
                    leagueId: match.leagueId
                }
            };
        } else {
            ctx.status = 400;
            ctx.body = { success: false, message: 'archived field is required' };
        }
    } catch (error) {
        console.error('Error in PATCH route:', error);
        ctx.status = 500;
        ctx.body = { success: false, message: 'Server error' };
    }
});

// DELETE route to remove a match
router.delete('/:id', required, async (ctx) => {
    try {
        const { id } = ctx.params;

        if (!ctx.state.user?.userId) {
            ctx.status = 401;
            ctx.body = { success: false, message: 'Unauthorized' };
            return;
        }

        // Get match first - without includes
        const match = await Match.findByPk(id) as MatchWithLeague | null;
        if (!match) {
            ctx.status = 404;
            ctx.body = { success: false, message: 'Match not found' };
            return;
        }

        // Use raw SQL to check admin permissions
        const adminCheck = await sequelize.query(`
            SELECT la.userId 
            FROM "Leagues" l
            LEFT JOIN "LeagueAdministrators" la ON l.id = la.leagueId 
            WHERE l.id = :leagueId AND la.userId = :userId
        `, {
            replacements: { 
                leagueId: match.leagueId, 
                userId: ctx.state.user.userId 
            },
            type: QueryTypes.SELECT
        });

        if (adminCheck.length === 0) {
            ctx.status = 403;
            ctx.body = { success: false, message: 'Only league administrators can delete matches' };
            return;
        }

        const hasScores = (match.homeTeamGoals || 0) > 0 ||
            (match.awayTeamGoals || 0) > 0 ||
            match.status === 'completed';

        if (hasScores) {
            ctx.status = 400;
            ctx.body = {
                success: false,
                message: 'Cannot delete match with scores. Archive it instead.'
            };
            return;
        }

        await match.destroy();

        // Cache cleanup
        try {
            cache.del('matches_all');
        } catch (error) {
            console.log('Cache cleanup failed:', error);
        }

        ctx.body = { success: true, message: 'Match deleted successfully' };
    } catch (error) {
        console.error('Error deleting match:', error);
        ctx.status = 500;
        ctx.body = { success: false, message: 'Failed to delete match' };
    }
});

// Example of what your League associations should look like:
// League.belongsToMany(User, { 
//     through: 'LeagueMembers', 
//     as: 'members',
//     foreignKey: 'leagueId',
//     otherKey: 'userId' 
// });

// League.belongsToMany(User, { 
//     through: 'LeagueAdministrators', 
//     as: 'administrators',  // Different alias
//     foreignKey: 'leagueId',
//     otherKey: 'userId'
// });

// League.belongsTo(User, { 
//     as: 'creator',  // Different alias
//     foreignKey: 'creatorId' 
// });

export default router;
