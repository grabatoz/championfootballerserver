import Router from 'koa-router';
import { leagueStatusService } from '../modules/leagues/leagueStatus.service';
import db from '../models';
import { required } from '../modules/auth';
import models from '../models';
import { MatchAvailability } from '../models/MatchAvailability';
import Notification from '../models/Notification';
import { getInviteCode, verifyLeagueAdmin } from '../modules/utils';
import type { LeagueAttributes } from '../models/League';
import { transporter } from '../modules/sendEmail';
import { Op, fn, col, where, QueryTypes } from 'sequelize';
import { calculateAndAwardXPAchievements } from '../utils/xpAchievementsEngine';
import Vote from '../models/Vote';
import MatchStatistics from '../models/MatchStatistics';
import { xpPointsTable } from '../utils/xpPointsTable';
import cache from '../utils/cache';
import { upload, uploadToCloudinary } from '../middleware/upload';
import { MatchPlayerLayout } from '../models';
const { League, Match, User, MatchGuest } = models;

// Add these helpers below imports
const isMultipart = (ctx: any) =>
  /multipart\/form-data/i.test(String(ctx.request.headers['content-type'] || ''));

const conditionalUpload = (fields: Array<{ name: string; maxCount?: number }>) => {
  const handler = upload.fields(fields);
  return async (ctx: any, next: any) => {
    if (isMultipart(ctx)) {
      // Run multer only for multipart requests
      return (handler as any)(ctx, next);
    }
    return next();
  };
};

