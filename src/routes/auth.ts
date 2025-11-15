import Router from '@koa/router';
import { transporter } from "../modules/sendEmail"
import { none, required } from "../modules/auth"
import models, { MatchAvailability } from "../models"
import { User } from "../models/User";
import { hash, compare } from "bcrypt"
import { getLoginCode } from "../modules/utils"
import { Context } from "koa";
import jwt from 'jsonwebtoken';
import cache from '../utils/cache'; // ensure this exists and has get/set
import crypto from 'crypto';
import type { FindAttributeOptions } from 'sequelize'; // ADD THIS

const router = new Router();
const { League, Match, Session } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'catsay\'s hello';
// In-flight promise coalescing to prevent thundering herd on cache miss
type CachedResponse<T> = { payload: T; etag: string };
const inFlight = new Map<string, Promise<any>>();

function getCachedWithEtag<T = any>(key: string): CachedResponse<T> | undefined {
  const v = cache.get<any>(key);
  if (!v) return undefined;
  if (v && typeof v === 'object' && 'payload' in v && 'etag' in v) {
    return v as CachedResponse<T>;
  }
  // Backward compatibility: older cache entries stored just the payload
  try {
    const etag = crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
    return { payload: v as T, etag };
  } catch {
    // Fallback to forcing refresh if stringify fails
    return undefined;
  }
}

function setCachedWithEtag<T = any>(key: string, payload: T, ttlSec: number): CachedResponse<T> {
  const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  const entry: CachedResponse<T> = { payload, etag };
  cache.set(key, entry, ttlSec);
  return entry;
}

// Simple concurrency limiter for batched DB calls
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

interface UserInput {
  firstName?: string;
  lastName?: string;
  age?: number;
  email: string;
  gender?: string;
  position?: string;
  positionType?: string;
  password: string;
}

interface CustomContext extends Context {
  session?: {
    userId: string;
  };
}

// type User = InstanceType<typeof userModel> & {
//   leaguesJoined: League[];
//   matchStatistics: Match[];
// };

// type LeagueWithAssociations = League & {
//   admins: InstanceType<typeof userModel>[];
//   users: InstanceType<typeof userModel>[];
//   matches: Match[];
// }

// type MatchWithAssociations = Match & {
//   availableUsers?: InstanceType<typeof userModel>[];
//   homeTeamUsers?: InstanceType<typeof userModel>[];
//   awayTeamUsers?: InstanceType<typeof userModel>[];
// }

// type UserWithAssociations = User & {
//   leaguesJoined: LeagueWithAssociations[];
//   matchStatistics: MatchWithAssociations[];
// }

router.post("/auth/register", none, async (ctx: Context) => {
  try {
    console.log('Received registration request:', {
      body: ctx.request.body,
      headers: ctx.request.headers,
      method: ctx.request.method,
      url: ctx.request.url
    });

    const userData = ctx.request.body.user || ctx.request.body;
    console.log('Parsed user data:', userData);

    if (!userData || !userData.email || !userData.password) {
      console.log('Missing required fields:', { userData });
      ctx.throw(400, "Email and password are required");
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(userData.email)) {
      ctx.throw(400, "Invalid email format");
    }

    // Validate password strength
    if (userData.password.length < 6) {
      ctx.throw(400, "Password must be at least 6 characters long");
    }

    // Convert email to lowercase
    userData.email = userData.email.toLowerCase();

    // Check if user already exists
    const existingUser = await User.findOne({ where: { email: userData.email } });
    if (existingUser) {
      ctx.throw(409, "User with that email already exists");
    }

    console.log('Creating new user with data:', {
      email: userData.email,
      firstName: userData.firstName,
      lastName: userData.lastName,
      age: userData.age,
      gender: userData.gender,
      country: userData.country,
      state: userData.state,
      city: userData.city
    });

    // Create user with all required fields
    const newUser = await User.create({
      email: userData.email,
      password: await hash(userData.password, 10),
      firstName: userData.firstName || '',
      lastName: userData.lastName || '',
      age: userData.age ? parseInt(userData.age) : undefined,
      gender: userData.gender,
      country: userData.country ?? null,
      state: userData.state ?? null,
      city: userData.city ?? null,
      position: userData.position || 'Goalkeeper (GK)',
      positionType: userData.positionType || 'Goalkeeper',
      style: userData.style || 'Axe',
      preferredFoot: userData.preferredFoot || 'Right',
      shirtNumber: userData.shirtNumber || 1,
      profilePicture: userData.profilePicture,
      skills: {
        dribbling: 50,
        shooting: 50,
        passing: 50,
        pace: 50,
        defending: 50,
        physical: 50
      }
    });

    console.log('User created successfully:', newUser.id);

    // Generate JWT
    const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '7d' });

    console.log('JWT generated for new user');

    // Send welcome email
    try {
      if (newUser.email) {
        await transporter.sendMail({
          to: newUser.email,
          subject: `Welcome to Champion Footballer!`,
          html: `
            <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;background:#f7f7f9;padding:24px">
              <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;padding:24px">
                <h1 style="margin:0 0 12px;font-size:22px;color:#111;">Welcome, ${newUser.firstName || 'Player'}! ⚽</h1>
                <p style="margin:0 0 8px;">Your account has been created successfully.</p>

                <p style="margin:0 0 8px;">Quick start:</p>
                <ol style="padding-left:18px;margin:0 0 16px;">
                  <li>Click the button below to open Champion Footballer.</li>
                  <li>Sign in with your email: <b>${newUser.email}</b>.</li>
                  <li>Complete your profile and join/create a league.</li>
                </ol>

                <a href="${process.env.CLIENT_URL ?? 'https://championfootballer-client.vercel.app'}"
                   style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600">
                  Login to Champion Footballer
                </a>

                <p style="margin:12px 0 0;font-size:12px;color:#6b7280;">
                  If the button doesn’t work, copy and paste this link:<br/>
                  <span style="word-break:break-all;">${process.env.CLIENT_URL ?? 'https://championfootballer-client.vercel.app'}</span>
                </p>

                <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />

                <p style="margin:0 0 8px;">Need help? Reply to this email any time.</p>
                <p style="margin:0 0 6px;">Follow us for updates:</p>
                <p style="margin:0;">
                  <a href="${process.env.SOCIAL_X_URL  ?? 'https://x.com/champf2baller'}" style="color:#0ea5e9;text-decoration:none;margin-right:12px;">X (Twitter)</a>
                  <a href="${process.env.SOCIAL_FB_URL ?? 'https://facebook.com/championfootballer'}" style="color:#0ea5e9;text-decoration:none;margin-right:12px;">Facebook</a>
                  <a href="${process.env.SOCIAL_IG_URL ?? 'https://www.instagram.com/champf2baller'}" style="color:#0ea5e9;text-decoration:none;">Instagram</a>
                </p>
              </div>
            </div>
          `,
        });
      } else {
        console.warn('Welcome email skipped: user has no email');
      }
    } catch (emailError) {
      console.error('Error sending welcome email:', emailError);
    }

    // Update cache with new user data
    const newUserData = {
      id: newUser.id,
      firstName: newUser.firstName,
      lastName: newUser.lastName,
      profilePicture: newUser.profilePicture,
      position: newUser.position,
      positionType: newUser.positionType,
      xp: newUser.xp || 0
    };

    // Update players cache with new user
    cache.updateArray('players_all', newUserData);
    
    // Clear any user-specific caches
    cache.clearPattern(`user_leagues_${newUser.id}`);

    // Return success response with token and user data
    ctx.status = 200;
    ctx.body = { 
      success: true,
      token: token,
      redirectTo: '/home',
      user: {
        id: newUser.id,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        email: newUser.email,
        age: newUser.age,
        gender: newUser.gender,
        country: newUser.country,
        state: newUser.state,
        city: newUser.city,
        position: newUser.position,
        positionType: newUser.positionType,
        style: newUser.style,
        preferredFoot: newUser.preferredFoot,
        shirtNumber: newUser.shirtNumber,
        profilePicture: newUser.profilePicture,
        skills: newUser.skills,
        xp: newUser.xp || 0,
        joinedLeagues: [],
        managedLeagues: [],
        homeTeamMatches: [],
        awayTeamMatches: [],
        availableMatches: []
      },
      message: "Registration successful"
    };
  } catch (error: any) {
    console.error('Registration error:', error);
    if (error.status) {
      ctx.status = error.status;
      ctx.body = { 
        success: false,
        message: error.message 
      };
    } else {
      ctx.status = 500;
      ctx.body = { 
        success: false,
        message: "Error creating user. Please try again." 
      };
    }
  }
});

