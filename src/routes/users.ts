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
const { User, League } = models

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

export default router;

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
    const UserModel = (models as any).User;
    const user = await UserModel.findByPk(userId, { attributes: ['id', 'xp'] });
    if (!user) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'User not found' };
      return;
    }

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
        userId,
        totalXP: Number(user.xp || 0),
        badges: [
          { id: 'rising_xp', title: 'Rising Star', count: 0, xp: Number(user.xp || 0), unlocked: true },
        ],
      };
      return;
    }

    // Load RESULT_PUBLISHED matches the user played in
    const matches = await Match.findAll({
      where: { id: { [Op.in]: matchIds as any }, status: 'RESULT_PUBLISHED' },
      attributes: ['id','leagueId','homeTeamGoals','awayTeamGoals','date','start','createdAt'],
      include: [
        { model: (models as any).User, as: 'homeTeamUsers', attributes: ['id'] },
        { model: (models as any).User, as: 'awayTeamUsers', attributes: ['id'] },
        { model: Vote, as: 'votes', attributes: ['votedForId'] },
      ],
      order: [['date','ASC'], ['start','ASC'], ['createdAt','ASC']],
    });

    // Load user stats for those matches
    const statsRows = await (models as any).MatchStatistics.findAll({
      where: { user_id: userId, match_id: { [Op.in]: matches.map((m: any) => m.id) as any } },
      attributes: ['match_id','goals','assists','cleanSheets'],
      raw: true,
    });
    const statsByMatch = new Map<string, { goals: number; assists: number; cleanSheets: number }>();
    for (const r of statsRows as any[]) {
      statsByMatch.set(String(r.match_id), {
        goals: Number(r.goals || 0),
        assists: Number(r.assists || 0),
        cleanSheets: Number(r.cleanSheets || 0),
      });
    }

    // Build per-league chronological summaries
    type Summ = { goals: number; assists: number; conceded: number; result: 'W' | 'D' | 'L'; motmVotes: number };
    const byLeague: Record<string, Summ[]> = {};
    const timeOf = (m: any) => {
      const d = m?.date ?? m?.start ?? m?.createdAt;
      const t = new Date(d).getTime();
      return Number.isFinite(t) ? t : 0;
    };
    const sortedMatches = [...matches].sort((a: any, b: any) => timeOf(a) - timeOf(b));

    for (const m of sortedMatches as any[]) {
      const isHome = ((m.homeTeamUsers || []).some((u: any) => String(u.id) === userId));
      const isAway = ((m.awayTeamUsers || []).some((u: any) => String(u.id) === userId));
      if (!isHome && !isAway) continue;
      const s = statsByMatch.get(String(m.id)) || { goals: 0, assists: 0, cleanSheets: 0 };
      const teamGoals = isHome ? Number(m.homeTeamGoals || 0) : Number(m.awayTeamGoals || 0);
      const oppGoals = isHome ? Number(m.awayTeamGoals || 0) : Number(m.homeTeamGoals || 0);
      const res: 'W' | 'D' | 'L' = teamGoals > oppGoals ? 'W' : teamGoals === oppGoals ? 'D' : 'L';
      const votes = (m.votes || []) as any[];
      const motmVotes = votes.filter(v => String(v.votedForId) === userId).length;
      const arr = byLeague[String(m.leagueId)] || [];
      arr.push({ goals: s.goals, assists: s.assists, conceded: oppGoals, result: res, motmVotes });
      byLeague[String(m.leagueId)] = arr;
    }

    // Streak helpers
    const longestStreak = (arr: Summ[], pred: (x: Summ) => boolean) => {
      let best = 0, cur = 0;
      for (const x of arr) { if (pred(x)) { cur++; best = Math.max(best, cur); } else { cur = 0; } }
      return best;
    };

    const leaguesArr = Object.values(byLeague);
    const acrossAll = leaguesArr.flat();
    const hatTricks = leaguesArr.reduce((acc, arr) => acc + arr.filter(x => x.goals >= 3).length, 0);
    const maxAssistStreakSingle = Math.max(0, ...leaguesArr.map(arr => longestStreak(arr, x => x.assists > 0)));
    const maxScoringStreakSingle = Math.max(0, ...leaguesArr.map(arr => longestStreak(arr, x => x.goals > 0)));
    const maxMotmStreakAll = longestStreak(acrossAll, x => x.motmVotes > 0);
    const maxCleanSheetWinStreakAll = longestStreak(acrossAll, x => x.result === 'W' && x.conceded === 0);
    const maxWinStreakSingle = Math.max(0, ...leaguesArr.map(arr => longestStreak(arr, x => x.result === 'W')));
    const maxCaptainPickCountSingle = Math.max(0, ...leaguesArr.map(arr => arr.filter(x => x.motmVotes > 0).length));

    const toNext = (best: number, target: number) => (target - (best % target || target));

    // Build badges (ids match client)
    const badges = [
      {
        id: 'rising_xp',
        title: 'Rising Star',
        count: 0,
        xp: Number(user.xp || 0),
        unlocked: true,
      },
      {
        id: 'hat_trick_3_matches', title: 'Hat-Trick x3', count: Math.floor(hatTricks / 3), xp: 100, unlocked: hatTricks >= 3,
        progressText: hatTricks >= 3 ? `x${Math.floor(hatTricks / 3)}` : `${3 - Math.min(hatTricks, 3)} hat-trick(s) to go`,
      },
      {
        id: 'captain_5_wins', title: "Captain's 5 Wins", count: Math.floor(0 / 5), xp: 150, unlocked: false, progressText: 'Captain tracking not available',
      },
      {
        id: 'assist_10_consecutive', title: 'Assist Streak x10', count: Math.floor(maxAssistStreakSingle / 10), xp: 200, unlocked: maxAssistStreakSingle >= 10,
        progressText: maxAssistStreakSingle >= 10 ? `Best streak: ${maxAssistStreakSingle}` : `${toNext(maxAssistStreakSingle, 10)} match(es) to go`,
      },
      {
        id: 'scoring_10_consecutive', title: 'Scoring Streak x10', count: Math.floor(maxScoringStreakSingle / 10), xp: 250, unlocked: maxScoringStreakSingle >= 10,
        progressText: maxScoringStreakSingle >= 10 ? `Best streak: ${maxScoringStreakSingle}` : `${toNext(maxScoringStreakSingle, 10)} match(es) to go`,
      },
      {
        id: 'captain_performance_3', title: "Captain's Picks x3", count: Math.floor(maxCaptainPickCountSingle / 3), xp: 300, unlocked: maxCaptainPickCountSingle >= 3,
        progressText: maxCaptainPickCountSingle >= 3 ? `Picks: ${maxCaptainPickCountSingle}` : `${3 - Math.min(maxCaptainPickCountSingle, 3)} pick(s) to go`,
      },
      {
        id: 'motm_4_consecutive', title: 'MOTM Streak x4', count: Math.floor(maxMotmStreakAll / 4), xp: 350, unlocked: maxMotmStreakAll >= 4,
        progressText: maxMotmStreakAll >= 4 ? `Best streak: ${maxMotmStreakAll}` : `${toNext(maxMotmStreakAll, 4)} match(es) to go`,
      },
      {
        id: 'clean_sheet_5_wins', title: 'Clean-Sheet Win Streak x5', count: Math.floor(maxCleanSheetWinStreakAll / 5), xp: 400, unlocked: maxCleanSheetWinStreakAll >= 5,
        progressText: maxCleanSheetWinStreakAll >= 5 ? `Best streak: ${maxCleanSheetWinStreakAll}` : `${toNext(maxCleanSheetWinStreakAll, 5)} match(es) to go`,
      },
      {
        id: 'top_spot_10_matches', title: 'Top Spot x10 Matches', count: 0, xp: 450, unlocked: false, progressText: 'League top-spot tracking not available',
      },
      {
        id: 'consecutive_10_victories', title: '10 In A Row', count: Math.floor(maxWinStreakSingle / 10), xp: 500, unlocked: maxWinStreakSingle >= 10,
        progressText: maxWinStreakSingle >= 10 ? `Best streak: ${maxWinStreakSingle}` : `${toNext(maxWinStreakSingle, 10)} win(s) to go`,
      },
    ];

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
      const { recalcUserTotalXP } = await import('../utils/xpRecalc');
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
