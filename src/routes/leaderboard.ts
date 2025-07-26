import Router from '@koa/router';
import models from '../models';
import { Op, fn, col, literal } from 'sequelize';
import cache from '../utils/cache';

const router = new Router({ prefix: '/leaderboard' });

const METRIC_MAP: Record<string, string> = {
  goals: 'goals',
  assists: 'assists',
  defence: 'defence', // Use penalties for defence
  motm: 'motm',         // Custom logic below
  impact: 'impact',  // Use free_kicks for impact (snake_case)
  cleanSheet: 'clean_sheets' // Use clean_sheets (snake_case)
};

router.get('/', async (ctx) => {
  const metric = (ctx.query.metric as string) || 'goals';
  const leagueId = ctx.query.leagueId as string | undefined;
  const positionType = ctx.query.positionType as string | undefined;
  const cacheKey = `leaderboard_${metric}_${leagueId || 'all'}_${positionType || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.body = cached;
    return;
  }

  // MOTM: aggregate from Vote model, filter by league
  if (metric === 'motm' && leagueId) {
    // Join Vote -> Match (as 'votedMatch') -> filter by leagueId
    const voteInclude: any[] = [
      {
        model: models.Match,
        as: 'votedMatch',
        attributes: [],
        where: { leagueId },
        required: true
      },
      {
        model: models.User,
        as: 'votedFor',
        attributes: ['id', 'firstName', 'lastName', 'positionType', 'profilePicture'],
        ...(positionType ? { where: { positionType } } : {})
      }
    ];
    const votes = await models.Vote.findAll({
      attributes: [
        'votedForId',
        [fn('COUNT', col('Vote.id')), 'voteCount']
      ],
      include: voteInclude,
      group: ['votedForId', 'votedFor.id'],
      order: [[fn('COUNT', col('Vote.id')), 'DESC']],
      limit: 5
    });
    const players = votes.map((vote: any) => ({
      id: vote.votedFor.id,
      name: `${vote.votedFor.firstName} ${vote.votedFor.lastName}`,
      positionType: vote.votedFor.positionType,
      profilePicture: vote.votedFor.profilePicture,
      value: vote.get('voteCount')
    }));
    ctx.body = { players: players || [] };
    return;
  }

  // Other metrics: aggregate from MatchStatistics, filter by league and positionType
  const include: any[] = [
    {
      model: models.User,
      as: 'user',
      attributes: ['id', 'firstName', 'lastName', 'positionType', 'profilePicture'],
      ...(positionType ? { where: { positionType } } : {})
    }
  ];
  if (leagueId) {
    include.push({
      model: models.Match,
      as: 'match',
      attributes: [],
      where: { leagueId },
      required: true
    });
  }

  const stats = await models.MatchStatistics.findAll({
    attributes: [
      'user_id',
      [fn('SUM', col(METRIC_MAP[metric] || 'goals')), 'value']
    ],
    group: ['user_id', 'user.id'],
    order: [[literal('value'), 'DESC']],
    limit: 5,
    include
  });

  const players = stats.map((stat: any) => ({
    id: stat.user.id,
    name: `${stat.user.firstName} ${stat.user.lastName}`,
    positionType: stat.user.positionType,
    profilePicture: stat.user.profilePicture,
    value: stat.get('value')
  }));

  // Only show message if all players' value for the selected metric is zero (and there is at least one player)
  const allZero = players.length > 0 && players.every(p => !p.value || Number(p.value) === 0);

  const result = {
    players,
    message: allZero ? 'Abhi kisi user ko assign nahi hua.' : undefined
  };
  cache.set(cacheKey, result, 600); // cache for 30 seconds
  ctx.body = result;
});

export default router; 