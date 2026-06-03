import Router from '@koa/router';
import { required } from "../modules/auth"
import models from "../models"
import { hash } from "bcrypt"
import cache from '../utils/cache';
import sequelize from '../config/database';
import { Op } from 'sequelize';
import Match from '../models/Match';
import Vote from '../models/Vote';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import { computeAchievementState, toAchievementMatchInput } from '../utils/achievementChecker';
import { invalidateCache as invalidateMemoryCache } from '../middleware/memoryCache';
const { User, League } = models

const importWithFallback = async <T = any>(specifier: string): Promise<T> => {
  try {
    return await import(specifier);
  } catch (err) {
    if (specifier.endsWith('.js')) {
      return await import(specifier.slice(0, -3) + '.ts');
    }
    throw err;
  }
};

const router = new Router({ prefix: '/users' });


interface UserInput {
  firstName?: string;
  lastName?: string;
  pictureKey?: string;
  email?: string;
  password?: string;
  age?: number;
  attributes?: any;
  chemistryStyle?: string;
  displayName?: string;
  gender?: string;
  position?: string;
  preferredFoot?: string;
  shirtNumber?: string;
}

router.patch("/:id", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");

  let {
    firstName,
    lastName,
    pictureKey,
    email,
    password,
    age,
    attributes,
    chemistryStyle,
    displayName,
    gender,
    position,
    preferredFoot,
    shirtNumber,
  } = ctx.request.body.user as UserInput

  if (ctx.params.id !== ctx.session!.userId)
    ctx.throw(403, "You can't edit this user.")

  if (displayName) {
    const user = await User.findByPk(ctx.session!.userId, {
      include: [{
        model: League,
        as: 'leaguesJoined',
        include: [{
          model: User,
          as: 'users'
        }]
      }]
    }) as any;
    if (!user) ctx.throw(404, "User not found");

    const allUsers: any[] = [];
    for (const league of user.leaguesJoined) {
      for (const user of league.users) {
        allUsers.push(user);
      }
    }

    if (allUsers.find((user) => user.displayName === displayName && user.id !== ctx.session!.userId)) {
      ctx.throw(409, "Card name is already being used by another player in your leagues.");
    }
  }

  await User.update({
    firstName,
    lastName,
    pictureKey,
    email: email?.toLowerCase(),
    password: password ? await hash(password, 10) : undefined,
    age,
    attributes,
    chemistryStyle,
    displayName,
    gender,
    position,
    preferredFoot,
    shirtNumber,
  } as any, {
    where: { id: ctx.params.id }
  });

  // Update cache with new user data
  const updatedUserData = {
    id: ctx.params.id,
    firstName,
    lastName,
    profilePicture: pictureKey,
    position,
    positionType: position,
    xp: 0 // Will be updated from database
  };

  // Update players cache
  cache.updateArray('players_all', updatedUserData);
  
  // Clear any user-specific caches
  cache.clearPattern(`user_leagues_${ctx.params.id}`);

  ctx.response.status = 200;
})

router.delete("/:id", required, async (ctx) => {
  if (!ctx.session || !ctx.session.userId) ctx.throw(401, "Unauthorized");

  if (ctx.params.id !== ctx.session!.userId)
    ctx.throw(403, "You can't delete this user.");

  await User.destroy({
    where: { id: ctx.params.id }
  });

  // Remove user from cache
  cache.removeFromArray('players_all', ctx.params.id);
  
  // Clear any user-specific caches
  cache.clearPattern(`user_leagues_${ctx.params.id}`);

  ctx.response.status = 200;
})

