import Router from '@koa/router';
import { getLeaderboard } from '../controllers/leaderboardController';

const router = new Router({ prefix: '/leaderboard' });

// Get leaderboard by metric
router.get('/', getLeaderboard);

export default router; 