import Router from '@koa/router';
import type Koa from 'koa';
import { realtime } from '../services/realtime';
import { none } from '../modules/auth';

const router = new Router();

// Server-Sent Events endpoint - NO AUTH REQUIRED
router.get('/events', none, async (ctx: Koa.Context) => {
  // CORS
  const origin = ctx.request.header.origin || '*';
  ctx.set('Access-Control-Allow-Origin', origin);
  ctx.set('Vary', 'Origin');
  ctx.set('Access-Control-Allow-Credentials', 'true');

  // SSE headers
  ctx.set('Content-Type', 'text/event-stream');
  ctx.set('Cache-Control', 'no-cache');
  ctx.set('X-Accel-Buffering', 'no');
  ctx.set('Cache-Control', 'no-transform');
  ctx.set('Connection', 'keep-alive');

  console.log('📡 SSE Client connected');

  // Take over low-level response
  ctx.status = 200;
  // @ts-ignore Koa types allow this in Node env
  ctx.respond = false;

  const res = ctx.res;
  const id = realtime.addClient(res);

  // Send a retry suggestion to EventSource (ms)
  try { res.write(`retry: 5000\n\n`); } catch {}

  // Cleanup on close
  const onClose = () => {
    console.log('📡 SSE Client disconnected:', id);
    realtime.removeClient(id);
  };
  res.on('close', onClose);
  res.on('finish', onClose);
});

export default router;