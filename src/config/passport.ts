import passport from "koa-passport"
import { Strategy as GoogleStrategy } from "passport-google-oauth20"
import { Strategy as FacebookStrategy } from "passport-facebook"
import { User } from "../models/User"
import { transporter } from "../modules/sendEmail"

export function setupPassport() {
  console.log("[PASSPORT] Setting up passport strategies")
  const hasGoogle =
    !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET && !!process.env.GOOGLE_CALLBACK_URL

    
  console.log("[PASSPORT] GOOGLE_CLIENT_ID exists:", !!process.env.GOOGLE_CLIENT_ID)
  console.log("[PASSPORT] GOOGLE_CLIENT_SECRET exists:", !!process.env.GOOGLE_CLIENT_SECRET)
  console.log("[PASSPORT] GOOGLE_CALLBACK_URL:", process.env.GOOGLE_CALLBACK_URL)

  if (hasGoogle) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          callbackURL: process.env.GOOGLE_CALLBACK_URL!,
          scope: ["profile", "email"],
        },
        async (_accessToken, _refreshToken, profile, done) => {
          try {
            console.log("[PASSPORT] Google strategy callback triggered")
            console.log("[PASSPORT] Google profile:", profile.id, profile.emails?.[0]?.value)

            const email = profile.emails?.[0]?.value
            if (!email) {
              console.error("[PASSPORT] No email from Google profile")
              return done(new Error("No email from Google"), false)
            }

            let user = await User.findOne({ where: { email } })
            console.log("[PASSPORT] Existing user found:", !!user)

            if (!user) {
              console.log("[PASSPORT] Creating new user for:", email)
              user = await User.create({
                email,
                password: "",
                firstName: profile.name?.givenName || "",
                lastName: profile.name?.familyName || "",
                profilePicture: profile.photos?.[0]?.value,
                provider: "google",
                providerId: profile.id,
                isVerified: true,
                position: "Goalkeeper (GK)",
                positionType: "Goalkeeper",
                style: "Axe",
                preferredFoot: "Right",
                shirtNumber: "1",
                age: 0,
                gender: "male",
                skills: {
                  dribbling: 50,
                  shooting: 50,
                  passing: 50,
                  pace: 50,
                  defending: 50,
                  physical: 50,
                },
                xp: 0,
                achievements: [],
              })
              console.log("[PASSPORT] New user created with ID:", user.id)

              // Send welcome email for new Google user
              try {
                await transporter.sendMail({
                  to: user.email,
                  subject: `Welcome to Champion Footballer!`,
                  html: `
                    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;background:#f7f7f9;padding:24px">
                      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
                        <h1 style="margin:0 0 12px;font-size:22px;color:#111;">Welcome, ${user.firstName || 'Player'}! ⚽</h1>
                        <p style="margin:0 0 8px;">Your account has been created successfully via Google.</p>
                        <p style="margin:0 0 8px;">Quick start:</p>
                        <ol style="padding-left:18px;margin:0 0 16px;">
                          <li>Complete your profile and join/create a league.</li>
                          <li>Start playing and earning XP!</li>
                        </ol>
                        <a href="${process.env.CLIENT_URL ?? 'https://championfootballer-client.vercel.app'}"
                           style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">
                          Open Champion Footballer
                        </a>
                        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
                        <p style="margin:0 0 6px;">Follow us for updates:</p>
                        <p style="margin:0;">
                          <a href="${process.env.SOCIAL_X_URL ?? 'https://x.com/champf2baller'}" style="color:#0ea5e9;text-decoration:none;margin-right:12px;">X (Twitter)</a>
                          <a href="${process.env.SOCIAL_FB_URL ?? 'https://facebook.com/championfootballer'}" style="color:#0ea5e9;text-decoration:none;margin-right:12px;">Facebook</a>
                          <a href="${process.env.SOCIAL_IG_URL ?? 'https://www.instagram.com/champf2baller'}" style="color:#0ea5e9;text-decoration:none;">Instagram</a>
                        </p>
                      </div>
                    </div>
                  `,
                });
                console.log("[PASSPORT] Welcome email sent to Google user:", user.email);
              } catch (emailError) {
                console.error("[PASSPORT] Error sending welcome email to Google user:", emailError);
              }
            }

            console.log("[PASSPORT] Returning user to callback:", user.email)
            return done(null, user)
          } catch (error) {
            console.error("[PASSPORT] Error in Google strategy:", error)
            return done(error, false)
          }
        },
      ),
    )
  } else {
    console.log("[PASSPORT] Google env vars missing, skipping Google strategy")
  }

  // FACEBOOK (only if env vars exist)
  const hasFacebook =
    !!process.env.FACEBOOK_APP_ID && !!process.env.FACEBOOK_APP_SECRET && !!process.env.FACEBOOK_CALLBACK_URL

  if (hasFacebook) {
    console.log("[PASSPORT] Setting up Facebook strategy")
    passport.use(
      new FacebookStrategy(
        {
          clientID: process.env.FACEBOOK_APP_ID!,
          clientSecret: process.env.FACEBOOK_APP_SECRET!,
          callbackURL: process.env.FACEBOOK_CALLBACK_URL!,
          profileFields: ["id", "displayName", "emails", "photos"],
          enableProof: true,
        },
        async (_accessToken, _refreshToken, profile, done) => {
          try {
            console.log("[PASSPORT] Facebook strategy callback triggered")
            const email = profile.emails?.[0]?.value || null

            if (!email) {
              return done(new Error("No email from Facebook"), false)
            }

            let user = await User.findOne({ where: { email } })

            if (!user) {
              const [firstName, ...lastNameParts] = (profile.displayName || "").split(" ")
              user = await User.create({
                email,
                password: "",
                firstName: firstName || "",
                lastName: lastNameParts.join(" ") || "",
                profilePicture: profile.photos?.[0]?.value,
                provider: "facebook",
                providerId: profile.id,
                isVerified: true,
                position: "Goalkeeper (GK)",
                positionType: "Goalkeeper",
                style: "Axe",
                preferredFoot: "Right",
                shirtNumber: "1",
                age: 0,
                gender: "male",
                skills: {
                  dribbling: 50,
                  shooting: 50,
                  passing: 50,
                  pace: 50,
                  defending: 50,
                  physical: 50,
                },
                xp: 0,
                achievements: [],
              })

              // Send welcome email for new Facebook user
              try {
                await transporter.sendMail({
                  to: user.email,
                  subject: `Welcome to Champion Footballer!`,
                  html: `
                    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;background:#f7f7f9;padding:24px">
                      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
                        <h1 style="margin:0 0 12px;font-size:22px;color:#111;">Welcome, ${user.firstName || 'Player'}! ⚽</h1>
                        <p style="margin:0 0 8px;">Your account has been created successfully via Facebook.</p>
                        <p style="margin:0 0 8px;">Quick start:</p>
                        <ol style="padding-left:18px;margin:0 0 16px;">
                          <li>Complete your profile and join/create a league.</li>
                          <li>Start playing and earning XP!</li>
                        </ol>
                        <a href="${process.env.CLIENT_URL ?? 'https://championfootballer-client.vercel.app'}"
                           style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">
                          Open Champion Footballer
                        </a>
                        <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
                        <p style="margin:0 0 6px;">Follow us for updates:</p>
                        <p style="margin:0;">
                          <a href="${process.env.SOCIAL_X_URL ?? 'https://x.com/champf2baller'}" style="color:#0ea5e9;text-decoration:none;margin-right:12px;">X (Twitter)</a>
                          <a href="${process.env.SOCIAL_FB_URL ?? 'https://facebook.com/championfootballer'}" style="color:#0ea5e9;text-decoration:none;margin-right:12px;">Facebook</a>
                          <a href="${process.env.SOCIAL_IG_URL ?? 'https://www.instagram.com/champf2baller'}" style="color:#0ea5e9;text-decoration:none;">Instagram</a>
                        </p>
                      </div>
                    </div>
                  `,
                });
                console.log("[PASSPORT] Welcome email sent to Facebook user:", user.email);
              } catch (emailError) {
                console.error("[PASSPORT] Error sending welcome email to Facebook user:", emailError);
              }
            }

            // Return basic user without associations
            return done(null, user)
          } catch (e) {
            console.error("[PASSPORT] Error in Facebook strategy:", e)
            return done(e as any, false)
          }
        },
      ),
    )
  } else {
    console.log("[PASSPORT] Facebook env vars missing, skipping Facebook strategy")
  }

  passport.serializeUser((user: any, done) => {
    console.log("[PASSPORT] Serializing user:", user.id)
    done(null, user)
  })

  passport.deserializeUser((obj: any, done) => {
    console.log("[PASSPORT] Deserializing user:", obj.id)
    done(null, obj)
  })
}

