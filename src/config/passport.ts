import passport from 'koa-passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import AppleStrategy from 'passport-apple';
import { findOrCreateSocialUser } from '../utils/socialUser';

export function setupPassport() {
  console.log('[OAUTH] GOOGLE_CALLBACK_URL =', process.env.GOOGLE_CALLBACK_URL);
  console.log('[OAUTH] FACEBOOK_CALLBACK_URL =', process.env.FACEBOOK_CALLBACK_URL);
  console.log('[OAUTH] APPLE_CALLBACK_URL =', process.env.APPLE_CALLBACK_URL);

  // GOOGLE
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      callbackURL: process.env.GOOGLE_CALLBACK_URL!,
      scope: ['profile', 'email'],
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || null;
        const avatar = profile.photos?.[0]?.value || null;
        const user = await findOrCreateSocialUser({
          provider: 'google',
          providerId: profile.id,
          email,
          name: profile.displayName || null,
          avatar,
        });
        return done(null, user);
      } catch (e) {
        return done(e as any);
      }
    }
  ));

  // FACEBOOK
  passport.use(new FacebookStrategy(
    {
      clientID: process.env.FACEBOOK_APP_ID!,
      clientSecret: process.env.FACEBOOK_APP_SECRET!,
      callbackURL: process.env.FACEBOOK_CALLBACK_URL!,
      profileFields: ['id', 'displayName', 'emails', 'photos'],
      enableProof: true,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || null;
        const avatar = profile.photos?.[0]?.value || null;
        const user = await findOrCreateSocialUser({
          provider: 'facebook',
          providerId: profile.id,
          email,
          name: profile.displayName || null,
          avatar,
        });
        return done(null, user);
      } catch (e) {
        return done(e as any);
      }
    }
  ));

  // APPLE
  const applePrivateKey = Buffer.from(process.env.APPLE_PRIVATE_KEY_BASE64 || '', 'base64').toString('utf8');
  passport.use(new (AppleStrategy as any)(
    {
      clientID: process.env.APPLE_CLIENT_ID!,
      teamID: process.env.APPLE_TEAM_ID!,
      keyID: process.env.APPLE_KEY_ID!,
      privateKey: applePrivateKey,
      callbackURL: process.env.APPLE_CALLBACK_URL!,
      scope: ['name', 'email'],
    },
    async (_accessToken: any, _refreshToken: any, idToken: any, profile: any, done: any) => {
      try {
        const providerId = profile?.id || idToken?.sub;
        const email = profile?.email || idToken?.email || null;
        const name = profile?.name?.fullName || null;
        const user = await findOrCreateSocialUser({
          provider: 'apple',
          providerId,
          email,
          name,
          avatar: null,
        });
        return done(null, user);
      } catch (e) {
        return done(e);
      }
    }
  ));

  passport.serializeUser((user: any, done) => done(null, user));
  passport.deserializeUser((obj: any, done) => done(null, obj));
}

export default passport;