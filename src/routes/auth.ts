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
      await transporter.sendMail({
        to: newUser.email,
        subject: `Welcome to Champion Footballer!`,
        html: `
        <a href="https://championfootballer-client.vercel.app" style="font-size:20px;font-weight:bold;margin-top:10px;">Login to Champion Footballer.</a>
        `,
      });
      // <img src="https://i.imgur.com/cH3e8JN.jpg" style="height:400px;" />
      // <img src="https://i.imgur.com/7wOPUk7.png" style="height:30px;" />
      console.log('Welcome email sent successfully');
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
    where: { email: userEmail }
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

  const userId = ctx.state.user.userId;
  const cacheKey = `auth_data_${userId}_ultra_fast`;

  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  const user = await User.findByPk(userId, {
    attributes: [
      'id',
      'firstName',
      'lastName',
      'email',
      'position',
      'positionType',
      'style',
      'preferredFoot',
      'shirtNumber',
      'profilePicture',
      'skills',
      'xp',
    ],
    include: [
      {
        model: League,
        as: 'leagues',
        attributes: ['id', 'name', 'inviteCode', 'createdAt'],
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
            attributes: [
              'id',
              'date',
              'status',
              'homeTeamGoals',
              'awayTeamGoals',
              'notes',
              'leagueId',
              'start',
              'homeCaptainId',
              'awayCaptainId',
              'createdAt',
            ],
            include: [
              {
                model: User,
                as: 'availableUsers',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              },
              {
                model: User,
                as: 'homeTeamUsers',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              },
              {
                model: User,
                as: 'awayTeamUsers',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              },
              // keep association for compatibility, but very light
              { model: User, as: 'statistics', attributes: ['id'], through: { attributes: [] } },
            ],
          },
        ],
      },
      {
        model: League,
        as: 'administeredLeagues',
        attributes: ['id', 'name', 'inviteCode', 'createdAt'],
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
            attributes: [
              'id',
              'date',
              'status',
              'homeTeamGoals',
              'awayTeamGoals',
              'notes',
              'leagueId',
              'start',
              'homeCaptainId',
              'awayCaptainId',
              'createdAt',
            ],
            include: [
              {
                model: User,
                as: 'availableUsers',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              },
              {
                model: User,
                as: 'homeTeamUsers',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              },
              {
                model: User,
                as: 'awayTeamUsers',
                attributes: ['id', 'firstName', 'lastName', 'positionType', 'shirtNumber', 'profilePicture'],
                through: { attributes: [] },
              },
              { model: User, as: 'statistics', attributes: ['id'], through: { attributes: [] } },
            ],
          },
        ],
      },
      { model: Match, as: 'homeTeamMatches', attributes: ['id', 'date', 'status'] },
      { model: Match, as: 'awayTeamMatches', attributes: ['id', 'date', 'status'] },
      { model: Match, as: 'availableMatches', attributes: ['id', 'date', 'status'] },
    ],
  }) as any;

  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Optional: testing merge (kept, but executes a narrower query)
  const myUserEmail = "huzaifahj29@gmail.com";
  const extractFromUserEmail = "ru.uddin@hotmail.com";
  if (user.email === myUserEmail) {
    const extractFromUser = await User.findOne({
      where: { email: extractFromUserEmail },
      include: [
        {
          model: League,
          as: 'leagues',
          attributes: ['id', 'name', 'inviteCode', 'createdAt'],
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
              attributes: ['id', 'date', 'status', 'homeTeamGoals', 'awayTeamGoals', 'notes', 'leagueId', 'start', 'homeCaptainId', 'awayCaptainId', 'createdAt'],
              include: [
                { model: User, as: 'availableUsers', attributes: ['id'], through: { attributes: [] } },
                { model: User, as: 'homeTeamUsers', attributes: ['id'], through: { attributes: [] } },
                { model: User, as: 'awayTeamUsers', attributes: ['id'], through: { attributes: [] } },
                { model: User, as: 'statistics', attributes: ['id'], through: { attributes: [] } },
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

  // Ensure password is not present
  delete (user as any)["password"];

  const payload = { success: true, user };
  cache.set(cacheKey, payload, 300); // 5 min
  ctx.set('X-Cache', 'MISS');
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
