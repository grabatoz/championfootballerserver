import { Context } from 'koa';
import models from '../models';
import { Op, fn, col, literal, QueryTypes } from 'sequelize';
import cache from '../utils/cache';
import sequelize from '../config/database';

const METRIC_MAP: Record<string, string> = {
  goals: 'goals',
  assists: 'assists',
  defence: 'defence',
  motm: 'motm',
  impact: 'impact',
  contribution: 'impact',
  cleanSheet: 'clean_sheets'
};

const NON_GUEST_PROVIDER_WHERE = {
  [Op.or]: [
    { provider: { [Op.ne]: 'guest' } },
    { provider: { [Op.is]: null } },
    { provider: '' }
  ]
};

const clampPercentage = (value: number): number => Math.max(0, Math.min(100, Math.round(value)));

const resolveTeamResult = (params: {
  isHome: boolean;
  isAway: boolean;
  homeGoals: number;
  awayGoals: number;
}): 'win' | 'draw' | 'lose' => {
  const { isHome, isAway, homeGoals, awayGoals } = params;
  if (homeGoals === awayGoals) return 'draw';
  if (isHome) return homeGoals > awayGoals ? 'win' : 'lose';
  if (isAway) return awayGoals > homeGoals ? 'win' : 'lose';
  return 'lose';
};

