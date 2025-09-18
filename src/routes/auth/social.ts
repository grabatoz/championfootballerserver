import Router from '@koa/router';
import jwt from 'jsonwebtoken';
import passport from 'koa-passport';

const router = new Router({ prefix: '/auth' });

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET || 'catsay\'s hello';

console.log('[SOCIAL] CLIENT_URL:', CLIENT_URL);
console.log('[SOCIAL] JWT_SECRET exists:', !!JWT_SECRET);

function redirectWithToken(ctx: any, user: any, nextPath = '/home') {
  console.log('[SOCIAL] redirectWithToken called with user:', user.id, user.email);
  
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  console.log('[SOCIAL] Generated token:', token.substring(0, 20) + '...');
  
  // Set cookies on API domain
  const secure = process.env.NODE_ENV === 'production';
  ctx.cookies.set('auth_token', token, { 
    path: '/', 
    sameSite: 'lax', 
    secure, 
    httpOnly: false, 
    maxAge: 604800000 
  });
  
  const redirectUrl = `${CLIENT_URL}/auth/callback?token=${encodeURIComponent(token)}&next=${encodeURIComponent(nextPath)}`;
  console.log('[SOCIAL] Redirecting to:', redirectUrl);
  
  ctx.redirect(redirectUrl);
}

// Google OAuth
router.get('/google', (ctx, next) => {
  console.log('[SOCIAL] /google route hit');
  return (passport.authenticate('google', {
    session: false,
    scope: ['profile', 'email'],
    state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
  }) as any)(ctx, next);
});

router.get('/google/callback', (ctx, next) => {
  console.log('[SOCIAL] /google/callback route hit');
  return (passport.authenticate('google', { session: false }, (err, user) => {
    console.log('[SOCIAL] Google auth result:', { err: !!err, user: !!user });
    
    if (err) {
      console.error('[SOCIAL] Google auth error:', err);
      return ctx.redirect(`${CLIENT_URL}/auth/callback?error=google_failed`);
    }
    
    if (!user) {
      console.error('[SOCIAL] No user returned from Google');
      return ctx.redirect(`${CLIENT_URL}/auth/callback?error=no_user`);
    }
    
    let nextPath = '/home';
    try {
      if (ctx.query.state) {
        const s = JSON.parse(String(ctx.query.state));
        if (s?.next && typeof s.next === 'string') nextPath = s.next;
      }
    } catch {}
    
    console.log('[SOCIAL] Proceeding with user:', user.email, 'nextPath:', nextPath);
    redirectWithToken(ctx, user, nextPath);
  }) as any)(ctx, next);
});

// Facebook OAuth
router.get('/facebook', (ctx, next) => {
  console.log('[SOCIAL] /facebook route hit');
  return (passport.authenticate('facebook', {
    session: false,
    scope: ['email'],
    state: JSON.stringify({ next: String(ctx.query.next || '/home') }),
  }) as any)(ctx, next);
});

router.get('/facebook/callback', (ctx, next) => {
  console.log('[SOCIAL] /facebook/callback route hit');
  return (passport.authenticate('facebook', { session: false }, (err, user) => {
    console.log('[SOCIAL] Facebook auth result:', { err: !!err, user: !!user });
    
    if (err || !user) {
      console.error('[SOCIAL] Facebook auth error:', err);
      return ctx.redirect(`${CLIENT_URL}/auth/callback?error=facebook_failed`);
    }
    
    let nextPath = '/home';
    try {
      if (ctx.query.state) {
        const s = JSON.parse(String(ctx.query.state));
        if (s?.next && typeof s.next === 'string') nextPath = s.next;
      }
    } catch {}
    
    redirectWithToken(ctx, user, nextPath);
  }) as any)(ctx, next);
});

export default router;