// --- Global Stats API ---
// GET /users/me/global-stats - get user's overall stats across all leagues
router.get('/me/global-stats', required, async (ctx) => {
  if (!ctx.state.user?.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = String(ctx.state.user.userId);
  try {
    const cacheKey = `user_global_stats_${userId}`;
    const forceRefresh =
      ctx.query?.refresh === '1' ||
      ctx.query?.nocache === '1' ||
      typeof ctx.query?._ !== 'undefined' ||
      typeof ctx.query?._t !== 'undefined';
    const cached = forceRefresh ? null : cache.get<any>(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }

    const startedAt = Date.now();
    const MatchStatisticsModel = (models as any).MatchStatistics;
    const statsRows = await MatchStatisticsModel.findAll({
      where: { user_id: userId },
      attributes: ['match_id', 'goals', 'assists', 'cleanSheets', 'defence'],
      raw: true,
    });

    const statMatchIds = Array.from(
      new Set((statsRows as any[]).map((r: any) => String(r.match_id || '')).filter((id: string) => id !== ''))
    );

    if (statMatchIds.length === 0) {
      const response = {
        success: true,
        stats: {
          matchesPlayed: 0,
          motmVotes: 0,
          goals: 0,
          assists: 0,
          cleanSheets: 0,
          defensiveImpact: 0
        }
      };
      cache.set(cacheKey, response, 20);
      ctx.body = response;
      return;
    }

    const [matches, totalMotmVotes] = await Promise.all([
      Match.findAll({
        where: { id: { [Op.in]: statMatchIds as any }, status: 'RESULT_PUBLISHED' },
        attributes: ['id', 'homeDefensiveImpactId', 'awayDefensiveImpactId'],
        raw: true,
      }) as any,
      Vote.count({
        where: { matchId: { [Op.in]: statMatchIds as any }, votedForId: userId },
      }),
    ]);

    const publishedMatchIdSet = new Set((matches as any[]).map((m: any) => String(m.id || '')));
    const defensivePickCount = (matches as any[]).reduce((sum: number, m: any) => {
      const isPick = String(m.homeDefensiveImpactId || '') === userId || String(m.awayDefensiveImpactId || '') === userId;
      return sum + (isPick ? 1 : 0);
    }, 0);

    let totalGoals = 0;
    let totalAssists = 0;
    let totalCleanSheets = 0;
    let totalDefensiveImpact = defensivePickCount;
    for (const row of statsRows as any[]) {
      if (!publishedMatchIdSet.has(String(row.match_id || ''))) continue;
      totalGoals += Number(row.goals || 0);
      totalAssists += Number(row.assists || 0);
      totalCleanSheets += Number(row.cleanSheets || 0);
      totalDefensiveImpact += Number(row.defence || 0);
    }

    const response = {
      success: true,
      stats: {
        matchesPlayed: publishedMatchIdSet.size,
        motmVotes: Number(totalMotmVotes || 0),
        goals: totalGoals,
        assists: totalAssists,
        cleanSheets: totalCleanSheets,
        defensiveImpact: totalDefensiveImpact
      }
    };
    cache.set(cacheKey, response, 20);
    console.log(`[Global Stats API] user=${userId} matches=${publishedMatchIdSet.size} durationMs=${Date.now() - startedAt}`);
    ctx.body = response;
  } catch (e) {
    console.error('GET /users/me/global-stats failed', e);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to fetch global stats' };
  }
});

// --- Achievements API ---
// GET /users/me/achievements - compute achievements/badges on the server
router.get('/me/achievements', required, async (ctx) => {
  if (!ctx.state.user?.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = String(ctx.state.user.userId);
  try {
    const startedAt = Date.now();
    const UserModel = (models as any).User;
    const MatchStatisticsModel = (models as any).MatchStatistics;
    const cacheKey = `user_achievements_${userId}`;
    const forceRefresh =
      ctx.query?.refresh === '1' ||
      ctx.query?.nocache === '1' ||
      typeof ctx.query?._ !== 'undefined' ||
      typeof ctx.query?._t !== 'undefined';
    const cached = forceRefresh ? null : cache.get<any>(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }
    const user = await UserModel.findByPk(userId, { attributes: ['id', 'xp'] });
    if (!user) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'User not found' };
      return;
    }

    // Primary scope: user's match statistics rows (indexed by user_id in DB)
    const userStatsRows = await MatchStatisticsModel.findAll({
      where: { user_id: userId },
      attributes: ['match_id', 'goals', 'assists'],
      raw: true,
    });
    const statsByMatch = new Map<string, { goals: number; assists: number }>();
    for (const r of userStatsRows as any[]) {
      statsByMatch.set(String(r.match_id), {
        goals: Number(r.goals || 0),
        assists: Number(r.assists || 0),
      });
    }
    const matchIdsFromStats = Array.from(
      new Set((userStatsRows as any[]).map((r: any) => String(r.match_id || '')).filter((id: string) => id !== ''))
    );

    // Fallback scope: join tables (for legacy rows if stats are missing)
    const Home = (sequelize.models as any)?.UserHomeMatches;
    const Away = (sequelize.models as any)?.UserAwayMatches;
    let matchIds: string[] = matchIdsFromStats;
    if (matchIds.length === 0) {
      const [homeRowsFallback, awayRowsFallback] = await Promise.all([
        Home ? Home.findAll({ where: { userId }, attributes: ['matchId'], raw: true }) : Promise.resolve([]),
        Away ? Away.findAll({ where: { userId }, attributes: ['matchId'], raw: true }) : Promise.resolve([]),
      ]);
      matchIds = Array.from(
        new Set(
          [...(homeRowsFallback as any[]), ...(awayRowsFallback as any[])]
            .map((r: any) => String(r.matchId || ''))
            .filter((id: string) => id !== '')
        )
      );
    }

    if (matchIds.length === 0) {
      const response = {
        success: true,
        userId,
        totalXP: Number(user.xp || 0),
        badges: [
          { id: 'rising_xp', title: 'Rising Star', count: 0, xp: Number(user.xp || 0), unlocked: true },
        ],
      };
      cache.set(cacheKey, response, 20);
      ctx.body = response;
      return;
    }

    // Load RESULT_PUBLISHED matches the user played in
    const playedMatches = await Match.findAll({
      where: { id: { [Op.in]: matchIds as any }, status: 'RESULT_PUBLISHED' },
      attributes: [
        'id',
        'leagueId',
        'homeTeamGoals',
        'awayTeamGoals',
        'date',
        'start',
        'createdAt',
        'homeCaptainId',
        'awayCaptainId',
        'homeDefensiveImpactId',
        'awayDefensiveImpactId',
        'homeMentalityId',
        'awayMentalityId',
      ],
      raw: true,
    }) as any[];

    if (playedMatches.length === 0) {
      ctx.body = {
        success: true,
        userId,
        totalXP: Number(user.xp || 0),
        badges: [
          { id: 'rising_xp', title: 'Rising Star', count: 0, xp: Number(user.xp || 0), unlocked: true },
        ],
      };
      return;
    }

    const leagueIds = Array.from(
      new Set(playedMatches.map((m: any) => String(m.leagueId || '')).filter((id: string) => id !== ''))
    );
    const playedMatchIds = playedMatches.map((m: any) => String(m.id || '')).filter((id: string) => id !== '');

    const [leagueTotalRows, voteRows, homeRows, awayRows] = await Promise.all([
      leagueIds.length > 0
        ? Match.findAll({
            where: { leagueId: { [Op.in]: leagueIds as any }, status: 'RESULT_PUBLISHED' },
            attributes: ['leagueId', [sequelize.fn('COUNT', sequelize.col('id')), 'totalMatches']],
            group: ['leagueId'],
            raw: true,
          })
        : Promise.resolve([]),
      playedMatchIds.length > 0
        ? Vote.findAll({
            where: { matchId: { [Op.in]: playedMatchIds as any } },
            attributes: ['matchId', 'votedForId'],
            raw: true,
          })
        : Promise.resolve([]),
      Home && playedMatchIds.length > 0
        ? Home.findAll({
            where: { userId, matchId: { [Op.in]: playedMatchIds as any } },
            attributes: ['matchId'],
            raw: true,
          })
        : Promise.resolve([]),
      Away && playedMatchIds.length > 0
        ? Away.findAll({
            where: { userId, matchId: { [Op.in]: playedMatchIds as any } },
            attributes: ['matchId'],
            raw: true,
          })
        : Promise.resolve([]),
    ]);

    const totalMatchesByLeague: Record<string, number> = {};
    for (const row of leagueTotalRows as any[]) {
      const key = String(row.leagueId || '').trim();
      if (!key) continue;
      totalMatchesByLeague[key] = Number(row.totalMatches || 0);
    }

    const votesByMatch = new Map<string, string[]>();
    for (const row of voteRows as any[]) {
      const matchId = String(row.matchId || '').trim();
      const votedForId = String(row.votedForId || '').trim();
      if (!matchId || !votedForId) continue;
      if (!votesByMatch.has(matchId)) votesByMatch.set(matchId, []);
      votesByMatch.get(matchId)!.push(votedForId);
    }

    const homeMatchIdSet = new Set((homeRows as any[]).map((r: any) => String(r.matchId || '')).filter((id: string) => id !== ''));
    const awayMatchIdSet = new Set((awayRows as any[]).map((r: any) => String(r.matchId || '')).filter((id: string) => id !== ''));

    const achievementMatches = playedMatches.map((m: any) => {
      const matchId = String(m.id || '');
      const votedForIds = votesByMatch.get(matchId) || [];
      return toAchievementMatchInput({
        ...m,
        homeTeamUsers: homeMatchIdSet.has(matchId) ? [{ id: userId }] : [],
        awayTeamUsers: awayMatchIdSet.has(matchId) ? [{ id: userId }] : [],
        votes: votedForIds.map((votedForId) => ({ votedForId })),
      });
    });
    const computed = computeAchievementState(userId, achievementMatches, statsByMatch, {
      totalMatchesByLeague,
    });

    const badges = [
      {
        id: 'rising_xp',
        title: 'Rising Star',
        count: 0,
        xp: Number(user.xp || 0),
        unlocked: true,
      },
      ...computed.badges,
    ];

    const response = { success: true, userId, totalXP: Number(user.xp || 0), badges };
    cache.set(cacheKey, response, 20);
    console.log(
      `[Achievements API] /users/me user=${userId} playedMatches=${playedMatchIds.length} leagues=${leagueIds.length} durationMs=${Date.now() - startedAt}`
    );
    ctx.body = response;
  } catch (e) {
    console.error('GET /users/me/achievements failed', e);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to compute achievements' };
  }
});

