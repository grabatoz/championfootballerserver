import Router from "@koa/router"
import jwt from "jsonwebtoken"
import passport from "koa-passport"
import { IS_PRODUCTION, JWT_SECRET } from "../../config/env"

const router = new Router({ prefix: "/auth" })

const CLIENT_URL = process.env.CLIENT_URL || process.env.FRONTEND_URL || "http://localhost:3000"

const normalizeOrigin = (value?: string | null): string | null => {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
};

const defaultClientOrigin = normalizeOrigin(CLIENT_URL) || 'http://localhost:3000';

const configuredClientOrigins = [
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL,
  'https://championfootballer.com',
  'https://www.championfootballer.com',
  'https://championfootballer-client.vercel.app',
  'https://championfootballer-client-git-main-championfootballer.vercel.app',
  'https://championfootballer-client-championfootballer.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
]
  .map(normalizeOrigin)
  .filter((origin): origin is string => Boolean(origin));

const allowedClientOrigins = new Set<string>([
  ...configuredClientOrigins,
  defaultClientOrigin,
]);

const isTrustedVercelPreview = (origin: string): boolean => {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return /^championfootballer-client(?:-[\w-]+)?\.vercel\.app$/.test(hostname);
  } catch {
    return false;
  }
};

const isAllowedClientOrigin = (origin: string): boolean => {
  return allowedClientOrigins.has(origin) || isTrustedVercelPreview(origin);
};

const resolveClientOrigin = (candidate?: string | null): string => {
  const normalized = normalizeOrigin(candidate);
  if (normalized && isAllowedClientOrigin(normalized)) {
    return normalized;
  }
  return defaultClientOrigin;
};

const sanitizeNextPath = (value: unknown): string => {
  if (typeof value !== 'string') return '/home';
  const trimmed = value.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return '/home';
  return trimmed;
};

const toSafeErrorCode = (value: unknown, fallback: string): string => {
  if (typeof value !== 'string') return fallback;
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return slug || fallback;
};

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const maybeMessage = (error as { message?: unknown }).message;
    if (typeof maybeMessage === 'string' && maybeMessage) return maybeMessage;
  }
  return 'callback_error';
};

const getRequestOrigin = (ctx: Router.RouterContext): string => {
  const protoHeader = String(ctx.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const hostHeader = String(ctx.get('x-forwarded-host') || '').split(',')[0].trim();

  const protocol =
    protoHeader === 'https' || protoHeader === 'http'
      ? protoHeader
      : (ctx.protocol === 'https' ? 'https' : 'http');
  const host = hostHeader || ctx.host;

  if (!host) return defaultClientOrigin;
  return `${protocol}://${host}`;
};

const buildProviderCallbackUrl = (ctx: Router.RouterContext, path: string): string => {
  return `${getRequestOrigin(ctx)}${path}`;
};

type OAuthState = {
  next?: string;
  client?: string;
};

const parseOAuthState = (value: unknown): OAuthState => {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as OAuthState;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
};

const GOOGLE_ENABLED = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
)
const FACEBOOK_ENABLED = Boolean(
  process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET,
)

type OAuthUser = {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  profilePicture?: string | null;
};

type PassportHandler = (ctx: unknown, next: unknown) => Promise<unknown>;

const runPassportHandler = async (handler: unknown, ctx: unknown, next: unknown) => {
  return await (handler as PassportHandler)(ctx, next);
};

const isOAuthUser = (value: unknown): value is OAuthUser => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<OAuthUser>;
  return typeof v.id === 'string' && typeof v.email === 'string';
};

const buildCallbackHashUrl = (params: Record<string, string>, clientOrigin = defaultClientOrigin) => {
  const hash = new URLSearchParams(params).toString();
  return `${clientOrigin}/auth/callback#${hash}`;
};


