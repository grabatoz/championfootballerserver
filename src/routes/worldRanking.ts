import Router from '@koa/router';
import { getWorldRanking } from '../controllers/worldRankingController';

const router = new Router({ prefix: '/world-ranking' });

// Get world ranking - top players globally by XP
router.get('/', getWorldRanking);
router.get('', getWorldRanking);

export default router;