router.post("/auth/reset-password", none, async (ctx: CustomContext) => {
  const { email } = ctx.request.body.user as UserInput;
  if (!email) {
    ctx.throw(400, "Email is required");
  }
  
  const userEmail = email.toLowerCase();
  const password = getLoginCode();

  const user = await User.findOne({ where: { email: userEmail } });
  if (!user) {
    ctx.throw(404, "We can't find a user with that email.");
  }

  await user.update({ password: await hash(password, 10) });

  await transporter.sendMail({
    to: userEmail,
    subject: `Password reset for Champion Footballer`,
    html: `Please use the new password ${password} to login.`,
  });

  ctx.response.status = 200;
});

router.post("/auth/login", none, async (ctx: CustomContext) => {
  const { email, password } = ctx.request.body.user as UserInput;
  if (!email || !password) {
    ctx.throw(401, "No email or password entered.");
  }

  const userEmail = email.toLowerCase();
  const user = await User.findOne({
    where: { email },
    attributes: ['id','firstName','lastName','email','password','age','gender','country','state','city','position','positionType','style','preferredFoot','shirtNumber','profilePicture','skills','xp','achievements','provider'] // removed providerId
  });

  console.log('first',email,user)

  if (!user) {
    ctx.throw(404, "We can't find a user with that email");
  }

  if (!user.password) {
    ctx.throw(400, "User has no password. Please reset it now.");
  }

  console.log('🔍 Password comparison:', {
    providedPassword: password,
    hashedPassword: user.password,
    passwordLength: user.password?.length
  });

  const passwordMatch = await compare(password, user.password);
  console.log('🔍 Password match result:', passwordMatch);

  if (!passwordMatch) {
    ctx.throw(401, "Incorrect login details.");
  }

  // Generate JWT
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

  ctx.status = 200;
  ctx.body = {
    success: true,
    token: token,
    redirectTo: '/home',
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      age: user.age,
      gender: user.gender,
      country: (user as any).country,
      state: (user as any).state,
      city: (user as any).city,
      position: user.position,
      positionType: user.positionType,
      style: user.style,
      preferredFoot: user.preferredFoot,
      shirtNumber: user.shirtNumber,
      profilePicture: user.profilePicture,
      skills: user.skills,
      xp: user.xp || 0,
      joinedLeagues: [],
      managedLeagues: [],
      homeTeamMatches: [],
      awayTeamMatches: [],
      availableMatches: []
    }
  };
});



router.post("/auth/logout", required, async (ctx: CustomContext) => {
  // For JWT, logout is handled on the client-side by deleting the token.
  // This endpoint can be kept for session invalidation if you mix strategies,
  // but for pure JWT it's often not needed.
  ctx.status = 200;
  ctx.body = { success: true, message: "Logged out successfully." };
}); 