// UUID validator (for Koa routes)
const isUuid = (v: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

// Small helper to normalize team
const normalizeTeam = (v: unknown): 'home' | 'away' =>
  String(v || '').toLowerCase() === 'away' ? 'away' : 'home';

// Types for match status normalization in this file
type ApiMatchStatus = 'RESULT_PUBLISHED' | 'SCHEDULED' | 'ONGOING';

// Normalize backend match status strings to our enum
const normalizeStatus = (s?: string): ApiMatchStatus => {
  const v = String(s ?? '').toLowerCase();
  if (['result_published', 'result_uploaded', 'uploaded', 'complete', 'finished', 'ended', 'done'].includes(v)) return 'RESULT_PUBLISHED';
  if (['ongoing', 'inprogress', 'in_progress', 'live', 'playing'].includes(v)) return 'ONGOING';
  return 'SCHEDULED';
};

// Minimal user normalizer for participants/members used in this route file
const toUserBasic = (p: any) => ({
  id: String(p?.id ?? ''),
  firstName: p?.firstName ?? '',
  lastName: p?.lastName ?? '',
  position: p?.positionType ?? p?.position ?? undefined,
});

const router = new Router({ prefix: '/leagues' });

// IMPORTANT: define this BEFORE any "/:id" routes to avoid collisions
router.get('/trophy-room', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: 'Unauthorized' };
    return;
  }
  const userId = ctx.state.user.userId;
  const leagueIdQ = typeof ctx.query?.leagueId === 'string' ? ctx.query.leagueId.trim() : '';

  type PlayerStats = { played: number; wins: number; draws: number; losses: number; goals: number; assists: number; motmVotes: number; teamGoalsConceded: number };

  // NEW: count completed matches for TBC/No Winner labeling
  const countCompleted = (league: any) =>
    (league.matches || []).filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED').length;

  // 1) Seed stats from both members and any match participants (fallback when members is empty)
  const calcStats = (league: any): Record<string, PlayerStats> => {
    const stats: Record<string, PlayerStats> = {};
    const ensure = (pid: string) => {
      if (!stats[pid]) {
        stats[pid] = { played: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };
      }
    };

    // Add league members
    (league.members || []).forEach((p: any) => ensure(String(p.id)));
    // Fallback: add anyone who appeared in matches
    (league.matches || []).forEach((m: any) => {
      (m.homeTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
      (m.awayTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
    });

    (league.matches || [])
      .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
      .forEach((m: any) => {
        const home: string[] = (m.homeTeamUsers || []).map((p: any) => String(p.id));
        const away: string[] = (m.awayTeamUsers || []).map((p: any) => String(p.id));

        [...home, ...away].forEach((pid: string) => {
          if (!stats[pid]) return;
          stats[pid].played += 1;
          const ps = (m.playerStats || {})[pid] || { goals: 0, assists: 0 };
          const g = Number(ps.goals || 0);
          const a = Number(ps.assists || 0);
          stats[pid].goals += Number.isFinite(g) ? g : 0;
          stats[pid].assists += Number.isFinite(a) ? a : 0;
        });

        const motmVals = Object.values(m.manOfTheMatchVotes || {}) as Array<string | number>;
        motmVals.forEach((pid) => {
          const id = String(pid);
          if (stats[id]) stats[id].motmVotes += 1;
        });

        const hg = Number(m.homeTeamGoals || 0);
        const ag = Number(m.awayTeamGoals || 0);
        const homeWon = hg > ag;
        const draw = hg === ag;

        home.forEach((pid: string) => {
          if (!stats[pid]) return;
          if (homeWon) stats[pid].wins += 1;
          else if (draw) stats[pid].draws += 1;
          else stats[pid].losses += 1;
          stats[pid].teamGoalsConceded += ag;
        });
        away.forEach((pid: string) => {
          if (!stats[pid]) return;
          if (!homeWon && !draw) stats[pid].wins += 1;
          else if (draw) stats[pid].draws += 1;
          else stats[pid].losses += 1;
          stats[pid].teamGoalsConceded += hg;
        });
      });
    return stats;
  };
  const calcWinners = (league: any, statsMap: Record<string, PlayerStats>) => {
    const completedMatches = countCompleted(league);

    const ids: string[] = Object.keys(statsMap);
    if (!ids.length) return [];

    // Only players who actually played are eligible for table-based awards
    const eligible: string[] = ids.filter((id: string) => (statsMap[id]?.played || 0) > 0);

    // League table by points (wins*3 + draws)
    const byPoints = (a: string, b: string) =>
      (statsMap[b].wins * 3 + statsMap[b].draws) - (statsMap[a].wins * 3 + statsMap[a].draws);
    const table: string[] = [...eligible].sort(byPoints);

    const getName = (pid: string) => {
      const p = (league.members || []).find((x: any) => String(x.id) === pid);
      return p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : 'Unknown';
    };

    // Goalkeepers and clean sheets
    const gkIds: string[] = (league.members || [])
      .filter((p: any) => String(p.positionType || p.position || '').toLowerCase().includes('goalkeeper'))
      .map((p: any) => String(p.id));
    const cleanSheets: Record<string, number> = {};
    gkIds.forEach((id: string) => (cleanSheets[id] = 0));

    (league.matches || [])
      .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
      .forEach((m: any) => {
        const homeGk: string[] = (m.homeTeamUsers || [])
          .filter((u: any) => gkIds.includes(String(u.id)))
          .map((u: any) => String(u.id));
        const awayGk: string[] = (m.awayTeamUsers || [])
          .filter((u: any) => gkIds.includes(String(u.id)))
          .map((u: any) => String(u.id));
        if (Number(m.awayTeamGoals || 0) === 0) homeGk.forEach((id: string) => (cleanSheets[id] = (cleanSheets[id] || 0) + 1));
        if (Number(m.homeTeamGoals || 0) === 0) awayGk.forEach((id: string) => (cleanSheets[id] = (cleanSheets[id] || 0) + 1));
      });

    // Helper: winner labeling (TBC vs No Winner)
    const withLabel = (winnerId: string | null) => {
      if (winnerId) return { winnerId, winner: getName(winnerId) };
      if (completedMatches === 0) return { winnerId: null, winner: null }; // TBC
      return { winnerId: null, winner: 'No Winner' }; // requirements not met
    };

    // Pickers with minimum requirements
    const pickChampion = () => (table.length >= 1 ? table[0] : null);
    const pickRunnerUp = () => (table.length >= 2 ? table[1] : null);

    const pickByMax = (arr: string[], metric: (id: string) => number, minRequired: number) => {
      if (!arr.length) return null;
      const sorted: string[] = [...arr].sort((a: string, b: string) => metric(b) - metric(a));
      const top = sorted[0];
      return metric(top) > minRequired ? top : null;
    };

    const goldenBoot = pickByMax(eligible, (id: string) => statsMap[id].goals, 0);
    const playmaker = pickByMax(eligible, (id: string) => statsMap[id].assists, 0);
    const ballonDor = pickByMax(eligible, (id: string) => statsMap[id].motmVotes, 0);

    const goat = (() => {
      if (!eligible.length) return null;
      const sorted: string[] = [...eligible].sort((a: string, b: string) => {
        const ra = statsMap[a].played ? statsMap[a].wins / statsMap[a].played : 0;
        const rb = statsMap[b].played ? statsMap[b].wins / statsMap[b].played : 0;
        return (rb - ra) || (statsMap[b].motmVotes - statsMap[a].motmVotes);
      });
      const top = sorted[0];
      const topRatio = statsMap[top].played ? statsMap[top].wins / statsMap[top].played : 0;
      return topRatio > 0 ? top : null;
    })();

    const shield = (() => {
      const defOrGk: string[] = (league.members || [])
        .filter((p: any) => ['defender', 'goalkeeper'].includes(String(p.positionType || p.position || '').toLowerCase()))
        .map((p: any) => String(p.id))
        .filter((id: string) => (statsMap[id]?.played || 0) > 0);
      if (!defOrGk.length) return null;
      const sorted: string[] = defOrGk.sort((a: string, b: string) => {
        const aa = statsMap[a].teamGoalsConceded / statsMap[a].played;
        const bb = statsMap[b].teamGoalsConceded / statsMap[b].played;
        return aa - bb;
      });
      const top = sorted[0];
      const avg = statsMap[top].teamGoalsConceded / statsMap[top].played;
      return Number.isFinite(avg) ? top : null;
    })();

    const darkHorse = (() => {
      if (table.length <= 3) return null;
      const outsideTop3: string[] = table.slice(3);
      const sorted: string[] = outsideTop3.sort((a: string, b: string) => statsMap[b].motmVotes - statsMap[a].motmVotes);
      const top = sorted[0];
      return top && statsMap[top].motmVotes > 0 ? top : null;
    })();

    const starKeeper = (() => {
      const eligibleGk: string[] = gkIds.filter((id: string) => (statsMap[id]?.played || 0) > 0);
      if (!eligibleGk.length) return null;
      const sorted: string[] = eligibleGk.sort((a: string, b: string) => {
        const csA = cleanSheets[a] || 0, csB = cleanSheets[b] || 0;
        if (csB !== csA) return csB - csA;
        const gaA = statsMap[a]?.teamGoalsConceded ?? Number.POSITIVE_INFINITY;
        const gaB = statsMap[b]?.teamGoalsConceded ?? Number.POSITIVE_INFINITY;
        return gaA - gaB;
      });
      const top = sorted[0];
      return (cleanSheets[top] || 0) > 0 ? top : null;
    })();

    const awards: Array<{ title: string; id: string | null }> = [
      { title: 'League Champion', id: pickChampion() },
      { title: 'Runner-Up', id: pickRunnerUp() },
      { title: "Ballon D'or", id: ballonDor },
      { title: 'GOAT', id: goat },
      { title: 'Golden Boot', id: goldenBoot },
      { title: 'King Playmaker', id: playmaker },
      { title: 'Legendary Shield', id: shield },
      { title: 'The Dark Horse', id: darkHorse },
      { title: 'Star Keeper', id: starKeeper },
    ];

    return awards.map(({ title, id }) => {
      const { winnerId, winner } = withLabel(id);
      return {
        title,
        winnerId,
        winner,
        leagueId: String(league.id),
        leagueName: league.name,
      };
    });
  };

  // Fetch leagues user belongs to (as member OR admin) with matches
  const memberLeagues = await League.findAll({
    where: { '$members.id$': userId },            // filter by membership
    include: [
      { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
      {
        model: Match, as: 'matches',
        include: [
          { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
          { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
        ],
      },
    ],
  });
  const adminLeagues = await League.findAll({
    where: { '$administeredLeagues.id$': userId }, // filter by admin
    include: [
      { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
      { model: User, as: 'administeredLeagues', attributes: ['id'] },
      {
        model: Match, as: 'matches',
        include: [
          { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
          { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
        ],
      },
    ],
  });

  // De-duplicate by id
  const byId: Record<string, any> = {};
  [...memberLeagues, ...adminLeagues].forEach((l: any) => { byId[String(l.id)] = l; });
  let leagues = Object.values(byId);

  // If a leagueId is provided, keep only that league
  if (leagueIdQ && leagueIdQ !== 'all') {
    leagues = leagues.filter((l: any) => String(l.id) === String(leagueIdQ));
  }

  // 3) Ensure members array is populated even if the ORM include missed them
  const leaguesPayload = leagues.map((l: any) => {
    const rawMembers = ((l as any).members || []) as any[];
    const rawMatches = ((l as any).matches || []) as any[];

    // derive members from match participants if needed
    const derivedFromMatches = [
      ...rawMatches.flatMap((m: any) => (m.homeTeamUsers || [])),
      ...rawMatches.flatMap((m: any) => (m.awayTeamUsers || [])),
    ];
    const mergedMap = new Map<string, any>();
    [...rawMembers, ...derivedFromMatches].forEach((u: any) => {
      const id = String(u.id);
      if (!mergedMap.has(id)) mergedMap.set(id, u);
    });
    const effectiveMembers = Array.from(mergedMap.values());

    return {
      id: String(l.id),
      name: l.name,
      members: effectiveMembers.map(toUserBasic),
      matches: rawMatches.map((m: any) => ({
        id: String(m.id),
        homeTeamGoals: Number(m.homeTeamGoals || 0),
        awayTeamGoals: Number(m.awayTeamGoals || 0),
        homeTeamUsers: ((m as any).homeTeamUsers || []).map(toUserBasic),
        awayTeamUsers: ((m as any).awayTeamUsers || []).map(toUserBasic),
        manOfTheMatchVotes: (m as any).manOfTheMatchVotes || {},
        playerStats: Object.fromEntries(
          (Object.entries((m as any).playerStats || {}) as Array<[string, any]>).map(([pid, s]) => [
            String(pid),
            { goals: Number(s?.goals || 0), assists: Number(s?.assists || 0) },
          ])
        ),
        status: normalizeStatus((m as any).status),
      })),
      maxGames: Number((l as any).maxGames || 0),
    };
  });

  // Compute winners only for the selected scope
  const trophyWinners = leaguesPayload.flatMap((lg) => {
    const stats = calcStats(lg);
    return calcWinners(lg, stats);
  });

  ctx.body = {
    success: true,
    leagues: leaguesPayload,
    trophyWinners,
  };
});

// Helper to return a consistent JSON 404 instead of throwing
function respondLeagueNotFound(ctx: any) {
  ctx.status = 404;
  ctx.body = { success: false, message: 'League not found' };
}

// REMOVE this incorrect route block (prefix already includes /leagues)
// router.get('/leagues/:leagueId', required, async (ctx) => { ... });

// ✅ Keep the canonical league-by-id route and return JSON instead of throwing
// router.get("/:id", required, async (ctx) => {
//   if (!ctx.state.user || !ctx.state.user.userId) {
//     ctx.status = 401;
//     ctx.body = { success: false, message: "Unauthorized" };
//     return;
//   }
//   if (!isUuid(ctx.params.id)) {
//     ctx.status = 400;
//     ctx.body = { success: false, message: "Invalid league id" };
//     return;
//   }

//   const leagueId = ctx.params.id;

//   try {
//     await Match.update(
//       { status: 'RESULT_PUBLISHED' },
//       {
//         where: {
//           leagueId: leagueId,
//           status: 'SCHEDULED',
//           end: { [Op.lt]: new Date() }
//         }
//       }
//     );
//   } catch (error) {
//     console.error('Error auto-updating match statuses:', error);
//   }

//   const league = await League.findByPk(ctx.params.id, {
//     include: [
//       { model: User, as: 'members' },
//       { model: User, as: 'administeredLeagues' },
//       {
//         model: Match,
//         as: 'matches',
//         include: [
//           { model: User, as: 'homeTeamUsers' },
//           { model: User, as: 'awayTeamUsers' },
//           { model: User, as: 'homeCaptain' },
//           { model: User, as: 'awayCaptain' },
//           { model: MatchGuest, as: 'guestPlayers' },
//           { model: User, as: 'availableUsers' }
//         ]
//       }
//     ]
//   });

//   if (!league) {
//     return respondLeagueNotFound(ctx);
//   }

//   const isMember = (league as any).members?.some((member: any) => member.id === ctx.state.user!.userId);
//   const isAdmin = (league as any).administeredLeagues?.some((admin: any) => admin.id === ctx.state.user!.userId);

//   if (!isMember && !isAdmin) {
//     // Optional stricter access: keep as 403 JSON instead of throw
//     ctx.status = 403;
//     ctx.body = { success: false, message: "You don't have access to this league" };
//     return;
//   }

//   ctx.body = {
//     success: true,
//     league: {
//       id: league.id,
//       name: league.name,
//       inviteCode: league.inviteCode,
//       createdAt: league.createdAt,
//       members: (league as any).members || [],
//       administrators: (league as any).administeredLeagues || [],
//       matches: (league as any).matches || [],
//       active: league.active,
//       maxGames: league.maxGames,
//       showPoints: league.showPoints,
//       image: league.image
//     }
//   };
// });

// ✅ ADD AVAILABILITY ROUTE HERE
router.get('/:leagueId/matches/:matchId/availability', required, async (ctx) => {
  try {
    const { leagueId, matchId } = ctx.params;

    console.log(`🔍 Fetching availability for match ${matchId} in league ${leagueId}`);

    // Validate parameters
    if (!isUuid(leagueId) || !isUuid(matchId)) {
      ctx.throw(400, 'Invalid league or match ID');
      return;
    }

    // Verify match exists in this league
    const match = await Match.findOne({
      where: {
        id: matchId,
        leagueId: leagueId
      }
    });

    if (!match) {
      ctx.throw(404, 'Match not found');
      return;
    }

    // Get all availability records for this match
    const availability = await MatchAvailability.findAll({
      where: { match_id: matchId },
      attributes: ['user_id', 'status', 'created_at', 'updated_at'],
      order: [['created_at', 'ASC']]
    });

    console.log(`📊 Found ${availability.length} availability records for match ${matchId}`);

    // Format the response to match what the frontend expects
    const formattedAvailability = availability.map((record: any) => ({
      userId: record.user_id,
      status: record.status,
      createdAt: record.created_at,
      updatedAt: record.updated_at
    }));

    ctx.body = {
      success: true,
      availability: formattedAvailability,
      matchId,
      count: formattedAvailability.length
    };

    console.log(`✅ Successfully returned availability data for match ${matchId}`);

  } catch (error) {
    console.error('❌ Error fetching match availability:', error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to fetch availability data',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Get all leagues for the current user (for /leagues/user) - ULTRA FAST FIXED
router.get('/user', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `user_leagues_${userId}_ultra_fast`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  try {
    // ORM-only: use membership association to fetch ONLY the current user's leagues
    const userLeagues = await League.findAll({
      attributes: ['id', 'name', 'maxGames', 'image', 'createdAt'],
      include: [
        {
          model: User,
          as: 'members',
          attributes: [],
          through: { attributes: [] },
          where: { id: userId },
          required: true
        }
      ],
      order: [['createdAt', 'DESC']],
      limit: 15
    });

    const leagues = userLeagues.map((l: any) => ({
      id: l.id,
      name: l.name,
      description: '',
      type: 'standard',
      maxGames: l.maxGames,
      leagueImage: l.image || null,
      createdAt: l.createdAt
    }));

    const result = { success: true, leagues };

    cache.set(cacheKey, result, 1800); // 30 min cache
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (error) {
    console.error("Error fetching leagues for user:", error);
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: "Failed to retrieve leagues.",
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Get all leagues for the current user - ULTRA FAST FIXED (keep this at "/")
// router.get("/", required, async (ctx) => {
//   if (!ctx.state.user || !ctx.state.user.userId) {
//     ctx.status = 401;
//     ctx.body = { success: false, message: "Unauthorized" };
//     return;
//   }

//   const userId = ctx.state.user.userId;
//   const cacheKey = `leagues_main_${userId}_ultra_fast`;
//   const cached = cache.get(cacheKey);
//   if (cached) {
//     ctx.set('X-Cache', 'HIT');
//     ctx.body = cached;
//     return;
//   }

//   try {
//     // Try to get user leagues with simple fallback
//     let results;

//     try {
//       // First try with minimal fields that should exist
//       [results] = await User.sequelize?.query(`
//         SELECT l.id, l.name, l."maxGames", l.image, l."createdAt"
//         FROM "Leagues" l
//         INNER JOIN "LeagueMembers" lm ON l.id = lm."leagueId"
//         WHERE lm."userId" = :userId
//         ORDER BY l."createdAt" DESC
//         LIMIT 10
//       `, {
//         replacements: { userId },
//         type: QueryTypes.SELECT
//       }) || [];

//       // Add missing fields that frontend expects
//       results = (results as any[]).map((league: any) => ({
//         ...league,
//         description: '', // Add empty description
//         type: 'standard', // Add default type
//         leagueImage: league.image || null // Map image to leagueImage
//       }));

//     } catch (queryError) {
//       console.log('Raw query failed, using fallback:', queryError);
//       // Fallback: get all leagues (not ideal but works)
//       const allLeagues = await League.findAll({
//         attributes: ['id', 'name', 'maxGames', 'image', 'createdAt'],
//         limit: 10
//       });

//       // Map to expected format
//       results = allLeagues.map((league: any) => ({
//         id: league.id,
//         name: league.name,
//         description: '', // Add empty description
//         type: 'standard', // Add default type
//         maxGames: league.maxGames,
//         leagueImage: league.image || null,
//         createdAt: league.createdAt
//       }));
//     }

//     const result = {
//       success: true,
//       leagues: results || []
//     };

//     cache.set(cacheKey, result, 1800); // 30 min cache
//     ctx.set('X-Cache', 'MISS');
//     ctx.body = result;
//   } catch (error) {
//     console.error("Error fetching leagues for user:", error);
//     ctx.status = 500;
//     ctx.body = {
//       success: false,
//       message: "Failed to retrieve leagues.",
//       error: error instanceof Error ? error.message : 'Unknown error'
//     };
//   }
// });

// Get league details by ID
router.get("/:id", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }
  if (!isUuid(ctx.params.id)) {
    ctx.throw(400, "Invalid league id");
    return;
  }

  const leagueId = ctx.params.id;

  try {
    await Match.update(
      { status: 'RESULT_PUBLISHED' },
      {
        where: {
          leagueId: leagueId,
          status: 'SCHEDULED',
          end: { [Op.lt]: new Date() }
        }
      }
    );
  } catch (error) {
    console.error('Error auto-updating match statuses:', error);
    // We don't throw here, as fetching the league is the primary purpose
  }

  const league = await League.findByPk(ctx.params.id, {
    include: [
      { model: User, as: 'members' },
      { model: User, as: 'administeredLeagues' },
      {
        model: Match,
        as: 'matches',
        include: [
          { model: User, as: 'homeTeamUsers' },
          { model: User, as: 'awayTeamUsers' },
          { model: User, as: 'homeCaptain' },
          { model: User, as: 'awayCaptain' },
          { model: MatchGuest, as: 'guestPlayers' },
          { model: User, as: 'availableUsers' }
        ]
      }
    ]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  const isMember = (league as any).members?.some((member: any) => member.id === ctx.state.user!.userId);
  const isAdmin = (league as any).administeredLeagues?.some((admin: any) => admin.id === ctx.state.user!.userId);

  if (!isMember && !isAdmin) {
    // New logic: allow if user has ever shared any league with any member
    // 1. Get all league IDs for the current user
    const userWithLeagues = await User.findByPk(ctx.state.user!.userId, {
      include: [{ model: League, as: 'leagues', attributes: ['id'] }]
    });
    const userLeagueIds = (userWithLeagues as any)?.leagues?.map((l: any) => l.id) || [];
    // 2. For each member of this league, check if there is any overlap
    const memberIds = (league as any).members?.map((m: any) => m.id) || [];
    let hasCommonLeague = false;
    for (const memberId of memberIds) {
      if (memberId === ctx.state.user!.userId) continue;
      const memberWithLeagues = await User.findByPk(memberId, {
        include: [{ model: League, as: 'leagues', attributes: ['id'] }]
      });
      const memberLeagueIds = (memberWithLeagues as any)?.leagues?.map((l: any) => l.id) || [];
      if (userLeagueIds.some((id: any) => memberLeagueIds.includes(id))) {
        hasCommonLeague = true;
        break;
      }
    }
    if (!hasCommonLeague) {
      ctx.throw(403, "You don't have access to this league");
    }
  }

  ctx.body = {
    success: true,
    league: {
      id: league.id,
      name: league.name,
      inviteCode: league.inviteCode,
      createdAt: league.createdAt,
      members: (league as any).members || [],
      administrators: (league as any).administeredLeagues || [],
      matches: (league as any).matches || [],
      active: league.active,
      maxGames: league.maxGames,
      showPoints: league.showPoints,
      image: league.image
    }
  };
});

// Create a new league
router.post("/", required, upload.single('image'), async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const { name, maxGames, showPoints } = ctx.request.body as LeagueAttributes;
  const trimmedName = (name || '').trim();
  if (!trimmedName) {
    ctx.throw(400, "League name is required");
  }

  // Case-insensitive duplicate name check
  const existingByName = await League.findOne({
    where: where(fn('LOWER', col('name')), trimmedName.toLowerCase())
  });
  if (existingByName) {
    ctx.status = 409;
    ctx.body = { success: false, message: "A league with this name already exists." };
    return;
  }

  try {
    let imageUrl = null;

    // Handle image upload if file is present
    if (ctx.file) {
      try {
        imageUrl = await uploadToCloudinary(ctx.file.buffer, 'league-images');
        console.log('League image uploaded successfully:', imageUrl);
      } catch (uploadError) {
        console.error('League image upload error:', uploadError);
        // Continue without image
        imageUrl = null;
      }
    }

    const newLeague = await League.create({
      name: trimmedName,
      inviteCode: getInviteCode(),
      maxGames: 20,
      showPoints,
      image: imageUrl,
    } as any);

    const user = await User.findByPk(ctx.state.user.userId);
    if (user) {
      await (newLeague as any).addMember(user);
      await (newLeague as any).addAdministeredLeague(user);

      const emailHtml = `
      <h1>Congratulations!</h1>
        <p>You have successfully created the league: <strong>${newLeague.name}</strong>.</p>
        <p>Your invite code is: <strong>${newLeague.inviteCode}</strong>. Share it with others to join!</p>
      <p>Happy competing!</p>
    `;

      if (user.email) {
        await transporter.sendMail({
          to: user.email,
          subject: `You've created a new league: ${newLeague.name}`,
          html: emailHtml,
        });
        console.log(`Creation email sent to ${user.email}`);
      } else {
        console.warn('Email not sent: user has no email');
      }
    }

    // Update cache with new league
    const newLeagueData = {
      id: newLeague.id,
      name: newLeague.name,
      inviteCode: newLeague.inviteCode,
      createdAt: newLeague.createdAt,
      maxGames,
      showPoints,
      active: true,
      image: imageUrl,
      members: [],
      administrators: [user],
      matches: []
    };

    // Update all user-specific league caches
    cache.updateArray(`user_leagues_${ctx.state.user.userId}`, newLeagueData);

    // Clear any general leagues cache to ensure fresh data
    cache.clearPattern('leagues_all');

    ctx.status = 201;
    ctx.body = {
      success: true,
      message: "League created successfully",
      league: {
        id: newLeague.id,
        name: newLeague.name,
        inviteCode: newLeague.inviteCode,
        createdAt: newLeague.createdAt,
        image: imageUrl,
      },
    };
  } catch (error) {
    console.error('League creation error:', error);
    ctx.throw(500, "Failed to create league");
  }
});

// New endpoint to update league status
router.patch("/:id/status", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const leagueId = ctx.params.id;
  const { active } = ctx.request.body as { active: boolean };

  // Verify user is an admin of the league
  await verifyLeagueAdmin(ctx, leagueId);

  const league = await League.findByPk(leagueId, {
    include: [{ model: User, as: 'members' }]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  // Update the league status
  league.active = active;
  await league.save();

  // If the league is being made inactive, run final XP calculation for all members
  if (active === false) {
    console.log(`League ${league.name} (${league.id}) is ending. Running final XP calculation.`);
    for (const member of (league as any).members || []) {
      try {
        await calculateAndAwardXPAchievements(member.id, league.id);
      } catch (error) {
        console.error(`Error during final XP calculation for user ${member.id} in league ${league.id}:`, error);
      }
    }
  }

  // Update cache with league status change
  const updatedLeagueData = {
    id: leagueId,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active,
    members: (league as any).members || [],
    administrators: [],
    matches: []
  };

  // Update all user league caches
  const memberIds = (league as any).members.map((m: any) => m.id);
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
  });

  ctx.body = { success: true, league };
});

// Update a league's general settings
router.patch("/:id", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  const { name, maxGames, showPoints, active, admins } = ctx.request.body as (LeagueAttributes & { active?: boolean, admins?: string[] });

  await league.update({
    name,
    maxGames,
    showPoints,
    active,
  });

  if (admins && admins.length > 0) {
    const newAdmin = await User.findByPk(admins[0]);
    if (newAdmin) {
      await (league as any).setAdministeredLeagues([newAdmin]);
    } else {
      ctx.throw(404, 'Selected admin user not found.');
      return;
    }
  }

  // Update cache with league changes
  const updatedLeagueData = {
    id: ctx.params.id,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active: league.active,
    members: [],
    administrators: [],
    matches: []
  };

  // Update all user league caches
  const leagueWithMembers = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
  });

  ctx.status = 200;
  ctx.body = { success: true, message: "League updated successfully." };
});

// Delete a league
router.delete("/:id", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  // Get league members before deletion
  const leagueWithMembers = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];

  await league.destroy();

  // Remove league from all user caches
  memberIds.forEach((memberId: string) => {
    cache.removeFromArray(`user_leagues_${memberId}`, ctx.params.id);
  });

  ctx.status = 204; // No Content
});

// Create a new match in a league WITH NOTIFICATIONS
router.post("/:id/matches", required, upload.fields([
  { name: 'homeTeamImage', maxCount: 1 },
  { name: 'awayTeamImage', maxCount: 1 }
]), async (ctx) => {
  // Validate league id before any DB call
  const leagueId = String(ctx.params.id || '').trim();
  if (!isUuid(leagueId)) {
    ctx.throw(400, "Invalid league id");
    return;
  }

  console.log("🎯 Creating match with notifications...");

  // Parse FormData fields
  const homeTeamName = ctx.request.body.homeTeamName;
  const awayTeamName = ctx.request.body.awayTeamName;
  const date = ctx.request.body.date;
  const start = ctx.request.body.start;
  const end = ctx.request.body.end;
  const location = ctx.request.body.location;

  // ✅ Validation (only required fields)
  if (!date || !start || !location) {
    ctx.throw(400, "Missing required match details: date, start, or location.");
  }

  // Parse JSON arrays from FormData
  let homeTeamUsers: string[] = [];
  let awayTeamUsers: string[] = [];

  try {
    if (ctx.request.body.homeTeamUsers) {
      homeTeamUsers = JSON.parse(ctx.request.body.homeTeamUsers);
    }
    if (ctx.request.body.awayTeamUsers) {
      awayTeamUsers = JSON.parse(ctx.request.body.awayTeamUsers);
    }
  } catch (error) {
    console.error('Error parsing team users arrays:', error);
  }

  // Filter out guest placeholder IDs that are not valid UUIDs
  const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
  const rawHomeTeamUsers = homeTeamUsers;
  const rawAwayTeamUsers = awayTeamUsers;
  homeTeamUsers = (homeTeamUsers || []).filter((id: string) => uuidRegex.test(id));
  awayTeamUsers = (awayTeamUsers || []).filter((id: string) => uuidRegex.test(id));

  const guestHomeIds = (rawHomeTeamUsers || []).filter((id: string) => !uuidRegex.test(id));
  const guestAwayIds = (rawAwayTeamUsers || []).filter((id: string) => !uuidRegex.test(id));

  if (guestHomeIds.length || guestAwayIds.length) {
    console.log('Guest placeholders ignored on initial match create:', { guestHomeIds, guestAwayIds });
  }

  const homeCaptain = ctx.request.body.homeCaptain;
  const awayCaptain = ctx.request.body.awayCaptain;

  await verifyLeagueAdmin(ctx, leagueId);

  // 🔥 UPDATED: Include members in the league query
  const league = await League.findByPk(leagueId, {
    include: [
      { model: Match, as: 'matches' },
      { model: User, as: 'members' } // <-- ADD THIS FOR NOTIFICATIONS
    ]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  if (league.maxGames && (league as any).matches.length >= league.maxGames) {
    ctx.throw(403, "This league has reached the maximum number of games.");
  }

  // Handle team image uploads
  let homeTeamImageUrl = null;
  let awayTeamImageUrl = null;

  if (ctx.files) {
    const files = ctx.files as { [fieldname: string]: Express.Multer.File[] };

    // Upload home team image
    if (files.homeTeamImage && files.homeTeamImage[0]) {
      try {
        homeTeamImageUrl = await uploadToCloudinary(files.homeTeamImage[0].buffer, 'team-images');
        console.log('Home team image uploaded successfully:', homeTeamImageUrl);
      } catch (uploadError) {
        console.error('Home team image upload error:', uploadError);
        homeTeamImageUrl = null;
      }
    }

    // Upload away team image
    if (files.awayTeamImage && files.awayTeamImage[0]) {
      try {
        awayTeamImageUrl = await uploadToCloudinary(files.awayTeamImage[0].buffer, 'team-images');
        console.log('Away team image uploaded successfully:', awayTeamImageUrl);
      } catch (uploadError) {
        console.error('Away team image upload error:', uploadError);
        awayTeamImageUrl = null;
      }
    }
  }

  const matchDate = new Date(date);
  const startDate = new Date(start);
  const finalEndDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 60000);

  // CREATE THE MATCH
  const match = await Match.create({
    awayTeamName,
    homeTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'SCHEDULED',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamImage: homeTeamImageUrl,
    awayTeamImage: awayTeamImageUrl
  } as any);

  console.log('✅ Match created:', match.id);

  // Add team users
  if (homeTeamUsers.length > 0) {
    await (match as any).addHomeTeamUsers(homeTeamUsers);
  }

  if (awayTeamUsers.length > 0) {
    await (match as any).addAwayTeamUsers(awayTeamUsers);
  }

  // 🔥 CREATE NOTIFICATIONS FOR ALL LEAGUE MEMBERS
  const members = (league as any).members || [];
  console.log(`📧 Creating notifications for ${members.length} league members`);

  if (members.length > 0) {
    try {
      const memberIds = members.map((m: any) => m.id);

      // Create availability entries
      const availabilityEntries = memberIds.map((userId: string) => ({
        match_id: match.id,
        user_id: userId,
        status: 'pending' as const
      }));

      await MatchAvailability.bulkCreate(availabilityEntries);
      console.log(`✅ Created ${availabilityEntries.length} availability entries`);

      // Create notifications
      const matchDateFormatted = new Date(start).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      const notificationEntries = memberIds.map((userId: string) => ({
        user_id: userId,
        type: 'match_created',
        title: '⚽ New Match Scheduled!',
        body: `${homeTeamName} vs ${awayTeamName} on ${matchDateFormatted} at ${location}. Please update your availability.`,
        meta: JSON.stringify({
          matchId: match.id,
          leagueId: leagueId,
          homeTeam: homeTeamName,
          awayTeam: awayTeamName,
          matchStart: start,
          location: location
        }),
        read: false,
        created_at: new Date(),
        updated_at: new Date()
      }));

      await Notification.bulkCreate(notificationEntries);
      console.log(`🔔 Created ${notificationEntries.length} notifications`);

    } catch (notificationError) {
      console.error('❌ Error creating notifications:', notificationError);
    }
  }

  // Get the complete match with users for response
  const matchWithUsers = await Match.findByPk(match.id, {
    include: [
      { model: User, as: 'awayTeamUsers' },
      { model: User, as: 'homeTeamUsers' }
    ]
  });

  // Serialize match data to avoid circular references
  const serializedMatch = {
    id: match.id,
    homeTeamName,
    awayTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'SCHEDULED',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamUsers: (matchWithUsers as any)?.homeTeamUsers?.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      profilePicture: user.profilePicture,
      shirtNumber: user.shirtNumber,
      level: user.level,
      positionType: user.positionType,
      preferredFoot: user.preferredFoot
    })) || [],
    awayTeamUsers: (matchWithUsers as any)?.awayTeamUsers?.map((user: any) => ({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      profilePicture: user.profilePicture,
      shirtNumber: user.shirtNumber,
      level: user.level,
      positionType: user.positionType,
      preferredFoot: user.preferredFoot
    })) || [],
    guests: []
  };

  // Update cache with new match
  const newMatchData = {
    id: match.id,
    homeTeamName,
    awayTeamName,
    location,
    leagueId,
    date: matchDate,
    start: startDate,
    end: finalEndDate,
    status: 'SCHEDULED',
    homeCaptainId: homeCaptain || null,
    awayCaptainId: awayCaptain || null,
    homeTeamUsers: serializedMatch.homeTeamUsers,
    awayTeamUsers: serializedMatch.awayTeamUsers,
    guests: []
  };

  // Update matches cache
  cache.updateArray('matches_all', newMatchData);

  // Update league cache with new match
  const updatedLeagueData = {
    id: leagueId,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active: league.active,
    members: [],
    administrators: [],
    matches: [newMatchData]
  };

  // Update all user league caches
  const memberIds = members.map((m: any) => m.id);
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, updatedLeagueData);
  });

  ctx.status = 201;
  ctx.body = {
    success: true,
    message: `Match scheduled successfully! ${members.length} members notified.`,
    match: serializedMatch,
    notificationsSent: members.length
  };
});

// Get a single match's details
router.get("/:leagueId/matches/:matchId", required, async (ctx) => {
  const { matchId } = ctx.params;

  const match = await Match.findByPk(matchId, {
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
      { model: MatchGuest, as: 'guestPlayers' },
    ],
  });

  if (!match) {
    ctx.status = 404;
    ctx.body = { success: false, message: "Match not found" };
    return;
  }

  const plain = (match as any).toJSON ? (match as any).toJSON() : match;
  const guests = (plain.guestPlayers || []).map((g: any) => ({
    id: g.id,
    team: g.team,
    firstName: g.firstName,
    lastName: g.lastName,
    shirtNumber: g.shirtNumber,
  }));

  ctx.body = { success: true, match: { ...plain, guests } };
});

