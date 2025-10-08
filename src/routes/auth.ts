import Router from '@koa/router';
import { transporter } from "../modules/sendEmail"
import { none, required } from "../modules/auth"
import models from "../models"
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
      gender: userData.gender
    });

    // Create user with all required fields
    const newUser = await User.create({
      email: userData.email,
      password: await hash(userData.password, 10),
      firstName: userData.firstName || '',
      lastName: userData.lastName || '',
      age: userData.age ? parseInt(userData.age) : undefined,
      gender: userData.gender,
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
        position: newUser.position,
        positionType: newUser.positionType,
        style: newUser.style,
        preferredFoot: newUser.preferredFoot,
        shirtNumber: newUser.shirtNumber,
        profilePicture: newUser.profilePicture,
        skills: newUser.skills,
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
    attributes: ['id','firstName','lastName','email','password','age','gender','position','positionType','style','preferredFoot','shirtNumber','profilePicture','skills','xp','achievements','provider'] // removed providerId
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

router.get("/auth/data", required, async (ctx: CustomContext) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  // Short cache TTLs (env overrideable)
  const AUTH_CACHE_TTL_SEC = Number(process.env.AUTH_DATA_CACHE_TTL_SEC ?? 5);      // server cache (memory)
  const AUTH_CLIENT_MAX_AGE_SEC = Number(process.env.AUTH_DATA_CLIENT_MAX_AGE_SEC ?? 5); // browser cache

  // Allow manual bypass: /auth/data?refresh=1 (or nocache=1)
  const q = ctx.query as Record<string, string | undefined>;
  const forceRefresh = q?.refresh === '1' || q?.nocache === '1';

  const userId = ctx.state.user.userId;
  const cacheKey = `auth_data_${userId}_ultra_fast`;

  // Serve cache if present (unless bypassed)
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      const etag = crypto.createHash('sha1').update(JSON.stringify(cached)).digest('hex');
      ctx.set('ETag', etag);
      ctx.set('Cache-Control', `private, max-age=${AUTH_CLIENT_MAX_AGE_SEC}`);
      if (ctx.get('If-None-Match') === etag) {
        ctx.status = 304;
        return;
      }
      ctx.set('X-Cache', 'HIT');
      ctx.body = cached;
      return;
    }
  } else {
    ctx.set('X-Cache', 'BYPASS');
  }

  const t0 = Date.now();

  // Lighten payload: add league settings, slim nested users on matches to just ids
  const lightUserAttrsOnMatch: FindAttributeOptions = ['id'];

  const user = await User.findByPk(userId, {
    attributes: [
      'id',
      'firstName',
      'lastName',
      'email',
      'age',
      'gender',
      'position',
      'positionType',
      'style',
      'preferredFoot',
      'shirtNumber',
      'profilePicture',
      'skills',
      'xp',
      'updatedAt', // ensure ETag changes on user edits
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
            attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture', 'updatedAt'],
            through: { attributes: [] },
          },
          {
            model: Match,
            as: 'matches',
            attributes: ['id','date','status','homeTeamGoals','awayTeamGoals','notes','leagueId','start','homeCaptainId','awayCaptainId','createdAt','updatedAt','archived'],
            separate: true,
            order: [['date', 'DESC']],
            include: [
              { model: User, as: 'availableUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              { model: User, as: 'homeTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              { model: User, as: 'awayTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              { model: User, as: 'statistics',     attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
            ],
          },
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
            attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture', 'updatedAt'],
            through: { attributes: [] },
          },
          {
            model: Match,
            as: 'matches',
            attributes: ['id','date','status','homeTeamGoals','awayTeamGoals','notes','leagueId','start','homeCaptainId','awayCaptainId','createdAt','updatedAt','archived'],
            separate: true,
            order: [['date', 'DESC']],
            include: [
              { model: User, as: 'availableUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              { model: User, as: 'homeTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              { model: User, as: 'awayTeamUsers',  attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              { model: User, as: 'statistics',     attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
            ],
          },
        ],
      },
      { model: Match, as: 'homeTeamMatches', attributes: ['id', 'date', 'status', 'updatedAt'] },
      { model: Match, as: 'awayTeamMatches', attributes: ['id', 'date', 'status', 'updatedAt'] },
      { model: Match, as: 'availableMatches', attributes: ['id', 'date', 'status', 'updatedAt'] },
    ],
  }) as any;

  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Optional merge (kept), but keep nested match users slim (ids only)
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
            {
              model: Match,
              as: 'matches',
              attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals', 'notes', 'leagueId', 'start', 'homeCaptainId', 'awayCaptainId', 'createdAt', 'archived'],
              include: [
                { model: User, as: 'availableUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
                { model: User, as: 'homeTeamUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
                { model: User, as: 'awayTeamUsers', attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
                { model: User, as: 'statistics',   attributes: lightUserAttrsOnMatch, through: { attributes: [] } },
              ],
            },
          ],
        },
      ],
    }) as unknown as { id: string; email: string; leagues: typeof League[] };

    if (extractFromUser) {
      const userWithLeagues = user as unknown as { leagues: typeof League[] };
      userWithLeagues.leagues = [...userWithLeagues.leagues, ...extractFromUser.leagues];
    }
  }

  delete (user as any)["password"];

  const payload = { success: true, user };

  // Refresh server cache with short TTL (unless explicitly no-store requested)
  if (!forceRefresh) {
    cache.set(cacheKey, payload, AUTH_CACHE_TTL_SEC);
  } else {
    // Even on refresh, you can also re-seed the cache:
    cache.set(cacheKey, payload, AUTH_CACHE_TTL_SEC);
  }

  const etag = crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
  ctx.set('ETag', etag);
  ctx.set('Cache-Control', forceRefresh ? 'no-store, no-cache, must-revalidate' : `private, max-age=${AUTH_CLIENT_MAX_AGE_SEC}`);
  ctx.set('X-Cache', forceRefresh ? 'BYPASS' : 'MISS');

  if (!forceRefresh && ctx.get('If-None-Match') === etag) {
    ctx.status = 304;
    return;
  }

  ctx.set('X-Gen-Time', String(Date.now() - t0));
  ctx.body = payload;
});

