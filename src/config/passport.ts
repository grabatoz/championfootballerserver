import passport from 'koa-passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as FacebookStrategy } from 'passport-facebook';
import { User } from '../models/User';
import { findOrCreateSocialUser } from '../utils/socialUser';

export function setupPassport() {
  console.log('[PASSPORT] Setting up passport strategies');
  console.log('[PASSPORT] GOOGLE_CLIENT_ID exists:', !!process.env.GOOGLE_CLIENT_ID);
  console.log('[PASSPORT] GOOGLE_CLIENT_SECRET exists:', !!process.env.GOOGLE_CLIENT_SECRET);
  console.log('[PASSPORT] GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL);

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
        console.log('[PASSPORT] Google strategy callback triggered');
        console.log('[PASSPORT] Google profile:', profile.id, profile.emails?.[0]?.value);
        
        const email = profile.emails?.[0]?.value;
        if (!email) {
          console.error('[PASSPORT] No email from Google profile');
          return done(new Error('No email from Google'));
        }

        let user = await User.findOne({ where: { email } });
        console.log('[PASSPORT] Existing user found:', !!user);

        if (!user) {
          console.log('[PASSPORT] Creating new user for:', email);
          user = await User.create({
            email,
            password: '', // Add empty password for social users
            firstName: profile.name?.givenName || '',
            lastName: profile.name?.familyName || '',
            profilePicture: profile.photos?.[0]?.value,
            provider: 'google',
            position: 'Goalkeeper (GK)',
            positionType: 'Goalkeeper',
            style: 'Axe',
            preferredFoot: 'Right',
            shirtNumber: '1',
            skills: {
              dribbling: 50,
              shooting: 50,
              passing: 50,
              pace: 50,
              defending: 50,
              physical: 50
            }
          });
          console.log('[PASSPORT] New user created with ID:', user.id);
        }

        console.log('[PASSPORT] Returning user to callback:', user.email);
        return done(null, user);
      } catch (error) {
        console.error('[PASSPORT] Error in Google strategy:', error);
        return done(error);
      }
    }
  ));

  // FACEBOOK (only if env vars exist)
  if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
    console.log('[PASSPORT] Setting up Facebook strategy');
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
          console.log('[PASSPORT] Facebook strategy callback triggered');
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
          console.error('[PASSPORT] Error in Facebook strategy:', e);
          return done(e as any);
        }
      }
    ));
  } else {
    console.log('[PASSPORT] Facebook env vars missing, skipping Facebook strategy');
  }

  passport.serializeUser((user: any, done) => {
    console.log('[PASSPORT] Serializing user:', user.id);
    done(null, user);
  });
  
  passport.deserializeUser((obj: any, done) => {
    console.log('[PASSPORT] Deserializing user:', obj.id);
    done(null, obj);
  });
}

export default passport;