export const getLeaderboard = async (ctx: Context) => {
  const metric = (ctx.query.metric as string) || 'goals';
  let leagueId = ctx.query.leagueId as string | undefined;
  let seasonId = ctx.query.seasonId as string | undefined;
  const positionType = ctx.query.positionType as string | undefined;
  const requestedLimitRaw = Number(ctx.query.limit);
  const topLimit = Number.isFinite(requestedLimitRaw) && requestedLimitRaw > 0
    ? Math.min(Math.floor(requestedLimitRaw), 50)
    : 5;
  const fetchLimit = Math.max(topLimit * 20, 50);

  // Sanitize leagueId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (typeof leagueId === 'string') {
    leagueId = leagueId.trim();
    if (leagueId.length === 0) leagueId = undefined;
  }
  if (leagueId && !uuidRegex.test(leagueId)) {
    ctx.status = 400;
    ctx.body = { players: [], message: 'Invalid leagueId format.' };
    return;
  }

  // Sanitize seasonId
  if (typeof seasonId === 'string') {
    seasonId = seasonId.trim();
    if (seasonId.length === 0) seasonId = undefined;
  }
  if (seasonId && !uuidRegex.test(seasonId)) {
    ctx.status = 400;
    ctx.body = { players: [], message: 'Invalid seasonId format.' };
    return;
  }

  const cacheKey = `leaderboard_${metric}_${leagueId || 'all'}_${seasonId || 'all'}_${positionType || 'all'}_${topLimit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }
  
  ctx.set('X-Cache', 'MISS');

  try {
    // MOTM: aggregate from Vote model
    if (metric === 'motm' && leagueId) {
      const matchWhere: any = { leagueId };
      if (seasonId) matchWhere.seasonId = seasonId;
      
      const voteInclude: any[] = [
        {
          model: models.Match,
          as: 'votedMatch',
          where: matchWhere,
          attributes: []
        }
      ];

      const votesGrouped = await models.Vote.findAll({
        attributes: [
          'votedForId',
          [fn('COUNT', col('Vote.votedForId')), 'count']
        ],
        include: voteInclude,
        group: ['Vote.votedForId'],
        order: [[literal('count'), 'DESC']],
        limit: fetchLimit,
        raw: true
      });

      const playerIds = [...new Set(votesGrouped.map((v: any) => v.votedForId))];
      const users = await models.User.findAll({
        where: {
          id: playerIds,
          ...NON_GUEST_PROVIDER_WHERE
        },
        attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType']
      });

      const userMap = new Map(users.map(u => [u.id, u]));
      const players = votesGrouped
        .map((v: any) => {
          const user = userMap.get(v.votedForId);
          if (!user) return null;
          return {
            id: v.votedForId,
            name: `${user.firstName} ${user.lastName}`,
            profilePicture: user.profilePicture,
            position: user.position,
            positionType: user.positionType,
            value: parseInt(v.count as string, 10) || 0
          };
        })
        .filter(Boolean)
        .slice(0, topLimit);

      const result = { players };
      cache.set(cacheKey, result, 1800);
      ctx.body = result;
      return;
    }

    // CONTRIBUTION INDEX %:
    // Dev notes formula per match:
    // - Goals share baseline = 100%
    // - Assists share = 50%
    // - Clean sheet = 15%
    // - Defensive impact count = 10% each
    // - +Mentality captain pick = 5%
    // - No action participation fallback (15% winner/draw, 10% loser)
    // - Cap each match at 100%
    if (metric === 'contribution' && leagueId) {
      const matchWhere: any = {
        leagueId,
        status: 'RESULT_PUBLISHED'
      };
      if (seasonId) matchWhere.seasonId = seasonId;

      const matches = await models.Match.findAll({
        where: matchWhere,
        attributes: [
          'id',
          'homeTeamGoals',
          'awayTeamGoals',
          'homeMentalityId',
          'awayMentalityId'
        ],
        raw: true
      }) as Array<{
        id: string;
        homeTeamGoals: number | null;
        awayTeamGoals: number | null;
        homeMentalityId: string | null;
        awayMentalityId: string | null;
      }>;

      if (!matches.length) {
        const result = { players: [] as any[] };
        cache.set(cacheKey, result, 1800);
        ctx.body = result;
        return;
      }

      const matchIds = matches
        .map((m) => String(m.id || '').trim())
        .filter((id) => id.length > 0);

      if (!matchIds.length) {
        const result = { players: [] as any[] };
        cache.set(cacheKey, result, 1800);
        ctx.body = result;
        return;
      }

      const statsRows = await models.MatchStatistics.findAll({
        where: {
          match_id: { [Op.in]: matchIds }
        },
        attributes: ['match_id', 'user_id', 'goals', 'assists', 'cleanSheets', 'defence'],
        raw: true
      }) as Array<{
        match_id: string;
        user_id: string;
        goals: number | null;
        assists: number | null;
        cleanSheets: number | null;
        defence: number | null;
      }>;

      if (!statsRows.length) {
        const result = { players: [] as any[] };
        cache.set(cacheKey, result, 1800);
        ctx.body = result;
        return;
      }

      const homeTeamRows = await sequelize.query<{ matchId: string; userId: string }>(
        `SELECT "matchId" as "matchId", "userId" as "userId" FROM "UserHomeMatches" WHERE "matchId" = ANY($1::uuid[])`,
        { bind: [matchIds], type: QueryTypes.SELECT }
      );
      const awayTeamRows = await sequelize.query<{ matchId: string; userId: string }>(
        `SELECT "matchId" as "matchId", "userId" as "userId" FROM "UserAwayMatches" WHERE "matchId" = ANY($1::uuid[])`,
        { bind: [matchIds], type: QueryTypes.SELECT }
      );

      const matchMeta = new Map<string, {
        homeGoals: number;
        awayGoals: number;
        homeMentalityId: string;
        awayMentalityId: string;
      }>();
      matches.forEach((match) => {
        const id = String(match.id || '').trim();
        if (!id) return;
        matchMeta.set(id, {
          homeGoals: Math.max(0, Number(match.homeTeamGoals) || 0),
          awayGoals: Math.max(0, Number(match.awayTeamGoals) || 0),
          homeMentalityId: String(match.homeMentalityId || '').trim(),
          awayMentalityId: String(match.awayMentalityId || '').trim()
        });
      });

      const homeTeamMap = new Map<string, Set<string>>();
      const awayTeamMap = new Map<string, Set<string>>();
      homeTeamRows.forEach((row) => {
        const mId = String(row.matchId || '').trim();
        const uId = String(row.userId || '').trim();
        if (!mId || !uId) return;
        if (!homeTeamMap.has(mId)) homeTeamMap.set(mId, new Set<string>());
        homeTeamMap.get(mId)?.add(uId);
      });
      awayTeamRows.forEach((row) => {
        const mId = String(row.matchId || '').trim();
        const uId = String(row.userId || '').trim();
        if (!mId || !uId) return;
        if (!awayTeamMap.has(mId)) awayTeamMap.set(mId, new Set<string>());
        awayTeamMap.get(mId)?.add(uId);
      });

      const contributionByPlayer = new Map<string, { total: number; matches: number }>();

      statsRows.forEach((row) => {
        const matchId = String(row.match_id || '').trim();
        const playerId = String(row.user_id || '').trim();
        if (!matchId || !playerId) return;

        const meta = matchMeta.get(matchId);
        if (!meta) return;

        const homeSet = homeTeamMap.get(matchId) || new Set<string>();
        const awaySet = awayTeamMap.get(matchId) || new Set<string>();
        const isHome = homeSet.has(playerId);
        const isAway = awaySet.has(playerId);

        const safeGoals = Math.max(0, Number(row.goals) || 0);
        const safeAssists = Math.max(0, Number(row.assists) || 0);
        const safeCleanSheets = Math.max(0, Number(row.cleanSheets) || 0);
        const safeDefence = Math.max(0, Number(row.defence) || 0);
        const totalGoalsInMatch = Math.max(0, meta.homeGoals + meta.awayGoals);

        const goalContribution = totalGoalsInMatch > 0 ? (safeGoals / totalGoalsInMatch) * 100 : 0;
        const assistContribution = totalGoalsInMatch > 0 ? (safeAssists / totalGoalsInMatch) * 50 : 0;
        const cleanSheetContribution = safeCleanSheets > 0 ? 15 * safeCleanSheets : 0;
        const defensiveContribution = safeDefence * 10;
        const isMentalityPick = playerId === meta.homeMentalityId || playerId === meta.awayMentalityId;
        const mentalityContribution = isMentalityPick ? 5 : 0;

        const rawContribution =
          goalContribution +
          assistContribution +
          cleanSheetContribution +
          defensiveContribution +
          mentalityContribution;

        const teamResult = resolveTeamResult({
          isHome,
          isAway,
          homeGoals: meta.homeGoals,
          awayGoals: meta.awayGoals
        });
        const defaultParticipation = teamResult === 'lose' ? 10 : 15;
        const matchContribution = clampPercentage(
          rawContribution > 0 ? rawContribution : defaultParticipation
        );

        const previous = contributionByPlayer.get(playerId) || { total: 0, matches: 0 };
        contributionByPlayer.set(playerId, {
          total: previous.total + matchContribution,
          matches: previous.matches + 1
        });
      });

      const playerIds = [...contributionByPlayer.keys()];
      const users = await models.User.findAll({
        where: {
          id: playerIds,
          ...NON_GUEST_PROVIDER_WHERE,
          ...(positionType && { positionType })
        },
        attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType']
      });

      const userMap = new Map(users.map((u) => [u.id, u]));
      const players = playerIds
        .map((playerId) => {
          const aggregate = contributionByPlayer.get(playerId);
          const user = userMap.get(playerId);
          if (!aggregate || !user) return null;
          if (positionType && user.positionType !== positionType) return null;

          const avgContribution = aggregate.matches > 0
            ? aggregate.total / aggregate.matches
            : 0;

          return {
            id: playerId,
            name: `${user.firstName} ${user.lastName}`,
            profilePicture: user.profilePicture,
            position: user.position,
            positionType: user.positionType,
            value: clampPercentage(avgContribution)
          };
        })
        .filter((player): player is {
          id: string;
          name: string;
          profilePicture: string;
          position: string;
          positionType: string;
          value: number;
        } => player !== null)
        .sort((a, b) => {
          if (b.value !== a.value) return b.value - a.value;
          return String(a.id).localeCompare(String(b.id));
        })
        .slice(0, topLimit);

      const result = { players };
      cache.set(cacheKey, result, 1800);
      ctx.body = result;
      return;
    }

    // DEFENSIVE HERO VOTES: Count captain picks from Match table (homeDefensiveImpactId & awayDefensiveImpactId)
    if (metric === 'impact' && leagueId) {
      const matchWhere: any = { 
        leagueId, 
        status: 'RESULT_PUBLISHED',
        [Op.or]: [
          { homeDefensiveImpactId: { [Op.ne]: null } },
          { awayDefensiveImpactId: { [Op.ne]: null } }
        ]
      };
      if (seasonId) matchWhere.seasonId = seasonId;

      // Get all matches with defensive impact picks
      const matches = await models.Match.findAll({
        where: matchWhere,
        attributes: ['homeDefensiveImpactId', 'awayDefensiveImpactId'],
        raw: true
      });

      // Count how many times each player was picked
      const playerCounts: Record<string, number> = {};
      matches.forEach((m: any) => {
        if (m.homeDefensiveImpactId) {
          playerCounts[m.homeDefensiveImpactId] = (playerCounts[m.homeDefensiveImpactId] || 0) + 1;
        }
        if (m.awayDefensiveImpactId) {
          playerCounts[m.awayDefensiveImpactId] = (playerCounts[m.awayDefensiveImpactId] || 0) + 1;
        }
      });

      // Sort by count
      const sortedPlayers = Object.entries(playerCounts)
        .sort((a, b) => b[1] - a[1]);

      const candidatePlayers = sortedPlayers.slice(0, fetchLimit);
      const playerIds = candidatePlayers.map(([id]) => id);
      const users = await models.User.findAll({
        where: {
          id: playerIds,
          ...NON_GUEST_PROVIDER_WHERE
        },
        attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType']
      });

      const userMap = new Map(users.map(u => [u.id, u]));
      const players = candidatePlayers
        .map(([playerId, count]) => {
          const user = userMap.get(playerId);
          if (!user) return null;
          return {
            id: playerId,
            name: `${user.firstName} ${user.lastName}`,
            profilePicture: user.profilePicture,
            position: user.position,
            positionType: user.positionType,
            value: count
          };
        })
        .filter(Boolean)
        .slice(0, topLimit);

      const result = { players };
      cache.set(cacheKey, result, 1800);
      ctx.body = result;
      return;
    }

    // Standard metrics from MatchStatistics
    const dbColumn = METRIC_MAP[metric] || 'goals';
    const matchWhere: any = { status: 'RESULT_PUBLISHED' };
    if (leagueId) matchWhere.leagueId = leagueId;
    if (seasonId) matchWhere.seasonId = seasonId;

    const statsGrouped = await models.MatchStatistics.findAll({
      attributes: [
        ['user_id', 'userId'],
        [fn('SUM', col(dbColumn)), 'total']
      ],
      include: [
        {
          model: models.Match,
          as: 'match',
          where: matchWhere,
          attributes: []
        }
      ],
      group: ['MatchStatistics.user_id'],
      order: [[literal('total'), 'DESC']],
      limit: fetchLimit,
      raw: true
    });

    const playerIds = [...new Set(statsGrouped.map((s: any) => s.userId || s.user_id))];
    const users = await models.User.findAll({
      where: {
        id: playerIds,
        ...NON_GUEST_PROVIDER_WHERE,
        ...(positionType && { positionType })
      },
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType']
    });

    const userMap = new Map(users.map(u => [u.id, u]));
    const players = statsGrouped
      .map((s: any) => {
        const odUserId = s.userId || s.user_id;
        const user = userMap.get(odUserId);
        if (!user) return null;
        if (positionType && user.positionType !== positionType) return null;
        return {
          id: odUserId,
          name: `${user.firstName} ${user.lastName}`,
          profilePicture: user.profilePicture,
          position: user.position,
          positionType: user.positionType,
          value: parseInt(s.total as string, 10) || 0
        };
      })
      .filter(Boolean)
      .slice(0, topLimit);

    const result = { players };
    cache.set(cacheKey, result, 1800);
    ctx.body = result;
  } catch (error) {
    console.error('Leaderboard error:', error);
    ctx.status = 500;
    ctx.body = { players: [], message: 'Internal server error' };
  }
};