// Update a match's details
// router.patch("/:leagueId/matches/:matchId", required, async (ctx) => {
//   await verifyLeagueAdmin(ctx, ctx.params.leagueId);

//   const { matchId } = ctx.params;
//   const match = await Match.findByPk(matchId);

//   const {
//     homeTeamName,
//     awayTeamName,
//     date,
//     location,
//     homeTeamUsers,
//     awayTeamUsers,
//     homeCaptainId,
//     awayCaptainId,
//   } = ctx.request.body as {
//     homeTeamName: string;
//     awayTeamName: string;
//     date: string;
//     location: string;
//     homeTeamUsers: string[];
//     awayTeamUsers: string[];
//     homeCaptainId:string;
//     awayCaptainId:string;
//   };

//   const matchDate = new Date(date);

//   if (!match) {
//     ctx.throw(404, "Match not found");
//     return;
//   }

//   await match.update({
//     homeTeamName,
//     awayTeamName,
//     date: matchDate,
//     start: matchDate,
//     end: matchDate,
//     location,
//     homeCaptainId: ctx.request.body.homeCaptainId, // <-- add this
//     awayCaptainId: ctx.request.body.awayCaptainId, // <-- add this
//   });

//   if (homeTeamUsers) {
//     await (match as any).setHomeTeamUsers(homeTeamUsers);
//   }
//   if (awayTeamUsers) {
//     await (match as any).setAwayTeamUsers(awayTeamUsers);
//   }

//   const updatedMatch = await Match.findByPk(matchId, {
//     include: [
//       { model: User, as: 'homeTeamUsers' },
//       { model: User, as: 'awayTeamUsers' },
//     ],
//   });

//   // Update cache with updated match
//   const updatedMatchData = {
//     id: matchId,
//     homeTeamName,
//     awayTeamName,
//     location,
//     leagueId: match.leagueId,
//     date: matchDate,
//     start: matchDate,
//     end: matchDate,
//     status: match.status,
//     homeCaptainId: ctx.request.body.homeCaptainId,
//     awayCaptainId: ctx.request.body.awayCaptainId,
//     homeTeamUsers: (updatedMatch as any)?.homeTeamUsers || [],
//     awayTeamUsers: (updatedMatch as any)?.awayTeamUsers || []
//   };

//   // Update matches cache
//   cache.updateArray('matches_all', updatedMatchData);

//   ctx.body = {
//     success: true,
//     message: "Match updated successfully.",
//     match: updatedMatch,
//   };
// });