router.get("/auth/data", required, async (ctx: CustomContext) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  // Ultra-fast cache for instant league create/delete updates
  const AUTH_CACHE_TTL_SEC = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 2);      // 2s server cache (instant updates)
  const AUTH_CLIENT_MAX_AGE_SEC = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 0); // 0s browser cache (no browser caching)

  // Allow manual bypass: /auth/data?refresh=1 (or nocache=1)
  const q = ctx.query as Record<string, string | undefined>;
  const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

  const userId = ctx.state.user.userId;
  const cacheKey = `auth_data_${userId}_ultra_fast`;

  // Serve cache if present (unless bypassed)
  if (!forceRefresh) {
    const cached = getCachedWithEtag(cacheKey);
    if (cached) {
      ctx.set('ETag', cached.etag);
      ctx.set('Cache-Control', `private, max-age=${AUTH_CLIENT_MAX_AGE_SEC}`);
      if (ctx.get('If-None-Match') === cached.etag) {
        ctx.status = 304;
        return;
      }
      ctx.set('X-Cache', 'HIT');
      ctx.body = cached.payload;
      return;
    }
  } else {
    ctx.set('X-Cache', 'BYPASS');
  }

  const t0 = Date.now();

  // Ultra-minimal attributes for match users to reduce payload
  const lightUserAttrsOnMatch: FindAttributeOptions = ['id', 'firstName', 'lastName'];
  const MATCH_FETCH_CONCURRENCY = Number(process.env.AUTH_DATA_MATCH_FETCH_CONCURRENCY ?? 10);
  // Coalesce concurrent cache misses by using a shared in-flight promise
  let work = inFlight.get(cacheKey) as Promise<any> | undefined;
  if (!work) {
    work = (async () => {
      // STEP 1: Load user + leagues + members (no matches here)
  const user = await User.findByPk(userId, {
        attributes: [
          'id',
          'firstName',
          'lastName',
          'email',
          'age',
          'gender',
          'country',
          'state',
          'city',
          'position',
          'positionType',
          'style',
          'preferredFoot',
          'shirtNumber',
          'profilePicture',
          'skills',
          'xp',
          'updatedAt',
        ],
        include: [
          {
            model: League,
            as: 'leagues',
            attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
            through: { attributes: [] },
            include: [
              {
                model: User,
                as: 'members',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              }
            ],
          },
          {
            model: League,
            as: 'administeredLeagues',
            attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
            through: { attributes: [] },
            include: [
              {
                model: User,
                as: 'members',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              }
            ],
          },
        ],
      }) as any;

      if (!user) {
        return { notFound: true };
      }

      // STEP 2: Load matches per league concurrently (limit 5) and then batch-attach users
      if (user && user.leagues && user.leagues.length > 0) {
        const leagueIds: string[] = user.leagues.map((l: any) => l.id);
        const perLeagueMatches = await mapWithConcurrency(leagueIds, MATCH_FETCH_CONCURRENCY, async (leagueId) => {
          try {
            const matches = await Match.findAll({
              where: { leagueId },
              attributes: ['id','date','status','homeTeamGoals','awayTeamGoals','leagueId','homeCaptainId','awayCaptainId','updatedAt','archived'],
              order: [['date', 'DESC']],
              limit: 50,
            });
            return { leagueId, matches };
          } catch (e) {
            console.error('Failed to fetch matches for league', leagueId, e);
            return { leagueId, matches: [] as any[] };
          }
        });

        // Build a flat list of matchIds
        const allMatches = perLeagueMatches.flatMap(x => x.matches);
        const matchIds = allMatches.map((m: any) => m.id);

        let availableUsersByMatch: Record<string, any[]> = {};
        let homeUsersByMatch: Record<string, any[]> = {};
        let awayUsersByMatch: Record<string, any[]> = {};

        if (matchIds.length > 0) {
          // Available users via MatchAvailability
          try {
            const avail = await MatchAvailability.findAll({
              where: { match_id: matchIds },
              include: [{ model: User, as: 'userRecord', attributes: ['id','firstName','lastName'] }]
            }) as any[];
            for (const row of avail) {
              const mid = String((row as any).match_id ?? (row as any).matchId);
              if (!availableUsersByMatch[mid]) availableUsersByMatch[mid] = [];
              const u = (row as any).userRecord ?? (row as any).User;
              if (u) availableUsersByMatch[mid].push(u);
            }
          } catch (e) {
            console.error('Failed to fetch availability for match set', e);
          }

          // Home/Away team users via implicit join tables
          const UserHomeMatches = (Match as any).sequelize?.models?.UserHomeMatches;
          const UserAwayMatches = (Match as any).sequelize?.models?.UserAwayMatches;

          if (UserHomeMatches) {
            try {
              // Fetch join rows with just ids to avoid association requirement
              const homeRows = await UserHomeMatches.findAll({
                where: { matchId: matchIds },
                attributes: ['matchId', 'userId'],
                raw: true,
              }) as Array<{ matchId: string | number; userId: string | number }>;

              const homeUserIds = Array.from(new Set(homeRows.map(r => String(r.userId))));
              if (homeUserIds.length) {
                const users = await User.findAll({
                  where: { id: homeUserIds },
                  attributes: ['id','firstName','lastName'],
                }) as any[];
                const userMap = new Map<string, any>(users.map(u => [String(u.id), u]));
                for (const row of homeRows) {
                  const mid = String(row.matchId);
                  if (!homeUsersByMatch[mid]) homeUsersByMatch[mid] = [];
                  const u = userMap.get(String(row.userId));
                  if (u) homeUsersByMatch[mid].push(u);
                }
              }
            } catch (e) {
              console.error('Failed to fetch home team users for matches', e);
            }
          }

          if (UserAwayMatches) {
            try {
              // Fetch join rows with just ids to avoid association requirement
              const awayRows = await UserAwayMatches.findAll({
                where: { matchId: matchIds },
                attributes: ['matchId', 'userId'],
                raw: true,
              }) as Array<{ matchId: string | number; userId: string | number }>;

              const awayUserIds = Array.from(new Set(awayRows.map(r => String(r.userId))));
              if (awayUserIds.length) {
                const users = await User.findAll({
                  where: { id: awayUserIds },
                  attributes: ['id','firstName','lastName'],
                }) as any[];
                const userMap = new Map<string, any>(users.map(u => [String(u.id), u]));
                for (const row of awayRows) {
                  const mid = String(row.matchId);
                  if (!awayUsersByMatch[mid]) awayUsersByMatch[mid] = [];
                  const u = userMap.get(String(row.userId));
                  if (u) awayUsersByMatch[mid].push(u);
                }
              }
            } catch (e) {
              console.error('Failed to fetch away team users for matches', e);
            }
          }
        }

        // Attach users to matches and attach matches to leagues
        const matchesByLeague: Record<string, any[]> = {};
        for (const { leagueId, matches } of perLeagueMatches) {
          const enriched = matches.map((m: any) => {
            const mid = String(m.id);
            const avail = availableUsersByMatch[mid] || [];
            const home = homeUsersByMatch[mid] || [];
            const away = awayUsersByMatch[mid] || [];
            // Ensure these ad-hoc properties are included in JSON by using setDataValue when available
            if (typeof (m as any).setDataValue === 'function') {
              (m as any).setDataValue('availableUsers', avail);
              (m as any).setDataValue('homeTeamUsers', home);
              (m as any).setDataValue('awayTeamUsers', away);
            } else {
              (m as any).availableUsers = avail;
              (m as any).homeTeamUsers = home;
              (m as any).awayTeamUsers = away;
            }
            return m;
          });
          matchesByLeague[leagueId] = enriched;
        }

        // Place matches into user.leagues and user.administeredLeagues
        for (const league of user.leagues) {
          const lm = matchesByLeague[league.id] || [];
          if (typeof (league as any).setDataValue === 'function') {
            (league as any).setDataValue('matches', lm);
          } else {
            (league as any).matches = lm;
          }
        }
        if (user.administeredLeagues) {
          for (const league of user.administeredLeagues) {
            const lm = matchesByLeague[league.id] || [];
            if (typeof (league as any).setDataValue === 'function') {
              (league as any).setDataValue('matches', lm);
            } else {
              (league as any).matches = lm;
            }
          }
        }
      }

  // Optional merge - optimized to avoid extra DB query if possible
      const myUserEmail = "huzaifahj29@gmail.com";
      const extractFromUserEmail = "ru.uddin@hotmail.com";
      if (user.email === myUserEmail) {
        const extractFromUser = await User.findOne({
          where: { email: extractFromUserEmail },
          include: [
            {
              model: League,
              as: 'leagues',
              attributes: ['id', 'name', 'inviteCode', 'createdAt', 'maxGames', 'showPoints', 'active'],
              through: { attributes: [] },
              include: [
                {
                  model: User,
                  as: 'members',
                  attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                  through: { attributes: [] },
                },
                // matches will be attached by our per-league step above if the leagues get merged
              ],
            },
          ],
        }) as unknown as { id: string; email: string; leagues: typeof League[] };

        // NOTE: Previously we merged leagues from another account for a specific email.
        // That could surface leagues the user is not actually a member of. Removed per requirement
        // to only show leagues the user currently belongs to.
      }

      // Ensure administeredLeagues are only shown if the user is also a current member
      // (protects against stale admin rows after leaving a league)
      if ((user as any).leagues && (user as any).administeredLeagues) {
        const memberLeagueIds = new Set<string>((user as any).leagues.map((l: any) => String(l.id)));
        const filteredAdmin = (user as any).administeredLeagues.filter((l: any) => memberLeagueIds.has(String(l.id)));
        (user as any).administeredLeagues = filteredAdmin;
        // Also expose a consistent alias used by /auth/status
        if (typeof (user as any).setDataValue === 'function') {
          (user as any).setDataValue('adminLeagues', filteredAdmin);
        } else {
          (user as any).adminLeagues = filteredAdmin;
        }
      }

      // Populate user's home/away/availableMatches via optimized lookups (avoid heavy includes)
      try {
        const UserHomeMatches = (Match as any).sequelize?.models?.UserHomeMatches;
        const UserAwayMatches = (Match as any).sequelize?.models?.UserAwayMatches;

        let homeTeamMatchIds: string[] = [];
        let awayTeamMatchIds: string[] = [];
        let availableMatchIds: (string | undefined)[] = [];

        if (UserHomeMatches) {
          const rows = await UserHomeMatches.findAll({ where: { userId: userId }, attributes: ['matchId'] });
          homeTeamMatchIds = rows.map((r: any) => String(r.matchId));
        }
        if (UserAwayMatches) {
          const rows = await UserAwayMatches.findAll({ where: { userId: userId }, attributes: ['matchId'] });
          awayTeamMatchIds = rows.map((r: any) => String(r.matchId));
        }
        {
          const rows = await MatchAvailability.findAll({ where: { user_id: userId }, attributes: ['match_id'] });
          availableMatchIds = rows.map((r: any) => String((r as any).match_id));
        }

        const uniqueIds = Array.from(new Set([...homeTeamMatchIds, ...awayTeamMatchIds, ...availableMatchIds].filter(Boolean))) as string[];
        const matchesById: Record<string, any> = {};
        if (uniqueIds.length) {
          // Include updatedAt so the client receives the same shape as requested
          const ms = await Match.findAll({ where: { id: uniqueIds }, attributes: ['id', 'date', 'status', 'updatedAt'] });
          for (const m of ms as any[]) matchesById[String(m.id)] = m;
        }
        const homeTeamMatches = homeTeamMatchIds.map(id => matchesById[id]).filter(Boolean);
        const awayTeamMatches = awayTeamMatchIds.map(id => matchesById[id]).filter(Boolean);
        const availableMatches = availableMatchIds.map(id => (id ? matchesById[id] : undefined)).filter(Boolean);

        // Expose these on the user payload just like /auth/status
        if (typeof (user as any).setDataValue === 'function') {
          (user as any).setDataValue('homeTeamMatches', homeTeamMatches);
          (user as any).setDataValue('awayTeamMatches', awayTeamMatches);
          (user as any).setDataValue('availableMatches', availableMatches);
        } else {
          (user as any).homeTeamMatches = homeTeamMatches;
          (user as any).awayTeamMatches = awayTeamMatches;
          (user as any).availableMatches = availableMatches;
        }
      } catch (e) {
        console.error('Failed to load user match association arrays fast-path:', e);
      }

      delete (user as any)["password"];
      return { success: true, user };
    })();
    inFlight.set(cacheKey, work);
  }
  const result = await work.finally(() => inFlight.delete(cacheKey));
  if (result?.notFound) {
    ctx.throw(404, "User not found");
  }
  const payload = result as { success: true; user: any };

  // Always cache the result (even on refresh, reseed the cache)
  const cachedEntry = setCachedWithEtag(cacheKey, payload, AUTH_CACHE_TTL_SEC);
  ctx.set('ETag', cachedEntry.etag);
  ctx.set('Cache-Control', forceRefresh ? 'no-store, no-cache, must-revalidate' : `private, max-age=${AUTH_CLIENT_MAX_AGE_SEC}`);
  ctx.set('X-Cache', forceRefresh ? 'BYPASS' : 'MISS');

  if (!forceRefresh && ctx.get('If-None-Match') === cachedEntry.etag) {
    ctx.status = 304;
    return;
  }

  ctx.set('X-Gen-Time', String(Date.now() - t0));
  ctx.body = payload;
});