console.log("[SOCIAL] CLIENT_URL:", CLIENT_URL)
console.log("[SOCIAL] JWT_SECRET exists:", Boolean(JWT_SECRET))
console.log("[SOCIAL] Providers enabled:", {
  google: GOOGLE_ENABLED,
  facebook: FACEBOOK_ENABLED,
})
console.log("[SOCIAL] Routes being registered...")

function redirectWithToken(
  ctx: Router.RouterContext,
  user: OAuthUser,
  nextPath = "/home",
  clientOrigin = defaultClientOrigin,
) {
  console.log("[SOCIAL] redirectWithToken called with user:", user.id, user.email)

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      picture: user.profilePicture,
    },
    JWT_SECRET,
    { expiresIn: "7d" },
  )
  console.log("[SOCIAL] Generated token:", token.substring(0, 20) + "...")

  // Set cookies on API domain
  const secure = IS_PRODUCTION
  // Set both names for compatibility with existing middleware/clients
  ctx.cookies.set("auth_token", token, {
    path: "/",
    sameSite: "lax",
    secure,
    httpOnly: true,
    maxAge: 604800000,
  })
  ctx.cookies.set("token", token, {
    path: "/",
    sameSite: "lax",
    secure,
    httpOnly: true,
    maxAge: 604800000,
  })

  // Use hash instead of query to reduce token leakage via logs/referrers.
  const redirectUrl = buildCallbackHashUrl({ token, next: nextPath }, clientOrigin)
  console.log("[SOCIAL] Redirecting to:", redirectUrl)

  ctx.redirect(redirectUrl)
}

// Test route to verify auth routes are working
router.get("/test", (ctx) => {
  console.log("[SOCIAL] Test route hit")
  ctx.body = { message: "Auth routes are working", timestamp: new Date().toISOString() }
})

// Google OAuth
router.get("/google", async (ctx, next) => {
  console.log("[SOCIAL] /google route hit")
  console.log("[SOCIAL] Query params:", ctx.query)
  const clientOrigin = resolveClientOrigin(String(ctx.query.client || ''));
  const nextPath = sanitizeNextPath(ctx.query.next);
  const callbackURL = buildProviderCallbackUrl(ctx, '/auth/google/callback');

  if (!GOOGLE_ENABLED) {
    console.warn("[SOCIAL] Google not configured in environment")
    const redirectUrl = buildCallbackHashUrl({ error: 'google_not_configured' }, clientOrigin)
    ctx.status = 302
    ctx.redirect(redirectUrl)
    return
  }

  try {
    const handler = passport.authenticate("google", {
      session: false,
      scope: ["profile", "email"],
      state: JSON.stringify({ next: nextPath, client: clientOrigin }),
      callbackURL,
    });
    return await runPassportHandler(handler, ctx, next);
  } catch (error) {
    console.error("[SOCIAL] Error in /google route:", error)
    const reason = toSafeErrorCode(extractErrorMessage(error), 'route_error');
    ctx.redirect(buildCallbackHashUrl({ error: `google_${reason}` }, clientOrigin))
  }
})

