
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
import zlib from 'zlib';
import sequelize, { initializeDatabase } from './config/database'; // Import sequelize too
import './models'; // Initialize models and associations

// Import additional routes
import authRoutes from './routes/auth';
import matchRoutes from './routes/matches';
import leagueRoutes from './routes/leagues';
import notificationRoutes from './routes/notifications';
import userRoutes from './routes/users';
import playersRoutes from './routes/players';
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

// Inline gzip middleware using Node's zlib to avoid adding external dependency
// Compresses JSON/text responses over 1KB when the client accepts gzip
app.use(async (ctx, next) => {
  await next();
  try {
    const acceptEncoding = String(ctx.request.get('Accept-Encoding') || '');
    if (!acceptEncoding.includes('gzip')) return;

    const contentType = (ctx.response.type || '').toLowerCase();
    if (!ctx.body) return;
    if (!contentType.includes('application/json') && !contentType.includes('text/')) return;
    if (ctx.response.get('Content-Encoding')) return; // already encoded

    let raw: Buffer;
    if (Buffer.isBuffer(ctx.body)) {
      raw = ctx.body as Buffer;
    } else if (typeof ctx.body === 'string') {
      raw = Buffer.from(ctx.body);
    } else {
      raw = Buffer.from(JSON.stringify(ctx.body));
    }

    if (raw.length < 1024) return; // only compress payloads >1KB

    const gz = zlib.gzipSync(raw, { level: 6 });
    ctx.set('Content-Encoding', 'gzip');
    ctx.set('Content-Length', String(gz.length));
    ctx.body = gz;
  } catch (e) {
    console.error('Compression middleware error:', e);
  }
});

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
    // Lightweight caching for safe GET JSON requests to reduce repeated DB load
    if (ctx.method === 'GET' && ctx.path.startsWith('/api') && ctx.response.type === 'application/json') {
      // Short default TTL for GET JSON (can be overridden on per-endpoint basis)
      const shortTtl = Number(process.env.API_GET_JSON_TTL_SEC ?? 10);
      ctx.set('Cache-Control', `private, max-age=${shortTtl}`);
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

// Lightweight diagnostic test endpoints to validate proxy forwarding
app.use(async (ctx, next) => {
  const p = ctx.path;
  const isTestPath = (
    p === '/auth/test' ||
    p === '/api/auth/test' ||
    p === '/v1/auth/test' ||
    p === '/api/v1/auth/test'
  );
  if (isTestPath && ctx.method === 'GET') {
    ctx.status = 200;
    ctx.body = {
      ok: true,
      message: 'Auth routes are working',
      path: p,
      timestamp: new Date().toISOString(),
    };
    return;
  }
  await next();
});

console.log('[SERVER] Mounting social auth routes...');
// Mount social auth routes at root level (/auth/*)
app.use(socialAuthRouter.routes()).use(socialAuthRouter.allowedMethods());

// Also mount under /api prefix for compatibility
const apiRouter = new Router({ prefix: '/api' });
apiRouter.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods());
//////////////////////////////////////////////////
// Mount core routers under /api for reverse proxy compatibility
apiRouter.use(matchRoutes.routes(), matchRoutes.allowedMethods());
apiRouter.use(leagueRoutes.routes(), leagueRoutes.allowedMethods());
apiRouter.use(playersRoutes.routes(), playersRoutes.allowedMethods());
// ////////////////////////////////////////////////////////////////////
app.use(apiRouter.routes()).use(apiRouter.allowedMethods());

// Mount under /v1 and /api/v1 for reverse proxies that enforce versioning
const v1Router = new Router({ prefix: '/v1' });
v1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods());
//////////////////////////////////////////////////////////////////////
// Mount core routers under /v1 as well
v1Router.use(matchRoutes.routes(), matchRoutes.allowedMethods());
v1Router.use(leagueRoutes.routes(), leagueRoutes.allowedMethods());
v1Router.use(playersRoutes.routes(), playersRoutes.allowedMethods());
//////////////////////////////////////////////////////////////////////
app.use(v1Router.routes()).use(v1Router.allowedMethods());

const apiV1Router = new Router({ prefix: '/api/v1' });
apiV1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods());
/////////////////////////////////////////
// Mount core routers under /api/v1
apiV1Router.use(matchRoutes.routes(), matchRoutes.allowedMethods());
apiV1Router.use(leagueRoutes.routes(), leagueRoutes.allowedMethods());
apiV1Router.use(playersRoutes.routes(), playersRoutes.allowedMethods());
// //////////////////////////////////////////////////////////////////////
app.use(apiV1Router.routes()).use(apiV1Router.allowedMethods());

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

async function applyPerformanceIndexesIfEnabled() {
  try {
    if (process.env.APPLY_PERF_INDEXES !== '1') return;
    console.log('[DB] APPLY_PERF_INDEXES=1 detected. Ensuring performance indexes...');
    const q = (sql: string) => sequelize.query(sql);
    await q('CREATE INDEX IF NOT EXISTS idx_matches_leagueid ON "Matches"("leagueId");');
    await q('CREATE INDEX IF NOT EXISTS idx_matches_leagueid_date ON "Matches"("leagueId", "date" DESC);');
  // Match availability uses explicit snake_case table name
  await q('CREATE INDEX IF NOT EXISTS idx_match_availability_match_id ON match_availabilities(match_id);');
  await q('CREATE INDEX IF NOT EXISTS idx_match_availability_user_match ON match_availabilities(user_id, match_id);');
    await q('CREATE INDEX IF NOT EXISTS idx_userhomematches_matchid ON "UserHomeMatches"("matchId");');
    await q('CREATE INDEX IF NOT EXISTS idx_userhomematches_user_match ON "UserHomeMatches"("userId", "matchId");');
    await q('CREATE INDEX IF NOT EXISTS idx_userawaymatches_matchid ON "UserAwayMatches"("matchId");');
    await q('CREATE INDEX IF NOT EXISTS idx_userawaymatches_user_match ON "UserAwayMatches"("userId", "matchId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leaguemember_leagueid ON "LeagueMember"("leagueId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leaguemember_user_league ON "LeagueMember"("userId", "leagueId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leagueadmin_leagueid ON "LeagueAdmin"("leagueId");');
  await q('CREATE INDEX IF NOT EXISTS idx_leagueadmin_user_league ON "LeagueAdmin"("userId", "leagueId");');
    console.log('[DB] Performance indexes ensured.');
  } catch (e) {
    console.error('[DB] Failed to apply performance indexes:', e);
  }
}

