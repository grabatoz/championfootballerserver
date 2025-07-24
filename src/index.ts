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

// Dependencies: extra
app.use(async (ctx, next) => {
  if (ctx.path === '/' && ctx.method === 'GET') {
    ctx.set('Access-Control-Allow-Origin', '*'); // ensure CORS header is sent
    ctx.set('Access-Control-Allow-Credentials', 'true');
    ctx.body = { status: 'ok', message: 'ChampionFootballer API root' };
    return;
  }
  await next();
});

// origin: 'http://localhost:3000',
// origin: 'http://localhost:3000',
// app.use(cors({
//   origin: 'https://championfootballer-client.vercel.app',
//   allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
//   allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
//   credentials: true
// }));


// CORS configuration
app.use(cors({
  origin: 'https://championfootballer-client.vercel.app',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin'],
  exposeHeaders: ['WWW-Authenticate', 'Server-Authorization'],
  maxAge: 5,
  credentials: true,
  keepHeadersOnError: true
}));


// Manual XP calculation endpoint
app.use(async (ctx: Koa.Context, next: Koa.Next) => {
  if (ctx.path === '/api/trigger-xp-calculation' && ctx.method === 'POST') {
    await triggerImmediateXPCalculation();
    ctx.body = { success: true, message: 'XP calculation triggered' };
    return;
  }
  await next();
});
// Root route for health check and CORS

// Body parser - using koaBody for better multipart support
app.use(async (ctx, next) => {
  // Skip koaBody for file upload route
  if (ctx.path === '/profile/picture' && ctx.method === 'POST') {
    return next();
  }
  await koaBody({
    multipart: true,
    json: true,
    urlencoded: true,
    text: true,
    jsonLimit: '1mb',
    formLimit: '1mb',
    textLimit: '1mb',
    formidable: {
      maxFileSize: 200 * 1024 * 1024 // 200MB
    }
  })(ctx, next);
});

app.use(mount('/uploads', serve(path.resolve(process.cwd(), 'uploads'))));

// Always send CORS headers on 404 responses
app.use(async (ctx, next) => {
  await next();
  if (ctx.status === 404) {
    ctx.set('Access-Control-Allow-Origin', '*'); // or your allowed origin
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
    // If there isn't a status, set it to 500 with default message
    if (error.status) {
      ctx.response.status = error.status
    } else {
      ctx.response.status = 500
      ctx.response.body = {
        message: "Something went wrong. Please contact support.",
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
});
