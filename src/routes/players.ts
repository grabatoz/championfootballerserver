import Router from '@koa/router';
import { required } from '../modules/auth';
import { getAllPlayers, getPlayerById, getPlayerStats, searchPlayers } from '../controllers/playerController';
import models from '../models';
import { Op } from 'sequelize';
import sequelize from '../config/database';
import cache from '../utils/cache';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

const router = new Router({ prefix: '/players' });

// Get all players with caching
router.get('/', getAllPlayers);

// Get all players who are MEMBERS of a given league (even if they never played a match)
router.get('/by-league', required, async (ctx) => {
  try {
    if (!ctx.state.user) {
      ctx.throw(401, 'User not authenticated');
      return;
    }
    const leagueId = typeof ctx.request.query?.leagueId === 'string' ? ctx.request.query.leagueId.trim() : '';
    const seasonId = typeof ctx.request.query?.seasonId === 'string' ? ctx.request.query.seasonId.trim() : '';
    
    if (!leagueId) {
      ctx.status = 400;
      ctx.body = { success: false, message: 'leagueId is required' };
      return;
    }

    // Fetch league with members; keep attributes minimal for speed
    const league = await LeagueModel.findByPk(leagueId, {
      include: [
        { model: models.User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'shirtNumber', 'email'] },
        { model: models.User, as: 'administeredLeagues', attributes: ['id'] },
      ],
      attributes: ['id', 'name'],
    });
    if (!league) {
      ctx.status = 404;
      ctx.body = { success: false, message: 'League not found' };
      return;
    }

    const uid = ctx.state.user.userId;
    const isMember = ((league as any).members || []).some((m: any) => String(m.id) === String(uid));
    const isAdmin = ((league as any).administeredLeagues || []).some((a: any) => String(a.id) === String(uid));
    if (!isMember && !isAdmin) {
      ctx.status = 403;
      ctx.body = { success: false, message: "You don't have access to this league" };
      return;
    }

    let members = ((league as any).members || []) as Array<any>;
    
    // If seasonId is provided, filter members by season
    if (seasonId && seasonId !== 'all') {
      const season = await models.Season.findByPk(seasonId, {
        include: [
          { model: models.User, as: 'players', attributes: ['id'] }
        ]
      });
      
      if (season) {
        const seasonPlayerIds = new Set(((season as any).players || []).map((p: any) => String(p.id)));
        members = members.filter((m) => seasonPlayerIds.has(String(m.id)));
      }
    }
    
    // Filter out guest players (those without proper user accounts)
    // Real players have email and are properly registered users
    const realPlayers = members.filter((p) => {
      // Exclude if it's a guest player or doesn't have a valid email
      return p.email && p.email.trim() !== '' && !p.email.includes('guest');
    });
    
    const players = realPlayers.map((p) => ({
      id: p.id,
      name: `${p.firstName || ''} ${p.lastName || ''}`.trim(),
      profilePicture: p.profilePicture ?? null,
      rating: Number(p.xp || 0),
      shirtNumber: p.shirtNumber ?? null,
    }));

    ctx.body = { success: true, players };
  } catch (error) {
    console.error('Error fetching league members:', error);
    ctx.throw(500, 'Failed to fetch league members.');
  }
});

