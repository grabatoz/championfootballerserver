import Koa from 'koa';
import { triggerImmediateXPCalculation } from './utils/xpAchievementsEngine';

const app = new Koa();

// Manual XP calculation endpoint
app.use(async (ctx: Koa.Context, next: Koa.Next) => {
  if (ctx.path === '/api/trigger-xp-calculation' && ctx.method === 'POST') {
    await triggerImmediateXPCalculation();
    ctx.body = { success: true, message: 'XP calculation triggered' };
    return;
  }
  await next();
});

export default app; 