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
    // Fetch match IDs where user participated via join tables
    const Home = (sequelize.models as any)?.UserHomeMatches;
    const Away = (sequelize.models as any)?.UserAwayMatches;
    let matchIds: string[] = [];
    if (Home) {
      const rows = await Home.findAll({ where: { userId }, attributes: ['matchId'], raw: true });
      matchIds.push(...(rows as any[]).map(r => String(r.matchId)));
    }
    if (Away) {
      const rows = await Away.findAll({ where: { userId }, attributes: ['matchId'], raw: true });
      matchIds.push(...(rows as any[]).map(r => String(r.matchId)));
    }
    matchIds = Array.from(new Set(matchIds));

    if (matchIds.length === 0) {
      ctx.body = {
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
      return;
    }

    // Load RESULT_PUBLISHED matches the user played in
    const matches = await Match.findAll({
      where: { id: { [Op.in]: matchIds as any }, status: 'RESULT_PUBLISHED' },
      attributes: ['id', 'homeTeamGoals', 'awayTeamGoals', 'homeDefensiveImpactId', 'awayDefensiveImpactId'],
      include: [
        { model: (models as any).User, as: 'homeTeamUsers', attributes: ['id'] },
        { model: (models as any).User, as: 'awayTeamUsers', attributes: ['id'] },
        { model: Vote, as: 'votes', attributes: ['votedForId'] },
      ],
    });

    // Load user stats for those matches
    const statsRows = await (models as any).MatchStatistics.findAll({
      where: { user_id: userId, match_id: { [Op.in]: matches.map((m: any) => m.id) as any } },
      attributes: ['match_id', 'goals', 'assists', 'cleanSheets', 'defence'],
      raw: true,
    });

    const statsByMatch = new Map<string, { goals: number; assists: number; cleanSheets: number; defence: number }>();
    for (const r of statsRows as any[]) {
      statsByMatch.set(String(r.match_id), {
        goals: Number(r.goals || 0),
        assists: Number(r.assists || 0),
        cleanSheets: Number(r.cleanSheets || 0),
        defence: Number(r.defence || 0),
      });
    }

    // Aggregate stats
    let totalGoals = 0;
    let totalAssists = 0;
    let totalCleanSheets = 0;
    let totalMotmVotes = 0;
    let totalDefensiveImpact = 0;

    for (const m of matches as any[]) {
      const isHome = ((m.homeTeamUsers || []).some((u: any) => String(u.id) === userId));
      const isAway = ((m.awayTeamUsers || []).some((u: any) => String(u.id) === userId));
      if (!isHome && !isAway) continue;

      const s = statsByMatch.get(String(m.id)) || { goals: 0, assists: 0, cleanSheets: 0, defence: 0 };
      totalGoals += s.goals;
      totalAssists += s.assists;
      totalCleanSheets += s.cleanSheets;
      totalDefensiveImpact += s.defence;

      // Also count captain picks for Defensive Impact
      if (String(m.homeDefensiveImpactId) === userId || String(m.awayDefensiveImpactId) === userId) {
        totalDefensiveImpact += 1;
      }

      // Count MOTM votes (all votes are MOTM votes in this system)
      const votes = (m.votes || []) as any[];
      const motmVotes = votes.filter((v: any) => String(v.votedForId) === userId).length;
      totalMotmVotes += motmVotes;
    }

    ctx.body = {
      success: true,
      stats: {
        matchesPlayed: matches.length,
        motmVotes: totalMotmVotes,
        goals: totalGoals,
        assists: totalAssists,
        cleanSheets: totalCleanSheets,
        defensiveImpact: totalDefensiveImpact
      }
    };
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
    const user = await UserModel.findByPk(userId, { attributes: ['id', 'xp'] });
    if (!user) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'User not found' };
      return;
    }

    // Fetch match IDs where user participated via join tables
    const Home = (sequelize.models as any)?.UserHomeMatches;
    const Away = (sequelize.models as any)?.UserAwayMatches;
    const [homeRows, awayRows] = await Promise.all([
      Home ? Home.findAll({ where: { userId }, attributes: ['matchId'], raw: true }) : Promise.resolve([]),
      Away ? Away.findAll({ where: { userId }, attributes: ['matchId'], raw: true }) : Promise.resolve([]),
    ]);
    const homeMatchIdSet = new Set((homeRows as any[]).map((r: any) => String(r.matchId || '')).filter((id: string) => id !== ''));
    const awayMatchIdSet = new Set((awayRows as any[]).map((r: any) => String(r.matchId || '')).filter((id: string) => id !== ''));
    const matchIds = Array.from(new Set([...homeMatchIdSet, ...awayMatchIdSet]));

    if (matchIds.length === 0) {
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

    const [leagueTotalRows, voteRows, statsRows] = await Promise.all([
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
      playedMatchIds.length > 0
        ? MatchStatisticsModel.findAll({
            where: { user_id: userId, match_id: { [Op.in]: playedMatchIds as any } },
            attributes: ['match_id', 'goals', 'assists'],
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

    const statsByMatch = new Map<string, { goals: number; assists: number }>();
    for (const r of statsRows as any[]) {
      statsByMatch.set(String(r.match_id), {
        goals: Number(r.goals || 0),
        assists: Number(r.assists || 0),
      });
    }

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

    console.log(
      `[Achievements API] /users/me user=${userId} playedMatches=${playedMatchIds.length} leagues=${leagueIds.length} durationMs=${Date.now() - startedAt}`
    );
    ctx.body = { success: true, userId, totalXP: Number(user.xp || 0), badges };
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
    try { cache.clearPattern(`user_leagues_${userId}`); } catch {}

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