// Get all players the current user has played with or against
router.get('/played-with', required, async (ctx) => {
  try {
    if (!ctx.state.user) {
      ctx.throw(401, 'User not authenticated');
      return;
    }
    const userId = ctx.state.user.userId;
    const leagueIdQ = typeof ctx.request.query?.leagueId === 'string' ? ctx.request.query.leagueId.trim() : '';

    // Find all match IDs the user has played in, based on stats
    const userMatchStats = await MatchStatistics.findAll({
      where: { user_id: userId },
      attributes: ['match_id']
    });     

    
    let matchIds = userMatchStats.map(stat => stat.match_id);

    // Optional: filter to a specific league's matches
    if (leagueIdQ && leagueIdQ !== 'all') {
      const leagueMatches = await MatchModel.findAll({
        where: { id: { [Op.in]: matchIds }, leagueId: leagueIdQ },
        attributes: ['id'],
      });
      matchIds = leagueMatches.map(m => m.id);
    }

    if (matchIds.length === 0) {
      ctx.body = { success: true, players: [] };
      return;
    }

    // Find all player IDs who participated in those matches
    const allPlayerStats = await MatchStatistics.findAll({
      where: {
        match_id: {
          [Op.in]: matchIds
        }
      },
      attributes: ['user_id']
    });

    const playerIds = new Set<string>(allPlayerStats.map(stat => stat.user_id));
    
    // Remove the current user from the set
    playerIds.delete(userId);

    // Fetch details for all unique players
    const players = await UserModel.findAll({
      where: {
        id: {
          [Op.in]: Array.from(playerIds)
        }
      },
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp','shirtNumber', 'email']
    });

    // Filter out guest players - only include real registered players
    const realPlayers = players.filter(p => 
      p.email && p.email.trim() !== '' && !p.email.includes('guest')
    );

    ctx.body = {
      success: true,
      players: realPlayers.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        profilePicture: p.profilePicture,
        rating: p.xp || 0 // Assuming XP is the rating
        ,shirtNumber: p.shirtNumber
      }))
    };

  } catch (error) {
    console.error('Error fetching played-with players:', error);
    ctx.throw(500, 'Failed to fetch players.');
  }
});

// Get player by ID
router.get('/:id', required, getPlayerById);

// Get player stats
router.get('/:id/stats', required, getPlayerStats);

// Search players (optional - if you want to add this feature later)
// router.get('/search', required, searchPlayers);

// GET /api/player/:playerId/leagues-matches?year=2025
router.get('/:playerId/leagues-matches', async (ctx) => {
  try {
    const { playerId } = ctx.params;
    const { year } = ctx.query;

    if (!year) {
      ctx.status = 400;
      ctx.body = { error: 'Year is required' };
      return;
    }

    const leagues = await LeagueModel.findAll({ include: [{ model: MatchModel, as: 'matches' }] });

    const filteredLeagues = leagues
      .map((league: any) => {
        const matches = (league.matches || []).filter((match: any) =>
          new Date(match.date).getFullYear() === Number(year) &&
          (
            (match.homeTeamUsers && match.homeTeamUsers.some((u: any) => String(u.id) === String(playerId))) ||
            (match.awayTeamUsers && match.awayTeamUsers.some((u: any) => String(u.id) === String(playerId)))
          )
        );
        return matches.length > 0 ? { ...league.toJSON(), matches } : null;
      })
      .filter(Boolean);

    ctx.body = filteredLeagues;
  } catch (err) {
    console.error(err);
    ctx.status = 500;
    ctx.body = { error: 'Server error' };
  }
});