router.get("/google/callback", async (ctx, next) => {
  console.log("[SOCIAL] /google/callback route hit")
  console.log("[SOCIAL] Callback query params:", ctx.query)
  const state = parseOAuthState(ctx.query.state);
  const clientOrigin = resolveClientOrigin(state.client);
  const callbackURL = buildProviderCallbackUrl(ctx, '/auth/google/callback');

  const oauthError = toSafeErrorCode(ctx.query.error, '');
  if (oauthError) {
    const oauthDescription = typeof ctx.query.error_description === 'string' ? ctx.query.error_description : '';
    console.warn("[SOCIAL] Google provider returned error:", oauthError, oauthDescription);
    ctx.redirect(buildCallbackHashUrl({ error: `google_${oauthError}` }, clientOrigin))
    return;
  }

  if (!GOOGLE_ENABLED) {
    console.warn("[SOCIAL] Google not configured in environment (callback)")
    ctx.redirect(buildCallbackHashUrl({ error: 'google_not_configured' }, clientOrigin))
    return
  }

  try {
    const handler = passport.authenticate("google", { session: false, callbackURL }, (err: unknown, user: unknown) => {
      console.log("[SOCIAL] Google auth result:", { err: !!err, user: !!user })

      if (err) {
        console.error("[SOCIAL] Google auth error:", err)
        const reason = toSafeErrorCode(extractErrorMessage(err), 'failed')
        return ctx.redirect(buildCallbackHashUrl({ error: `google_${reason}` }, clientOrigin))
      }

      if (!isOAuthUser(user)) {
        console.error("[SOCIAL] No valid user returned from Google")
        return ctx.redirect(buildCallbackHashUrl({ error: 'no_user' }, clientOrigin))
      }

      const nextPath = sanitizeNextPath(state.next);

      console.log("[SOCIAL] Proceeding with user:", user.email, "nextPath:", nextPath)
      redirectWithToken(ctx, user, nextPath, clientOrigin)
    });
    return await runPassportHandler(handler, ctx, next);
  } catch (error) {
    console.error("[SOCIAL] Error in /google/callback route:", error)
    const reason = toSafeErrorCode(extractErrorMessage(error), 'callback_error')
    ctx.redirect(buildCallbackHashUrl({ error: `google_${reason}` }, clientOrigin))
  }
})

// Facebook OAuth
router.get("/facebook", async (ctx, next) => {
  console.log("[SOCIAL] /facebook route hit")
  const clientOrigin = resolveClientOrigin(String(ctx.query.client || ''));
  const nextPath = sanitizeNextPath(ctx.query.next);
  const callbackURL = buildProviderCallbackUrl(ctx, '/auth/facebook/callback');

  if (!FACEBOOK_ENABLED) {
    console.warn("[SOCIAL] Facebook not configured in environment")
    ctx.redirect(buildCallbackHashUrl({ error: 'facebook_not_configured' }, clientOrigin))
    return
  }

  try {
    const handler = passport.authenticate("facebook", {
      session: false,
      scope: ["email"],
      state: JSON.stringify({ next: nextPath, client: clientOrigin }),
      callbackURL,
    });
    return await runPassportHandler(handler, ctx, next);
  } catch (error) {
    console.error("[SOCIAL] Error in /facebook route:", error)
    const reason = toSafeErrorCode(extractErrorMessage(error), 'route_error');
    ctx.redirect(buildCallbackHashUrl({ error: `facebook_${reason}` }, clientOrigin))
  }
})

router.get("/facebook/callback", async (ctx, next) => {
  console.log("[SOCIAL] /facebook/callback route hit")
  const state = parseOAuthState(ctx.query.state);
  const clientOrigin = resolveClientOrigin(state.client);
  const callbackURL = buildProviderCallbackUrl(ctx, '/auth/facebook/callback');

  const oauthError = toSafeErrorCode(ctx.query.error, '');
  if (oauthError) {
    const oauthDescription = typeof ctx.query.error_description === 'string' ? ctx.query.error_description : '';
    console.warn("[SOCIAL] Facebook provider returned error:", oauthError, oauthDescription);
    ctx.redirect(buildCallbackHashUrl({ error: `facebook_${oauthError}` }, clientOrigin))
    return;
  }

  if (!FACEBOOK_ENABLED) {
    console.warn("[SOCIAL] Facebook not configured in environment (callback)")
    ctx.redirect(buildCallbackHashUrl({ error: 'facebook_not_configured' }, clientOrigin))
    return
  }

  try {
    const handler = passport.authenticate("facebook", { session: false, callbackURL }, (err: unknown, user: unknown) => {
      console.log("[SOCIAL] Facebook auth result:", { err: !!err, user: !!user })

      if (err || !isOAuthUser(user)) {
        console.error("[SOCIAL] Facebook auth error:", err)
        const reason = toSafeErrorCode(extractErrorMessage(err), 'failed')
        return ctx.redirect(buildCallbackHashUrl({ error: `facebook_${reason}` }, clientOrigin))
      }

      const nextPath = sanitizeNextPath(state.next);

      console.log("[SOCIAL] Proceeding with user:", user.email, "nextPath:", nextPath)
      redirectWithToken(ctx, user, nextPath, clientOrigin)
    });
    return await runPassportHandler(handler, ctx, next);
  } catch (error) {
    console.error("[SOCIAL] Error in /facebook/callback route:", error)
    const reason = toSafeErrorCode(extractErrorMessage(error), 'callback_error')
    ctx.redirect(buildCallbackHashUrl({ error: `facebook_${reason}` }, clientOrigin))
  }
})