router.patch(
  "/:leagueId/matches/:matchId",
  required,
  conditionalUpload([
    { name: 'homeTeamImage', maxCount: 1 },
    { name: 'awayTeamImage', maxCount: 1 }
  ]),
  async (ctx) => {
    await verifyLeagueAdmin(ctx, ctx.params.leagueId);

    const { matchId } = ctx.params;
    const match = await Match.findByPk(matchId);
    if (!match) { ctx.throw(404, "Match not found"); return; }

    const body = (ctx.request as any).body || {};
    const files = (ctx.files as any) || {};

    const hasProp = (obj: any, key: string) => Object.prototype.hasOwnProperty.call(obj, key);

    const parseIds = (v: any): string[] => {
      if (!v) return [];
      if (Array.isArray(v)) return v.map(String);
      if (typeof v === 'string') {
        try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed.map(String) : [v]; }
        catch { return [v]; }
      }
      return [];
    };

    const parseGuests = (v: any): Array<{ id?: string; team: 'home' | 'away'; firstName: string; lastName: string; shirtNumber?: string }> => {
      if (!v) return [];
      try {
        const arr = typeof v === 'string' ? JSON.parse(v) : v;
        return Array.isArray(arr) ? arr.map(g => ({
          id: g.id ? String(g.id) : undefined,
          team: g.team === 'away' ? 'away' : 'home',
          firstName: String(g.firstName || '').trim(),
          lastName: String(g.lastName || '').trim(),
          shirtNumber: g.shirtNumber != null ? String(g.shirtNumber) : undefined,
        })) : [];
      } catch {
        return [];
      }
    };

    const homeTeamName = body.homeTeamName;
    const awayTeamName = body.awayTeamName;
    const date = body.date;    // optional
    const startIso = body.start; // optional
    const endIso = body.end;     // optional
    const location = body.location; // optional

    const homeTeamUsers = parseIds(body.homeTeamUsers);
    const awayTeamUsers = parseIds(body.awayTeamUsers);

    // Accept either ...Id or plain keys from FormData (only persist with >=6 players)
    const homeCaptainIdRaw = (body.homeCaptain ?? body.homeCaptainId);
    const awayCaptainIdRaw = (body.awayCaptain ?? body.awayCaptainId);

    // Upload images if provided
    let homeTeamImageUrl = match.homeTeamImage;
    let awayTeamImageUrl = match.awayTeamImage;
    if (files.homeTeamImage?.[0]?.buffer) {
      try { homeTeamImageUrl = await uploadToCloudinary(files.homeTeamImage[0].buffer, 'team-images'); }
      catch (e) { console.error('Home team image upload error:', e); }
    }
    if (files.awayTeamImage?.[0]?.buffer) {
      try { awayTeamImageUrl = await uploadToCloudinary(files.awayTeamImage[0].buffer, 'team-images'); }
      catch (e) { console.error('Away team image upload error:', e); }
    }

    // Compute start/end but do not require inputs
    const previousStart = match.start;
    const previousEnd = match.end;
    const prevDurationMs = previousEnd && previousStart
      ? (new Date(previousEnd).getTime() - new Date(previousStart).getTime())
      : 90 * 60 * 1000;

    const computedStart = startIso
      ? new Date(startIso)
      : (date ? new Date(date) : new Date(previousStart));
    const computedEnd = endIso
      ? new Date(endIso)
      : (date ? new Date(new Date(date).getTime() + prevDurationMs) : new Date(new Date(computedStart).getTime() + prevDurationMs));
    const matchDate = computedStart;

    // Only update provided primitives; avoid overwriting non-sent fields
    const updatePayload: any = {};
    if (hasProp(body, 'homeTeamName')) updatePayload.homeTeamName = homeTeamName;
    if (hasProp(body, 'awayTeamName')) updatePayload.awayTeamName = awayTeamName;
    if (hasProp(body, 'location')) updatePayload.location = location;
    // Update timing if any timing field present
    if (hasProp(body, 'date') || hasProp(body, 'start') || hasProp(body, 'end')) {
      updatePayload.date = matchDate;
      updatePayload.start = computedStart;
      updatePayload.end = computedEnd;
    }
    // Always allow image updates if uploaded
    updatePayload.homeTeamImage = homeTeamImageUrl;
    updatePayload.awayTeamImage = awayTeamImageUrl;

    if (Object.keys(updatePayload).length) {
      await match.update(updatePayload);
    }

    // Detect actual team changes (only if arrays were sent)
    const currHome = await (match as any).getHomeTeamUsers({ attributes: ['id'] });
    const currAway = await (match as any).getAwayTeamUsers({ attributes: ['id'] });
    const currHomeIds = currHome.map((u: any) => String(u.id));
    const currAwayIds = currAway.map((u: any) => String(u.id));
    const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x));

    const teamsWereSent = hasProp(body, 'homeTeamUsers') || hasProp(body, 'awayTeamUsers');
    const teamsChanged = teamsWereSent && (!sameSet(homeTeamUsers, currHomeIds) || !sameSet(awayTeamUsers, currAwayIds));

    // Guests sync (only when provided)
    let desiredGuests = parseGuests(body.guests);
    if (!desiredGuests.length) {
      const homeGuests = parseGuests(body.homeGuests).map(g => ({ ...g, team: 'home' as const }));
      const awayGuests = parseGuests(body.awayGuests).map(g => ({ ...g, team: 'away' as const }));
      desiredGuests = [...homeGuests, ...awayGuests];
    }
    if (desiredGuests.length || hasProp(body, 'guests') || hasProp(body, 'homeGuests') || hasProp(body, 'awayGuests')) {
      const existing = await MatchGuest.findAll({ where: { matchId } });
      const existingMap = new Map(existing.map((g: any) => [String(g.id), g]));

      const keepIds = new Set(desiredGuests.filter(g => g.id).map(g => String(g.id)));
      const toDeleteIds = existing.map((g: any) => String(g.id)).filter(id => !keepIds.has(id));
      if (toDeleteIds.length) {
        await MatchGuest.destroy({ where: { matchId, id: toDeleteIds } as any });
      }

      for (const g of desiredGuests) {
        if (g.id && existingMap.has(g.id)) {
          await MatchGuest.update(
            { team: g.team, firstName: g.firstName, lastName: g.lastName },
            { where: { id: g.id, matchId } as any }
          );
        } else {
          await MatchGuest.create({
            matchId,
            team: g.team,
            firstName: g.firstName,
            lastName: g.lastName,
            // TS: prefer undefined over null for optional attrs
            shirtNumber: g.shirtNumber ?? undefined
          } as any);
        }
      }
    }

    // Selection logic
    const MIN_PLAYERS = 6;
    const selectedUserIds = Array.from(new Set([...(homeTeamUsers || []), ...(awayTeamUsers || [])]));
    const registeredCount = selectedUserIds.length;
    const guestCount = (desiredGuests || []).length;
    const totalWithGuests = registeredCount + guestCount;

    // Persist teams/captains ONLY if teams changed AND enough players (including guests)
    if (teamsChanged && totalWithGuests >= MIN_PLAYERS) {
      await (match as any).setHomeTeamUsers(homeTeamUsers);
      await (match as any).setAwayTeamUsers(awayTeamUsers);

      // --- AUTO CAPTAIN ASSIGNMENT WITH 3-GAME GAP RULE ---
      const homeCandidates: string[] = homeTeamUsers || [];
      const awayCandidates: string[] = awayTeamUsers || [];
      const refDate: Date = computedStart instanceof Date ? computedStart : new Date(computedStart || match.start || Date.now());

      const prevMatches = await Match.findAll({
        where: { leagueId: match.leagueId, id: { [Op.ne]: matchId }, start: { [Op.lt]: refDate } },
        attributes: ['id', 'homeCaptainId', 'awayCaptainId', 'start'],
        order: [['start', 'DESC']],
        limit: 3
      });

      const ineligible = new Set<string>();
      for (const m of prevMatches) {
        const hc = (m as any).homeCaptainId ? String((m as any).homeCaptainId) : null;
        const ac = (m as any).awayCaptainId ? String((m as any).awayCaptainId) : null;
        if (hc) ineligible.add(hc);
        if (ac) ineligible.add(ac);
      }

      const pickCaptain = (teamIds: string[], preferredRaw?: any): string | null => {
        const preferred = preferredRaw ? String(preferredRaw) : undefined;
        const inTeam = (id: string | undefined) => !!id && teamIds.includes(id);
        if (preferred && inTeam(preferred) && !ineligible.has(preferred)) return preferred;
        const eligible = teamIds.filter((id) => !ineligible.has(String(id)));
        if (eligible.length > 0) return eligible[0];
        return teamIds[0] || null;
      };

      const newHomeCaptainId = pickCaptain(homeCandidates, body.homeCaptain ?? body.homeCaptainId);
      const newAwayCaptainId = pickCaptain(awayCandidates, body.awayCaptain ?? body.awayCaptainId);

      await match.update({
        homeCaptainId: toNullableUUID(newHomeCaptainId ?? null) as any,
        awayCaptainId: toNullableUUID(newAwayCaptainId ?? null) as any
      });
      // --- END AUTO CAPTAIN ASSIGNMENT ---

      // --- NEW: NOTIFY NEWLY ADDED PLAYERS ---
      try {
        // Compare with current team membership captured earlier
        const addedHomeIds = (homeTeamUsers || []).filter(id => !currHomeIds.includes(String(id)));
        const addedAwayIds = (awayTeamUsers || []).filter(id => !currAwayIds.includes(String(id)));
        const addedAll = [
          ...addedHomeIds.map(id => ({ id, team: 'home' as const })),
          ...addedAwayIds.map(id => ({ id, team: 'away' as const }))
        ];

        if (addedAll.length > 0) {
          const leagueRec = await League.findByPk(match.leagueId, { attributes: ['id', 'name'] });
          const leagueName = leagueRec ? (leagueRec as any).name : String(match.leagueId);
          const matchStartISO = (computedStart instanceof Date ? computedStart : new Date(computedStart)).toISOString();

          const title = 'You were added to a match';
          const bodyTemplate = (team: 'home' | 'away') =>
            `You have been added to the ${team} team for ${homeTeamName || match.homeTeamName} vs ${awayTeamName || match.awayTeamName} in league ${leagueName}.`;

          const notificationEntries = addedAll.map(({ id, team }) => ({
            user_id: id,
            type: 'match_added_to_team',
            title,
            body: bodyTemplate(team),
            meta: JSON.stringify({
              matchId,
              leagueId: String(match.leagueId),
              team,
              matchStart: matchStartISO,
              location: hasProp(body, 'location') ? location : match.location
            }),
            read: false,
            created_at: new Date(),
            updated_at: new Date()
          }));

          await Notification.bulkCreate(notificationEntries);
          console.log(`🔔 Sent "added to match" notifications to ${notificationEntries.length} users for match ${matchId}`);
        }
      } catch (notifyAddedErr) {
        console.error('Notify (added to match) error:', notifyAddedErr);
      }
      // --- END NEW: NOTIFY NEWLY ADDED PLAYERS ---
    }

    // Notify only when teams actually changed and total (including guests) < 6
    try {
      if (teamsChanged && registeredCount > 0 && totalWithGuests < MIN_PLAYERS) {
        const missing = MIN_PLAYERS - totalWithGuests;
        const title = '⚠️ Match needs more players';
        const bodyText = `${homeTeamName || match.homeTeamName} vs ${awayTeamName || match.awayTeamName} needs ${missing} more player${missing === 1 ? '' : 's'} to confirm.`;
        const matchStartISO = (computedStart instanceof Date ? computedStart : new Date(computedStart)).toISOString();

        const notificationEntries = selectedUserIds.map((userId: string) => ({
          user_id: userId,
          type: 'match_needs_players',
          title,
          body: bodyText,
          meta: JSON.stringify({
            matchId,
            leagueId: String(match.leagueId),
            required: MIN_PLAYERS,
            selectedCount: totalWithGuests,
            matchStart: matchStartISO,
            location: hasProp(body, 'location') ? location : match.location
          }),
          read: false,
          created_at: new Date(),
          updated_at: new Date()
        }));

        await Notification.bulkCreate(notificationEntries);
        console.log(`🔔 Sent "< ${MIN_PLAYERS}" notifications to ${notificationEntries.length} selected players for match ${matchId}`);
      }
    } catch (notifyErr) {
      console.error('Notify (<6 players) error:', notifyErr);
    }

    // Reload and respond using DB values (avoid undefined from request)
    const updatedMatch = await Match.findByPk(matchId, {
      include: [
        { model: User, as: 'homeTeamUsers' },
        { model: User, as: 'awayTeamUsers' },
        { model: MatchGuest, as: 'guestPlayers' },
      ],
    });

    if (!updatedMatch) { ctx.throw(404, "Match not found after update"); return; }

    const guests = (updatedMatch as any)?.guestPlayers?.map((g: any) => ({
      id: g.id,
      team: g.team,
      firstName: g.firstName,
      lastName: g.lastName,
      shirtNumber: g.shirtNumber,
    })) || [];

    const updatedMatchData = {
      id: updatedMatch.id,
      homeTeamName: (updatedMatch as any).homeTeamName,
      awayTeamName: (updatedMatch as any).awayTeamName,
      location: (updatedMatch as any).location,
      leagueId: (updatedMatch as any).leagueId,
      date: (updatedMatch as any).date,
      start: (updatedMatch as any).start,
      end: (updatedMatch as any).end,
      status: (updatedMatch as any).status,
      homeCaptainId: (updatedMatch as any).homeCaptainId,
      awayCaptainId: (updatedMatch as any).awayCaptainId,
      homeTeamImage: (updatedMatch as any).homeTeamImage,
      awayTeamImage: (updatedMatch as any).awayTeamImage,
      homeTeamUsers: (updatedMatch as any)?.homeTeamUsers?.map((user: any) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePicture: user.profilePicture,
        shirtNumber: user.shirtNumber,
        level: user.level,
        positionType: user.positionType,
        preferredFoot: user.preferredFoot
      })) || [],
      awayTeamUsers: (updatedMatch as any)?.awayTeamUsers?.map((user: any) => ({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        profilePicture: user.profilePicture,
        shirtNumber: user.shirtNumber,
        level: user.level,
        positionType: user.positionType,
        preferredFoot: user.preferredFoot
      })) || [],
      guests
    };

    // Cache updates
    cache.updateArray('matches_all', updatedMatchData);
    const league = await League.findByPk((updatedMatch as any).leagueId, { include: [{ model: User, as: 'members' }] });
    if (league) {
      const memberIds = (league as any)?.members?.map((m: any) => m.id) || [];
      memberIds.forEach((memberId: string) => {
        cache.updateArray(`user_leagues_${memberId}`, updatedMatchData);
      });
    }

    ctx.body = { success: true, message: "Match updated successfully.", match: updatedMatchData };
  }
);

// Join a league with an invite code
router.post("/join", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const { inviteCode } = ctx.request.body as { inviteCode: string };
  if (!inviteCode) {
    ctx.throw(400, "Invite code is required");
  }

  const league = await League.findOne({
    where: { inviteCode: inviteCode }
  });

  if (!league) {
    ctx.throw(404, "Invalid invite code.");
    return;
  }

  const isAlreadyMember = await (league as any).hasMember(ctx.state.user.userId);

  if (isAlreadyMember) {
    ctx.body = {
      success: false,
      message: "You have already joined this league."
    };
    return;
  }

  const user = await User.findByPk(ctx.state.user.userId);
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

 

  await (league as any).addMember(user.id);

  const emailHtml = `
    <h1>Welcome to the League!</h1>
    <p>You have successfully joined <strong>${league.name}</strong>.</p>
    <p>Get ready for some exciting competition!</p>
  `;

  if (user.email) {
    await transporter.sendMail({
      to: user.email,
      subject: `Welcome to ${league.name}`,
      html: emailHtml,
    });
    console.log(`Join email sent to ${user.email}`);
  } else {
    console.warn('Email not sent: user has no email');
  }

  // Update cache with joined league
  const joinedLeagueData = {
    id: league.id,
    name: league.name,
    inviteCode: league.inviteCode,
    maxGames: league.maxGames,
    showPoints: league.showPoints,
    active: league.active,
    members: [],
    administrators: [],
    matches: []
  };

  // Update user's league cache
  cache.updateArray(`user_leagues_${ctx.state.user.userId}`, joinedLeagueData);

  // Clear any general leagues cache to ensure fresh data
  cache.clearPattern('leagues_all');

  ctx.body = {
    success: true,
    message: "Successfully joined league",
    league: {
      id: league.id,
      name: league.name,
      inviteCode: league.inviteCode
    }
  };
});

// Leave a league
router.post("/:id/leave", required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }
  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  await (league as any).removeMember(ctx.state.user.userId);

  // Remove league from user's cache
  cache.removeFromArray(`user_leagues_${ctx.state.user.userId}`, league.id);

  // Clear any general leagues cache to ensure fresh data
  cache.clearPattern('leagues_all');

  ctx.response.status = 200;
});

// Remove a user from a league
router.delete("/:id/users/:userId", required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id);
  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  await (league as any).removeMember(ctx.params.userId);

  ctx.response.status = 200;
});

// Add XP calculation when league ends
router.patch('/:id/end', required, async (ctx) => {
  await verifyLeagueAdmin(ctx, ctx.params.id);

  const league = await League.findByPk(ctx.params.id, {
    include: [{ model: User, as: 'members' }]
  });

  if (!league) {
    return respondLeagueNotFound(ctx);
  }

  // Mark league as inactive
  await league.update({ active: false });

  // Calculate final XP for all league members
  for (const member of (league as any).members || []) {
    try {
      await calculateAndAwardXPAchievements(member.id, league.id);
      console.log(`Final XP calculated for user ${member.id} in league ${league.id}`);
    } catch (error) {
      console.error(`Error calculating final XP for user ${member.id}:`, error);
    }
  }

  ctx.status = 200;
  ctx.body = { success: true, message: "League ended and final XP calculated" };
});

// GET /leagues/:leagueId/xp - Return XP for each member in the league (sum of xpAwarded for completed matches in this league)
router.get('/:leagueId/xp', async (ctx) => {
  const { leagueId } = ctx.params;
  const league = await models.League.findByPk(leagueId, {
    include: [{ model: models.User, as: 'members' }]
  });
  if (!league) {
    ctx.status = 404;
    ctx.body = { success: false, message: 'League not found' };
    return;
  }
  // Fix type for members
  //@ts-ignore
  const members = (league.members || []) as any[];
  const xp: Record<string, number> = {};
  for (const member of members) {
    const stats = await models.MatchStatistics.findAll({
      where: { user_id: member.id },
      include: [{
        model: models.Match,
        as: 'match',
        where: { leagueId, status: 'RESULT_PUBLISHED' }
      }]
    });
    xp[member.id] = stats.reduce((sum, s) => sum + (s.xpAwarded || 0), 0);
  }
  ctx.body = { success: true, xp };
});

