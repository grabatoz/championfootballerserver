import { Context } from 'koa';
import models from '../models';
import { Op, fn, col, literal } from 'sequelize';
import cache from '../utils/cache';

const METRIC_MAP: Record<string, string> = {
  goals: 'goals',
  assists: 'assists',
  defence: 'defence',
  motm: 'motm',
  impact: 'impact',
  cleanSheet: 'clean_sheets'
};

export const getLeaderboard = async (ctx: Context) => {
  const metric = (ctx.query.metric as string) || 'goals';
  let leagueId = ctx.query.leagueId as string | undefined;
  let seasonId = ctx.query.seasonId as string | undefined;
  const positionType = ctx.query.positionType as string | undefined;

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

  const cacheKey = `leaderboard_${metric}_${leagueId || 'all'}_${seasonId || 'all'}_${positionType || 'all'}`;
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
        limit: 5,
        raw: true
      });

      const playerIds = [...new Set(votesGrouped.map((v: any) => v.votedForId))];
      const users = await models.User.findAll({
        where: { id: playerIds },
        attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType']
      });

      const userMap = new Map(users.map(u => [u.id, u]));
      const players = votesGrouped.map((v: any) => {
        const user = userMap.get(v.votedForId);
        return {
          id: v.votedForId,
          name: user ? `${user.firstName} ${user.lastName}` : 'Unknown',
          profilePicture: user?.profilePicture,
          position: user?.position,
          positionType: user?.positionType,
          value: parseInt(v.count as string, 10) || 0
        };
      });

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

      // Sort by count and get top 5
      const sortedPlayers = Object.entries(playerCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      const playerIds = sortedPlayers.map(([id]) => id);
      const users = await models.User.findAll({
        where: { id: playerIds },
        attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'position', 'positionType']
      });

      const userMap = new Map(users.map(u => [u.id, u]));
      const players = sortedPlayers.map(([playerId, count]) => {
        const user = userMap.get(playerId);
        return {
          id: playerId,
          name: user ? `${user.firstName} ${user.lastName}` : 'Unknown',
          profilePicture: user?.profilePicture,
          position: user?.position,
          positionType: user?.positionType,
          value: count
        };
      });

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
      limit: 5,
      raw: true
    });

    const playerIds = [...new Set(statsGrouped.map((s: any) => s.userId || s.user_id))];
    const users = await models.User.findAll({
      where: {
        id: playerIds,
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
      .filter(Boolean);

    const result = { players };
    cache.set(cacheKey, result, 1800);
    ctx.body = result;
  } catch (error) {
    console.error('Leaderboard error:', error);
    ctx.status = 500;
    ctx.body = { players: [], message: 'Internal server error' };
  }
};