// League-wise teammates (players a given player has played with inside a league)
router.get('/:playerId/leagues/:leagueId/teammates', required, async (ctx) => {
  try {
    const { playerId, leagueId } = ctx.params;

    if (!ctx.state.user) {
      ctx.throw(401, 'User not authenticated');
      return;
    }

    // Basic validation
    if (!playerId || !leagueId) {
      ctx.throw(400, 'playerId and leagueId are required');
      return;
    }

    // Optional: check player exists
    const player = await UserModel.findByPk(playerId, { attributes: ['id'] });
    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    // Optional: confirm league exists
    const league = await LeagueModel.findByPk(leagueId, { attributes: ['id'] });
    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }

    // Cache key
    const cacheKey = `league_teammates_${playerId}_${leagueId}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }

    // 1. Get all matches in this league
    const leagueMatches = await MatchModel.findAll({
      where: { leagueId },
      attributes: ['id']
    });
    const leagueMatchIds = leagueMatches.map(m => m.id);

    if (leagueMatchIds.length === 0) {
      const emptyResult = { success: true, data: [], players: [] };
      cache.set(cacheKey, emptyResult, 300);
      ctx.body = emptyResult;
      return;
    }

    // 2. Get matches (in this league) that the player participated in (via stats)
    const playerLeagueStats = await MatchStatistics.findAll({
      where: {
        user_id: playerId,
        match_id: { [Op.in]: leagueMatchIds }
      },
      attributes: ['match_id']
    });
    const participatedMatchIds = playerLeagueStats.map(s => s.match_id);

    if (participatedMatchIds.length === 0) {
      const emptyResult = { success: true, data: [], players: [] };
      cache.set(cacheKey, emptyResult, 300);
      ctx.body = emptyResult;
      return;
    }

    // 3. Get ALL stats rows for those matches to gather co-player ids
    const allStatsSameMatches = await MatchStatistics.findAll({
      where: {
        match_id: { [Op.in]: participatedMatchIds }
      },
      attributes: ['user_id']
    });

    const teammateIdsSet = new Set<string>(allStatsSameMatches.map(s => s.user_id));
    teammateIdsSet.delete(String(playerId));

    if (teammateIdsSet.size === 0) {
      const emptyResult = { success: true, data: [], players: [] };
      cache.set(cacheKey, emptyResult, 300);
      ctx.body = emptyResult;
      return;
    }

    const teammateIds = Array.from(teammateIdsSet);

    // 4. Fetch teammate user records
    const teammates = await UserModel.findAll({
      where: {
        id: { [Op.in]: teammateIds }
      },
      attributes: [
        'id',
        'firstName',
        'lastName',
        'profilePicture',
        'xp',
        'position',
        'positionType',
        'shirtNumber'
      ]
    });

    // (Optional) Aggregate simple per-player stats inside this league (goals, assists, matches)
    const leagueStatsAgg = await MatchStatistics.findAll({
      where: {
        user_id: { [Op.in]: teammateIds },
        match_id: { [Op.in]: participatedMatchIds }
      },
      attributes: [
        'user_id',
        [sequelize.fn('SUM', sequelize.col('goals')), 'goals'],
        [sequelize.fn('SUM', sequelize.col('assists')), 'assists'],
        [sequelize.fn('COUNT', sequelize.col('match_id')), 'appearances']
      ],
      group: ['user_id']
    });

    const statMap: Record<string, { goals: number; assists: number; appearances: number }> = {};
    leagueStatsAgg.forEach((row: any) => {
      statMap[row.get('user_id')] = {
        goals: Number(row.get('goals') || 0),
        assists: Number(row.get('assists') || 0),
        appearances: Number(row.get('appearances') || 0)
      };
    });

    const resultPlayers = teammates.map(t => {
      const stats = statMap[t.id] || { goals: 0, assists: 0, appearances: 0 };
      return {
        id: t.id,
        firstName: t.firstName,
        lastName: t.lastName,
        name: `${t.firstName} ${t.lastName}`.trim(),
        avatar: t.profilePicture,
        profilePicture: t.profilePicture,
        rating: t.xp || 0,
        position: t.position,
        positionType: t.positionType,
        shirtNumber: t.shirtNumber,
        goals: stats.goals,
        assists: stats.assists,
        appearances: stats.appearances
      };
    });

    const payload = { success: true, data: resultPlayers, players: resultPlayers, leagueId, playerId };
    cache.set(cacheKey, payload, 300); // 5 min
    ctx.body = payload;
  } catch (err) {
    console.error('Error fetching league teammates:', err);
    ctx.throw(500, 'Failed to fetch league teammates.');
  }
});

// XP summary for a player with optional league/year filters
// GET /players/:id/xp?leagueId=...&year=...
router.get('/:id/xp', required, async (ctx) => {
  try {
    const { id: playerId } = ctx.params as { id: string };
    const { leagueId, year } = ctx.query as { leagueId?: string; year?: string };

    const cacheKey = `player_xp_${playerId}_${leagueId || 'all'}_${year || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }

    // Validate player exists (lightweight)
    const player = await models.User.findByPk(playerId, { attributes: ['id'] });
    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    // Build include filter on Match for league/year
    const include: any[] = [
      {
        model: MatchModel,
        as: 'match',
        required: true,
        attributes: ['id', 'date', 'leagueId'],
        where: {} as any,
      },
    ];

    if (leagueId && leagueId !== 'all') {
      (include[0].where as any).leagueId = leagueId;
    }
    if (year && year !== 'all') {
      const y = Number(year);
      if (!Number.isNaN(y)) {
        const start = new Date(y, 0, 1);
        const end = new Date(y + 1, 0, 1);
        (include[0].where as any).date = { [Op.gte]: start, [Op.lt]: end };
      }
    }

    // Fetch all stats rows for this player with filters
    const rows = await MatchStatistics.findAll({
      where: { user_id: playerId },
      include,
      attributes: ['xpAwarded'],
    });

    const totalXP = rows.reduce((sum: number, r: any) => sum + (Number(r.get('xpAwarded')) || 0), 0);
    const matches = rows.length;
    const avgXP = matches > 0 ? totalXP / matches : 0;

    const payload = {
      success: true,
      data: {
        playerId,
        filters: { leagueId: leagueId || 'all', year: year || 'all' },
        totalXP,
        matches,
        avgXP,
      },
    };
    cache.set(cacheKey, payload, 300); // 5 min
    ctx.body = payload;
  } catch (err) {
    console.error('Error computing filtered XP:', err);
    ctx.throw(500, 'Failed to compute XP');
  }
});