router.get("/auth/status", required, async (ctx: CustomContext) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const userId = ctx.state.user.userId;
  const cacheKey = `auth_status_${userId}_fast`;
  
  // Ultra-fast cache for instant league create/delete updates
  const STATUS_CACHE_TTL_SEC = Number(process.env.AUTH_STATUS_CACHE_TTL_SEC ?? 2);      // 2s server cache (instant updates)
  const STATUS_CLIENT_MAX_AGE_SEC = Number(process.env.AUTH_STATUS_CLIENT_MAX_AGE_SEC ?? 0); // 0s browser cache (no browser caching)

  // Check for manual bypass: /auth/status?refresh=1
  const q = ctx.query as Record<string, string | undefined>;
  const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

  // Serve from cache if available (unless bypassed)
  if (!forceRefresh) {
    const cached = getCachedWithEtag(cacheKey);
    if (cached) {
      ctx.set('ETag', cached.etag);
      ctx.set('Cache-Control', `private, max-age=${STATUS_CLIENT_MAX_AGE_SEC}`);
      if (ctx.get('If-None-Match') === cached.etag) {
        ctx.status = 304;
        return;
      }
      ctx.set('X-Cache', 'HIT');
      ctx.body = cached.payload;
      return;
    }
  } else {
    ctx.set('X-Cache', 'BYPASS');
  }

  const t0 = Date.now();

  // Coalesce concurrent misses
  let statusWork = inFlight.get(cacheKey) as Promise<any> | undefined;
  if (!statusWork) {
    statusWork = (async () => {
      // Load only the base user and league memberships (skip heavy match associations)
      const user = await User.findByPk(userId, {
        attributes: [
          'id', 'firstName', 'lastName', 'email', 'age', 'gender',
          'country', 'state', 'city', 'position', 'positionType',
          'style', 'preferredFoot', 'shirtNumber', 'profilePicture',
          'skills', 'xp', 'updatedAt'
        ],
        include: [
          {
            model: League,
            as: 'leagues',
            attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
            through: { attributes: [] }
          },
          {
            model: League,
            as: 'administeredLeagues',
            attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
            through: { attributes: [] }
          }
        ]
      }) as any;

      if (!user) {
        return { unauthorized: true };
      }

      // Load match associations via optimized join-table lookups
      const UserHomeMatches = (Match as any).sequelize?.models?.UserHomeMatches;
      const UserAwayMatches = (Match as any).sequelize?.models?.UserAwayMatches;

      let homeTeamMatchIds: string[] = [];
      let awayTeamMatchIds: string[] = [];
      let availableMatchIds: (string | undefined)[] = [];

      if (UserHomeMatches) {
        const rows = await UserHomeMatches.findAll({ where: { userId: userId }, attributes: ['matchId'] });
        homeTeamMatchIds = rows.map((r: any) => String(r.matchId));
      }
      if (UserAwayMatches) {
        const rows = await UserAwayMatches.findAll({ where: { userId: userId }, attributes: ['matchId'] });
        awayTeamMatchIds = rows.map((r: any) => String(r.matchId));
      }
      {
        const rows = await MatchAvailability.findAll({ where: { user_id: userId }, attributes: ['match_id'] });
        availableMatchIds = rows.map((r: any) => String((r as any).match_id));
      }

      const uniqueIds = Array.from(new Set([...homeTeamMatchIds, ...awayTeamMatchIds, ...availableMatchIds].filter(Boolean))) as string[];
      const matchesById: Record<string, any> = {};
      if (uniqueIds.length) {
        const ms = await Match.findAll({
          where: { id: uniqueIds },
          attributes: ['id', 'date', 'status', 'updatedAt']
        });
        for (const m of ms as any[]) matchesById[String(m.id)] = m;
      }

      const homeTeamMatches = homeTeamMatchIds.map(id => matchesById[id]).filter(Boolean);
      const awayTeamMatches = awayTeamMatchIds.map(id => matchesById[id]).filter(Boolean);
      const availableMatches = availableMatchIds.map(id => (id ? matchesById[id] : undefined)).filter(Boolean);

      // Filter administeredLeagues to those where the user is still a member
      const memberLeagueIds = new Set<string>((user.leagues || []).map((l: any) => String(l.id)));
      const filteredAdminLeagues = (user.administeredLeagues || []).filter((l: any) => memberLeagueIds.has(String(l.id)));

      const payload = {
        success: true,
        user: {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          age: user.age,
          gender: user.gender,
          country: (user as any).country,
          state: (user as any).state,
          city: (user as any).city,
          position: user.position,
          positionType: user.positionType,
          style: user.style,
          preferredFoot: user.preferredFoot,
          shirtNumber: user.shirtNumber,
          profilePicture: user.profilePicture,
          skills: user.skills,
          xp: user.xp || 0,
          leagues: user.leagues || [],
          adminLeagues: filteredAdminLeagues || [],
          homeTeamMatches,
          awayTeamMatches,
          availableMatches,
        }
      };
      return payload;
    })();
    inFlight.set(cacheKey, statusWork);
  }
  const statusPayload = await statusWork.finally(() => inFlight.delete(cacheKey));
  if (statusPayload?.unauthorized) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  // Cache the response
  const statusCached = setCachedWithEtag(cacheKey, statusPayload, STATUS_CACHE_TTL_SEC);
  ctx.set('ETag', statusCached.etag);
  ctx.set('Cache-Control', forceRefresh ? 'no-store, no-cache, must-revalidate' : `private, max-age=${STATUS_CLIENT_MAX_AGE_SEC}`);
  ctx.set('X-Cache', forceRefresh ? 'BYPASS' : 'MISS');
  ctx.set('X-Gen-Time', String(Date.now() - t0));

  if (!forceRefresh && ctx.get('If-None-Match') === statusCached.etag) {
    ctx.status = 304;
    return;
  }

  ctx.body = statusPayload;
});

router.get("/me", required, async (ctx: CustomContext) => {
  try {
    if (!ctx.state.user) {
      ctx.throw(401, "Authentication error");
      return;
    }
    const userId = ctx.state.user.userId;
    
    console.log(`📋 Fetching /me for user: ${userId}`);
    
    // OPTIMIZED: Removed heavy nested includes to prevent timeout
    const user = await User.findOne({ 
      where: { id: userId },
      include: [{
        model: League,
        as: 'leagues',
        attributes: ['id', 'name', 'image', 'createdAt'],
        include: [{
          model: User,
          as: 'members',
          attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp']
        }]
      }, {
        model: League,
        as: 'administeredLeagues',
        attributes: ['id', 'name', 'image', 'createdAt'],
        include: [{
          model: User,
          as: 'members',
          attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp']
        }]
      }]
    }) as any;

  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Add leagues to personal account for testing
  const myUserEmail = "huzaifahj29@gmail.com"
  const extractFromUserEmail = "ru.uddin@hotmail.com"
  if (user.email === myUserEmail) {
    const extractFromUser = await User.findOne({
      where: { email: extractFromUserEmail },
      include: [{
        model: League,
        as: 'leagues',
        include: [{
          model: User,
          as: 'members'
        }, {
          model: Match,
          as: 'matches',
          include: [
            { model: User, as: 'availableUsers' },
            { model: User, as: 'homeTeamUsers' },
            { model: User, as: 'awayTeamUsers' },
            { model: User, as: 'statistics' }
          ]
        }]
      }]
    }) as unknown as { 
      id: string;
      email: string;
      leagues: typeof League[];
    };
    if (extractFromUser) {
      const userWithLeagues = user as unknown as { leagues: typeof League[] };
      userWithLeagues.leagues = [...userWithLeagues.leagues, ...extractFromUser.leagues];
    }
  }

  // Delete sensitive data
  const propertiesToDelete = [
    "loginCode",
    "email",
    "age",
    "ipAddress",
    "gender",
  ]
  const deleteProperties = (input: User[] | User) => {
    if (Array.isArray(input)) {
      for (const user of input) {
        for (const property of propertiesToDelete) {
          delete (user as any)[property]
        }
      }
    } else if (typeof input === "object") {
      for (const property of propertiesToDelete) {
        delete (input as any)[property]
      }
    }
  }
  delete (user as any)["password"]
  
  // Handle both leagues and administeredLeagues
  if ((user as any).leagues) {
    for (const league of (user as any).leagues) {
      deleteProperties(league.members)
      deleteProperties(league.matches)
    }
  }
  
  if ((user as any).administeredLeagues) {
    for (const league of (user as any).administeredLeagues) {
      deleteProperties(league.members)
      deleteProperties(league.matches)
    }
  }

  ctx.body = {
    success: true,
    user: user,
  };
  
  console.log(`✅ /me successful for user: ${userId}`);
  
  } catch (error: any) {
    console.error(`❌ /me endpoint error for user ${ctx.state.user?.userId}:`, error.message);
    console.error('Stack:', error.stack);
    ctx.status = 500;
    ctx.body = {
      success: false,
      error: 'Internal server error fetching user data',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    };
  }
});