// Removed duplicate, incomplete startup block left from earlier version

// Start app - SINGLE LISTEN CALL
const PORT = process.env.PORT || 5000;

// Initialize database and start server (ONLY ONCE)
initializeDatabase().then(async () => {
  await applyPerformanceIndexesIfEnabled();
  app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 Allowed origins: ${allowedOrigins.join(', ')}`);
    console.log(`📱 Client URL: ${process.env.CLIENT_URL}`);
    console.log('🔗 Social routes:');
    console.log(`   Google: http://localhost:${PORT}/auth/google`);
    console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`);

    // Schedule a safe background XP/Achievements recalculation shortly after boot
    try {
      setTimeout(async () => {
        try {
          console.log('⏱️ Scheduling initial XP/Achievements recalculation...');
          await triggerImmediateXPCalculation();
          console.log('✅ Initial XP/Achievements recalculation completed');
        } catch (calcErr) {
          console.error('❌ Initial XP/Achievements recalculation failed:', calcErr);
        }
      }, 5000);
    } catch (scheduleErr) {
      console.error('Failed to schedule initial XP calculation:', scheduleErr);
    }
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


























































// // Dependencies: server
// import Koa from "koa"
// const app = new Koa()
// import koaBody from "koa-body"
// import router from "./routes"
// import worldRankingRouter from "./routes/worldRanking"
// import cors from "@koa/cors"
// import serve from "koa-static"
// import path from "path"
// import mount from "koa-mount"
// import { triggerImmediateXPCalculation } from "./utils/xpAchievementsEngine"
// import bodyParser from "koa-bodyparser"
// import { initializeDatabase } from "./config/database" // Import sequelize too
// import "./models" // Initialize models and associations
// import jwt from "jsonwebtoken" // Import jwt for social fallback interceptors

// // Import additional routes
// import authRoutes from "./routes/auth"
// import matchRoutes from "./routes/matches"
// import leagueRoutes from "./routes/leagues"
// import notificationRoutes from "./routes/notifications"
// import userRoutes from "./routes/users"
// import Router from "@koa/router"
// import { setupPassport } from "./config/passport"
// import passport from "koa-passport"
// import socialAuthRouter from "./routes/auth/social"
// import socialRoutes from "./routes/auth/social"

// // CORS configuration for both development and production
// const allowedOrigins = [
//   "http://localhost:3000",
//   "http://localhost:3001",
//   "http://192.168.18.102:3000",
//   "https://championfootballer-client.vercel.app",
//   "https://championfootballer-client-git-main-championfootballer.vercel.app",
//   "https://championfootballer-client-championfootballer.vercel.app",
// ]

// app.use(
//   cors({
//     origin: process.env.CLIENT_URL || "*",
//     allowHeaders: ["Authorization", "Content-Type"],
//     exposeHeaders: ["X-Cache"],
//     credentials: true,
//     allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//   }),
// )

// // Root route for health check and CORS
// app.use(async (ctx, next) => {
//   if (ctx.path === "/" && ctx.method === "GET") {
//     ctx.set("Access-Control-Allow-Origin", "*")
//     ctx.set("Access-Control-Allow-Credentials", "true")
//     ctx.body = {
//       status: "ok",
//       message: "ChampionFootballer API root",
//       timestamp: new Date().toISOString(),
//       environment: process.env.NODE_ENV || "development",
//     }
//     return
//   }
//   await next()
// })

// // Manual XP calculation endpoint
// app.use(async (ctx: Koa.Context, next: Koa.Next) => {
//   if (ctx.path === "/api/trigger-xp-calculation" && ctx.method === "POST") {
//     await triggerImmediateXPCalculation()
//     ctx.body = { success: true, message: "XP calculation triggered" }
//     return
//   }
//   await next()
// })

// // Body parser: skip multipart so multer (upload.fields) can read the stream
// app.use(async (ctx, next) => {
//   const ct = String(ctx.get("content-type") || "")
//   if (/multipart\/form-data/i.test(ct)) {
//     return next() // let route's multer handle multipart (POST/PATCH/PUT)
//   }
//   return koaBody({
//     multipart: false,
//     json: true,
//     urlencoded: true,
//     text: false,
//     jsonLimit: "5mb", // Reduced for speed
//     formLimit: "5mb", // Reduced for speed
//   })(ctx, next)
// })

// app.use(mount("/uploads", serve(path.resolve(process.cwd(), "uploads"))))

// // Always send CORS headers on 404 responses
// app.use(async (ctx, next) => {
//   await next()
//   if (ctx.status === 404) {
//     const origin = ctx.request.header.origin
//     if (origin && allowedOrigins.includes(origin)) {
//       ctx.set("Access-Control-Allow-Origin", origin)
//     } else {
//       ctx.set("Access-Control-Allow-Origin", allowedOrigins[0])
//     }
//     ctx.set("Access-Control-Allow-Credentials", "true")
//   }
// })

// // Client error handling with performance timing
// app.use(async (ctx, next) => {
//   const start = Date.now()
//   try {
//     await next()
//     // Add cache headers for static content
//     if (ctx.path.includes("/uploads/") || ctx.path.includes(".css") || ctx.path.includes(".js")) {
//       ctx.set("Cache-Control", "public, max-age=31536000") // 1 year for static assets
//     }
//   } catch (error: any) {
//     console.error("Request error:", error)

//     // Set CORS headers even on error
//     const origin = ctx.request.header.origin
//     if (origin && allowedOrigins.includes(origin)) {
//       ctx.set("Access-Control-Allow-Origin", origin)
//     } else {
//       ctx.set("Access-Control-Allow-Origin", allowedOrigins[0])
//     }
//     ctx.set("Access-Control-Allow-Credentials", "true")

//     // If there isn't a status, set it to 500 with default message
//     if (error.status) {
//       ctx.response.status = error.status
//     } else {
//       ctx.response.status = 500
//       ctx.response.body = {
//         message: "Something went wrong. Please contact support.",
//         error: process.env.NODE_ENV === "development" ? error.message : undefined,
//       }
//     }

//     // If error message needs to be exposed, send it to client. Else, hide it from client and log it to us
//     if (error.expose) {
//       ctx.response.body = { message: error.message }
//     } else {
//       ctx.app.emit("error", error, ctx)
//     }
//   } finally {
//     const ms = Date.now() - start
//     // Add performance headers for debugging
//     ctx.set("X-Response-Time", `${ms}ms`)

//     if (ms > 500) {
//       // Log slow requests (reduced threshold)
//       console.log(`🐌 SLOW REQUEST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     } else if (ms < 100) {
//       console.log(`⚡ FAST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     } else {
//       console.log(`${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     }
//   }
// })

// // Setup Passport
// console.log("[SERVER] Setting up passport...")
// setupPassport()

// console.log("[SERVER] Setting up middleware...")
// app.use(bodyParser())
// app.use(passport.initialize())

// // Add hard fallback interceptors to guarantee /auth/* works even if a router fails to mount
// {
//   const CLIENT_URL = process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:3000"
//   const JWT_SECRET = process.env.JWT_SECRET || "catsay's hello"

//   const GOOGLE_ENABLED = Boolean(
//     process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL,
//   )
//   const FACEBOOK_ENABLED = Boolean(
//     process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET && process.env.FACEBOOK_CALLBACK_URL,
//   )

//   // helper to sign token and redirect (mirrors routes/auth/social.ts)
//   function redirectWithToken(ctx: Koa.Context, user: any, nextPath = "/home") {
//     const token = jwt.sign(
//       {
//         userId: user.id,
//         email: user.email,
//         firstName: user.firstName,
//         lastName: user.lastName,
//         picture: user.profilePicture,
//       },
//       JWT_SECRET,
//       { expiresIn: "7d" },
//     )

//     const secure = process.env.NODE_ENV === "production"
//     ctx.cookies.set("auth_token", token, {
//       path: "/",
//       sameSite: "lax",
//       secure,
//       httpOnly: false,
//       maxAge: 604800000,
//     })
//     ctx.cookies.set("token", token, {
//       path: "/",
//       sameSite: "lax",
//       secure,
//       httpOnly: false,
//       maxAge: 604800000,
//     })

//     const redirectUrl = `${CLIENT_URL}/auth/callback?token=${encodeURIComponent(
//       token,
//     )}&next=${encodeURIComponent(nextPath)}`
//     ctx.redirect(redirectUrl)
//   }

//   // Interceptor middleware
//   app.use(async (ctx, next) => {
//     if (ctx.method !== "GET") return next()

//     // ---- GOOGLE ----
//     if (ctx.path === "/auth/google") {
//       console.log("[SOCIAL-FALLBACK] /auth/google intercepted")
//       if (!GOOGLE_ENABLED) {
//         ctx.status = 302
//         ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_not_configured`)
//         return
//       }
//       return await (
//         passport.authenticate("google", {
//           session: false,
//           scope: ["profile", "email"],
//           state: JSON.stringify({ next: String(ctx.query?.next || "/home") }),
//         }) as any
//       )(ctx, next)
//     }

//     if (ctx.path === "/auth/google/callback") {
//       console.log("[SOCIAL-FALLBACK] /auth/google/callback intercepted")
//       if (!GOOGLE_ENABLED) {
//         ctx.status = 302
//         ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_not_configured`)
//         return
//       }
//       return await (
//         passport.authenticate("google", { session: false }, (err: any, user: any) => {
//           if (err || !user) {
//             ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_failed`)
//             return
//           }
//           let nextPath = "/home"
//           try {
//             if (ctx.query?.state) {
//               const s = JSON.parse(String(ctx.query.state))
//               if (s?.next && typeof s.next === "string") nextPath = s.next
//             }
//           } catch {}
//           redirectWithToken(ctx, user, nextPath)
//         }) as any
//       )(ctx, next)
//     }

//     // ---- FACEBOOK ----
//     if (ctx.path === "/auth/facebook") {
//       console.log("[SOCIAL-FALLBACK] /auth/facebook intercepted")
//       if (!FACEBOOK_ENABLED) {
//         ctx.status = 302
//         ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_not_configured`)
//         return
//       }
//       return await (
//         passport.authenticate("facebook", {
//           session: false,
//           scope: ["email"],
//           state: JSON.stringify({ next: String(ctx.query?.next || "/home") }),
//         }) as any
//       )(ctx, next)
//     }

//     if (ctx.path === "/auth/facebook/callback") {
//       console.log("[SOCIAL-FALLBACK] /auth/facebook/callback intercepted")
//       if (!FACEBOOK_ENABLED) {
//         ctx.status = 302
//         ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_not_configured`)
//         return
//       }
//       return await (
//         passport.authenticate("facebook", { session: false }, (err: any, user: any) => {
//           if (err || !user) {
//             ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_failed`)
//             return
//           }
//           let nextPath = "/home"
//           try {
//             if (ctx.query?.state) {
//               const s = JSON.parse(String(ctx.query.state))
//               if (s?.next && typeof s.next === "string") nextPath = s.next
//             }
//           } catch {}
//           redirectWithToken(ctx, user, nextPath)
//         }) as any
//       )(ctx, next)
//     }

//     return next()
//   })
// }

// // Lightweight diagnostic test endpoints to validate proxy forwarding
// app.use(async (ctx, next) => {
//   const p = ctx.path
//   const isTestPath = p === "/auth/test" || p === "/api/auth/test" || p === "/v1/auth/test" || p === "/api/v1/auth/test"
//   if (isTestPath && ctx.method === "GET") {
//     ctx.status = 200
//     ctx.body = {
//       ok: true,
//       message: "Auth routes are working",
//       path: p,
//       timestamp: new Date().toISOString(),
//     }
//     return
//   }
//   await next()
// })

// console.log("[SERVER] Mounting social auth routes...")
// // Mount social auth routes at root level (/auth/*)
// app.use(socialAuthRouter.routes()).use(socialAuthRouter.allowedMethods())

// // Also mount under /api prefix for compatibility
// const apiRouter = new Router({ prefix: "/api" })
// apiRouter.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(apiRouter.routes()).use(apiRouter.allowedMethods())

// // Mount under /v1 and /api/v1 for reverse proxies that enforce versioning
// const v1Router = new Router({ prefix: "/v1" })
// v1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(v1Router.routes()).use(v1Router.allowedMethods())

// const apiV1Router = new Router({ prefix: "/api/v1" })
// apiV1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(apiV1Router.routes()).use(apiV1Router.allowedMethods())

// console.log("[SERVER] Social routes mounted successfully")

// // Add runtime diagnostics to enumerate social routes
// try {
//   const socialStack = (socialAuthRouter as any)?.stack ?? []
//   console.log(`[SERVER] socialAuthRouter has ${socialStack.length} routes:`)
//   for (const layer of socialStack) {
//     const methods = Array.isArray(layer.methods) ? layer.methods.join(",") : "GET"
//     console.log(`   ${methods} ${layer.path}`)
//   }
// } catch (e) {
//   console.log("[SERVER] Failed to enumerate social routes:", e)
// }

// // Add a well-known endpoint to list social routes in production
// app.use(async (ctx, next) => {
//   if (ctx.method === "GET" && ctx.path === "/.well-known/social-routes") {
//     try {
//       const socialStack = (socialAuthRouter as any)?.stack ?? []
//       ctx.body = {
//         ok: true,
//         routes: socialStack.map((l: any) => ({
//           methods: l?.methods ?? [],
//           path: l?.path ?? "",
//         })),
//         prefixes: ["/auth", "/api/auth", "/v1/auth", "/api/v1/auth"],
//         timestamp: new Date().toISOString(),
//       }
//       return
//     } catch (e) {
//       ctx.status = 500
//       ctx.body = { ok: false, error: "unable_to_list_routes" }
//       return
//     }
//   }
//   await next()
// })

// {
//   const alias = new Router()
//   const withQs = (ctx: Koa.Context, to: string) => (ctx.querystring ? `${to}?${ctx.querystring}` : to)

//   // Google aliases
//   alias.get("/auth/google", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/google"))
//   })
//   alias.get("/auth/google/callback", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/google/callback"))
//   })

//   // Facebook aliases
//   alias.get("/auth/facebook", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/facebook"))
//   })
//   alias.get("/auth/facebook/callback", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/facebook/callback"))
//   })

//   app.use(alias.routes()).use(alias.allowedMethods())
// }

// // Mount other routes
// app.use(router.routes()).use(router.allowedMethods())
// app.use(authRoutes.routes())
// app.use(matchRoutes.routes())
// app.use(leagueRoutes.routes())
// app.use(notificationRoutes.routes())
// app.use(userRoutes.routes()).use(userRoutes.allowedMethods())
// app.use(socialRoutes.routes())
// app.use(socialRoutes.allowedMethods())

// // Explicitly mount world-ranking to avoid 404s if server runs an older routes index
// app.use(worldRankingRouter.routes())
// app.use(worldRankingRouter.allowedMethods())

// // App error handling
// app.on("error", async (error) => {
//   console.error("Server error:", error)
//   // Don't close the database connection on every error
//   // Only log the error and let the connection pool handle reconnection
// })

// // Start app - SINGLE LISTEN CALL
// const PORT = process.env.PORT || 5000

// // Initialize database and start server (ONLY ONCE)
// initializeDatabase()
//   .then(() => {
// async function applyPerformanceIndexesIfEnabled() {
//   try {
//     if (process.env.APPLY_PERF_INDEXES !== '1') return;
//     console.log('[DB] APPLY_PERF_INDEXES=1 detected. Ensuring performance indexes...');
//     const q = (sql: string) => sequelize.query(sql);
//     await q('CREATE INDEX IF NOT EXISTS idx_matches_leagueid ON "Matches"("leagueId");');
//     await q('CREATE INDEX IF NOT EXISTS idx_matches_leagueid_date ON "Matches"("leagueId", "date" DESC);');
//   // Match availability uses explicit snake_case table name
//   await q('CREATE INDEX IF NOT EXISTS idx_match_availability_match_id ON match_availabilities(match_id);');
//   await q('CREATE INDEX IF NOT EXISTS idx_match_availability_user_match ON match_availabilities(user_id, match_id);');
//     await q('CREATE INDEX IF NOT EXISTS idx_userhomematches_matchid ON "UserHomeMatches"("matchId");');
//     await q('CREATE INDEX IF NOT EXISTS idx_userhomematches_user_match ON "UserHomeMatches"("userId", "matchId");');
//     await q('CREATE INDEX IF NOT EXISTS idx_userawaymatches_matchid ON "UserAwayMatches"("matchId");');
//     await q('CREATE INDEX IF NOT EXISTS idx_userawaymatches_user_match ON "UserAwayMatches"("userId", "matchId");');
//   await q('CREATE INDEX IF NOT EXISTS idx_leaguemember_leagueid ON "LeagueMember"("leagueId");');
//   await q('CREATE INDEX IF NOT EXISTS idx_leaguemember_user_league ON "LeagueMember"("userId", "leagueId");');
//   await q('CREATE INDEX IF NOT EXISTS idx_leagueadmin_leagueid ON "LeagueAdmin"("leagueId");');
//   await q('CREATE INDEX IF NOT EXISTS idx_leagueadmin_user_league ON "LeagueAdmin"("userId", "leagueId");');
//     console.log('[DB] Performance indexes ensured.');
//   } catch (e) {
//     console.error('[DB] Failed to apply performance indexes:', e);
//   }
// }

// // Removed duplicate, incomplete startup block left from earlier version























// // Dependencies: server
// import Koa from "koa"
// const app = new Koa()
// import koaBody from "koa-body"
// import router from "./routes"
// import worldRankingRouter from "./routes/worldRanking"
// import cors from "@koa/cors"
// import serve from "koa-static"
// import path from "path"
// import mount from "koa-mount"
// import { triggerImmediateXPCalculation } from "./utils/xpAchievementsEngine"
// import bodyParser from "koa-bodyparser"
// import { initializeDatabase } from "./config/database" // Import sequelize too
// import "./models" // Initialize models and associations

// // Import additional routes
// import authRoutes from "./routes/auth"
// import matchRoutes from "./routes/matches"
// import leagueRoutes from "./routes/leagues"
// import notificationRoutes from "./routes/notifications"
// import userRoutes from "./routes/users"
// import Router from "@koa/router"
// import { setupPassport } from "./config/passport"
// import passport from "koa-passport"
// import socialAuthRouter from "./routes/auth/social"
// import socialRoutes from "./routes/auth/social"

// // CORS configuration for both development and production
// const allowedOrigins = [
//   "http://localhost:3000",
//   "http://localhost:3001",
//   "http://192.168.18.102:3000",
//   "https://championfootballer-client.vercel.app",
//   "https://championfootballer-client-git-main-championfootballer.vercel.app",
//   "https://championfootballer-client-championfootballer.vercel.app",
// ]

// app.use(
//   cors({
//     origin: process.env.CLIENT_URL || "*",
//     allowHeaders: ["Authorization", "Content-Type"],
//     exposeHeaders: ["X-Cache"],
//     credentials: true,
//     allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//   }),
// )

// // Root route for health check and CORS
// app.use(async (ctx, next) => {
//   if (ctx.path === "/" && ctx.method === "GET") {
//     ctx.set("Access-Control-Allow-Origin", "*")
//     ctx.set("Access-Control-Allow-Credentials", "true")
//     ctx.body = {
//       status: "ok",
//       message: "ChampionFootballer API root",
//       timestamp: new Date().toISOString(),
//       environment: process.env.NODE_ENV || "development",
//     }
//     return
//   }
//   await next()
// })

// // Manual XP calculation endpoint
// app.use(async (ctx: Koa.Context, next: Koa.Next) => {
//   if (ctx.path === "/api/trigger-xp-calculation" && ctx.method === "POST") {
//     await triggerImmediateXPCalculation()
//     ctx.body = { success: true, message: "XP calculation triggered" }
//     return
//   }
//   await next()
// })

// // Body parser: skip multipart so multer (upload.fields) can read the stream
// app.use(async (ctx, next) => {
//   const ct = String(ctx.get("content-type") || "")
//   if (/multipart\/form-data/i.test(ct)) {
//     return next() // let route's multer handle multipart (POST/PATCH/PUT)
//   }
//   return koaBody({
//     multipart: false,
//     json: true,
//     urlencoded: true,
//     text: false,
//     jsonLimit: "5mb", // Reduced for speed
//     formLimit: "5mb", // Reduced for speed
//   })(ctx, next)
// })

// app.use(mount("/uploads", serve(path.resolve(process.cwd(), "uploads"))))

// // Always send CORS headers on 404 responses
// app.use(async (ctx, next) => {
//   await next()
//   if (ctx.status === 404) {
//     const origin = ctx.request.header.origin
//     if (origin && allowedOrigins.includes(origin)) {
//       ctx.set("Access-Control-Allow-Origin", origin)
//     } else {
//       ctx.set("Access-Control-Allow-Origin", allowedOrigins[0])
//     }
//     ctx.set("Access-Control-Allow-Credentials", "true")
//   }
// })

// // Client error handling with performance timing
// app.use(async (ctx, next) => {
//   const start = Date.now()
//   try {
//     await next()
//     // Add cache headers for static content
//     if (ctx.path.includes("/uploads/") || ctx.path.includes(".css") || ctx.path.includes(".js")) {
//       ctx.set("Cache-Control", "public, max-age=31536000") // 1 year for static assets
//     }
//   } catch (error: any) {
//     console.error("Request error:", error)

//     // Set CORS headers even on error
//     const origin = ctx.request.header.origin
//     if (origin && allowedOrigins.includes(origin)) {
//       ctx.set("Access-Control-Allow-Origin", origin)
//     } else {
//       ctx.set("Access-Control-Allow-Origin", allowedOrigins[0])
//     }
//     ctx.set("Access-Control-Allow-Credentials", "true")

//     // If there isn't a status, set it to 500 with default message
//     if (error.status) {
//       ctx.response.status = error.status
//     } else {
//       ctx.response.status = 500
//       ctx.response.body = {
//         message: "Something went wrong. Please contact support.",
//         error: process.env.NODE_ENV === "development" ? error.message : undefined,
//       }
//     }

//     // If error message needs to be exposed, send it to client. Else, hide it from client and log it to us
//     if (error.expose) {
//       ctx.response.body = { message: error.message }
//     } else {
//       ctx.app.emit("error", error, ctx)
//     }
//   } finally {
//     const ms = Date.now() - start
//     // Add performance headers for debugging
//     ctx.set("X-Response-Time", `${ms}ms`)

//     if (ms > 500) {
//       // Log slow requests (reduced threshold)
//       console.log(`🐌 SLOW REQUEST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     } else if (ms < 100) {
//       console.log(`⚡ FAST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     } else {
//       console.log(`${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     }
//   }
// })

// // Setup Passport
// console.log("[SERVER] Setting up passport...")
// setupPassport()

// console.log("[SERVER] Setting up middleware...")
// app.use(bodyParser())
// app.use(passport.initialize())

// // Lightweight diagnostic test endpoints to validate proxy forwarding
// app.use(async (ctx, next) => {
//   const p = ctx.path
//   const isTestPath = p === "/auth/test" || p === "/api/auth/test" || p === "/v1/auth/test" || p === "/api/v1/auth/test"
//   if (isTestPath && ctx.method === "GET") {
//     ctx.status = 200
//     ctx.body = {
//       ok: true,
//       message: "Auth routes are working",
//       path: p,
//       timestamp: new Date().toISOString(),
//     }
//     return
//   }
//   await next()
// })

// console.log("[SERVER] Mounting social auth routes...")
// // Mount social auth routes at root level (/auth/*)
// app.use(socialAuthRouter.routes()).use(socialAuthRouter.allowedMethods())

// // Also mount under /api prefix for compatibility
// const apiRouter = new Router({ prefix: "/api" })
// apiRouter.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(apiRouter.routes()).use(apiRouter.allowedMethods())

// // Mount under /v1 and /api/v1 for reverse proxies that enforce versioning
// const v1Router = new Router({ prefix: "/v1" })
// v1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(v1Router.routes()).use(v1Router.allowedMethods())

// const apiV1Router = new Router({ prefix: "/api/v1" })
// apiV1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(apiV1Router.routes()).use(apiV1Router.allowedMethods())

// console.log("[SERVER] Social routes mounted successfully")

// // Add runtime diagnostics to enumerate social routes
// try {
//   const socialStack = (socialAuthRouter as any)?.stack ?? []
//   console.log(`[SERVER] socialAuthRouter has ${socialStack.length} routes:`)
//   for (const layer of socialStack) {
//     const methods = Array.isArray(layer.methods) ? layer.methods.join(",") : "GET"
//     console.log(`   ${methods} ${layer.path}`)
//   }
// } catch (e) {
//   console.log("[SERVER] Failed to enumerate social routes:", e)
// }

// // Add a well-known endpoint to list social routes in production
// app.use(async (ctx, next) => {
//   if (ctx.method === "GET" && ctx.path === "/.well-known/social-routes") {
//     try {
//       const socialStack = (socialAuthRouter as any)?.stack ?? []
//       ctx.body = {
//         ok: true,
//         routes: socialStack.map((l: any) => ({
//           methods: l?.methods ?? [],
//           path: l?.path ?? "",
//         })),
//         prefixes: ["/auth", "/api/auth", "/v1/auth", "/api/v1/auth"],
//         timestamp: new Date().toISOString(),
//       }
//       return
//     } catch (e) {
//       ctx.status = 500
//       ctx.body = { ok: false, error: "unable_to_list_routes" }
//       return
//     }
//   }
//   await next()
// })

// {
//   const alias = new Router()
//   const withQs = (ctx: Koa.Context, to: string) => (ctx.querystring ? `${to}?${ctx.querystring}` : to)

//   // Google aliases
//   alias.get("/auth/google", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/google"))
//   })
//   alias.get("/auth/google/callback", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/google/callback"))
//   })

//   // Facebook aliases
//   alias.get("/auth/facebook", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/facebook"))
//   })
//   alias.get("/auth/facebook/callback", (ctx) => {
//     ctx.status = 302
//     ctx.redirect(withQs(ctx, "/api/auth/facebook/callback"))
//   })

//   app.use(alias.routes()).use(alias.allowedMethods())
// }

// // Mount other routes
// app.use(router.routes()).use(router.allowedMethods())
// app.use(authRoutes.routes())
// app.use(matchRoutes.routes())
// app.use(leagueRoutes.routes())
// app.use(notificationRoutes.routes())
// app.use(userRoutes.routes()).use(userRoutes.allowedMethods())
// app.use(socialRoutes.routes())
// app.use(socialRoutes.allowedMethods())

// // Explicitly mount world-ranking to avoid 404s if server runs an older routes index
// app.use(worldRankingRouter.routes())
// app.use(worldRankingRouter.allowedMethods())

// // App error handling
// app.on("error", async (error) => {
//   console.error("Server error:", error)
//   // Don't close the database connection on every error
//   // Only log the error and let the connection pool handle reconnection
// })

// // Start app - SINGLE LISTEN CALL
// const PORT = process.env.PORT || 5000

// // Initialize database and start server (ONLY ONCE)
// initializeDatabase()
//   .then(() => {
//     app.listen(PORT, () => {
//       console.log(`🚀 Server is running on http://localhost:${PORT}`)
//       console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`)
//       console.log(`🔗 Allowed origins: ${allowedOrigins.join(", ")}`)
//       console.log(`📱 Client URL: ${process.env.CLIENT_URL}`)
//       console.log("🔗 Social routes:")
//       console.log(`   Google: http://localhost:${PORT}/auth/google`)
//       console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`)

//       // Schedule a safe background XP/Achievements recalculation shortly after boot
//       try {
//         setTimeout(async () => {
//           try {
//             console.log("⏱️ Scheduling initial XP/Achievements recalculation...")
//             await triggerImmediateXPCalculation()
//             console.log("✅ Initial XP/Achievements recalculation completed")
//           } catch (calcErr) {
//             console.error("❌ Initial XP/Achievements recalculation failed:", calcErr)
//           }
//         }, 5000)
//       } catch (scheduleErr) {
//         console.error("Failed to schedule initial XP calculation:", scheduleErr)
//       }
//     })
//   })
//   .catch((error) => {
//     console.error("❌ Failed to initialize database:", error)
//     // Start server anyway for testing
//     app.listen(PORT, () => {
//       console.log(`🚀 Server is running on http://localhost:${PORT} (without database)`)
//       console.log("🔗 Social routes:")
//       console.log(`   Google: http://localhost:${PORT}/auth/google`)
//       console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`)
//     })
//   })



















// // Dependencies: server
// import Koa from "koa"
// const app = new Koa()
// import koaBody from "koa-body"
// import router from "./routes"
// import worldRankingRouter from "./routes/worldRanking"
// import cors from "@koa/cors"
// import serve from "koa-static"
// import path from "path"
// import mount from "koa-mount"
// import { triggerImmediateXPCalculation } from "./utils/xpAchievementsEngine"
// import bodyParser from "koa-bodyparser"
// import { initializeDatabase } from "./config/database" // Import sequelize too
// import "./models" // Initialize models and associations

// // Import additional routes
// import authRoutes from "./routes/auth"
// import matchRoutes from "./routes/matches"
// import leagueRoutes from "./routes/leagues"
// import notificationRoutes from "./routes/notifications"
// import userRoutes from "./routes/users"
// import Router from "@koa/router"
// import { setupPassport } from "./config/passport"
// import passport from "koa-passport"
// import socialAuthRouter from "./routes/auth/social"
// import socialRoutes from "./routes/auth/social"

// // CORS configuration for both development and production
// const allowedOrigins = [
//   "http://localhost:3000",
//   "http://localhost:3001",
//   "http://192.168.18.102:3000",
//   "https://championfootballer-client.vercel.app",
//   "https://championfootballer-client-git-main-championfootballer.vercel.app",
//   "https://championfootballer-client-championfootballer.vercel.app",
// ]

// app.use(
//   cors({
//     origin: process.env.CLIENT_URL || "*",
//     allowHeaders: ["Authorization", "Content-Type"],
//     exposeHeaders: ["X-Cache"],
//     credentials: true,
//     allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
//   }),
// )

// // Root route for health check and CORS
// app.use(async (ctx, next) => {
//   if (ctx.path === "/" && ctx.method === "GET") {
//     ctx.set("Access-Control-Allow-Origin", "*")
//     ctx.set("Access-Control-Allow-Credentials", "true")
//     ctx.body = {
//       status: "ok",
//       message: "ChampionFootballer API root",
//       timestamp: new Date().toISOString(),
//       environment: process.env.NODE_ENV || "development",
//     }
//     return
//   }
//   await next()
// })

// // Manual XP calculation endpoint
// app.use(async (ctx: Koa.Context, next: Koa.Next) => {
//   if (ctx.path === "/api/trigger-xp-calculation" && ctx.method === "POST") {
//     await triggerImmediateXPCalculation()
//     ctx.body = { success: true, message: "XP calculation triggered" }
//     return
//   }
//   await next()
// })

// // Body parser: skip multipart so multer (upload.fields) can read the stream
// app.use(async (ctx, next) => {
//   const ct = String(ctx.get("content-type") || "")
//   if (/multipart\/form-data/i.test(ct)) {
//     return next() // let route's multer handle multipart (POST/PATCH/PUT)
//   }
//   return koaBody({
//     multipart: false,
//     json: true,
//     urlencoded: true,
//     text: false,
//     jsonLimit: "5mb", // Reduced for speed
//     formLimit: "5mb", // Reduced for speed
//   })(ctx, next)
// })

// app.use(mount("/uploads", serve(path.resolve(process.cwd(), "uploads"))))

// // Always send CORS headers on 404 responses
// app.use(async (ctx, next) => {
//   await next()
//   if (ctx.status === 404) {
//     const origin = ctx.request.header.origin
//     if (origin && allowedOrigins.includes(origin)) {
//       ctx.set("Access-Control-Allow-Origin", origin)
//     } else {
//       ctx.set("Access-Control-Allow-Origin", allowedOrigins[0])
//     }
//     ctx.set("Access-Control-Allow-Credentials", "true")
//   }
// })

// // Client error handling with performance timing
// app.use(async (ctx, next) => {
//   const start = Date.now()
//   try {
//     await next()
//     // Add cache headers for static content
//     if (ctx.path.includes("/uploads/") || ctx.path.includes(".css") || ctx.path.includes(".js")) {
//       ctx.set("Cache-Control", "public, max-age=31536000") // 1 year for static assets
//     }
//   } catch (error: any) {
//     console.error("Request error:", error)

//     // Set CORS headers even on error
//     const origin = ctx.request.header.origin
//     if (origin && allowedOrigins.includes(origin)) {
//       ctx.set("Access-Control-Allow-Origin", origin)
//     } else {
//       ctx.set("Access-Control-Allow-Origin", allowedOrigins[0])
//     }
//     ctx.set("Access-Control-Allow-Credentials", "true")

//     // If there isn't a status, set it to 500 with default message
//     if (error.status) {
//       ctx.response.status = error.status
//     } else {
//       ctx.response.status = 500
//       ctx.response.body = {
//         message: "Something went wrong. Please contact support.",
//         error: process.env.NODE_ENV === "development" ? error.message : undefined,
//       }
//     }

//     // If error message needs to be exposed, send it to client. Else, hide it from client and log it to us
//     if (error.expose) {
//       ctx.response.body = { message: error.message }
//     } else {
//       ctx.app.emit("error", error, ctx)
//     }
//   } finally {
//     const ms = Date.now() - start
//     // Add performance headers for debugging
//     ctx.set("X-Response-Time", `${ms}ms`)

//     if (ms > 500) {
//       // Log slow requests (reduced threshold)
//       console.log(`🐌 SLOW REQUEST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     } else if (ms < 100) {
//       console.log(`⚡ FAST: ${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     } else {
//       console.log(`${ctx.request.method} ${ctx.response.status} in ${ms}ms: ${ctx.request.path}`)
//     }
//   }
// })

// // Setup Passport
// console.log("[SERVER] Setting up passport...")
// setupPassport()

// console.log("[SERVER] Setting up middleware...")
// app.use(bodyParser())
// app.use(passport.initialize())

// // Lightweight diagnostic test endpoints to validate proxy forwarding
// app.use(async (ctx, next) => {
//   const p = ctx.path
//   const isTestPath = p === "/auth/test" || p === "/api/auth/test" || p === "/v1/auth/test" || p === "/api/v1/auth/test"
//   if (isTestPath && ctx.method === "GET") {
//     ctx.status = 200
//     ctx.body = {
//       ok: true,
//       message: "Auth routes are working",
//       path: p,
//       timestamp: new Date().toISOString(),
//     }
//     return
//   }
//   await next()
// })

// console.log("[SERVER] Mounting social auth routes...")
// // Mount social auth routes at root level (/auth/*)
// app.use(socialAuthRouter.routes()).use(socialAuthRouter.allowedMethods())

// // Also mount under /api prefix for compatibility
// const apiRouter = new Router({ prefix: "/api" })
// apiRouter.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(apiRouter.routes()).use(apiRouter.allowedMethods())

// // Mount under /v1 and /api/v1 for reverse proxies that enforce versioning
// const v1Router = new Router({ prefix: "/v1" })
// v1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(v1Router.routes()).use(v1Router.allowedMethods())

// const apiV1Router = new Router({ prefix: "/api/v1" })
// apiV1Router.use(socialAuthRouter.routes(), socialAuthRouter.allowedMethods())
// app.use(apiV1Router.routes()).use(apiV1Router.allowedMethods())

// console.log("[SERVER] Social routes mounted successfully")

// // Add runtime diagnostics to enumerate social routes
// try {
//   const socialStack = (socialAuthRouter as any)?.stack ?? []
//   console.log(`[SERVER] socialAuthRouter has ${socialStack.length} routes:`)
//   for (const layer of socialStack) {
//     const methods = Array.isArray(layer.methods) ? layer.methods.join(",") : "GET"
//     console.log(`   ${methods} ${layer.path}`)
//   }
// } catch (e) {
//   console.log("[SERVER] Failed to enumerate social routes:", e)
// }

// // Add a well-known endpoint to list social routes in production
// app.use(async (ctx, next) => {
//   if (ctx.method === "GET" && ctx.path === "/.well-known/social-routes") {
//     try {
//       const socialStack = (socialAuthRouter as any)?.stack ?? []
//       ctx.body = {
//         ok: true,
//         routes: socialStack.map((l: any) => ({
//           methods: l?.methods ?? [],
//           path: l?.path ?? "",
//         })),
//         prefixes: ["/auth", "/api/auth", "/v1/auth", "/api/v1/auth"],
//         timestamp: new Date().toISOString(),
//       }
//       return
//     } catch (e) {
//       ctx.status = 500
//       ctx.body = { ok: false, error: "unable_to_list_routes" }
//       return
//     }
//   }
//   await next()
// })

// // Mount other routes
// app.use(router.routes()).use(router.allowedMethods())
// app.use(authRoutes.routes())
// app.use(matchRoutes.routes())
// app.use(leagueRoutes.routes())
// app.use(notificationRoutes.routes())
// app.use(userRoutes.routes()).use(userRoutes.allowedMethods())
// app.use(socialRoutes.routes())
// app.use(socialRoutes.allowedMethods())

// // Explicitly mount world-ranking to avoid 404s if server runs an older routes index
// app.use(worldRankingRouter.routes())
// app.use(worldRankingRouter.allowedMethods())

// // App error handling
// app.on("error", async (error) => {
//   console.error("Server error:", error)
//   // Don't close the database connection on every error
//   // Only log the error and let the connection pool handle reconnection
// })

// // Start app - SINGLE LISTEN CALL
// const PORT = process.env.PORT || 5000

// // Initialize database and start server (ONLY ONCE)
// initializeDatabase()
//   .then(() => {
//     app.listen(PORT, () => {
//       console.log(`🚀 Server is running on http://localhost:${PORT}`)
//       console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`)
//       console.log(`🔗 Allowed origins: ${allowedOrigins.join(", ")}`)
//       console.log(`📱 Client URL: ${process.env.CLIENT_URL}`)
//       console.log("🔗 Social routes:")
//       console.log(`   Google: http://localhost:${PORT}/auth/google`)
//       console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`)

//       // Schedule a safe background XP/Achievements recalculation shortly after boot
//       try {
//         setTimeout(async () => {
//           try {
//             console.log("⏱️ Scheduling initial XP/Achievements recalculation...")
//             await triggerImmediateXPCalculation()
//             console.log("✅ Initial XP/Achievements recalculation completed")
//           } catch (calcErr) {
//             console.error("❌ Initial XP/Achievements recalculation failed:", calcErr)
//           }
//         }, 5000)
//       } catch (scheduleErr) {
//         console.error("Failed to schedule initial XP calculation:", scheduleErr)
//       }
//     })
//   })
//   .catch((error) => {
//     console.error("❌ Failed to initialize database:", error)
//     // Start server anyway for testing
//     app.listen(PORT, () => {
//       console.log(`🚀 Server is running on http://localhost:${PORT} (without database)`)
//       console.log("🔗 Social routes:")
//       console.log(`   Google: http://localhost:${PORT}/auth/google`)
//       console.log(`   Facebook: http://localhost:${PORT}/auth/facebook`)
//     })
//   })