export default passport










// import passport from 'koa-passport';
// import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
// import { Strategy as FacebookStrategy } from 'passport-facebook';
// import { User } from '../models/User';

// export function setupPassport() {
//   console.log('[PASSPORT] Setting up passport strategies');
//   console.log('[PASSPORT] GOOGLE_CLIENT_ID exists:', !!process.env.GOOGLE_CLIENT_ID);
//   console.log('[PASSPORT] GOOGLE_CLIENT_SECRET exists:', !!process.env.GOOGLE_CLIENT_SECRET);
//   console.log('[PASSPORT] GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL);

//   // GOOGLE
//   passport.use(new GoogleStrategy(
//     {
//       clientID: process.env.GOOGLE_CLIENT_ID!,
//       clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
//       callbackURL: process.env.GOOGLE_CALLBACK_URL!,
//       scope: ['profile', 'email'],
//     },
//     async (_accessToken, _refreshToken, profile, done) => {
//       try {
//         console.log('[PASSPORT] Google strategy callback triggered');
//         console.log('[PASSPORT] Google profile:', profile.id, profile.emails?.[0]?.value);
        
//         const email = profile.emails?.[0]?.value;
//         if (!email) {
//           console.error('[PASSPORT] No email from Google profile');
//           return done(new Error('No email from Google'), false);
//         }

