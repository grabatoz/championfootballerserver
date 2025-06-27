import Router from '@koa/router';
import authRouter from './auth';
import usersRouter from './users';
import matchesRouter from './matches';
import leaguesRouter from './leagues';
import profileRouter from './profile';
import { Context } from 'koa';

const router = new Router();

// Mount auth routes
router.use(authRouter.routes(), authRouter.allowedMethods());
router.use(usersRouter.routes(), usersRouter.allowedMethods());
router.use(matchesRouter.routes(), matchesRouter.allowedMethods());
router.use(leaguesRouter.routes(), leaguesRouter.allowedMethods());
router.use(profileRouter.routes(), profileRouter.allowedMethods());

// Root route
router.get('/', async (ctx: Context) => {
    ctx.body = {
        message: 'Welcome to Champion Footballer API',
        version: '1.0.0',
        status: 'running'
    };
});

export default router; 