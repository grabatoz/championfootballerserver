import Router from '@koa/router';
import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import jwt from 'jsonwebtoken';
import models from '../models/index.js';

const router = new Router();
const { User } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'catsay\'s hello';
const CLIENT_URL = process.env.CLIENT_URL || 'https://championfootballer-client.vercel.app';

console.log('[SOCIAL] Social routes loaded');

// Configure Google Strategy
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: "/auth/google/callback"
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('[PASSPORT] Google strategy callback triggered');
    console.log('[PASSPORT] Google profile:', profile.id, profile.emails[0]?.value);

    const email = profile.emails[0]?.value;
    if (!email) {
      return done(new Error('No email found in Google profile'), null);
    }

    // Check if user exists
    let user = await User.findOne({ where: { email: email.toLowerCase() } });
    console.log('[PASSPORT] Existing user found:', !!user);

    if (!user) {
      // Create new user
      console.log('[PASSPORT] Creating new user from Google profile');
      user = await User.create({
        email: email.toLowerCase(),
        firstName: profile.name?.givenName || 'User',
        lastName: profile.name?.familyName || 'Player',
        profilePicture: profile.photos[0]?.value || null,
        position: 'Midfielder',
        positionType: 'Midfielder',
        style: 'Balanced',
        preferredFoot: 'Right',
        shirtNumber: Math.floor(Math.random() * 99) + 1,
        skills: {
          dribbling: 50,
          shooting: 50,
          passing: 50,
          pace: 50,
          defending: 50,
          physical: 50
        }
      });
    }

    console.log('[PASSPORT] Returning user to callback:', user.email);
    return done(null, user);
  } catch (error) {
    console.error('[PASSPORT] Google strategy error:', error);
    return done(error, null);
  }
}));

// Google Auth Routes
router.get('/auth/google', (ctx) => {
  console.log('[SOCIAL] /google route hit');
  const next = ctx.query.next || '/home';
  
  // Store next URL in session or pass as state
  const authURL = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(process.env.API_URL + '/auth/google/callback')}&` +
    `response_type=code&` +
    `scope=profile email&` +
    `state=${encodeURIComponent(next)}`;
  
  ctx.redirect(authURL);
});

router.get('/auth/google/callback', async (ctx) => {
  console.log('[SOCIAL] /google/callback route hit');
  
  try {
    const { code, state } = ctx.query;
    const next = state || '/home';
    
    if (!code) {
      console.error('[SOCIAL] No authorization code received');
      ctx.redirect(`${CLIENT_URL}/?error=auth_failed`);
      return;
    }

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: process.env.API_URL + '/auth/google/callback'
      })
    });

    const tokens = await tokenResponse.json();
    
    if (!tokens.access_token) {
      console.error('[SOCIAL] Failed to get access token');
      ctx.redirect(`${CLIENT_URL}/?error=token_failed`);
      return;
    }

    // Get user profile
    const profileResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });

    const profile = await profileResponse.json();
    
    if (!profile.email) {
      console.error('[SOCIAL] No email in profile');
      ctx.redirect(`${CLIENT_URL}/?error=no_email`);
      return;
    }

    // Find or create user
    let user = await User.findOne({ where: { email: profile.email.toLowerCase() } });
    
    if (!user) {
      user = await User.create({
        email: profile.email.toLowerCase(),
        firstName: profile.given_name || 'User',
        lastName: profile.family_name || 'Player',
        profilePicture: profile.picture || null,
        position: 'Midfielder',
        positionType: 'Midfielder',
        style: 'Balanced',
        preferredFoot: 'Right',
        shirtNumber: Math.floor(Math.random() * 99) + 1,
        skills: {
          dribbling: 50,
          shooting: 50,
          passing: 50,
          pace: 50,
          defending: 50,
          physical: 50
        }
      });
    }

    // Generate JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log('[SOCIAL] Generated token for user:', user.email);
    console.log('[SOCIAL] Redirecting to:', `${CLIENT_URL}/auth/callback?token=${token}&next=${encodeURIComponent(next)}`);

    // Redirect to client with token
    ctx.redirect(`${CLIENT_URL}/auth/callback?token=${token}&next=${encodeURIComponent(next)}`);
    
  } catch (error) {
    console.error('[SOCIAL] Callback error:', error);
    ctx.redirect(`${CLIENT_URL}/?error=server_error`);
  }
});

export default router;