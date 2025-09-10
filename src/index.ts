// Dependencies: server
import Koa from "koa"
const app = new Koa()
import koaBody from "koa-body"
import router from "./routes"
import cors from "@koa/cors"
import serve from 'koa-static';
import path from 'path';
import mount from 'koa-mount';
import { triggerImmediateXPCalculation } from './utils/xpAchievementsEngine';

// CORS configuration for both development and production
const allowedOrigins = [
  'http://localhost:3000',
  'https://championfootballer-client.vercel.app',
  'https://championfootballer-client-git-main-championfootballer.vercel.app',
  'https://championfootballer-client-championfootballer.vercel.app'
];


app.use(cors({
  origin: (ctx) => {
    const origin = ctx.request.header.origin;
    if (origin && allowedOrigins.includes(origin)) {
      return origin;
    }
    return allowedOrigins[0]; // fallback to first origin
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
  credentials: true,
  maxAge: 86400 // 24 hours
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
    jsonLimit: '10mb',
    formLimit: '10mb'
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

// Client error handling
app.use(async (ctx, next) => {
  const start = Date.now()
  try {
    await next()
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
    console.log(
      `${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`
    )
  }
})

// Mount routes
app.use(router.routes());
app.use(router.allowedMethods());

// App error handling
app.on("error", async (error) => {
  console.error('Server error:', error);
  // Don't close the database connection on every error
  // Only log the error and let the connection pool handle reconnection
});

// Start app
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 Allowed origins: ${allowedOrigins.join(', ')}`);
});