//         let user = await User.findOne({ where: { email } });
//         console.log('[PASSPORT] Existing user found:', !!user);

//         if (!user) {
//           console.log('[PASSPORT] Creating new user for:', email);
//           user = await User.create({
//             email,
//             password: '', // Required field - empty for social users
//             firstName: profile.name?.givenName || '',
//             lastName: profile.name?.familyName || '',
//             profilePicture: profile.photos?.[0]?.value,
//             provider: 'google',
//             providerId: profile.id,
//             position: 'Goalkeeper (GK)',
//             positionType: 'Goalkeeper',
//             style: 'Axe',
//             preferredFoot: 'Right',
//             shirtNumber: '1',
//             age: 0,
//             gender: 'male',
//             skills: {
//               dribbling: 50,
//               shooting: 50,
//               passing: 50,
//               pace: 50,
//               defending: 50,
//               physical: 50
//             },
//             xp: 0,
//             achievements: []
//           });
//           console.log('[PASSPORT] New user created with ID:', user.id);
//         }

//         // Return basic user without associations to avoid errors
//         console.log('[PASSPORT] Returning user to callback:', user.email);
//         return done(null, user);
//       } catch (error) {
//         console.error('[PASSPORT] Error in Google strategy:', error);
//         return done(error, false);
//       }
//     }
//   ));

//   // FACEBOOK (only if env vars exist)
//   if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
//     console.log('[PASSPORT] Setting up Facebook strategy');
//     passport.use(new FacebookStrategy(
//       {
//         clientID: process.env.FACEBOOK_APP_ID!,
//         clientSecret: process.env.FACEBOOK_APP_SECRET!,
//         callbackURL: process.env.FACEBOOK_CALLBACK_URL!,
//         profileFields: ['id', 'displayName', 'emails', 'photos'],
//         enableProof: true,
//       },
//       async (_accessToken, _refreshToken, profile, done) => {
//         try {
//           console.log('[PASSPORT] Facebook strategy callback triggered');
//           const email = profile.emails?.[0]?.value || null;
          
//           if (!email) {
//             return done(new Error('No email from Facebook'), false);
//           }

//           let user = await User.findOne({ where: { email } });

//           if (!user) {
//             const [firstName, ...lastNameParts] = (profile.displayName || '').split(' ');
//             user = await User.create({
//               email,
//               password: '',
//               firstName: firstName || '',
//               lastName: lastNameParts.join(' ') || '',
//               profilePicture: profile.photos?.[0]?.value,
//               provider: 'facebook',
//               providerId: profile.id,
//               position: 'Goalkeeper (GK)',
//               positionType: 'Goalkeeper',
//               style: 'Axe',
//               preferredFoot: 'Right',
//               shirtNumber: '1',
//               age: 0,
//               gender: 'male',
//               skills: {
//                 dribbling: 50,
//                 shooting: 50,
//                 passing: 50,
//                 pace: 50,
//                 defending: 50,
//                 physical: 50
//               },
//               xp: 0,
//               achievements: []
//             });
//           }

//           // Return basic user without associations
//           return done(null, user);
//         } catch (e) {
//           console.error('[PASSPORT] Error in Facebook strategy:', e);
//           return done(e as any, false);
//         }
//       }
//     ));
//   } else {
//     console.log('[PASSPORT] Facebook env vars missing, skipping Facebook strategy');
//   }

//   passport.serializeUser((user: any, done) => {
//     console.log('[PASSPORT] Serializing user:', user.id);
//     done(null, user);
//   });
  
//   passport.deserializeUser((obj: any, done) => {
//     console.log('[PASSPORT] Deserializing user:', obj.id);
//     done(null, obj);
//   });
// }

// export default passport;