import Router from '@koa/router';
import jwt from 'jsonwebtoken';
import passport from 'koa-passport';

const router = new Router({ prefix: '/auth' });

const CLIENT_URL = process.env.CLIENT_URL!;
const JWT_SECRET = process.env.JWT_SECRET!;
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL!;
const FACEBOOK_CALLBACK_URL = process.env.FACEBOOK_CALLBACK_URL;
const APPLE_CALLBACK_URL = process.env.APPLE_CALLBACK_URL;

function redirectWithToken(ctx: any, user: any, nextPath: string = '/home') {
  const token = jwt.sign({ userId: String(user.id), email: user.email || null }, JWT_SECRET, { expiresIn: '7d' });
  const url = `${CLIENT_URL}/auth/callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
  ctx.redirect(url);
}

// GOOGLE
router.get('/google', (ctx, next) =>
  (passport.authenticate('google', {
    session: false,
    scope: ['profile', 'email'],
    callbackURL: GOOGLE_CALLBACK_URL,
    state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
  }) as any)(ctx, next)
);

router.get('/google/callback', (ctx, next) =>
  (passport.authenticate('google', { session: false }, (err, user, info) => {
    if (err || !user) return ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_failed`);
    let nextPath = '/home';
    try {
      if (ctx.query.state) {
        const s = JSON.parse(String(ctx.query.state));
        if (s?.next && typeof s.next === 'string') nextPath = s.next;
      }
    } catch {}
    redirectWithToken(ctx, user, nextPath);
  }) as any)(ctx, next)
);

// FACEBOOK
router.get('/facebook', (ctx, next) =>
  (passport.authenticate('facebook', {
    session: false,
    scope: ['email'],
    callbackURL: FACEBOOK_CALLBACK_URL || undefined,
    state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
  }) as any)(ctx, next)
);

router.get('/facebook/callback', (ctx, next) =>
  (passport.authenticate('facebook', { session: false }, (err, user) => {
    if (err || !user) return ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_failed`);
    let nextPath = '/home';
    try {
      if (ctx.query.state) {
        const s = JSON.parse(String(ctx.query.state));
        if (s?.next && typeof s.next === 'string') nextPath = s.next;
      }
    } catch {}
    redirectWithToken(ctx, user, nextPath);
  }) as any)(ctx, next)
);

// APPLE
router.get('/apple', (ctx, next) =>
  (passport.authenticate('apple', {
    session: false,
    callbackURL: APPLE_CALLBACK_URL || undefined,
    state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
  }) as any)(ctx, next)
);

router.post('/apple/callback', (ctx, next) =>
  (passport.authenticate('apple', { session: false }, (err, user) => {
    if (err || !user) return ctx.redirect(`${CLIENT_URL}/auth/callback?error=apple_failed`);
    let nextPath = '/home';
    try {
      if (ctx.query.state) {
        const s = JSON.parse(String(ctx.query.state));
        if (s?.next && typeof s.next === 'string') nextPath = s.next;
      }
    } catch {}
    redirectWithToken(ctx, user, nextPath);
  }) as any)(ctx, next)
);

export default router;