// router.get("/auth/status", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
  
//   // Determine mode - light by default for /auth/status
//   const lightMode = ctx.path === "/auth/status" && (q?.full !== '1' && q?.mode !== 'full');
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

//   if (lightMode) {
//     await getLightAuthStatus(ctx, userId, forceRefresh);
//   } else {
//     await getFullAuthData(ctx, userId, forceRefresh);
//   }
// });

// // Helper function to serve cached responses
// function serveCachedResponse(ctx: CustomContext, cached: any, maxAge: number, cacheStatus: string) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(cached)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return true; // Response handled
//   }
  
//   ctx.body = cached;
//   return false; // Response not handled
// }

// // Helper function to serve fresh responses
// function serveFreshResponse(ctx: CustomContext, payload: any, maxAge: number, cacheStatus: string, startTime: number) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
//   ctx.set('X-Gen-Time', String(Date.now() - startTime));
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return;
//   }
  
//   ctx.body = payload;
// }

// // Ultra Light Version - Fastest
// async function getLightAuthStatus(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_STATUS_CACHE_TTL_SEC ?? 45);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_STATUS_CLIENT_MAX_AGE_SEC ?? 30);
//   const cacheKey = `auth_light_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
  
//   // SUPER LIGHT query - only essential fields for basic auth status
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'profilePicture', 
//       'xp', 'updatedAt', 'position', 'positionType'
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'active'],
//         through: { attributes: [] },
//         limit: 10
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'active'],
//         through: { attributes: [] },
//         limit: 5
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const payload = {
//     success: true,
//     user: {
//       id: user.id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//       profilePicture: user.profilePicture,
//       xp: user.xp || 0,
//       position: user.position,
//       positionType: user.positionType,
//       leagues: user.leagues?.map((l: any) => ({ id: l.id, name: l.name, active: l.active })) || [],
//       adminLeagues: user.administeredLeagues?.map((l: any) => ({ id: l.id, name: l.name, active: l.active })) || [],
//       lastUpdated: user.updatedAt
//     }
//   };

//   // Cache and respond
//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Full Data Version - Comprehensive but optimized
// async function getFullAuthData(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 120);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 60);
//   const cacheKey = `auth_full_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
//   const lightUserAttrs = ['id', 'firstName', 'lastName', 'profilePicture', 'position'];

//   // Optimized full query
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'age', 'gender',
//       'country', 'state', 'city', 'position', 'positionType',
//       'style', 'preferredFoot', 'shirtNumber', 'profilePicture',
//       'skills', 'xp', 'updatedAt'
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] },
//         include: [
//           {
//             model: User,
//             as: 'members',
//             attributes: lightUserAttrs,
//             through: { attributes: [] },
//             limit: 50
//           },
//           {
//             model: Match,
//             as: 'matches',
//             attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals'],
//             separate: true,
//             order: [['date', 'DESC']],
//             limit: 20,
//             include: [
//               { 
//                 model: User, 
//                 as: 'availableUsers', 
//                 attributes: lightUserAttrs, 
//                 through: { attributes: [] },
//                 limit: 10 
//               }
//             ],
//           },
//         ],
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] }
//       },
//       { 
//         model: Match, 
//         as: 'homeTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10 
//       },
//       { 
//         model: Match, 
//         as: 'awayTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10 
//       },
//       { 
//         model: Match, 
//         as: 'availableMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10 
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(404, "User not found");
//     return;
//   }

//   // Optional: Remove special email merge logic for performance
//   // If you need it, keep it but be aware it impacts performance
//   const myUserEmail = "huzaifahj29@gmail.com";
//   const extractFromUserEmail = "ru.uddin@hotmail.com";
//   if (user.email === myUserEmail) {
//     const extractFromUser = await User.findOne({
//       where: { email: extractFromUserEmail },
//       include: [
//         {
//           model: League,
//           as: 'leagues',
//           attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//           through: { attributes: [] },
//           include: [
//             {
//               model: User,
//               as: 'members',
//               attributes: lightUserAttrs,
//               through: { attributes: [] },
//               limit: 50
//             }
//           ],
//         },
//       ],
//     }) as any;

//     if (extractFromUser) {
//       (user as any).leagues = [...(user as any).leagues, ...extractFromUser.leagues];
//     }
//   }

//   const payload = { 
//     success: true, 
//     user 
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Original /auth/data endpoint for backward compatibility
// router.get("/auth/data", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "User not authenticated");
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';
  
//   await getFullAuthData(ctx, userId, forceRefresh);
// });










// import crypto from 'crypto';

// router.get("/auth/status", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
  
//   // Determine mode - light by default for /auth/status
//   const lightMode = ctx.path === "/auth/status" && (q?.full !== '1' && q?.mode !== 'full');
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

//   if (lightMode) {
//     await getLightAuthStatus(ctx, userId, forceRefresh);
//   } else {
//     await getFullAuthData(ctx, userId, forceRefresh);
//   }
// });

// // Helper function to serve cached responses
// function serveCachedResponse(ctx: CustomContext, cached: any, maxAge: number, cacheStatus: string) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(cached)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return true; // Response handled
//   }
  
//   ctx.body = cached;
//   return false; // Response not handled
// }

// // Helper function to serve fresh responses
// function serveFreshResponse(ctx: CustomContext, payload: any, maxAge: number, cacheStatus: string, startTime: number) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
//   ctx.set('X-Gen-Time', String(Date.now() - startTime));
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return;
//   }
  
//   ctx.body = payload;
// }

// // Ultra Light Version - Fastest
// async function getLightAuthStatus(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_STATUS_CACHE_TTL_SEC ?? 45);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_STATUS_CLIENT_MAX_AGE_SEC ?? 30);
//   const cacheKey = `auth_light_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
  
//   // SUPER LIGHT query - only essential fields for basic auth status
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'profilePicture', 
//       'xp', 'updatedAt', 'position', 'positionType'
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'active'],
//         through: { attributes: [] }
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'active'],
//         through: { attributes: [] }
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const payload = {
//     success: true,
//     user: {
//       id: user.id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//       profilePicture: user.profilePicture,
//       xp: user.xp || 0,
//       position: user.position,
//       positionType: user.positionType,
//       leagues: user.leagues?.map((l: any) => ({ id: l.id, name: l.name, active: l.active })) || [],
//       adminLeagues: user.administeredLeagues?.map((l: any) => ({ id: l.id, name: l.name, active: l.active })) || [],
//       lastUpdated: user.updatedAt
//     }
//   };

//   // Cache and respond
//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Full Data Version - Comprehensive but optimized
// async function getFullAuthData(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 120);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 60);
//   const cacheKey = `auth_full_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
//   const lightUserAttrs = ['id', 'firstName', 'lastName', 'profilePicture', 'position'];

//   // Optimized full query - REMOVED separate: true from non-HasMany associations
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'age', 'gender',
//       'country', 'state', 'city', 'position', 'positionType',
//       'style', 'preferredFoot', 'shirtNumber', 'profilePicture',
//       'skills', 'xp', 'updatedAt'
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] },
//         include: [
//           {
//             model: User,
//             as: 'members',
//             attributes: lightUserAttrs,
//             through: { attributes: [] }
//           },
//           {
//             model: Match,
//             as: 'matches',
//             attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals'],
//             // REMOVED separate: true - only use if League.matches is HasMany
//             order: [['date', 'DESC']],
//             limit: 20,
//             include: [
//               { 
//                 model: User, 
//                 as: 'availableUsers', 
//                 attributes: lightUserAttrs, 
//                 through: { attributes: [] }
//               }
//             ],
//           },
//         ],
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] }
//       },
//       { 
//         model: Match, 
//         as: 'homeTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10 
//       },
//       { 
//         model: Match, 
//         as: 'awayTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10 
//       },
//       { 
//         model: Match, 
//         as: 'availableMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10 
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(404, "User not found");
//     return;
//   }

