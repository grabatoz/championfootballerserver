import Router from '@koa/router';
import models from '../models';
import cache from '../utils/cache';
import { Op, literal, fn, col } from 'sequelize';

// World Ranking: top 1000 players globally by XP + ability to jump to a specific player's row
// Query params:
//   mode=avg|total (default total) - avg = mean XP per match, total = accumulated xp field on user
//   playerId=<uuid> (optional) - if provided and player outside top 1000, include that row appended
//   limit=<number> (optional, default 1000, max 1000)
//   positionType=<string> (optional filter)
//   country=<string> (optional future filter placeholder, not yet stored)
//   year=<number> (optional year filter: matches finished in that calendar year for avg calc)
//   weekEnding=<ISO date> (optional week ending filter for potential future expansions - currently ignored)

const router = new Router({ prefix: '/world-ranking' });

// Unified handler so we can mount both with and without trailing slash
async function handleGetWorldRanking(ctx: any) {
  const mode = (ctx.query.mode as string) === 'avg' ? 'avg' : 'total';
  const playerId = ctx.query.playerId as string | undefined;
  const positionType = ctx.query.positionType as string | undefined;
  const year = ctx.query.year ? Number(ctx.query.year) : undefined;
  // Allow large lists: default to a high limit if not provided; cap for safety
  const requestedLimit = ctx.query.limit ? Number(ctx.query.limit) : undefined;
  const limit = requestedLimit && Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 100000)
    : 100000;

  const cacheKey = `world_rank_${mode}_${positionType || 'all'}_${year || 'all'}_${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && !playerId) { // SPEED: always use cache when possible
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }
  
  ctx.set('X-Cache', 'MISS');

  // Build base where for user filter by positionType
  const userWhere: any = {};
  if (positionType) userWhere.positionType = positionType;

  // Fetch all users (or filtered by positionType). Include even XP=0 so everyone appears.
  const users = await models.User.findAll({
    attributes: ['id','firstName','lastName','position','positionType','profilePicture','xp'],
    where: {
      ...(positionType ? { positionType } : {}),
    },
    // Order by total XP; final ranking may re-sort depending on mode
    order: [['xp', 'DESC']],
  });

  // Aggregate match counts per user (fast GROUP BY). Filter by year if provided.
  const matchStats = await models.MatchStatistics.findAll({
    attributes: [
      'user_id',
      [fn('COUNT', col('MatchStatistics.user_id')), 'matches']
    ],
    include: [
      {
        model: models.Match,
        as: 'match',
        attributes: [],
        required: true,
        ...(year ? { where: { date: { [Op.gte]: new Date(`${year}-01-01`), [Op.lt]: new Date(`${year + 1}-01-01`) } } } : {})
      }
    ],
    group: ['MatchStatistics.user_id']
  });
  const matchCount: Record<string, number> = {};
  matchStats.forEach((ms: any) => {
    const uid = ms.user_id;
    const count = Number(ms.get ? ms.get('matches') : (ms as any).matches) || 0;
    matchCount[uid] = count;
  });

  interface RankRow {
    id: string; name: string; position: string; positionType: string; profilePicture: string; totalXP: number; avgXP: number; matches: number; rank?: number;
  }
  const rows: RankRow[] = users.map(u => {
    const totalXP = (u as any).xp || 0;
    const matches = matchCount[(u as any).id] || 0;
    const avgXP = matches > 0 ? totalXP / matches : 0;
    return {
      id: (u as any).id,
      name: `${(u as any).firstName} ${(u as any).lastName}`.trim(),
      position: (u as any).position || '',
      positionType: (u as any).positionType || '',
      profilePicture: (u as any).profilePicture || '',
      totalXP,
      avgXP: Number(avgXP.toFixed(2)),
      matches
    };
  });

  rows.sort((a,b)=>{
    if (mode === 'avg') return b.avgXP - a.avgXP || b.totalXP - a.totalXP;
    return b.totalXP - a.totalXP || b.avgXP - a.avgXP;
  });

  // Assign ranks
  rows.forEach((r,i)=>{ r.rank = i + 1; });

  let top = rows.slice(0, limit);

  let playerRow: any = null;
  if (playerId) {
    playerRow = rows.find(r=> r.id === playerId);
    if (playerRow && playerRow.rank > limit) {
      top = [...top, playerRow];
    }
  }

  const result = {
    players: top.map(r=>({
      id: r.id,
      name: r.name,
      position: r.position,
      positionType: r.positionType,
      profilePicture: r.profilePicture,
      totalXP: r.totalXP,
      avgXP: r.avgXP,
      matches: r.matches,
      rank: r.rank
    })),
    mode,
    limit,
    playerOutsideTop: playerRow ? playerRow.rank > limit : false,
    playerRank: playerRow ? playerRow.rank : undefined
  };

  if (!playerId) cache.set(cacheKey, result, 1800); // 30 min cache for MAXIMUM speed

  ctx.body = result;
}

// Support both /world-ranking and /world-ranking/ paths
router.get('/', handleGetWorldRanking);
router.get('', handleGetWorldRanking);

export default router;
