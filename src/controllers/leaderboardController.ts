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

  const cacheKey = `leaderboard_${metric}_${leagueId || 'all'}_${positionType || 'all'}`;
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
      const voteInclude: any[] = [
        {
          model: models.Match,
          as: 'votedMatch',
          where: { leagueId },
          attributes: []
        }
      ];

      const votesGrouped = await models.Vote.findAll({
        attributes: [
          'votedForId',
          [fn('COUNT', col('votedForId')), 'count']
        ],
        include: voteInclude,
        group: ['votedForId', 'Vote.id'],
        order: [[literal('count'), 'DESC']],
        limit: 10,
        raw: false
      });

      const playerIds = votesGrouped.map((v: any) => v.votedForId);
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
          value: parseInt(v.get('count') as string, 10)
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
      group: ['user_id', 'MatchStatistics.id'],
      order: [[literal('total'), 'DESC']],
      limit: 10,
      raw: false
    });

    const playerIds = statsGrouped.map((s: any) => s.get('userId') || s.user_id);
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
        const odUserId = s.get('userId') || s.user_id;
        const user = userMap.get(odUserId);
        if (!user) return null;
        if (positionType && user.positionType !== positionType) return null;
        return {
          id: odUserId,
          name: `${user.firstName} ${user.lastName}`,
          profilePicture: user.profilePicture,
          position: user.position,
          positionType: user.positionType,
          value: parseInt(s.get('total') as string, 10) || 0
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