// Debug endpoint: Get XP breakdown for a user in a league
router.get('/:leagueId/xp-breakdown/:userId', required, async (ctx) => {
  const { leagueId, userId } = ctx.params;
  const league = await League.findByPk(leagueId);
  if (!league) { ctx.throw(404, 'League not found'); return; }

  // Load all completed matches in chronological order
  const matches = await Match.findAll({
    where: { leagueId, status: 'RESULT_PUBLISHED' },
    order: [['date', 'ASC'], ['start', 'ASC'], ['createdAt', 'ASC']],
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
    ]
  });
  const matchIds = matches.map(m => m.id);
  const allStats = await MatchStatistics.findAll({ where: { match_id: matchIds, user_id: userId } });
  const allVotes = await Vote.findAll({ where: { matchId: matchIds } });

  // Helper: team result for the user on a match
  const resultFor = (match: any): 'win' | 'draw' | 'lose' => {
    const homeUsers = (match.homeTeamUsers || []);
    const awayUsers = (match.awayTeamUsers || []);
    const isHome = homeUsers.some((u: any) => String(u.id) === String(userId));
    const isAway = awayUsers.some((u: any) => String(u.id) === String(userId));
    const hg = Number(match.homeTeamGoals ?? 0);
    const ag = Number(match.awayTeamGoals ?? 0);
    if (hg === ag) return 'draw';
    if (isHome && hg > ag) return 'win';
    if (isAway && ag > hg) return 'win';
    return 'lose';
  };

  // Helper: captain bonus by context (mirrors matches.ts)
  const captainBonusByContext = (res: 'win' | 'draw' | 'lose', category: 'defence' | 'influence') => {
    const loseOrDraw: any = { defence: 10, influence: 5 };
    const win: any = { defence: 15, influence: 10 };
    return (res === 'win' ? win : loseOrDraw)[category];
  };

  // Pre-compute thresholds for participation streaks
  const total = matches.length;
  const need25 = Math.max(1, Math.ceil(total * 0.25));
  const need50 = Math.max(1, Math.ceil(total * 0.50));
  const need75 = Math.max(1, Math.ceil(total * 0.75));
  let participated = 0;
  let consec = 0;
  let awarded50 = false;
  let awarded75 = false;

  const breakdown: any[] = [];
  let runningTotalComputed = 0;
  let runningTotalSaved = 0;

  for (const match of matches) {
    const homeTeamUsers = ((match as any).homeTeamUsers || []);
    const awayTeamUsers = ((match as any).awayTeamUsers || []);
    const isOnTeam = [...homeTeamUsers, ...awayTeamUsers].some((u: any) => String(u.id) === String(userId));
    const stat = allStats.find(s => String(s.match_id) === String(match.id));
    const savedXP = stat?.xpAwarded || 0;

    if (!isOnTeam) {
      // Keep saved vs computed alignment in running totals even when user not on team
      runningTotalSaved += 0;
      breakdown.push({ matchId: match.id, matchDate: match.date, details: [], matchXP: 0, savedXP, delta: savedXP - 0, runningTotalComputed, runningTotalSaved });
      continue;
    }

    // Base XP components
    const res = resultFor(match);
    let computedXP = 0;
    const details: any[] = [];
    if (res === 'win') { computedXP += xpPointsTable.winningTeam; details.push({ type: 'Win', points: xpPointsTable.winningTeam }); }
    else if (res === 'draw') { computedXP += xpPointsTable.draw; details.push({ type: 'Draw', points: xpPointsTable.draw }); }
    else { computedXP += xpPointsTable.losingTeam; details.push({ type: 'Loss', points: xpPointsTable.losingTeam }); }

    if (stat) {
      if (stat.goals) { const pts = (res === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals; computedXP += pts; details.push({ type: 'Goals', count: stat.goals, points: pts }); }
      if (stat.assists) { const pts = (res === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists; computedXP += pts; details.push({ type: 'Assists', count: stat.assists, points: pts }); }
      if (stat.cleanSheets) { const pts = xpPointsTable.cleanSheet * stat.cleanSheets; computedXP += pts; details.push({ type: 'Clean Sheets', count: stat.cleanSheets, points: pts }); }
    }

    // MOTM and votes
    const votes = allVotes.filter(v => String(v.matchId) === String(match.id));
    const voteCounts: Record<string, number> = {};
    votes.forEach(vote => { const id = String(vote.votedForId); voteCounts[id] = (voteCounts[id] || 0) + 1; });
    let motmId: string | null = null; let maxVotes = 0;
    Object.entries(voteCounts).forEach(([id, count]) => { if ((count as number) > maxVotes) { motmId = id; maxVotes = count as number; } });
    if (motmId === String(userId)) { const pts = (res === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose); computedXP += pts; details.push({ type: 'MOTM', points: pts }); }
    if (voteCounts[String(userId)]) { const pts = (res === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[String(userId)]; computedXP += pts; details.push({ type: 'MOTM Votes', count: voteCounts[String(userId)], points: pts }); }

    // Streak bonuses:
    // - 25% consecutive participation; 50%/75% overall participation
    // Update counters for this match
    consec = isOnTeam ? (consec + 1) : 0;
    const consecPrev = consec - 1;
    participated += 1; // only counting matches user played (since we continue if !isOnTeam)

    // 75% milestone (overall)
    if (!awarded75 && (participated - 1) < need75 && participated >= need75) {
      computedXP += xpPointsTable.streak75; details.push({ type: 'Streak 75%', points: xpPointsTable.streak75 }); awarded75 = true;
    }
    // 50% milestone (overall)
    else if (!awarded50 && (participated - 1) < need50 && participated >= need50) {
      computedXP += xpPointsTable.streak50; details.push({ type: 'Streak 50%', points: xpPointsTable.streak50 }); awarded50 = true;
    }
    // 25% milestone (consecutive)
    else if (consecPrev < need25 && consec >= need25) {
      computedXP += xpPointsTable.streak25; details.push({ type: 'Streak 25% (consecutive)', points: xpPointsTable.streak25 });
    }

    // Captain picks bonus if cached
    try {
      const key = `captain_picks_${match.id}`;
      const picks: any = cache.get(key);
      if (picks) {
        const homeIds = homeTeamUsers.map((u: any) => String(u.id));
        const awayIds = awayTeamUsers.map((u: any) => String(u.id));
        const uid = String(userId);
        // If user is selected for defence or influence, award corresponding bonus
        const isHome = homeIds.includes(uid);
        const teamRes = res;
        if (isHome) {
          if (picks.home?.defence && String(picks.home.defence) === uid) {
            const pts = captainBonusByContext(teamRes, 'defence');
            computedXP += pts; details.push({ type: 'Captain Pick (defence)', points: pts });
          }
          if (picks.home?.influence && String(picks.home.influence) === uid) {
            const pts = captainBonusByContext(teamRes, 'influence');
            computedXP += pts; details.push({ type: 'Captain Pick (influence)', points: pts });
          }
        } else {
          if (picks.away?.defence && String(picks.away.defence) === uid) {
            const pts = captainBonusByContext(teamRes, 'defence');
            computedXP += pts; details.push({ type: 'Captain Pick (defence)', points: pts });
          }
          if (picks.away?.influence && String(picks.away.influence) === uid) {
            const pts = captainBonusByContext(teamRes, 'influence');
            computedXP += pts; details.push({ type: 'Captain Pick (influence)', points: pts });
          }
        }
      }
    } catch {}

    // Reconcile with saved xpAwarded (authoritative)
    runningTotalComputed += computedXP;
    runningTotalSaved += savedXP;

    const delta = savedXP - computedXP;
    if (Math.abs(delta) > 0) {
      details.push({ type: 'Other Bonuses / Adjustments', points: delta });
    }

    breakdown.push({
      matchId: match.id,
      matchDate: match.date,
      details,
      matchXP: computedXP,
      savedXP,
      delta,
      runningTotalComputed,
      runningTotalSaved
    });
  }

  // --- Achievements section: list user's awarded achievements and total XP from achievements ---
  // Note: achievements are stored globally on the user (not per-league). We include all awarded achievements here.
  try {
    const user = await User.findByPk(userId, { attributes: ['id', 'achievements'] });
    const { xpAchievements } = await import('../utils/xpAchievements');
    const achIds: string[] = Array.isArray((user as any)?.achievements) ? ((user as any).achievements as string[]) : [];
    const achDefs = (xpAchievements as any[]).filter((a: any) => achIds.includes(a.id));
    const achievements = achDefs.map((a: any) => ({ id: a.id, definition: a.definition, xp: a.xp }));
    const achievementsTotalXP = achDefs.reduce((sum: number, a: any) => sum + (a.xp || 0), 0);

    ctx.body = {
      userId,
      leagueId,
      breakdown,
      totals: {
        matchSavedXP: runningTotalSaved,
        achievementsXP: achievementsTotalXP,
        combined: runningTotalSaved + achievementsTotalXP,
      },
      achievements,
    };
  } catch {
    // Fallback if anything goes wrong while reading achievements
    ctx.body = { userId, leagueId, breakdown, totals: { matchSavedXP: runningTotalSaved } };
  }
});

// POST endpoint to reset all users' XP in a league to the correct value
router.post('/:id/reset-xp', required, async (ctx) => {
  const leagueId = ctx.params.id;
  const league = await League.findByPk(leagueId, {
    include: [{ model: User, as: 'members' }]
  });
  if (!league) {
    ctx.throw(404, 'League not found');
    return;
  }
  // Get all completed matches in this league
  const matches = await Match.findAll({
    where: { leagueId, status: 'RESULT_PUBLISHED' },
    include: [
      { model: User, as: 'homeTeamUsers' },
      { model: User, as: 'awayTeamUsers' },
    ]
  });
  const matchIds = matches.map(m => m.id);
  const allStats = await MatchStatistics.findAll({ where: { match_id: matchIds } });
  const allVotes = await Vote.findAll({ where: { matchId: matchIds } });
  for (const member of (league as any).members || []) {
    let userXP = 0;
    for (const match of matches) {
      const homeTeamUsers = ((match as any).homeTeamUsers || []);
      const awayTeamUsers = ((match as any).awayTeamUsers || []);
      // Only count the user once per match
      const isOnTeam = [...homeTeamUsers, ...awayTeamUsers].some((u: any) => u.id === member.id);
      if (!isOnTeam) continue;
      const homeGoals = match.homeTeamGoals ?? 0;
      const awayGoals = match.awayTeamGoals ?? 0;
      // Win/Draw/Loss
      let teamResult: 'win' | 'draw' | 'lose' = 'lose';
      const isHome = homeTeamUsers.some((u: any) => u.id === member.id);
      const isAway = awayTeamUsers.some((u: any) => u.id === member.id);
      if (isHome && homeGoals > awayGoals) teamResult = 'win';
      else if (isAway && awayGoals > homeGoals) teamResult = 'win';
      else if (homeGoals === awayGoals) teamResult = 'draw';
      // Only one of these applies:
      if (teamResult === 'win') userXP += xpPointsTable.winningTeam;
      else if (teamResult === 'draw' ) userXP += xpPointsTable.draw;
      else userXP += xpPointsTable.losingTeam;
      // Get stats for this user in this match (from pre-fetched allStats)
      const stat = allStats.find(s => s.user_id === member.id && s.match_id === match.id);
      if (stat) {
        if (stat.goals) userXP += (teamResult === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * stat.goals;
        if (stat.assists) userXP += (teamResult === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * stat.assists;
        if (stat.cleanSheets) userXP += xpPointsTable.cleanSheet * stat.cleanSheets;
      }
      // Votes for MOTM (from pre-fetched allVotes)
      const votes = allVotes.filter(v => v.matchId === match.id);
      const voteCounts: Record<string, number> = {};
      votes.forEach(vote => {
        const id = String(vote.votedForId);
        voteCounts[id] = (voteCounts[id] || 0) + 1;
      });
      let motmId: string | null = null;
      let maxVotes = 0;
      Object.entries(voteCounts).forEach(([id, count]: [string, number]) => {
        if (count > maxVotes) {
          motmId = id;
          maxVotes = count;
        }
      });
      if (motmId === member.id) userXP += (teamResult === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
      if (voteCounts[member.id]) userXP += (teamResult === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[member.id];
    }
    // Update the user's XP in the database (recalculate total including achievements)
    try {
      const { recalcUserTotalXP } = await import('../utils/xpRecalc');
      await recalcUserTotalXP(String(member.id));
    } catch {
      const user = await User.findByPk(member.id);
      if (user) { user.xp = Number(userXP) || 0; await user.save(); }
    }
  }
  // Update cache for all users whose XP was reset
  for (const member of (league as any).members || []) {
    const user = await User.findByPk(member.id);
    if (user) {
      const updatedUserData = {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        profilePicture: user.profilePicture,
        position: user.position,
        positionType: user.positionType,
        xp: user.xp || 0
      };

      // Update players cache
      cache.updateArray('players_all', updatedUserData);

      // Clear any user-specific caches
      cache.clearPattern(`user_leagues_${user.id}`);
    }
  }

  // Clear leaderboard cache for this league
  cache.clearPattern(`leaderboard_`);

  ctx.body = { success: true, message: 'XP reset for all users in this league.' };
});

// Get ALL available leagues (avoid route collision)
// CHANGE path from "/" to "/all"
router.get('/all', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }
  try {
    console.log('Fetching ALL available leagues...');
    const allLeagues = await League.findAll({
      include: [
        { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'email', 'shirtNumber'] },
        { model: User, as: 'administrators', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: Match, as: 'matches', attributes: ['id', 'homeScore', 'awayScore', 'status', 'matchDate'] }
      ],
      order: [['createdAt', 'DESC']],
      limit: 50
    });
    const formattedLeagues = allLeagues.map((league: any) => ({
      id: league.id,
      name: league.name,
      description: league.description || '',
      image: league.image,
      inviteCode: league.inviteCode,
      createdAt: league.createdAt,
      maxGames: league.maxGames,
      showPoints: league.showPoints,
      active: league.active,
      members: league.members || [],
      administrators: league.administrators || [],
      matches: league.matches || [],
      adminId: league.administrators?.[0]?.id || null
    }));
    console.log(`Found ${formattedLeagues.length} leagues total`);
    ctx.body = { success: true, leagues: formattedLeagues };
  } catch (error) {
    console.error("Error fetching all leagues:", error);
    ctx.status = 500;
    ctx.body = { success: false, message: "Failed to retrieve leagues" };
  }
});

// List guests for a match
router.get('/:leagueId/matches/:matchId/guests', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const match = await Match.findOne({ where: { id: matchId, leagueId } });
  if (!match) { ctx.throw(404, 'Match not found'); return; } // <-- return

  const guests = await MatchGuest.findAll({ where: { matchId } });
  ctx.body = { success: true, guests };
});

// Add a guest player to a match (ADMIN ONLY)
router.post('/:leagueId/matches/:matchId/guests', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { team, firstName, lastName, shirtNumber } = (ctx.request as any).body || {};

  await verifyLeagueAdmin(ctx, leagueId); // <-- admin check

  if (!team || !['home', 'away'].includes(team)) { ctx.throw(400, 'Invalid team'); return; }
  if (!firstName || !lastName) { ctx.throw(400, 'First and last name required'); return; }

  const match = await Match.findOne({ where: { id: matchId, leagueId } });
  if (!match) { ctx.throw(404, 'Match not found'); return; }

  const guest = await MatchGuest.create({
    matchId,
    team,
    firstName: String(firstName).trim(),
    lastName: String(lastName).trim(),
    shirtNumber: shirtNumber ? String(shirtNumber) : undefined, // <-- undefined, not null
  });

  // Fetch all guests and update caches so lists stay fresh
  const allGuests = await MatchGuest.findAll({ where: { matchId } });
  const guests = allGuests.map((g: any) => ({
    id: g.id,
    team: g.team,
    firstName: g.firstName,
    lastName: g.lastName,
    shirtNumber: g.shirtNumber,
  }));

  // Update matches cache
  cache.updateArray('matches_all', { id: matchId, guests });

  // Update league caches for all members
  const leagueWithMembers = await League.findByPk(leagueId, { include: [{ model: User, as: 'members' }] });
  const memberIds = (leagueWithMembers as any)?.members?.map((m: any) => m.id) || [];
  memberIds.forEach((memberId: string) => {
    cache.updateArray(`user_leagues_${memberId}`, { id: matchId, guests });
  });

  ctx.body = { success: true, guest, guests };
});

// Remove a guest player from a match (ADMIN ONLY)
router.delete('/:leagueId/matches/:matchId/guests/:guestId', required, async (ctx) => {
  const { leagueId, matchId, guestId } = ctx.params;

  await verifyLeagueAdmin(ctx, leagueId); // <-- admin check

  const match = await Match.findOne({ where: { id: matchId, leagueId } });
  if (!match) { ctx.throw(404, 'Match not found'); return; }

  const guest = await MatchGuest.findOne({ where: { id: guestId, matchId } });
  if (!guest) { ctx.throw(404, 'Guest not found'); return; }

  await guest.destroy();
  ctx.body = { success: true, message: 'Guest removed' };
});

// CREATE MATCH WITH AUTO NOTIFICATIONS
router.post('/:leagueId/matches', required, async (ctx) => {
  const { leagueId } = ctx.params;
  const {
    homeTeamName,
    awayTeamName,
    start,
    end,
    location,
    date
  } = ctx.request.body as any;

  try {
    // 1. Create the match - FIX THE END DATE ISSUE
    const startDate = new Date(start);
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 90 * 60000); // Default 90 minutes

    const match = await Match.create({
      leagueId,
      homeTeamName,
      awayTeamName,
      start: startDate,
      end: endDate, // ✅ Now guaranteed to be a Date, not null
      location,
      date: date ? new Date(date) : startDate,
      status: 'SCHEDULED'
    });

    // 2. Get ALL league members using raw query to avoid association issues
    const members = await User.findAll({
      include: [{
        model: League,
        where: { id: leagueId },
        through: { attributes: [] } // Don't include junction table data
      }],
      attributes: ['id', 'username', 'firstName', 'lastName']
    });

    console.log(`Found ${members.length} league members`);

    if (members.length === 0) {
      ctx.body = { success: true, match, message: 'Match created but no members found' };
      return;
    }

    const memberIds = members.map((m: any) => m.id);

    // 3. Create availability entries for all members
    const availabilityEntries = memberIds.map((userId: string) => ({
      match_id: match.id,
      user_id: userId,
      status: 'pending' as const
    }));

    await MatchAvailability.bulkCreate(availabilityEntries);

    // 4. Send notifications to ALL members
    const matchDate = new Date(start).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });

    const notificationEntries = memberIds.map((userId: string) => ({
      user_id: userId,
      type: 'match_availability',
      title: '⚽ New Match Created!',
      body: `${homeTeamName} vs ${awayTeamName} on ${matchDate}. Please update your availability status.`,
      meta: JSON.stringify({ // ✅ Stringify the meta object
        matchId: match.id,
        leagueId: leagueId,
        homeTeam: homeTeamName,
        awayTeam: awayTeamName,
        matchStart: start
      }),
      read: false,
      created_at: new Date(),
      updated_at: new Date()
    }));

    await Notification.bulkCreate(notificationEntries);

    console.log(`✅ Match created with ${memberIds.length} availability entries and notifications sent`);

    ctx.body = {
      success: true,
      match,
      availabilitiesCreated: memberIds.length,
      notificationsSent: memberIds.length,
      message: `Match created! ${memberIds.length} members notified.`
    };

  } catch (error) {
    console.error('Error creating match with notifications:', error);
    ctx.throw(500, 'Failed to create match');
  }
});

