import Router from 'koa-router';
import authRouter from './auth';
import { Context } from 'koa';

const router = new Router();

// Mount auth routes
router.use('/auth', authRouter.routes());

// Root route
router.get('/', async (ctx: Context) => {
    ctx.body = {
        message: 'Welcome to Champion Footballer API',
        version: '1.0.0',
        status: 'running'
    };
});

export default router; 