router.post("/auth/logout", required, async (ctx: CustomContext) => {
  // For JWT, logout is handled on the client-side by deleting the token.
  // This endpoint can be kept for session invalidation if you mix strategies,
  // but for pure JWT it's often not needed.
  ctx.status = 200;
  ctx.body = { success: true, message: "Logged out successfully." };
}); 

router.get("/auth/status", required, async (ctx: CustomContext) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.throw(401, "Unauthorized");
    return;
  }

  const user = await User.findByPk(ctx.state.user.userId, {
    include: [
      {
        model: League,
        as: 'leagues',
        attributes: ['id', 'name', 'inviteCode', 'createdAt'],
        through: { attributes: [] } 
      },
      {
        model: League,
        as: 'administeredLeagues',
        attributes: ['id', 'name', 'inviteCode', 'createdAt'],
        through: { attributes: [] }
      },
      {
        model: Match,
        as: 'homeTeamMatches',
        attributes: ['id', 'date', 'status'],
      },
      {
        model: Match,
        as: 'awayTeamMatches',
        attributes: ['id', 'date', 'status'],
      },
      {
        model: Match,
        as: 'availableMatches',
        attributes: ['id', 'date', 'status'],
      }
    ]
  }) as any;

  if (!user) {
    ctx.throw(401, "Unauthorized");
    return;
  }
  
  ctx.body = {
    success: true,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      age: user.age,
      gender: user.gender,
      position: user.position,
      style: user.style,
      preferredFoot: user.preferredFoot,
      shirtNumber: user.shirtNumber,
      profilePicture: user.profilePicture,
      skills: user.skills,
      leagues: user.leagues || [],
      adminLeagues: user.administeredLeagues || [],
      homeTeamMatches: user.homeTeamMatches || [],
      awayTeamMatches: user.awayTeamMatches || [],
      availableMatches: user.availableMatches || [],
    }
  };
});

router.get("/me", required, async (ctx: CustomContext) => {
  if (!ctx.state.user) {
    ctx.throw(401, "Authentication error");
    return;
  }
  // const userId = ctx.state.user.userId;
  const user = await User.findOne({ 
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
    }, {
      model: League,
      as: 'administeredLeagues',
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
    }, {
      model: Match,
      as: 'homeTeamMatches'
    }, {
      model: Match,
      as: 'awayTeamMatches'
    }, {
      model: Match,
      as: 'availableMatches'
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
});

export default router;