// Accumulative trophies for a player (normalized titles), optional league/year filters
// GET /players/:id/trophies?leagueId=...&year=...
router.get('/:id/trophies', required, async (ctx) => {
  try {
    const { id: playerId } = ctx.params as { id: string };
    const { leagueId, year } = ctx.query as { leagueId?: string; year?: string };

    const cacheKey = `player_trophies_${playerId}_${leagueId || 'all'}_${year || 'all'}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.body = cached;
      return;
    }

    // Load leagues the player has ever joined, including members and matches with teams
    const playerWithLeagues = await models.User.findByPk(playerId, {
      include: [
        {
          model: LeagueModel,
          as: 'leagues',
          include: [
            { model: models.User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
            {
              model: MatchModel,
              as: 'matches',
              include: [
                { model: models.User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
                { model: models.User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
              ],
            },
          ],
        },
      ],
    });

    const allLeagues: any[] = (playerWithLeagues as any)?.leagues || [];
    if (!allLeagues.length) {
      const payload = { success: true, data: { trophies: {}, counts: {} as Record<string, number> } };
      cache.set(cacheKey, payload, 300);
      ctx.body = payload;
      return;
    }

    // Normalizers (borrowed from leagues trophy-room)
    const normalizeStatus = (s?: string) => {
      const v = String(s ?? '').toLowerCase();
      if (['result_published', 'result_uploaded', 'uploaded', 'complete', 'finished', 'ended', 'done'].includes(v)) return 'RESULT_PUBLISHED';
      if (['ongoing', 'inprogress', 'in_progress', 'live', 'playing'].includes(v)) return 'ONGOING';
      return 'SCHEDULED';
    };

    type PlayerStats = { played: number; wins: number; draws: number; losses: number; goals: number; assists: number; motmVotes: number; teamGoalsConceded: number };

    const calcStats = (league: any): Record<string, PlayerStats> => {
      const stats: Record<string, PlayerStats> = {};
      const ensure = (pid: string) => {
        if (!stats[pid]) stats[pid] = { played: 0, wins: 0, draws: 0, losses: 0, goals: 0, assists: 0, motmVotes: 0, teamGoalsConceded: 0 };
      };
      const members = (league.members || []);
      members.forEach((p: any) => ensure(String(p.id)));
      const matches = (league.matches || []);
      matches.forEach((m: any) => {
        (m.homeTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
        (m.awayTeamUsers || []).forEach((p: any) => ensure(String(p.id)));
      });
      matches
        .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
        .forEach((m: any) => {
          const home: string[] = (m.homeTeamUsers || []).map((p: any) => String(p.id));
          const away: string[] = (m.awayTeamUsers || []).map((p: any) => String(p.id));
          [...home, ...away].forEach((pid: string) => { if (stats[pid]) stats[pid].played += 1; });
          // Aggregate simple goals/assists if present on m.playerStats
          const ps = (m.playerStats || {}) as Record<string, { goals?: number; assists?: number }>;
          Object.entries(ps).forEach(([pid, s]) => {
            if (!stats[pid]) return;
            stats[pid].goals += Number(s?.goals || 0);
            stats[pid].assists += Number(s?.assists || 0);
          });
          // MOTM votes if present (best-effort)
          const motmVals = Object.values((m as any).manOfTheMatchVotes || {}) as Array<string | number>;
          motmVals.forEach((pid) => { const id = String(pid); if (stats[id]) stats[id].motmVotes += 1; });
          const hg = Number(m.homeTeamGoals || 0), ag = Number(m.awayTeamGoals || 0);
          const homeWon = hg > ag; const draw = hg === ag;
          home.forEach((pid: string) => { if (!stats[pid]) return; if (homeWon) stats[pid].wins++; else if (draw) stats[pid].draws++; else stats[pid].losses++; stats[pid].teamGoalsConceded += ag; });
          away.forEach((pid: string) => { if (!stats[pid]) return; if (!homeWon && !draw) stats[pid].wins++; else if (draw) stats[pid].draws++; else stats[pid].losses++; stats[pid].teamGoalsConceded += hg; });
        });
      return stats;
    };

    const calcWinners = (league: any, statsMap: Record<string, PlayerStats>) => {
      const ids: string[] = Object.keys(statsMap);
      if (!ids.length) return [] as Array<{ title: string; winnerId: string | null; leagueId: string; leagueName: string }>;
      const eligible: string[] = ids.filter((id: string) => (statsMap[id]?.played || 0) > 0);
      const byPoints = (a: string, b: string) => (statsMap[b].wins * 3 + statsMap[b].draws) - (statsMap[a].wins * 3 + statsMap[a].draws);
      const table: string[] = [...eligible].sort(byPoints);
      const gkIds: string[] = (league.members || [])
        .filter((p: any) => String(p.positionType || p.position || '').toLowerCase().includes('goalkeeper'))
        .map((p: any) => String(p.id));
      // Compute clean sheets for GKs
      const cleanSheets: Record<string, number> = {}; gkIds.forEach((id: string) => (cleanSheets[id] = 0));
      (league.matches || [])
        .filter((m: any) => normalizeStatus(m.status) === 'RESULT_PUBLISHED')
        .forEach((m: any) => {
          const homeGk: string[] = (m.homeTeamUsers || []).filter((u: any) => gkIds.includes(String(u.id))).map((u: any) => String(u.id));
          const awayGk: string[] = (m.awayTeamUsers || []).filter((u: any) => gkIds.includes(String(u.id))).map((u: any) => String(u.id));
          if (Number(m.awayTeamGoals || 0) === 0) homeGk.forEach((id: string) => (cleanSheets[id] = (cleanSheets[id] || 0) + 1));
          if (Number(m.homeTeamGoals || 0) === 0) awayGk.forEach((id: string) => (cleanSheets[id] = (cleanSheets[id] || 0) + 1));
        });

      const pickByMax = (arr: string[], metric: (id: string) => number, min: number) => {
        if (!arr.length) return null;
        const sorted = [...arr].sort((a, b) => metric(b) - metric(a));
        const top = sorted[0];
        return metric(top) > min ? top : null;
      };

      const champion = table.length >= 1 ? table[0] : null;
      const runnerUp = table.length >= 2 ? table[1] : null;
      const goldenBoot = pickByMax(eligible, (id) => statsMap[id].goals, 0);
      const playmaker = pickByMax(eligible, (id) => statsMap[id].assists, 0);
      const ballonDor = pickByMax(eligible, (id) => statsMap[id].motmVotes, 0);
      const goat = (() => {
        if (!eligible.length) return null;
        const sorted = [...eligible].sort((a, b) => {
          const ra = statsMap[a].played ? statsMap[a].wins / statsMap[a].played : 0;
          const rb = statsMap[b].played ? statsMap[b].wins / statsMap[b].played : 0;
          return (rb - ra) || (statsMap[b].motmVotes - statsMap[a].motmVotes);
        });
        const top = sorted[0];
        const ratio = statsMap[top].played ? statsMap[top].wins / statsMap[top].played : 0;
        return ratio > 0 ? top : null;
      })();
      const shield = (() => {
        const defOrGk = (league.members || [])
          .filter((p: any) => ['defender', 'goalkeeper'].includes(String(p.positionType || p.position || '').toLowerCase()))
          .map((p: any) => String(p.id))
          .filter((id: string) => (statsMap[id]?.played || 0) > 0);
        if (!defOrGk.length) return null;
        const sorted = defOrGk.sort((a: string, b: string) => {
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
        const outsideTop3 = table.slice(3);
        const sorted = outsideTop3.sort((a: string, b: string) => statsMap[b].motmVotes - statsMap[a].motmVotes);
        const top = sorted[0];
        return top && statsMap[top].motmVotes > 0 ? top : null;
      })();
      const starKeeper = (() => {
        const eligibleGk = gkIds.filter((id: string) => (statsMap[id]?.played || 0) > 0);
        if (!eligibleGk.length) return null;
        const sorted = eligibleGk.sort((a: string, b: string) => {
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
        { title: 'League Champion', id: champion },
        { title: 'Runner-Up', id: runnerUp },
        { title: "Ballon D'or", id: ballonDor },
        { title: 'GOAT', id: goat },
        { title: 'Golden Boot', id: goldenBoot },
        { title: 'King Playmaker', id: playmaker },
        { title: 'Legendary Shield', id: shield },
        { title: 'The Dark Horse', id: darkHorse },
        { title: 'Star Keeper', id: starKeeper },
      ];

      return awards.map(({ title, id }) => ({
        title,
        winnerId: id,
        leagueId: String(league.id),
        leagueName: league.name,
      }));
    };

    // Apply filters and compute winners per league
    const selectedYear = year && year !== 'all' ? Number(year) : null;
    const leagues = allLeagues
      .filter((l: any) => !leagueId || leagueId === 'all' || String(l.id) === String(leagueId))
      .map((l: any) => {
        const matches = (l.matches || []).filter((m: any) => !selectedYear || new Date(m.date).getFullYear() === selectedYear);
        return {
          id: l.id,
          name: l.name,
          members: (l.members || []),
          matches,
        };
      });

    // Aggregate trophies for this player
    const trophyMap: Record<string, { leagueId: string; leagueName: string }[]> = {};
    leagues.forEach((lg: any) => {
      const stats = calcStats(lg);
      const winners = calcWinners(lg, stats);
      winners.forEach((w) => {
        if (w.winnerId && String(w.winnerId) === String(playerId)) {
          if (!trophyMap[w.title]) trophyMap[w.title] = [];
          trophyMap[w.title].push({ leagueId: w.leagueId, leagueName: w.leagueName });
        }
      });
    });

    const counts: Record<string, number> = Object.fromEntries(Object.entries(trophyMap).map(([k, v]) => [k, v.length]));
    const payload = { success: true, data: { trophies: trophyMap, counts } };
    cache.set(cacheKey, payload, 300);
    ctx.body = payload;
  } catch (err) {
    console.error('Error computing player trophies:', err);
    ctx.throw(500, 'Failed to compute trophies');
  }
});

interface SimplePairingAgg {
  playerId: string;
  name: string;
  matchesTogether: number;
  winsTogether: number;
}
interface SimpleRivalAgg {
  playerId: string;
  name: string;
  matchesAgainst: number;
  lossesAgainst: number;
}



const inMemorySynergyCache = new Map<string, { data: any; ts: number }>();
const SYNERGY_TTL_MS = 60_000; // 1 min cache

/**
 * Logic:
 * For each player in the same league:
 *  - Best Pairing: teammate with whom the player accumulated the most wins (tie -> higher win rate -> more matches)
 *  - Toughest Rival: opponent versus whom the player accumulated the most losses (tie -> higher loss rate -> more matches)
 * Optional leagueId query returns only that league summary; otherwise returns all leagues.
 */
router.get('/:playerId/simple-synergy', async (ctx) => {
  const { playerId } = ctx.params;
  const { leagueId } = ctx.query as { leagueId?: string };

  if (!playerId) {
    ctx.status = 400;
    ctx.body = { error: 'playerId required' };
    return;
  }

  const cacheKey = `synergy:leagues:${playerId}:${leagueId || 'ALL'}`;
  const cached = inMemorySynergyCache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < SYNERGY_TTL_MS) {
    ctx.body = cached.data;
    return;
  }

  try {
    // 1. Get all match ids where this player has a stats row
    const playerStatRows = await MatchStatistics.findAll({
      where: { user_id: playerId },
      attributes: ['match_id']
    });
    const allMatchIds = playerStatRows.map(r => r.match_id);
    if (allMatchIds.length === 0) {
      const emptyPayload = leagueId
        ? {
            playerId,
            leagueId,
            participatedMatches: 0,
            bestPairing: null,
            toughestRival: null,
            generatedAt: new Date().toISOString()
          }
        : {
            playerId,
            leagues: [],
            generatedAt: new Date().toISOString()
          };
      inMemorySynergyCache.set(cacheKey, { data: emptyPayload, ts: Date.now() });
      ctx.body = emptyPayload;
      return;
    }

    // 2. Fetch matches (filtered by league if requested)
    const matchWhere: any = { id: { [Op.in]: allMatchIds } };
    if (leagueId) matchWhere.leagueId = leagueId;

    const matches = await MatchModel.findAll({
      where: matchWhere,
      include: [
        { model: models.User, as: 'homeTeamUsers', attributes: ['id', 'firstName', 'lastName'] },
        { model: models.User, as: 'awayTeamUsers', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['date', 'ASC']]
    });

    if (!matches.length) {
      const emptyPayload = leagueId
        ? {
            playerId,
            leagueId,
            participatedMatches: 0,
            bestPairing: null,
            toughestRival: null,
            generatedAt: new Date().toISOString()
          }
        : {
            playerId,
            leagues: [],
            generatedAt: new Date().toISOString()
          };
      inMemorySynergyCache.set(cacheKey, { data: emptyPayload, ts: Date.now() });
      ctx.body = emptyPayload;
      return;
    }

    // Helper normalize
    const norm = (arr: any[]): { id: string; name: string }[] =>
      (Array.isArray(arr) ? arr : [])
        .map(u => ({
          id: String(u.id),
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim()
        }))
        .filter(p => p.id);

    interface PairingAgg {
      playerId: string;
      name: string;
      matchesTogether: number;
      winsTogether: number;
    }
    interface RivalAgg {
      playerId: string;
      name: string;
      matchesAgainst: number;
      lossesAgainst: number;
    }

    // Group matches by leagueId
    const leagueBuckets = new Map<string, { leagueId: string; leagueName?: string; matches: any[] }>();
    matches.forEach(m => {
      const lid = String(m.leagueId);
      if (!leagueBuckets.has(lid)) {
        leagueBuckets.set(lid, { leagueId: lid, leagueName: (m as any).leagueName || undefined, matches: [] });
      }
      leagueBuckets.get(lid)!.matches.push(m);
    });

    const buildLeagueSynergy = (bucket: { leagueId: string; leagueName?: string; matches: any[] }) => {
      const teammateMap = new Map<string, PairingAgg>();
      const rivalMap = new Map<string, RivalAgg>();
      let participated = 0;

      bucket.matches.forEach(m => {
        const home = norm((m as any).homeTeamUsers);
        const away = norm((m as any).awayTeamUsers);
        const pid = String(playerId);
        const onHome = home.some(p => p.id === pid);
        const onAway = away.some(p => p.id === pid);
        if (!onHome && !onAway) return;
        if (onHome && onAway) return; // corrupt data safety
        participated++;

        const myTeam = onHome ? home : away;
        const oppTeam = onHome ? away : home;

        const hGoals = (m as any).homeTeamGoals;
        const aGoals = (m as any).awayTeamGoals;
        let res: 'W' | 'L' | 'D' | null = null;
        if (hGoals != null && aGoals != null) {
          if (hGoals === aGoals) res = 'D';
          else {
            const iWon = onHome ? hGoals > aGoals : aGoals > hGoals;
            res = iWon ? 'W' : 'L';
          }
        }

        myTeam.filter(p => p.id !== pid).forEach(p => {
          if (!teammateMap.has(p.id)) {
            teammateMap.set(p.id, {
              playerId: p.id,
              name: p.name || p.id,
              matchesTogether: 0,
              winsTogether: 0
            });
          }
          const agg = teammateMap.get(p.id)!;
          agg.matchesTogether++;
          if (res === 'W') agg.winsTogether++;
        });

        oppTeam.forEach(p => {
          if (!rivalMap.has(p.id)) {
            rivalMap.set(p.id, {
              playerId: p.id,
              name: p.name || p.id,
              matchesAgainst: 0,
              lossesAgainst: 0
            });
          }
          const agg = rivalMap.get(p.id)!;
          agg.matchesAgainst++;
          if (res === 'L') agg.lossesAgainst++;
        });
      });

      const teammateArr = [...teammateMap.values()].filter(t => t.matchesTogether > 0);
      const rivalArr = [...rivalMap.values()].filter(r => r.matchesAgainst > 0);

      const bestPairing = teammateArr
        .sort((a, b) => {
          if (b.winsTogether !== a.winsTogether) return b.winsTogether - a.winsTogether;
          const wrA = a.matchesTogether ? a.winsTogether / a.matchesTogether : 0;
          const wrB = b.matchesTogether ? b.winsTogether / b.matchesTogether : 0;
          if (wrB !== wrA) return wrB - wrA;
          return b.matchesTogether - a.matchesTogether;
        })[0] || null;

      const toughestRival = rivalArr
        .sort((a, b) => {
          if (b.lossesAgainst !== a.lossesAgainst) return b.lossesAgainst - a.lossesAgainst;
          const lrA = a.matchesAgainst ? a.lossesAgainst / a.matchesAgainst : 0;
            const lrB = b.matchesAgainst ? b.lossesAgainst / b.matchesAgainst : 0;
          if (lrB !== lrA) return lrB - lrA;
          return b.matchesAgainst - a.matchesAgainst;
        })[0] || null;

      return {
        leagueId: bucket.leagueId,
        leagueName: bucket.leagueName || null,
        participatedMatches: participated,
        bestPairing: bestPairing && {
          ...bestPairing,
          winRate: +(bestPairing.winsTogether / Math.max(1, bestPairing.matchesTogether) * 100).toFixed(2)
        },
        toughestRival: toughestRival && {
          ...toughestRival,
          lossRate: +(toughestRival.lossesAgainst / Math.max(1, toughestRival.matchesAgainst) * 100).toFixed(2)
        }
      };
    };

    if (leagueId) {
      const bucket = leagueBuckets.get(String(leagueId));
      const single = bucket ? buildLeagueSynergy(bucket) : {
        leagueId: String(leagueId),
        leagueName: null,
        participatedMatches: 0,
        bestPairing: null,
        toughestRival: null
      };
      const payload = {
        playerId,
        leagueId: single.leagueId,
        participatedMatches: single.participatedMatches,
        bestPairing: single.bestPairing,
        toughestRival: single.toughestRival,
        generatedAt: new Date().toISOString()
      };
      inMemorySynergyCache.set(cacheKey, { data: payload, ts: Date.now() });
      ctx.body = payload;
      return;
    }

    // All leagues
    const leagues = [...leagueBuckets.values()].map(buildLeagueSynergy).filter(l => l.participatedMatches > 0);
    const response = {
      playerId,
      leagues,
      generatedAt: new Date().toISOString()
    };
    inMemorySynergyCache.set(cacheKey, { data: response, ts: Date.now() });
    ctx.body = response;

  } catch (err) {
    console.error('Synergy league logic error', err);
    ctx.status = 500;
    ctx.body = { error: 'Internal error computing league synergy' };
  }
});

export default router;