//   // Optional: Remove special email merge logic for performance
//   // If you need it, keep it but be aware it impacts performance
//   const myUserEmail = "huzaifahj29@gmail.com";
//   const extractFromUserEmail = "ru.uddin@hotmail.com";
//   if (user.email === myUserEmail) {
//     const extractFromUser = await User.findOne({
//       where: { email: extractFromUserEmail },
//       include: [
//         {
//           model: League,
//           as: 'leagues',
//           attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//           through: { attributes: [] },
//           include: [
//             {
//               model: User,
//               as: 'members',
//               attributes: lightUserAttrs,
//               through: { attributes: [] }
//             }
//           ],
//         },
//       ],
//     }) as any;

//     if (extractFromUser) {
//       user.leagues = [...user.leagues, ...extractFromUser.leagues];
//     }
//   }

//   const payload = { 
//     success: true, 
//     user 
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Original /auth/data endpoint for backward compatibility
// router.get("/auth/data", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "User not authenticated");
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';
  
//   await getFullAuthData(ctx, userId, forceRefresh);
// });















// import crypto from 'crypto';

// router.get("/auth/status", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
  
//   // Determine mode - light by default for /auth/status
//   const lightMode = ctx.path === "/auth/status" && (q?.full !== '1' && q?.mode !== 'full');
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

//   if (lightMode) {
//     await getLightAuthStatus(ctx, userId, forceRefresh);
//   } else {
//     await getFullAuthData(ctx, userId, forceRefresh);
//   }
// });

// // Helper function to serve cached responses
// function serveCachedResponse(ctx: CustomContext, cached: any, maxAge: number, cacheStatus: string) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(cached)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return true; // Response handled
//   }
  
//   ctx.body = cached;
//   return false; // Response not handled
// }

// // Helper function to serve fresh responses
// function serveFreshResponse(ctx: CustomContext, payload: any, maxAge: number, cacheStatus: string, startTime: number) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
//   ctx.set('X-Gen-Time', String(Date.now() - startTime));
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return;
//   }
  
//   ctx.body = payload;
// }

// // Ultra Light Version - Fastest
// async function getLightAuthStatus(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_STATUS_CACHE_TTL_SEC ?? 45);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_STATUS_CLIENT_MAX_AGE_SEC ?? 30);
//   const cacheKey = `auth_light_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
  
//   // SUPER LIGHT query - only essential fields for basic auth status
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'profilePicture', 
//       'xp', 'updatedAt', 'position', 'positionType'
//     ],
//      include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
//         through: { attributes: [] } 
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
//         through: { attributes: [] }
//       },
//       {
//         model: Match,
//         as: 'homeTeamMatches',
//         attributes: ['id', 'date', 'status', 'updatedAt'],
//       },
//       {
//         model: Match,
//         as: 'awayTeamMatches',
//         attributes: ['id', 'date', 'status', 'updatedAt'],
//       },
//       {
//         model: Match,
//         as: 'availableMatches',
//         attributes: ['id', 'date', 'status', 'updatedAt'],
//       }
//     ]
//   }) as any;
  


//   if (!user) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   // const payload = {
//   //   success: true,
//   //   user: {
//   //     id: user.id,
//   //     firstName: user.firstName,
//   //     lastName: user.lastName,
//   //     email: user.email,
//   //     profilePicture: user.profilePicture,
//   //     xp: user.xp || 0,
//   //     position: user.position,
//   //     positionType: user.positionType,
//   //     leagues: user.leagues?.map((l: any) => ({ id: l.id, name: l.name, active: l.active })) || [],
//   //     adminLeagues: user.administeredLeagues?.map((l: any) => ({ id: l.id, name: l.name, active: l.active })) || [],
//   //     lastUpdated: user.updatedAt
//   //   }
//   // };

//   // Cache and respond


//       const payload = {
//     success: true,
//     user: {
//       id: user.id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//       age: user.age,
//       gender: user.gender,
//       country: (user as any).country,
//       state: (user as any).state,
//       city: (user as any).city,
//       position: user.position,
//       positionType: user.positionType,
//       style: user.style,
//       preferredFoot: user.preferredFoot,
//       shirtNumber: user.shirtNumber,
//       profilePicture: user.profilePicture,
//       skills: user.skills,
//       xp: user.xp || 0,
//       leagues: user.leagues || [],
//       adminLeagues: user.administeredLeagues || [],
//       homeTeamMatches: user.homeTeamMatches || [],
//       awayTeamMatches: user.awayTeamMatches || [],
//       availableMatches: user.availableMatches || [],
//     }
//   };


//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Full Data Version - WITHOUT ANY separate: true
// async function getFullAuthData(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 120);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 60);
//   const cacheKey = `auth_full_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
//   const lightUserAttrs = ['id', 'firstName', 'lastName', 'profilePicture', 'position'];

//    const lightUserAttrsOnMatch: FindAttributeOptions = ['id', 'firstName', 'lastName'];
//   // SIMPLIFIED query - NO complex nested includes that might have separate: true
//   const user = await User.findByPk(userId, {
//        attributes: [
//       'id',
//       'firstName',
//       'lastName',
//       'email',
//       'age',
//       'gender',
//       'country',
//       'state',
//       'city',
//       'position',
//       'positionType',
//       'style',
//       'preferredFoot',
//       'shirtNumber',
//       'profilePicture',
//       'skills',
//       'xp',
//       'updatedAt',
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] },
//         include: [
//           {
//             model: User,
//             as: 'members',
//             attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
//             through: { attributes: [] },
//           },
//           {
//             model: Match,
//             as: 'matches',
//             attributes: ['id','date','status','homeTeamGoals','awayTeamGoals','leagueId','homeCaptainId','awayCaptainId','updatedAt','archived'],
//             separate: true,
//             order: [['date', 'DESC']],
//             limit: 50, // Limit matches to reduce payload size
//             include: [
//               { model: User, as: 'availableUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
//               { model: User, as: 'homeTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
//               { model: User, as: 'awayTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
//             ],
//           },
//         ],
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] },
//         include: [
//           {
//             model: User,
//             as: 'members',
//             attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
//             through: { attributes: [] },
//           },
//           {
//             model: Match,
//             as: 'matches',
//             attributes: ['id','date','status','homeTeamGoals','awayTeamGoals','leagueId','homeCaptainId','awayCaptainId','updatedAt','archived'],
//             separate: true,
//             order: [['date', 'DESC']],
//             limit: 50, // Limit matches to reduce payload size
//             include: [
//               { model: User, as: 'availableUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
//               { model: User, as: 'homeTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
//               { model: User, as: 'awayTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
//             ],
//           },
//         ],
//       },
//       { model: Match, as: 'homeTeamMatches', attributes: ['id', 'date', 'status'] },
//       { model: Match, as: 'awayTeamMatches', attributes: ['id', 'date', 'status'] },
//       { model: Match, as: 'availableMatches', attributes: ['id', 'date', 'status'] },
//     ],
//   }) as any;
// ;


//   if (!user) {
//     ctx.throw(404, "User not found");
//     return;
//   }

//   // Manual loading for matches to avoid separate: true issue
//   if (user.leagues && user.leagues.length > 0) {
//     for (const league of user.leagues) {
//       // Load matches manually for each league
//       const matches = await Match.findAll({
//         where: { leagueId: league.id },
//         attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals'],
//         order: [['date', 'DESC']],
//         limit: 20,
//         include: [
//           { 
//             model: User, 
//             as: 'availableUsers', 
//             attributes: lightUserAttrs, 
//             through: { attributes: [] }
//           }
//         ]
//       });
//       league.matches = matches;
//     }
//   }

//   // Optional: Remove special email merge logic for performance
//   const myUserEmail = "huzaifahj29@gmail.com";
//   const extractFromUserEmail = "ru.uddin@hotmail.com";
//   if (user.email === myUserEmail) {
//     const extractFromUser = await User.findOne({
//       where: { email: extractFromUserEmail },
//       include: [
//         {
//           model: League,
//           as: 'leagues',
//           attributes: ['id', 'name', 'inviteCode', 'maxGames', 'showPoints', 'active'],
//           through: { attributes: [] }
//         }
//       ]
//     }) as any;

//     if (extractFromUser) {
//       user.leagues = [...user.leagues, ...extractFromUser.leagues];
//     }
//   }

//   const payload = { 
//     success: true, 
//     user 
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Original /auth/data endpoint for backward compatibility
// router.get("/auth/data", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "User not authenticated");
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';
  