// Team view for a match (used by "view team" dialog)
router.get("/:leagueId/matches/:matchId/team-view", required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;

  const match = await Match.findByPk(matchId, {
    attributes: [
      'id', 'leagueId', 'homeTeamName', 'awayTeamName', 'homeCaptainId', 'awayCaptainId',
      'homeTeamImage', 'awayTeamImage', 'status', 'date', 'start', 'end', 'location',
      'homeTeamGoals', 'awayTeamGoals', 'removed' // ADDED: return removed list
    ],
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'email', 'shirtNumber', 'positionType'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'email', 'shirtNumber', 'positionType'] },
      { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'team', 'firstName', 'lastName', 'shirtNumber'] },
    ]
  });

  if (!match || String(match.leagueId) !== String(leagueId)) {
    ctx.status = 404;
    ctx.body = { success: false, message: 'Match not found' };
    return;
  }

  const homeUsers = ((match as any).homeTeamUsers || []);
  const awayUsers = ((match as any).awayTeamUsers || []);

  // Per-match XP: prefer authoritative saved xpAwarded from MatchStatistics, fallback to computed
  const xpMap: Record<string, number> = {};
  if ((match as any).status === 'RESULT_PUBLISHED') {
    const homeGoals = Number((match as any).homeTeamGoals || 0);
    const awayGoals = Number((match as any).awayTeamGoals || 0);

    const allStats = await MatchStatistics.findAll({ where: { match_id: matchId } });
    const votes = await Vote.findAll({ where: { matchId } });

    // Build quick lookup for saved xpAwarded
    const xpAwardedByUser: Record<string, number | null | undefined> = {};
    allStats.forEach((s: any) => {
      xpAwardedByUser[String(s.user_id)] = typeof s.xpAwarded === 'number' ? s.xpAwarded : null;
    });

    // Prepare fallback computation ingredients
    const voteCounts: Record<string, number> = {};
    votes.forEach((v: any) => { const id = String(v.votedForId); voteCounts[id] = (voteCounts[id] || 0) + 1; });
    let motmId: string | null = null;
    let maxVotes = 0;
    Object.entries(voteCounts).forEach(([id, count]: [string, number]) => {
      if (count > maxVotes) { motmId = id; maxVotes = count; }
    });

    const statFor = (userId: string) => allStats.find((s: any) => String(s.user_id) === userId);
    const computeXpFallback = (userId: string, isHome: boolean) => {
      // Basic fallback mirrors the main algorithm; captain/streak bonuses can only be honored if already saved in xpAwarded
      let result: 'win' | 'draw' | 'lose' = 'lose';
      if (homeGoals === awayGoals) result = 'draw';
      else if ((isHome && homeGoals > awayGoals) || (!isHome && awayGoals > homeGoals)) result = 'win';
      let xp = result === 'win' ? xpPointsTable.winningTeam : result === 'draw' ? xpPointsTable.draw : xpPointsTable.losingTeam;
      const s: any = statFor(userId);
      if (s) {
        const goals = Number(s.goals || 0), assists = Number(s.assists || 0), cleanSheets = Number(s.cleanSheets || 0);
        if (goals) xp += (result === 'win' ? xpPointsTable.goal.win : xpPointsTable.goal.lose) * goals;
        if (assists) xp += (result === 'win' ? xpPointsTable.assist.win : xpPointsTable.assist.lose) * assists;
        if (cleanSheets) xp += xpPointsTable.cleanSheet * cleanSheets;
      }
      if (motmId && motmId === userId) xp += (result === 'win' ? xpPointsTable.motm.win : xpPointsTable.motm.lose);
      if (voteCounts[userId]) xp += (result === 'win' ? xpPointsTable.motmVote.win : xpPointsTable.motmVote.lose) * voteCounts[userId];
      return xp;
    };

    // Fill xpMap for all players in match
    const ensureXp = (userId: string, isHome: boolean) => {
      const saved = xpAwardedByUser[userId];
      if (typeof saved === 'number') xpMap[userId] = saved;
      else xpMap[userId] = computeXpFallback(userId, isHome);
    };
    homeUsers.forEach((u: any) => ensureXp(String(u.id), true));
    awayUsers.forEach((u: any) => ensureXp(String(u.id), false));
  }

  // Fetch saved positions for this match (guard when model missing)
  const positionsHome: Record<string, { x: number; y: number }> = {};
  const positionsAway: Record<string, { x: number; y: number }> = {};
  if (MatchPlayerLayout) {
    const layoutRows = await MatchPlayerLayout.findAll({ where: { matchId } });
    layoutRows.forEach((r: any) => {
      const rec = { x: r.x, y: r.y };
      if ((r.team as string) === 'home') positionsHome[String(r.userId)] = rec;
      else positionsAway[String(r.userId)] = rec;
    });
  }

  const toPlayer = (u: any) => ({
    id: String(u.id),
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    profilePicture: u.profilePicture,
    shirtNumber: u.shirtNumber ?? undefined,
    positionType: u.positionType ?? undefined,
    xp: xpMap[String(u.id)] !== undefined ? xpMap[String(u.id)] : undefined
  });

  const home = homeUsers?.map(toPlayer);
  const away = awayUsers?.map(toPlayer);

  const rawGuests = ((match as any).guestPlayers || []);
  const guests = Array.from(new Map(rawGuests.map((g: any) => [String(g.id), g])).values())
    .map((g: any) => ({
      id: g.id,
      team: g.team,
      firstName: g.firstName,
      lastName: g.lastName,
      shirtNumber: g.shirtNumber,
    }));

  // Auto-role assignment per spec
  const assignRoles = (list: any[]) => {
    const n = list.length;
    const roles: Array<'GK' | 'DF' | 'MD' | 'FW'> = [];
    if (n < 5) { roles.push('GK'); for (let i = 1; i < n; i++) roles.push('DF'); }
    else if (n === 5) { roles.push('GK', 'DF', 'DF', 'FW', 'FW'); }
    else if (n === 6) { roles.push('GK', 'DF', 'DF', 'DF', 'FW', 'FW'); }
    else if (n === 7) { roles.push('GK', 'DF', 'DF', 'DF', 'FW', 'FW', 'FW'); }
    else { roles.push('GK', 'DF', 'DF', 'DF'); for (let i = roles.length; i < n; i++) roles.push('FW'); }
    return list.map((p, i) => ({ ...p, role: roles[i] || 'FW' }));
  };

  // Normalise removed for client greying logic
  const rm = ((match as any).removed || {}) as { home?: any[]; away?: any[] };
  const removed = {
    home: Array.isArray(rm.home) ? rm.home.map((v: any) => String(v)) : [],
    away: Array.isArray(rm.away) ? rm.away.map((v: any) => String(v)) : []
  };

  ctx.body = {
    success: true,
    match: {
      id: String(match.id),
      leagueId: String(match.leagueId),
      homeTeamName: (match as any).homeTeamName,
      awayTeamName: (match as any).awayTeamName,
      homeTeamImage: (match as any).homeTeamImage,
      awayTeamImage: (match as any).awayTeamImage,
      status: (match as any).status,
      date: (match as any).date,
      start: (match as any).start,
      end: (match as any).end,
      location: (match as any).location,
      homeCaptainId: (match as any).homeCaptainId ? String((match as any).homeCaptainId) : undefined,
      awayCaptainId: (match as any).awayCaptainId ? String((match as any).awayCaptainId) : undefined,
      homeTeam: assignRoles(home),
      awayTeam: assignRoles(away),
      guests,
      positions: { home: positionsHome, away: positionsAway },
      removed // ADDED
    }
  };
});

// Save layout (captain/admin only, clamp to half, include guests)
router.patch('/:leagueId/matches/:matchId/layout', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  let { team, positions } = ctx.request.body || {};
  team = normalizeTeam(team);

  const actorId = String((ctx.state.user as any).id || (ctx.state.user as any).userId);
  // REPLACED: role-admin check -> league admin via verifyLeagueAdmin
  let isLeagueAdmin = false;
  try { await verifyLeagueAdmin(ctx, leagueId); isLeagueAdmin = true; } catch { }

  // Helpers
  const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));
  const sanitizeToHalf = (side: 'home' | 'away', pos: { x: number; y: number }) => {
    const minY = side === 'home' ? 0.0 : 0.5;
    const maxY = side === 'home' ? 0.5 : 1.0;
    return { x: clamp01(pos.x), y: Math.max(minY, Math.min(maxY, clamp01(pos.y))) };
  };

  const match = await Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'homeCaptainId', 'awayCaptainId', 'removed'],
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id'] },
      { model: MatchGuest, as: 'guestPlayers', attributes: ['id', 'team'] }
    ]
  });
  if (!match || String(match.leagueId) !== String(leagueId)) {
    ctx.status = 404; ctx.body = { success: false, message: 'Match not found' }; return;
  }

  const removedObj = ((match as any).removed || {}) as { home?: any[]; away?: any[] };
  const removedSet = new Set<string>([
    ...((removedObj.home || []).map((x: any) => String(x))),
    ...((removedObj.away || []).map((x: any) => String(x))),
  ]);

  // Build membership sets (users + guests)
  const homeIds = new Set([
    ...(((match as any).homeTeamUsers || []).map((u: any) => String(u.id))),
    ...(((match as any).guestPlayers || []).filter((g: any) => g.team === 'home').map((g: any) => String(g.id))),
  ]);
  const awayIds = new Set([
    ...(((match as any).awayTeamUsers || []).map((u: any) => String(u.id))),
    ...(((match as any).guestPlayers || []).filter((g: any) => g.team === 'away').map((g: any) => String(g.id))),
  ]);

  const isCaptainOfTeam =
    (team === 'home'
      ? String((match as any).homeCaptainId || '')
      : String((match as any).awayCaptainId || '')) === actorId;

  if (!(isLeagueAdmin || isCaptainOfTeam)) {
    ctx.status = 403;
    ctx.body = { success: false, message: 'Only the league administrator or the team captain can update the layout' };
    return;
  }

  const incoming = positions && typeof positions === 'object'
    ? (positions as Record<string, { x: number; y: number }>)
    : {};
  const incomingIds = Object.keys(incoming).map(String);

  // Block moves of removed players
  if (incomingIds.some(id => removedSet.has(id))) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'Removed players cannot be moved' };
    return;
  }

  // Filter to team membership (users + guests) and clamp to the correct half
  const allowedSet = team === 'home' ? homeIds : awayIds;
  const filtered: Record<string, { x: number, y: number }> = {};
  for (const id of incomingIds) {
    if (allowedSet.has(id)) filtered[id] = sanitizeToHalf(team, incoming[id]);
  }

  const updates = Object.entries(filtered);
  for (const [entityId, pos] of updates) {
    await MatchPlayerLayout.upsert({
      matchId,
      userId: entityId,
      team,
      x: Number(pos.x),
      y: Number(pos.y)
    } as any);
  }

  ctx.body = { success: true, count: updates.length, positions: filtered };
});

