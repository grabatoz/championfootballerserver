// Dependencies: server
import Koa from "koa"
const app = new Koa()
import koaBody from "koa-body"
import router from "./routes"
import worldRankingRouter from './routes/worldRanking'
import cors from '@koa/cors';
import serve from 'koa-static';
import path from 'path';
import mount from 'koa-mount';
import { triggerImmediateXPCalculation } from './utils/xpAchievementsEngine';
import bodyParser from 'koa-bodyparser';
import { initializeDatabase } from './config/database'; // Import sequelize too
import './models'; // Initialize models and associations

// Import additional routes
import authRoutes from './routes/auth';
import matchRoutes from './routes/matches';
import leagueRoutes from './routes/leagues';
import notificationRoutes from './routes/notifications';
import userRoutes from './routes/users';
import Router from '@koa/router';
import { setupPassport } from './config/passport';
import passport from 'koa-passport';
import socialAuthRouter from './routes/auth/social';
import socialRoutes from './routes/auth/social';

// CORS configuration for both development and production
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://192.168.18.102:3000',
  'https://championfootballer-client.vercel.app',
  'https://championfootballer-client-git-main-championfootballer.vercel.app',
  'https://championfootballer-client-championfootballer.vercel.app'
];

app.use(cors({
  origin: process.env.CLIENT_URL || '*',
  allowHeaders: ['Authorization', 'Content-Type'],
  exposeHeaders: ['X-Cache'],
  credentials: true,
  allowMethods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

// Root route for health check and CORS
app.use(async (ctx, next) => {
  if (ctx.path === '/' && ctx.method === 'GET') {
    ctx.set('Access-Control-Allow-Origin', '*');
    ctx.set('Access-Control-Allow-Credentials', 'true');
    ctx.body = { 
      status: 'ok', 
      message: 'ChampionFootballer API root',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    };
    return;
  }
  await next();
});

// Manual XP calculation endpoint
app.use(async (ctx: Koa.Context, next: Koa.Next) => {
  if (ctx.path === '/api/trigger-xp-calculation' && ctx.method === 'POST') {
    await triggerImmediateXPCalculation();
    ctx.body = { success: true, message: 'XP calculation triggered' };
    return;
  }
  await next();
});

// Body parser: skip multipart so multer (upload.fields) can read the stream
app.use(async (ctx, next) => {
  const ct = String(ctx.get('content-type') || '');
  if (/multipart\/form-data/i.test(ct)) {
    return next(); // let route's multer handle multipart (POST/PATCH/PUT)
  }
  return koaBody({
    multipart: false,
    json: true,
    urlencoded: true,
    text: false,
    jsonLimit: '5mb', // Reduced for speed
    formLimit: '5mb'  // Reduced for speed
  })(ctx, next);
});

app.use(mount('/uploads', serve(path.resolve(process.cwd(), 'uploads'))));

// Always send CORS headers on 404 responses
app.use(async (ctx, next) => {
  await next();
  if (ctx.status === 404) {
    const origin = ctx.request.header.origin;
    if (origin && allowedOrigins.includes(origin)) {
      ctx.set('Access-Control-Allow-Origin', origin);
    } else {
      ctx.set('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
    ctx.set('Access-Control-Allow-Credentials', 'true');
  }
});

// Client error handling with performance timing
app.use(async (ctx, next) => {
  const start = Date.now()
  try {
    await next()
    // Add cache headers for static content
    if (ctx.path.includes('/uploads/') || ctx.path.includes('.css') || ctx.path.includes('.js')) {
      ctx.set('Cache-Control', 'public, max-age=31536000'); // 1 year for static assets
    }
  } catch (error: any) {
    console.error('Request error:', error);
    
    // Set CORS headers even on error
    const origin = ctx.request.header.origin;
    if (origin && allowedOrigins.includes(origin)) {
      ctx.set('Access-Control-Allow-Origin', origin);
    } else {
      ctx.set('Access-Control-Allow-Origin', allowedOrigins[0]);
    }
    ctx.set('Access-Control-Allow-Credentials', 'true');
    
    // If there isn't a status, set it to 500 with default message
    if (error.status) {
      ctx.response.status = error.status
    } else {
      ctx.response.status = 500
      ctx.response.body = {
        message: "Something went wrong. Please contact support.",
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      }
    }

    // If error message needs to be exposed, send it to client. Else, hide it from client and log it to us
    if (error.expose) {
      ctx.response.body = { message: error.message }
    } else {
      ctx.app.emit("error", error, ctx)
    }
  } finally {
    const ms = Date.now() - start
    // Add performance headers for debugging
    ctx.set('X-Response-Time', `${ms}ms`);
    
    if (ms > 500) { // Log slow requests (reduced threshold)
      console.log(`🐌 SLOW REQUEST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
    } else if (ms < 100) {
      console.log(`⚡ FAST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
    } else {
      console.log(`${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
    }
  }
})

// Setup Passport
console.log('[SERVER] Setting up passport...');
setupPassport();

console.log('[SERVER] Setting up middleware...');
app.use(bodyParser());
app.use(passport.initialize());

console.log('[SERVER] Mounting social auth routes...');
// Mount social auth routes at root level (/auth/*)
app.use(socialAuthRouter.routes()).use(socialAuthRouter.allowedMethods());

// Also mount under /api prefix for compatibility
const apiRouter = new Router({ prefix: '/api' });
apiRouter.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods());
app.use(apiRouter.routes()).use(apiRouter.allowedMethods());

console.log('[SERVER] Social routes mounted successfully');

// Mount other routes
app.use(router.routes()).use(router.allowedMethods());
app.use(authRoutes.routes());
app.use(matchRoutes.routes());
app.use(leagueRoutes.routes());
app.use(notificationRoutes.routes());
app.use(userRoutes.routes()).use(userRoutes.allowedMethods());
app.use(socialRoutes.routes());
app.use(socialRoutes.allowedMethods());

// Explicitly mount world-ranking to avoid 404s if server runs an older routes index
app.use(worldRankingRouter.routes());
app.use(worldRankingRouter.allowedMethods());

// App error handling
app.on("error", async (error) => {
  console.error('Server error:', error);
  // Don't close the database connection on every error
  // Only log the error and let the connection pool handle reconnection
});

// Start app - SINGLE LISTEN CALL
const PORT = process.env.PORT || 5000;

// Initialize database and start server (ONLY ONCE)
initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log(`📱 Client URL: ${process.env.CLIENT_URL}`);
    console.log('🔗 Social routes:');
    console.log(`   Google: http://localhost:${PORT}/auth/google`);
    console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`);
  });
}).catch((error) => {
  console.error('❌ Failed to initialize database:', error);
  // Start server anyway for testing
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT} (without database)`);
    console.log('🔗 Social routes:');
    console.log(`   Google: http://localhost:${PORT}/auth/google`);
    console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`);
  });
});