//   await getFullAuthData(ctx, userId, forceRefresh);
// });






// import crypto from 'crypto';

// router.get("/auth/status", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
  
//   // Determine mode - light by default for /auth/status
//   const lightMode = ctx.path === "/auth/status" && (q?.full !== '1' && q?.mode !== 'full');
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

//   if (lightMode) {
//     await getLightAuthStatus(ctx, userId, forceRefresh);
//   } else {
//     await getFullAuthData(ctx, userId, forceRefresh);
//   }
// });

// // Helper function to serve cached responses
// function serveCachedResponse(ctx: CustomContext, cached: any, maxAge: number, cacheStatus: string) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(cached)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return true;
//   }
  
//   ctx.body = cached;
//   return false;
// }

// // Helper function to serve fresh responses
// function serveFreshResponse(ctx: CustomContext, payload: any, maxAge: number, cacheStatus: string, startTime: number) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
//   ctx.set('X-Gen-Time', String(Date.now() - startTime));
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return;
//   }
  
//   ctx.body = payload;
// }

// // Ultra Light Version - Fastest
// async function getLightAuthStatus(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_STATUS_CACHE_TTL_SEC ?? 45);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_STATUS_CLIENT_MAX_AGE_SEC ?? 30);
//   const cacheKey = `auth_light_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
  
//   // SUPER LIGHT query - only essential fields
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'profilePicture', 
//       'xp', 'updatedAt', 'position', 'positionType'
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
//         through: { attributes: [] } 
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
//         through: { attributes: [] }
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const payload = {
//     success: true,
//     user: {
//       id: user.id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//       profilePicture: user.profilePicture,
//       xp: user.xp || 0,
//       position: user.position,
//       positionType: user.positionType,
//       leagues: user.leagues || [],
//       adminLeagues: user.administeredLeagues || [],
//       lastUpdated: user.updatedAt
//     }
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Full Data Version - COMPLETELY FIXED
// async function getFullAuthData(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 120);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 60);
//   const cacheKey = `auth_full_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();

//   // STEP 1: Get basic user data with leagues ONLY (no matches)
//   const user = await User.findByPk(userId, {
//     attributes: [
//       'id', 'firstName', 'lastName', 'email', 'age', 'gender',
//       'country', 'state', 'city', 'position', 'positionType',
//       'style', 'preferredFoot', 'shirtNumber', 'profilePicture',
//       'skills', 'xp', 'updatedAt'
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] },
//         include: [
//           {
//             model: User,
//             as: 'members',
//             attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
//             through: { attributes: [] },
//           }
//         ],
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] },
//         include: [
//           {
//             model: User,
//             as: 'members',
//             attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
//             through: { attributes: [] },
//           }
//         ],
//       },
//       { 
//         model: Match, 
//         as: 'homeTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10
//       },
//       { 
//         model: Match, 
//         as: 'awayTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10
//       },
//       { 
//         model: Match, 
//         as: 'availableMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 10
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(404, "User not found");
//     return;
//   }

//   // STEP 2: Load matches SEPARATELY for all leagues
//   if (user.leagues && user.leagues.length > 0) {
//     const leagueIds = user.leagues.map((l: any) => l.id);
    
//     // Load matches for all leagues in one query
//     const matches = await Match.findAll({
//       where: { leagueId: leagueIds },
//       attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals', 'leagueId', 'homeCaptainId', 'awayCaptainId', 'updatedAt', 'archived'],
//       order: [['date', 'DESC']],
//       limit: 100
//     });

//     // STEP 3: Load match users SEPARATELY to avoid complex includes
//     const matchIds = matches.map((m: any) => m.id);
    
//     if (matchIds.length > 0) {
//       // Load available users for matches
//       const matchAvailableUsers = await MatchAvailability.findAll({
//         where: { match_id: matchIds },
//         include: [{
//           model: User,
//           attributes: ['id', 'firstName', 'lastName'],
//         }]
//       });

//       // Load home team users for matches from the implicit join table created by Sequelize
//       // The join tables were defined using `through: 'UserHomeMatches'` and `through: 'UserAwayMatches'`.
//       const UserHomeMatches = (Match as any).sequelize?.models?.UserHomeMatches;
//       const UserAwayMatches = (Match as any).sequelize?.models?.UserAwayMatches;

//       let matchHomeUsers: any[] = [];
//       let matchAwayUsers: any[] = [];

//       if (UserHomeMatches) {
//         matchHomeUsers = await UserHomeMatches.findAll({
//           where: { matchId: matchIds },
//           include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
//         });
//       }

//       if (UserAwayMatches) {
//         matchAwayUsers = await UserAwayMatches.findAll({
//           where: { matchId: matchIds },
//           include: [{ model: User, attributes: ['id', 'firstName', 'lastName'] }]
//         });
//       }

//       // Group users by matchId
//       const availableUsersByMatch: { [key: string]: any[] } = {};
//       const homeUsersByMatch: { [key: string]: any[] } = {};
//       const awayUsersByMatch: { [key: string]: any[] } = {};

//       matchAvailableUsers.forEach((ma: any) => {
//         if (!availableUsersByMatch[ma.matchId]) availableUsersByMatch[ma.matchId] = [];
//         availableUsersByMatch[ma.matchId].push(ma.User);
//       });

//       matchHomeUsers.forEach((mh: any) => {
//         if (!homeUsersByMatch[mh.matchId]) homeUsersByMatch[mh.matchId] = [];
//         homeUsersByMatch[mh.matchId].push(mh.User);
//       });

//       matchAwayUsers.forEach((ma: any) => {
//         if (!awayUsersByMatch[ma.matchId]) awayUsersByMatch[ma.matchId] = [];
//         awayUsersByMatch[ma.matchId].push(ma.User);
//       });

//       // Attach users to matches
//       matches.forEach((match: any) => {
//         match.availableUsers = availableUsersByMatch[match.id] || [];
//         match.homeTeamUsers = homeUsersByMatch[match.id] || [];
//         match.awayTeamUsers = awayUsersByMatch[match.id] || [];
//       });
//     }

//     // STEP 4: Group matches by league and attach to leagues
//     const matchesByLeague: { [key: string]: any[] } = {};
//     matches.forEach(match => {
//       if (!matchesByLeague[match.leagueId]) {
//         matchesByLeague[match.leagueId] = [];
//       }
//       matchesByLeague[match.leagueId].push(match);
//     });

//     // Attach matches to leagues
//     user.leagues.forEach((league: any) => {
//       league.matches = matchesByLeague[league.id] || [];
//     });

//     user.administeredLeagues.forEach((league: any) => {
//       if (!league.matches) {
//         league.matches = matchesByLeague[league.id] || [];
//       }
//     });
//   }

//   // STEP 5: Optional email merge (only if needed)
//   const myUserEmail = "huzaifahj29@gmail.com";
//   const extractFromUserEmail = "ru.uddin@hotmail.com";
  
//   if (user.email === myUserEmail) {
//     try {
//       const extractFromUser = await User.findOne({
//         where: { email: extractFromUserEmail },
//         attributes: ['id'],
//         include: [{
//           model: League,
//           as: 'leagues',
//           attributes: ['id', 'name', 'inviteCode', 'createdAt', 'maxGames', 'showPoints', 'active'],
//           through: { attributes: [] },
//         }],
//       }) as any;

//       if (extractFromUser?.leagues) {
//         user.leagues = [...user.leagues, ...extractFromUser.leagues];
//       }
//     } catch (error) {
//       console.log('Email merge skipped due to error');
//     }
//   }

//   const payload = { 
//     success: true, 
//     user 
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Original /auth/data endpoint
// router.get("/auth/data", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "User not authenticated");
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';
  
//   await getFullAuthData(ctx, userId, forceRefresh);
// });









// import crypto from 'crypto';

// router.get("/auth/status", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
  
//   // Determine mode - light by default for /auth/status
//   const lightMode = ctx.path === "/auth/status" && (q?.full !== '1' && q?.mode !== 'full');
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

//   if (lightMode) {
//     await getLightAuthStatus(ctx, userId, forceRefresh);
//   } else {
//     await getFullAuthData(ctx, userId, forceRefresh);
//   }
// });

// // Helper function to serve cached responses
// function serveCachedResponse(ctx: CustomContext, cached: any, maxAge: number, cacheStatus: string) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(cached)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return true;
//   }
  