// NEW: a player can remove themselves (or admin can remove anyone)
router.post('/:leagueId/matches/:matchId/remove', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { playerId } = ctx.request.body || {};
  const actorId = String((ctx.state.user as any).id || (ctx.state.user as any).userId);

  // League admin or team captain or self
  let isLeagueAdmin = false;
  try { await verifyLeagueAdmin(ctx, leagueId); isLeagueAdmin = true; } catch { }

  const match = await Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'homeCaptainId', 'awayCaptainId'],
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id'] }
    ]
  });
  if (!match || String(match.leagueId) !== String(leagueId)) { ctx.status = 404; ctx.body = { success: false, message: 'Match not found' }; return; }

  const pid = String(playerId || '');
  if (!pid) { ctx.status = 400; ctx.body = { success: false, message: 'playerId required' }; return; }

  const onHome = ((match as any).homeTeamUsers || []).some((u: any) => String(u.id) === pid);
  const onAway = ((match as any).awayTeamUsers || []).some((u: any) => String(u.id) === pid);
  if (!onHome && !onAway) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'Player not on this match' };
    return;
  }

  const isTeamCaptain = onHome
    ? String((match as any).homeCaptainId || '') === actorId
    : String((match as any).awayCaptainId || '') === actorId;

  if (!(isLeagueAdmin || isTeamCaptain || pid === actorId)) {
    ctx.status = 403;
    ctx.body = { success: false, message: 'Only league admin, team captain, or the player can remove' };
    return;
  }

  // Build new removed map (dedup + stringify)
  const prevRemoved = ((match as any).removed || { home: [], away: [] }) as { home?: any[]; away?: any[] };
  const toSet = (arr?: any[]) => new Set<string>((arr || []).map(String));
  const removedHome = toSet(prevRemoved.home);
  const removedAway = toSet(prevRemoved.away);
  if (onHome) removedHome.add(pid);
  if (onAway) removedAway.add(pid);
  const newRemoved = { home: Array.from(removedHome), away: Array.from(removedAway) };

  // Persist removed and detach from team(s)
  await Match.update({ removed: newRemoved }, { where: { id: matchId } });
  try { if (onHome && (match as any).removeHomeTeamUser) await (match as any).removeHomeTeamUser(pid); } catch { }
  try { if (onAway && (match as any).removeAwayTeamUser) await (match as any).removeAwayTeamUser(pid); } catch { }
  // Optional: clear saved layout for this player (if model present)
  try { if (MatchPlayerLayout) await MatchPlayerLayout.destroy({ where: { matchId, userId: pid } } as any); } catch { }

  ctx.body = {
    success: true,
    removed: { home: newRemoved.home, away: newRemoved.away }
  };
});

// NEW: admin replaces a removed player with someone not yet in the teams
router.post('/:leagueId/matches/:matchId/replace', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { team, removedId, replacementId } = ctx.request.body || {};
  const sideFromBody: 'home' | 'away' = String(team || '').toLowerCase() === 'away' ? 'away' : 'home';

  const actorId = String((ctx.state.user as any).id || (ctx.state.user as any).userId);
  let isLeagueAdmin = false;
  try { await verifyLeagueAdmin(ctx, leagueId); isLeagueAdmin = true; } catch { }

  if (!removedId || !replacementId) {
    ctx.status = 400; ctx.body = { success: false, message: 'removedId and replacementId required' }; return;
  }

  const match = await Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'homeCaptainId', 'awayCaptainId'],
    include: [
      { model: User, as: 'homeTeamUsers', attributes: ['id'] },
      { model: User, as: 'awayTeamUsers', attributes: ['id'] }
    ]
  });
  if (!match || String(match.leagueId) !== String(leagueId)) { ctx.status = 404; ctx.body = { success: false, message: 'Match not found' }; return; }

  const rid = String(removedId);
  const repId = String(replacementId);

  const homeIds = new Set(((match as any).homeTeamUsers || []).map((u: any) => String(u.id)));
  const awayIds = new Set(((match as any).awayTeamUsers || []).map((u: any) => String(u.id)));

  // Determine side: prefer current membership; fallback to provided team
  const teamDetected: 'home' | 'away' | null =
    homeIds.has(rid) ? 'home' : (awayIds.has(rid) ? 'away' : null);
  const t: 'home' | 'away' = teamDetected ?? sideFromBody;

  // Captain permission by team
  const isTeamCaptain = t === 'home'
    ? String((match as any).homeCaptainId || '') === actorId
    : String((match as any).awayCaptainId || '') === actorId;

  if (!(isLeagueAdmin || isTeamCaptain)) {
    ctx.status = 403; ctx.body = { success: false, message: 'League admin or team captain only' }; return;
  }

  // Make operation idempotent and permissive:
  // 1) Ensure "removed" JSON is present and mark rid as removed on side t (if not yet)
  const removed = ((match as any).removed || { home: [], away: [] }) as { home?: any[]; away?: any[] };
  const ensureSideArr = (arr?: any[]) => Array.isArray(arr) ? arr.map(String) : [];
  const removedHome = new Set<string>(ensureSideArr(removed.home));
  const removedAway = new Set<string>(ensureSideArr(removed.away));
  if (t === 'home') removedHome.add(rid); else removedAway.add(rid);
  const newRemoved = { home: Array.from(removedHome), away: Array.from(removedAway) };

  // 2) Remove rid from both sides if present
  try { if (homeIds.has(rid) && (match as any).removeHomeTeamUser) await (match as any).removeHomeTeamUser(rid); } catch { }
  try { if (awayIds.has(rid) && (match as any).removeAwayTeamUser) await (match as any).removeAwayTeamUser(rid); } catch { }

  // 3) If replacement already in match, move to requested side if needed; else add to side
  const repInHome = homeIds.has(repId);
  const repInAway = awayIds.has(repId);

  if (repInHome && t === 'away') {
    try { await (match as any).removeHomeTeamUser(repId); } catch { }
    await (match as any).addAwayTeamUser(repId);
  } else if (repInAway && t === 'home') {
    try { await (match as any).removeAwayTeamUser(repId); } catch { }
    await (match as any).addHomeTeamUser(repId);
  } else if (!repInHome && !repInAway) {
    if (t === 'home') await (match as any).addHomeTeamUser(repId);
    else await (match as any).addAwayTeamUser(repId);
  }
  await match.save();

  ctx.body = { success: true, team: t, replaced: { out: rid, in: repId } };
});

// NEW: swap two players’ positions on the same team (captain/admin)
router.post('/:leagueId/matches/:matchId/switch', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { team, aId, bId } = ctx.request.body || {};
  const t: 'home' | 'away' = normalizeTeam(team);
  const actorId = String((ctx.state.user as any).id || (ctx.state.user as any).userId);
  // REPLACED: role-admin check -> league admin via verifyLeagueAdmin
  let isLeagueAdmin = false;
  try { await verifyLeagueAdmin(ctx, leagueId); isLeagueAdmin = true; } catch { }

  const match = await Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'homeCaptainId', 'awayCaptainId'],
    include: [
      { model: User, as: t === 'home' ? 'homeTeamUsers' : 'awayTeamUsers', attributes: ['id'] },
    ]
  });
  if (!match || String(match.leagueId) !== String(leagueId)) { ctx.status = 404; ctx.body = { success: false }; return; }

  const capId = String(t === 'home' ? (match as any).homeCaptainId || '' : (match as any).awayCaptainId || '');
  const isTeamCaptain = capId === actorId;
  if (!(isLeagueAdmin || isTeamCaptain)) { ctx.status = 403; ctx.body = { success: false, message: 'League admin or team captain only' }; return; }

  const ids = new Set<string>(((((match as any)[t === 'home' ? 'homeTeamUsers' : 'awayTeamUsers']) || []).map((u: any) => String(u.id))));
  const A = String(aId), B = String(bId);
  if (!ids.has(A) || !ids.has(B)) { ctx.status = 400; ctx.body = { success: false, message: 'Both players must be on the same team' }; return; }

  const [pa, pb] = await Promise.all([
    MatchPlayerLayout.findOne({ where: { matchId, userId: A, team: t } }),
    MatchPlayerLayout.findOne({ where: { matchId, userId: B, team: t } })
  ]);
  const posA = pa ? { x: pa.x, y: pa.y } : { x: 0.5, y: t === 'home' ? 0.25 : 0.75 };
  const posB = pb ? { x: pb.x, y: pb.y } : { x: 0.5, y: t === 'home' ? 0.25 : 0.75 };

  await MatchPlayerLayout.upsert({ matchId, userId: A, team: t, x: Number(posB.x), y: Number(posB.y) } as any);
  await MatchPlayerLayout.upsert({ matchId, userId: B, team: t, x: Number(posA.x), y: Number(posA.y) } as any);

  ctx.body = { success: true };
});

// NEW: make captain (admin)
router.post('/:leagueId/matches/:matchId/make-captain', required, async (ctx) => {
  const { leagueId, matchId } = ctx.params;
  const { team, userId } = ctx.request.body || {};
  const t: 'home' | 'away' = normalizeTeam(team);
  const actorId = String((ctx.state.user as any).id || (ctx.state.user as any).userId);
  // REPLACED: role-admin check -> league admin via verifyLeagueAdmin
  let isLeagueAdmin = false;
  try { await verifyLeagueAdmin(ctx, leagueId); isLeagueAdmin = true; } catch { }

  const match = await Match.findByPk(matchId, {
    attributes: ['id', 'leagueId', 'homeCaptainId', 'awayCaptainId'],
    include: [{ model: User, as: t === 'home' ? 'homeTeamUsers' : 'awayTeamUsers', attributes: ['id'] }]
  });
  if (!match || String(match.leagueId) !== String(leagueId)) { ctx.status = 404; ctx.body = { success: false }; return; }

  const ids = new Set<string>((((match as any)[t === 'home' ? 'homeTeamUsers' : 'awayTeamUsers']) || []).map((u: any) => String(u.id)))
  const uid = String(userId);
  if (!ids.has(uid)) { ctx.status = 400; ctx.body = { success: false, message: 'User must be on this team' }; return; }

  if (t === 'home') (match as any).homeCaptainId = uid; else (match as any).awayCaptainId = uid;
  await match.save();

  ctx.body = { success: true, team: t, captainId: uid };
});

// Utility: normalize UUID-like inputs (empty string -> null)
const toNullableUUID = (v: any) => {
  if (v === undefined) return undefined; // do not touch
  if (v === '' || v === null) return null; // store as NULL
  return String(v); // let PG validate actual UUID string
};

// ▶️ League statistics (played/remaining/players/best pairing/hottest player)
router.get('/:id/statistics', required, async (ctx) => {
  const { id } = ctx.params;

  if (!isUuid(id)) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'Invalid league id' };
    return;
  }

  // Load league with members and completed matches
  const league = await League.findByPk(id, {
    attributes: ['id', 'name', 'createdAt', 'maxGames'],
    include: [
      { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName'] },
      {
        model: Match,
        as: 'matches',
        attributes: ['id', 'date', 'start', 'homeTeamGoals', 'awayTeamGoals', 'status', 'archived'],
        include: [
          { model: User, as: 'homeTeamUsers', attributes: ['id'] },
          { model: User, as: 'awayTeamUsers', attributes: ['id'] },
        ],
      },
    ],
  });

  if (!league) {
    ctx.status = 404;
    ctx.body = { success: false, message: 'League not found' };
    return;
  }

  // Access: members only (keep simple and consistent)
  const actorId = String((ctx.state.user as any)?.id || (ctx.state.user as any)?.userId || '');
  const isMember = ((league as any).members || []).some((m: any) => String(m.id) === actorId);
  if (!isMember) {
    ctx.status = 403;
    ctx.body = { success: false, message: "You don't have access to this league" };
    return;
  }

  const members = (league as any).members as Array<{ id: string; firstName: string; lastName: string }>;
  const memberById = new Map(members.map((u) => [String(u.id), `${u.firstName} ${u.lastName}`.trim()]));

  const allMatches = ((league as any).matches || []) as Array<any>;
  const completed = allMatches
    .filter(
      (m) =>
        !m.archived &&
        (m.status === 'RESULT_PUBLISHED' || m.status === 'RESULT_UPLOADED') &&
        m.homeTeamGoals != null &&
        m.awayTeamGoals != null
    )
    .sort((a: any, b: any) => new Date(a.date || a.start || 0).getTime() - new Date(b.date || b.start || 0).getTime());

  const playedMatches = completed.length;
  const remaining = Math.max((league as any).maxGames || 0 - playedMatches, 0);
  const players = members.length;

  // Preload per-match player stats for completed matches (if available)
  const matchIds = completed.map((m) => m.id);
  const statsRows = matchIds.length
    ? await MatchStatistics.findAll({ where: { match_id: matchIds } as any })
    : [];
  // Quick access maps
  const statMapByMatchUser = new Map(
    statsRows.map((s: any) => [`${s.match_id}:${s.user_id}`, s])
  );

  // Build best pairing (wins together, then combined goals/assists, then matches together)
  type PairData = {
    ids: [string, string];
    names: [string, string];
    togetherMatches: number;
    togetherWins: number;
    combinedGoals: number;
    combinedAssists: number;
  };
  const pairMap = new Map<string, PairData>();

  const addPairForTeam = (m: any, teamUsers: any[], teamWon: boolean) => {
    for (let i = 0; i < teamUsers.length; i++) {
      for (let j = i + 1; j < teamUsers.length; j++) {
        const aId = String(teamUsers[i].id);
        const bId = String(teamUsers[j].id);
        const ids = [aId, bId].sort() as [string, string];
        const key = ids.join('|');
        const names: [string, string] = [
          memberById.get(ids[0]) || 'Unknown',
          memberById.get(ids[1]) || 'Unknown',
        ];
        const rec =
          pairMap.get(key) || {
            ids,
            names,
            togetherMatches: 0,
            togetherWins: 0,
            combinedGoals: 0,
            combinedAssists: 0,
          };
        rec.togetherMatches += 1;
        if (teamWon) rec.togetherWins += 1;

        // Add their goals/assists for this match (if stats exist)
        const aStat = statMapByMatchUser.get(`${m.id}:${ids[0]}`) as any;
        const bStat = statMapByMatchUser.get(`${m.id}:${ids[1]}`) as any;
        rec.combinedGoals += Number(aStat?.goals || 0) + Number(bStat?.goals || 0);
        rec.combinedAssists += Number(aStat?.assists || 0) + Number(bStat?.assists || 0);

        pairMap.set(key, rec);
      }
    }
  };

  for (const m of completed) {
    const home = (m.homeTeamUsers || []) as any[];
    const away = (m.awayTeamUsers || []) as any[];
    const homeWon = Number(m.homeTeamGoals) > Number(m.awayTeamGoals);
    const awayWon = Number(m.awayTeamGoals) > Number(m.homeTeamGoals);

    addPairForTeam(m, home, homeWon);
    addPairForTeam(m, away, awayWon);
  }

  const bestPairing =
    Array.from(pairMap.values()).sort((a: PairData, b: PairData) => {
      if (b.togetherWins !== a.togetherWins) return b.togetherWins - a.togetherWins;
      const aGA = a.combinedGoals + a.combinedAssists;
      const bGA = b.combinedGoals + b.combinedAssists;
      if (bGA !== aGA) return bGA - aGA;
      return b.togetherMatches - a.togetherMatches;
    })[0] || null;

  // Hottest player: most XP over last 5 completed matches
  let hottestPlayer: null | {
    playerId: string;
    name: string;
    xpInLast5: number;
    matchesConsidered: number;
  } = null;

  if (completed.length > 0) {
    const recent = completed.slice(-5);
    const recentIds = recent.map((m) => m.id);
    const recentStats = statsRows.length
      ? statsRows.filter((s: any) => recentIds.includes(s.match_id))
      : await MatchStatistics.findAll({ where: { match_id: recentIds } });

    const xpTotals: Record<string, number> = {};
    for (const s of recentStats) {
      const pid = String((s as any).user_id);
      const xp = Number((s as any).xpAwarded || 0);
      xpTotals[pid] = (xpTotals[pid] || 0) + xp;
    }
    const top = Object.entries(xpTotals).sort((a: [string, number], b: [string, number]) => b[1] - a[1])[0];
    if (top) {
      const [pid, total] = top;
      hottestPlayer = {
        playerId: pid,
        name: memberById.get(pid) || 'Unknown',
        xpInLast5: total,
        matchesConsidered: recent.length,
      };
    }
  }

  ctx.body = {
    success: true,
    data: {
      playedMatches,
      remaining,
      players,
      created: (league as any).createdAt,
      bestPairing,
      hottestPlayer,
    },
  };
});

