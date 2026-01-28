import Router from '@koa/router';
import { required } from '../modules/auth';
import { getDreamTeam } from '../controllers/dreamTeamController';

const router = new Router({ prefix: '/dream-team' });

// Get dream team - best players by position
router.get('/', required, getDreamTeam);

export default router; 