// Provider status route to help diagnose production quickly
router.get("/providers", (ctx) => {
  const gcid = process.env.GOOGLE_CLIENT_ID || "";
  const gidMasked = gcid ? `${gcid.slice(0, 4)}...${gcid.slice(-6)}` : null;
  ctx.body = {
    google: GOOGLE_ENABLED,
    facebook: FACEBOOK_ENABLED,
    clientUrl: CLIENT_URL,
    googleCallbackUrl: process.env.GOOGLE_CALLBACK_URL || null,
    facebookCallbackUrl: process.env.FACEBOOK_CALLBACK_URL || null,
    googleClientIdHint: gidMasked,
    hasGoogleSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET || null),
    defaultClientOrigin,
    allowedClientOrigins: Array.from(allowedClientOrigins),
    timestamp: new Date().toISOString(),
  }
})




// Log all registered routes
console.log("[SOCIAL] Registered routes:")
console.log("- GET /auth/test")
console.log("- GET /auth/google")
console.log("- GET /auth/google/callback")
console.log("- GET /auth/facebook")
console.log("- GET /auth/facebook/callback")
console.log("- GET /auth/providers")

export default router










// import Router from '@koa/router';
// import jwt from 'jsonwebtoken';
// import passport from 'koa-passport';

// const router = new Router({ prefix: '/auth' });

// const CLIENT_URL = process.env.CLIENT_URL || process.env.FRONTEND_URL || 'http://localhost:3000';
// const JWT_SECRET = process.env.JWT_SECRET || 'catsay\'s hello';

// console.log('[SOCIAL] CLIENT_URL:', CLIENT_URL);
// console.log('[SOCIAL] JWT_SECRET exists:', !!JWT_SECRET);
// console.log('[SOCIAL] Routes being registered...');

// function redirectWithToken(ctx: any, user: any, nextPath = '/home') {
//   console.log('[SOCIAL] redirectWithToken called with user:', user.id, user.email);
  
//   const token = jwt.sign(
//     { 
//       userId: user.id, 
//       email: user.email,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       picture: user.profilePicture 
//     }, 
//     JWT_SECRET, 
//     { expiresIn: '7d' }
//   );
//   console.log('[SOCIAL] Generated token:', token.substring(0, 20) + '...');
  
//   // Set cookies on API domain
//   const secure = process.env.NODE_ENV === 'production';
//   // Set both names for compatibility with existing middleware/clients
//   ctx.cookies.set('auth_token', token, { 
//     path: '/', 
//     sameSite: 'lax', 
//     secure, 
//     httpOnly: false, 
//     maxAge: 604800000 
//   });
//   ctx.cookies.set('token', token, {
//     path: '/',
//     sameSite: 'lax',
//     secure,
//     httpOnly: false,
//     maxAge: 604800000,
//   });
  
//   const redirectUrl = `${CLIENT_URL}/auth/callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
//   console.log('[SOCIAL] Redirecting to:', redirectUrl);
  
//   ctx.redirect(redirectUrl);
// }