//   ctx.body = cached;
//   return false;
// }

// // Helper function to serve fresh responses
// function serveFreshResponse(ctx: CustomContext, payload: any, maxAge: number, cacheStatus: string, startTime: number) {
//   const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
//   ctx.set('ETag', etag);
//   ctx.set('Cache-Control', `private, max-age=${maxAge}`);
//   ctx.set('X-Cache', cacheStatus);
//   ctx.set('X-Gen-Time', String(Date.now() - startTime));
  
//   if (ctx.get('If-None-Match') === etag) {
//     ctx.status = 304;
//     return;
//   }
  
//   ctx.body = payload;
// }

// // Ultra Light Version - Fastest
// async function getLightAuthStatus(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_STATUS_CACHE_TTL_SEC ?? 45);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_STATUS_CLIENT_MAX_AGE_SEC ?? 30);
//   const cacheKey = `auth_light_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();
  
//   // SUPER LIGHT query - only essential fields
//   const user = await User.findByPk(userId, {
//     attributes: [
//      'id',
//       'firstName',
//       'lastName',
//       'email',
//       'age',
//       'gender',
//       'country',
//       'state',
//       'city',
//       'position',
//       'positionType',
//       'style',
//       'preferredFoot',
//       'shirtNumber',
//       'profilePicture',
//       'skills',
//       'xp',
//       'updatedAt',
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
//         through: { attributes: [] } 
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt'],
//         through: { attributes: [] }
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(401, "Unauthorized");
//     return;
//   }

//   const payload = {
//     success: true,
//     user: {
//       id: user.id,
//       firstName: user.firstName,
//       lastName: user.lastName,
//       email: user.email,
//       profilePicture: user.profilePicture,
//       xp: user.xp || 0,
//       position: user.position,
//       positionType: user.positionType,
//       style: user.style,
//       preferredFoot: user.preferredFoot,
//       shirtNumber: user.shirtNumber,
//       skills: user.skills,
//       age: user.age,
//       leagues: user.leagues || [],
//       adminLeagues: user.administeredLeagues || [],
//       lastUpdated: user.updatedAt
//     }
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Full Data Version - ULTRA SIMPLE (NO ERRORS)
// async function getFullAuthData(ctx: CustomContext, userId: string, forceRefresh: boolean) {
//   const CACHE_TTL = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 120);
//   const CLIENT_MAX_AGE = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 60);
//   const cacheKey = `auth_full_${userId}`;

//   // Cache check
//   if (!forceRefresh) {
//     const cached = cache.get(cacheKey);
//     if (cached) {
//       const responseHandled = serveCachedResponse(ctx, cached, CLIENT_MAX_AGE, 'HIT');
//       if (responseHandled) return;
//     }
//   } else {
//     ctx.set('X-Cache', 'BYPASS');
//   }

//   const t0 = Date.now();

//   // STEP 1: Get basic user data with SIMPLE includes only
//   const user = await User.findByPk(userId, {
//     attributes: [
//      'id',
//       'firstName',
//       'lastName',
//       'email',
//       'age',
//       'gender',
//       'country',
//       'state',
//       'city',
//       'position',
//       'positionType',
//       'style',
//       'preferredFoot',
//       'shirtNumber',
//       'profilePicture',
//       'skills',
//       'xp',
//       'updatedAt',
//     ],
//     include: [
//       {
//         model: League,
//         as: 'leagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] }
//       },
//       {
//         model: League,
//         as: 'administeredLeagues',
//         attributes: ['id', 'name', 'inviteCode', 'createdAt', 'updatedAt', 'maxGames', 'showPoints', 'active'],
//         through: { attributes: [] }
//       },
//       { 
//         model: Match, 
//         as: 'homeTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 5
//       },
//       { 
//         model: Match, 
//         as: 'awayTeamMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 5
//       },
//       { 
//         model: Match, 
//         as: 'availableMatches', 
//         attributes: ['id', 'date', 'status'],
//         limit: 5
//       }
//     ]
//   }) as any;

//   if (!user) {
//     ctx.throw(404, "User not found");
//     return;
//   }

//   // STEP 2: Load league members separately
//   if (user.leagues && user.leagues.length > 0) {
//     const leagueIds = user.leagues.map((l: any) => l.id);
    
//     // Load members for all leagues via League includes (safer than relying on an implicit join-model)
//     const leaguesWithMembers = await League.findAll({
//       where: { id: leagueIds },
//       include: [{
//         model: User,
//         as: 'members',
//         attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
//         through: { attributes: [] }
//       }]
//     }) as any[];

//     // Group members by league id
//     const membersByLeague: { [key: string]: any[] } = {};
//     for (const l of leaguesWithMembers) {
//       membersByLeague[l.id] = l.members || [];
//     }

//     // Attach members to leagues and administeredLeagues
//     user.leagues.forEach((league: any) => {
//       league.members = membersByLeague[league.id] || [];
//     });
//     user.administeredLeagues.forEach((league: any) => {
//       league.members = membersByLeague[league.id] || [];
//     });
//   }

//   // STEP 3: Load matches separately (if leagues exist)
//   if (user.leagues && user.leagues.length > 0) {
//     const leagueIds = user.leagues.map((l: any) => l.id);
    
//     // Load matches for leagues
//     const matches = await Match.findAll({
//       where: { leagueId: leagueIds },
//       attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals', 'leagueId', 'updatedAt'],
//       order: [['date', 'DESC']],
//       limit: 50
//     });


//     // Group matches by league
//     const matchesByLeague: { [key: string]: any[] } = {};
//     matches.forEach(match => {
//       if (!matchesByLeague[match.leagueId]) matchesByLeague[match.leagueId] = [];
//       matchesByLeague[match.leagueId].push(match);
//     });

//     // Attach matches to leagues
//     user.leagues.forEach((league: any) => {
//       league.matches = matchesByLeague[league.id] || [];
//     });
//     user.administeredLeagues.forEach((league: any) => {
//       league.matches = matchesByLeague[league.id] || [];
//     });
//   }

//   // STEP 4: Optional email merge (simplified)
//   const myUserEmail = "huzaifahj29@gmail.com";
//   const extractFromUserEmail = "ru.uddin@hotmail.com";
  
//   if (user.email === myUserEmail) {
//     try {
//       const extractFromUser = await User.findOne({
//         where: { email: extractFromUserEmail },
//         attributes: ['id'],
//         include: [{
//           model: League,
//           as: 'leagues',
//           attributes: ['id', 'name', 'inviteCode', 'createdAt', 'maxGames', 'showPoints', 'active'],
//           through: { attributes: [] },
//         }],
//       }) as any;

//       if (extractFromUser?.leagues) {
//         user.leagues = [...user.leagues, ...extractFromUser.leagues];
//       }
//     } catch (error) {
//       // Silent fail - not critical
//     }
//   }

//   const payload = { 
//     success: true, 
//     user 
//   };

//   cache.set(cacheKey, payload, CACHE_TTL);
//   serveFreshResponse(ctx, payload, CLIENT_MAX_AGE, forceRefresh ? 'BYPASS' : 'MISS', t0);
// }

// // Original /auth/data endpoint
// router.get("/auth/data", required, async (ctx: CustomContext) => {
//   if (!ctx.state.user?.userId) {
//     ctx.throw(401, "User not authenticated");
//   }

//   const userId = ctx.state.user.userId;
//   const q = ctx.query as Record<string, string | undefined>;
//   const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

//   try {
//     // Try to serve the full payload (optimized and safe in current code)
//     await getFullAuthData(ctx, userId, forceRefresh);
//   } catch (err: any) {
//     // If something unexpected (like Sequelize include.separate validation) happens,
//     // fall back to the lightweight status payload so the client still receives a valid response.
//   console.error('getFullAuthData failed, falling back to lightweight status:', err && (err as any).stack ? (err as any).stack : err);
//     try {
//       await getLightAuthStatus(ctx, userId, forceRefresh);
//     } catch (err2) {
//   console.error('Fallback getLightAuthStatus also failed:', err2 && (err2 as any).stack ? (err2 as any).stack : err2);
//       // Last resort: return a minimal error-safe JSON without throwing so clients don't get a 500
//       ctx.status = 200;
//       ctx.body = { success: true, user: { id: userId } };
//     }
//   }
// });
































































































export default router;