// QUICK-VIEW (dynamic) for a player within a league
router.get('/:leagueId/player/:playerId/quick-view', required, async (ctx) => {
  const leagueId = String(ctx.params.leagueId || '');
  const playerId = String(ctx.params.playerId || '');

  // Safe actor id (avoid property 'id' TS error)
  const authUser = (ctx.state.user || {}) as any;
  const requesterId = String(authUser.userId ?? authUser.id ?? '');

  // Debug
  console.log('[GET] /leagues/:leagueId/player/:playerId/quick-view', {
    leagueId,
    playerId,
    user: requesterId || null,
  });

  if (!leagueId || !playerId) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'leagueId and playerId are required' };
    return;
  }

  // 1) Fetch league with members + matches and normalize (so "league" exists)
  const leagueRow = await League.findByPk(leagueId, {
    include: [
      { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType', 'preferredFoot', 'shirtNumber', 'profilePicture'] },
      {
        model: Match,
        as: 'matches',
        include: [
          { model: User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
          { model: User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
        ],
      },
    ],
  });

  if (!leagueRow) {
    ctx.status = 404;
    ctx.body = { success: false, message: 'League not found' };
    return;
  }

  const rawMembers = ((leagueRow as any).members || []) as any[];
  const rawMatches = ((leagueRow as any).matches || []) as any[];

  // derive members from match participants and merge
  const derivedFromMatches = [
    ...rawMatches.flatMap((m: any) => (m.homeTeamUsers || [])),
    ...rawMatches.flatMap((m: any) => (m.awayTeamUsers || [])),
  ];
  const mergedMap = new Map<string, any>();
  [...rawMembers, ...derivedFromMatches].forEach((u: any) => {
    const id = String(u.id);
    if (!mergedMap.has(id)) mergedMap.set(id, u);
  });

  const league = {
    id: String(leagueRow.id),
    name: (leagueRow as any).name,
    members: Array.from(mergedMap.values()).map(toUserBasic),
    matches: rawMatches.map((m: any) => ({
      id: String(m.id),
      homeTeamGoals: Number(m.homeTeamGoals || 0),
      awayTeamGoals: Number(m.awayTeamGoals || 0),
      homeTeamUsers: ((m as any).homeTeamUsers || []).map(toUserBasic),
      awayTeamUsers: ((m as any).awayTeamUsers || []).map(toUserBasic),
      manOfTheMatchVotes: (m as any).manOfTheMatchVotes || {},
      playerStats: Object.fromEntries(
        (Object.entries((m as any).playerStats || {}) as Array<[string, any]>).map(([pid, s]) => [
          String(pid),
          { goals: Number(s?.goals || 0), assists: Number(s?.assists || 0) },
        ])
      ),
      status: normalizeStatus((m as any).status),
      start: (m as any).start,
      date: (m as any).date,
    })),
  };

  // 2) Compute base stats (then override goals/assists/motmVotes from DB below)
  type PlayerStats = { played: number; wins: number; draws: number; losses: number; goals: number; assists: number; motmVotes: number; teamGoalsConceded: number };
  const calcStats = (lg: any): Record<string, PlayerStats> => {
    const stats: Record<string, PlayerStats> = {};
    const ensure = (pid: string) => {
      if (!stats[pid]) stats[pid] = { played: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };
    };
    (lg.members || []).forEach((p: any) => ensure(String(p.id)));
    (lg.matches || []).forEach((m: any) => {
      (m.homeTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
      (m.awayTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
    });
    (lg.matches || [])
      .filter((m: any) => m.status === 'RESULT_PUBLISHED')
      .forEach((m: any) => {
        const home: string[] = (m.homeTeamUsers || []).map((p: any) => String(p.id));
        const away: string[] = (m.awayTeamUsers || []).map((p: any) => String(p.id));
        [...home, ...away].forEach((pid: string) => {
          ensure(pid);
          stats[pid].played += 1;
          const ps = (m.playerStats || {})[pid] || { goals: 0, assists: 0 };
          stats[pid].goals += Number(ps.goals || 0);
          stats[pid].assists += Number(ps.assists || 0);
        });
        const hg = Number(m.homeTeamGoals || 0);
        const ag = Number(m.awayTeamGoals || 0);
        const homeWon = hg > ag;
        const draw = hg === ag;
        home.forEach((pid: string) => {
          ensure(pid);
          if (homeWon) stats[pid].wins += 1;
          else if (draw) stats[pid].draws += 1;
          else stats[pid].losses += 1;
          stats[pid].teamGoalsConceded += ag;
        });
        away.forEach((pid: string) => {
          ensure(pid);
          if (!homeWon && !draw) stats[pid].wins += 1;
          else if (draw) stats[pid].draws += 1;
          else stats[pid].losses += 1;
          stats[pid].teamGoalsConceded += hg;
        });
      });
    return stats;
  };

  const statsMap = calcStats(league);
  const stats: PlayerStats = statsMap[playerId] || { played: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };

  // 3) Completed matches for this league
  const completedMatches = (league.matches || []).filter((m: any) => m.status === 'RESULT_PUBLISHED');
  const completedIds = completedMatches.map((m: any) => String(m.id));

  // 4) Pull per-match player stats and votes from DB
  const allStats = completedIds.length
    ? await MatchStatistics.findAll({ where: { match_id: completedIds } as any })
    : [];
  const userStatsAll = allStats.filter((s: any) => String(s.user_id) === playerId);

  const allVotes = completedIds.length
    ? await Vote.findAll({ where: { matchId: completedIds } as any })
    : [];

  const statByMatchUser = new Map<string, any>(
    allStats.map((s: any) => [`${String(s.match_id)}:${String(s.user_id)}`, s])
  );

  const votesByMatch: Record<string, { counts: Record<string, number>; winnerId: string | null; maxVotes: number }> = {};
  completedIds.forEach((mid: string) => {
    const vlist = allVotes.filter((v: any) => String(v.matchId) === mid);
    const counts: Record<string, number> = {};
    vlist.forEach((v: any) => {
      const id = String(v.votedForId);
      counts[id] = (counts[id] || 0) + 1;
    });
    let winnerId: string | null = null, maxVotes = 0;
    Object.entries(counts).forEach(([id, c]) => { if (c > maxVotes) { maxVotes = c as number; winnerId = id; } });
    votesByMatch[mid] = { counts, winnerId, maxVotes };
  });

  // 5) Override totals in stats strictly from DB
  const totalGoals = userStatsAll.reduce((s: number, r: any) => s + Number(r.goals || 0), 0);
  const totalAssists = userStatsAll.reduce((s: number, r: any) => s + Number(r.assists || 0), 0);
  const totalMotmVotes = allVotes.filter((v: any) => String(v.votedForId) === playerId).length;

  stats.goals = Number(totalGoals || 0);
  stats.assists = Number(totalAssists || 0);
  stats.motmVotes = Number(totalMotmVotes || 0);

  // 6) Build lastFiveDetailed from DB rows (plus a legacy lastFive)
  type UserMatchSummary = { goals: number; assists: number; conceded: number; result: 'W'|'D'|'L'; motmVotes: number };
  type LastFiveDetailed = {
    matchId: string;
    date: string | null;
    result: 'W' | 'D' | 'L';
    goals: number;
    assists: number;
    conceded: number;
    cleanSheet: boolean;
    motmVotes: number;
    isMOTM: boolean;
    xp: number;
  };

  const detailedAll: LastFiveDetailed[] = [];
  completedMatches.forEach((m: any) => {
    const matchId = String(m.id);
    const isHome = (m.homeTeamUsers || []).some((u: any) => String(u.id) === playerId);
    const isAway = (m.awayTeamUsers || []).some((u: any) => String(u.id) === playerId);
    if (!isHome && !isAway) return;

    const teamGoals = isHome ? Number(m.homeTeamGoals || 0) : Number(m.awayTeamGoals || 0);
    const oppGoals = isHome ? Number(m.awayTeamGoals || 0) : Number(m.homeTeamGoals || 0);
    const result: 'W'|'D'|'L' = teamGoals > oppGoals ? 'W' : (teamGoals === oppGoals ? 'D' : 'L');

    const stat = statByMatchUser.get(`${matchId}:${playerId}`);
    const goals = Number(stat?.goals || 0);
    const assists = Number(stat?.assists || 0);
    const cleanSheet = Number(stat?.cleanSheets || 0) > 0 ? true : oppGoals === 0;

    const v = votesByMatch[matchId] || { counts: {}, winnerId: null, maxVotes: 0 };
    const motmVotes = Number((v.counts as any)[playerId] || 0);
    const isMOTM = v.winnerId === playerId && v.maxVotes > 0;

    detailedAll.push({
      matchId,
      date: m.start ? new Date(m.start).toISOString() : (m.date ? new Date(m.date).toISOString() : null),
      result,
      goals,
      assists,
      conceded: oppGoals,
      cleanSheet,
      motmVotes,
      isMOTM,
      xp: 0 // filled below
    });
  });

  const detailedSorted = detailedAll.sort((a, b) => (b.date ? Date.parse(b.date) : 0) - (a.date ? Date.parse(a.date) : 0));
  const lastFiveDetailedIds = detailedSorted.slice(0, 5).map(d => d.matchId);

  // After building detailedSorted and lastFiveDetailedIds, REMOVE per-match XP fetch:
  // const statsRowsForFive = lastFiveDetailedIds.length
  //   ? await MatchStatistics.findAll({ where: { match_id: lastFiveDetailedIds, user_id: playerId } as any })
  //   : [];
  // const xpByMatch: Record<string, number> = {};
  // (statsRowsForFive || []).forEach((r: any) => { xpByMatch[String(r.match_id)] = Number(r.xpAwarded || 0); });

  // Keep last five details, but set xp to 0 (no per-match XP)
  const lastFiveDetailed: LastFiveDetailed[] =
    detailedSorted.slice(0, 5).map(d => ({ ...d, xp: 0 }));

  const lastFive: UserMatchSummary[] = lastFiveDetailed.map(d => ({
    goals: d.goals,
    assists: d.assists,
    conceded: d.conceded,
    result: d.result,
    motmVotes: d.motmVotes
  }));

  const cleanSheets = detailedAll.filter(d => d.cleanSheet).length;
  const motmCount = detailedAll.filter(d => d.isMOTM).length;

  // 7) Player + skills (DB only)
  const dbPlayer = await User.findByPk(String(ctx.params.playerId), {
    attributes: [
      'id', 'firstName', 'lastName', 'position', 'positionType',
      'preferredFoot', 'shirtNumber', 'profilePicture', 'skills', 'xp'
    ],
  });

  const player = dbPlayer
    ? {
        id: String(dbPlayer.get('id')),
        firstName: dbPlayer.get('firstName') as string,
        lastName: dbPlayer.get('lastName') as string,
        position: (dbPlayer.get('position') as string) ?? (dbPlayer.get('positionType') as string),
        positionType: (dbPlayer.get('positionType') as string) ?? undefined,
        preferredFoot: (dbPlayer.get('preferredFoot') as string) ?? undefined,
        shirtNumber: (dbPlayer.get('shirtNumber') as string) ?? undefined,
        profilePicture: (dbPlayer.get('profilePicture') as string) ?? undefined,
      }
    : undefined;

  const rawSkills = (dbPlayer?.get('skills') ?? null) as
    | null
    | { dribbling?: number; shooting?: number; passing?: number; pace?: number; defending?: number; physical?: number; };

  const skills =
    rawSkills && typeof rawSkills === 'object'
      ? {
          dribbling: Number(rawSkills.dribbling ?? 0),
          shooting: Number(rawSkills.shooting ?? 0),
          passing: Number(rawSkills.passing ?? 0),
          pace: Number(rawSkills.pace ?? 0),
          defending: Number(rawSkills.defending ?? 0),
          physical: Number(rawSkills.physical ?? 0),
        }
      : null;

  // XP ONLY from User model
  const profileXP = Number(dbPlayer?.get('xp') ?? 0);
  console.log('xpppppppppppppppppppppp',profileXP)
  const xpLatest = profileXP;       // keep fields for compatibility
  const xpRecentTotal = profileXP;  // keep fields for compatibility

  ctx.body = {
    success: true,
    league: { id: league.id, name: league.name },
    player,
    stats,
    lastFive,
    lastFiveDetailed,
    cleanSheets,
    motmCount,
    xp: profileXP,     // NEW: explicit XP from User.xp
    profileXP,
    xpLatest,
    xpRecentTotal,
    skills
  };
});

router.get('/:id/status', required, async (ctx) => {
  const { id } = ctx.params;
  const status = await leagueStatusService.compute(id);

  // derive "locked" from inviteCode being null
  const leagueRow = await League.findByPk(id, { attributes: ['inviteCode'] });
  const locked = !leagueRow?.get('inviteCode');

  ctx.body = { success: true, status: { ...status, locked } };
});

// REPLACE the previous lock route that used requireLeagueAdmin and isLocked
router.post('/:id/lock', required, async (ctx) => {
  const { id } = ctx.params;

  // ensure admin via helper
  await verifyLeagueAdmin(ctx, id);

  const status = await leagueStatusService.compute(id);
  if (!status.isComplete) {
    ctx.status = 400;
    ctx.body = { success: false, message: 'League is not complete yet' };
    return;
  }

  // "Lock" by clearing inviteCode so it can’t be used anymore
  await League.update(
    { inviteCode: '' },
    { where: { id } }
  );

  // On lock, run final XP/Achievement calculation for all members
  try {
    const league = await League.findByPk(id, { include: [{ model: User, as: 'members', attributes: ['id'] }] });
    const memberIds: string[] = ((league as any)?.members || []).map((m: any) => String(m.id));
    await Promise.all(memberIds.map((uid) => calculateAndAwardXPAchievements(uid, String(id))));
  } catch (err) {
    console.error('Final XP calc on lock failed:', err);
  }

  ctx.body = { success: true, locked: true };
});

export default router;