// // Test route to verify auth routes are working
// router.get('/test', (ctx) => {
//   console.log('[SOCIAL] Test route hit');
//   ctx.body = { message: 'Auth routes are working', timestamp: new Date().toISOString() };
// });

// // Google OAuth
// router.get('/google', async (ctx, next) => {
//   console.log('[SOCIAL] /google route hit');
//   console.log('[SOCIAL] Query params:', ctx.query);
  
//   try {
//     return await (passport.authenticate('google', {
//       session: false,
//       scope: ['profile', 'email'],
//       state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
//     }) as any)(ctx, next);
//   } catch (error) {
//     console.error('[SOCIAL] Error in /google route:', error);
//     ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_route_error`);
//   }
// });

// router.get('/google/callback', async (ctx, next) => {
//   console.log('[SOCIAL] /google/callback route hit');
//   console.log('[SOCIAL] Callback query params:', ctx.query);
  
//   try {
//     return await (passport.authenticate('google', { session: false }, (err, user) => {
//       console.log('[SOCIAL] Google auth result:', { err: !!err, user: !!user });
      
//       if (err) {
//         console.error('[SOCIAL] Google auth error:', err);
//         return ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_failed`);
//       }
      
//       if (!user) {
//         console.error('[SOCIAL] No user returned from Google');
//         return ctx.redirect(`${CLIENT_URL}/auth/callback?error=no_user`);
//       }
      
//       let nextPath = '/home';
//       try {
//         if (ctx.query.state) {
//           const s = JSON.parse(String(ctx.query.state));
//           if (s?.next && typeof s.next === 'string') nextPath = s.next;
//         }
//       } catch (e) {
//         console.warn('[SOCIAL] Failed to parse state:', e);
//       }
      
//       console.log('[SOCIAL] Proceeding with user:', user.email, 'nextPath:', nextPath);
//       redirectWithToken(ctx, user, nextPath);
//     }) as any)(ctx, next);
//   } catch (error) {
//     console.error('[SOCIAL] Error in /google/callback route:', error);
//     ctx.redirect(`${CLIENT_URL}/auth/callback?error=callback_error`);
//   }
// });

// // Facebook OAuth
// router.get('/facebook', async (ctx, next) => {
//   console.log('[SOCIAL] /facebook route hit');
  
//   try {
//     return await (passport.authenticate('facebook', {
//       session: false,
//       scope: ['email'],
//       state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
//     }) as any)(ctx, next);
//   } catch (error) {
//     console.error('[SOCIAL] Error in /facebook route:', error);
//     ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_route_error`);
//   }
// });

// router.get('/facebook/callback', async (ctx, next) => {
//   console.log('[SOCIAL] /facebook/callback route hit');
  
//   try {
//     return await (passport.authenticate('facebook', { session: false }, (err, user) => {
//       console.log('[SOCIAL] Facebook auth result:', { err: !!err, user: !!user });
      
//       if (err || !user) {
//         console.error('[SOCIAL] Facebook auth error:', err);
//         return ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_failed`);
//       }
      
//       let nextPath = '/home';
//       try {
//         if (ctx.query.state) {
//           const s = JSON.parse(String(ctx.query.state));
//           if (s?.next && typeof s.next === 'string') nextPath = s.next;
//         }
//       } catch (e) {
//         console.warn('[SOCIAL] Failed to parse state:', e);
//       }
      
//       redirectWithToken(ctx, user, nextPath);
//     }) as any)(ctx, next);
//   } catch (error) {
//     console.error('[SOCIAL] Error in /facebook/callback route:', error);
//     ctx.redirect(`${CLIENT_URL}/auth/callback?error=callback_error`);
//   }
// });

// // Log all registered routes
// console.log('[SOCIAL] Registered routes:');
// console.log('- GET /auth/test');
// console.log('- GET /auth/google');
// console.log('- GET /auth/google/callback');
// console.log('- GET /auth/facebook');
// console.log('- GET /auth/facebook/callback');

// export default router;