// POST /users/me/achievements/award - persist achievements XP to the user's profile
router.post('/me/achievements/award', required, async (ctx) => {
  if (!ctx.state.user?.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }

  const userId = String(ctx.state.user.userId);
  try {
    // Compute and award any missing achievements across all leagues
    await calculateAndAwardXPAchievements(userId);

    // Return updated XP snapshot
    // Recalculate total XP to include both match stats and achievements
    try {
      const { recalcUserTotalXP } = await importWithFallback('../utils/xpRecalc.js');
      await recalcUserTotalXP(userId);
    } catch {}
    const UserModel = (models as any).User;
    const user = await UserModel.findByPk(userId, { attributes: ['id', 'xp', 'achievements'] });
    if (!user) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'User not found' };
      return;
    }

    // Optionally clear any cached profile data
    try {
      cache.clearPattern(`user_leagues_${userId}`);
      cache.del(`user_achievements_${userId}`);
      cache.del(`user_global_stats_${userId}`);
      invalidateMemoryCache('/users/me/achievements');
      invalidateMemoryCache('/users/me/global-stats');
      invalidateMemoryCache('/auth/status');
    } catch {}

    ctx.body = {
      success: true,
      message: 'Achievements XP persisted',
      userId,
      totalXP: Number(user.xp || 0),
      achievements: Array.isArray(user.achievements) ? user.achievements : [],
    };
  } catch (e) {
    console.error('POST /users/me/achievements/award failed', e);
    ctx.status = 500;
    ctx.body = { success: false, message: 'Failed to persist achievements' };
  }
});

export default router;
