import Router from "koa-router";
import sendEmail from "../modules/sendEmail"
import { none, required } from "../modules/auth"
import { League, Match, Session } from "../models"
import userModel from "../models/User";
import { hash, compare } from "bcrypt"
import { getLoginCode } from "../modules/utils"
import { Context } from "koa";

const router = new Router();

interface UserInput {
  firstName?: string;
  lastName?: string;
  age?: number;
  email: string;
  gender?: string;
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

router.post("/signup", none, async (ctx: Context) => {
  try {
    const { user } = ctx.request.body as {
      user: UserInput;
    };

    console.log('user', user);

    if (!user || !user.email || !user.password) {
      ctx.throw(400, "Email and password are required");
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(user.email)) {
      ctx.throw(400, "Invalid email format");
    }

    // Validate password strength
    if (user.password.length < 6) {
      ctx.throw(400, "Password must be at least 6 characters long");
    }

    // Convert email to lowercase
    user.email = user.email.toLowerCase();

    // Check if user already exists
    const existingUser = await userModel.findOne({ where: { email: user.email } });
    if (existingUser) {
      ctx.throw(409, "User with that email already exists");
    }

    // Create user with all required fields
    const newUser = await userModel.create({
      firstName: user.firstName || '',
      lastName: user.lastName || '',
      email: user.email,
      age: user.age,
      gender: user.gender,
      password: user.password,
      ipAddress: ctx.request.ip,
      attributes: {
        Pace: 50,
        Passing: 50,
        Physical: 50,
        Shooting: 50,
        Defending: 50,
        Dribbling: 50,
      }
    });

    // Create session
    const session = await Session.create({
      ipAddress: ctx.request.ip,
      userId: newUser.id
    });

    // Send welcome email
    try {
      await sendEmail({
        to: newUser.email,
        subject: `Welcome to Champion Footballer!`,
        html: `<div><img src="https://i.imgur.com/7wOPUk7.png" style="height:30px;" /></div>
        <a href="http://championfootballer.com" style="font-size:20px;font-weight:bold;margin-top:10px;">Login to Champion Footballer.</a>
        <div><img src="https://i.imgur.com/cH3e8JN.jpg" style="height:400px;" /></div>`,
      });
    } catch (emailError) {
      console.error('Error sending welcome email:', emailError);
      // Don't throw error here, just log it
    }

    // Return success response with token and user data
    ctx.status = 200;
    ctx.body = { 
      success: true,
      token: session.id,
      user: {
        id: newUser.id,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        email: newUser.email,
        age: newUser.age,
        gender: newUser.gender,
        attributes: newUser.attributes
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

router.post("/reset-password", none, async (ctx: CustomContext) => {
  const { email } = ctx.request.body.user as UserInput;
  if (!email) {
    ctx.throw(400, "Email is required");
  }
  
  const userEmail = email.toLowerCase();
  const password = getLoginCode();

  const user = await userModel.findOne({ where: { email: userEmail } });
  if (!user) {
    ctx.throw(404, "We can't find a user with that email.");
  }

  await user.update({ password: await hash(password, 10) });

  await sendEmail({
    to: userEmail,
    subject: `Password reset for Champion Footballer`,
    html: `Please use the new password ${password} to login.`,
  });

  ctx.response.status = 200;
});

router.post("/login", none, async (ctx: CustomContext) => {
  const { email, password } = ctx.request.body.user as UserInput;
  if (!email || !password) {
    ctx.throw(401, "No email or password entered.");
  }

  const userEmail = email.toLowerCase();
  const user = await userModel.findOne({
    where: { email: userEmail }
  });

  if (!user) {
    ctx.throw(404, "We can't find a user with that email");
  }

  if (!user.password) {
    ctx.throw(400, "User has no password. Please reset it now.");
  }

  if (!(await compare(password, user.password))) {
    ctx.throw(401, "Incorrect login details.");
  }

  const session = await Session.create({
    ipAddress: ctx.request.ip,
    userId: user.id
  });

  // Return success response with token and user data
  ctx.response.body = { 
    success: true,
    token: session.id,
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      age: user.age,
      gender: user.gender,
      attributes: user.attributes
    }
  };
});

router.get("/data", required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await userModel.findByPk(ctx.session.userId, {
    include: [{
      model: League,
      as: 'leaguesJoined',
      include: [{
        model: userModel,
        as: 'admins'
      }, {
        model: Match,
        as: 'matches',
        include: [{
          model: userModel,
          as: 'availableUsers'
        }, {
          model: userModel,
          as: 'homeTeamUsers'
        }, {
          model: userModel,
          as: 'awayTeamUsers'
        }]
      }, {
        model: userModel,
        as: 'users',
        include: [{
          model: Match,
          as: 'matchStatistics'
        }]
      }]
    }, {
      model: Match,
      as: 'matchStatistics'
    }]
  });

  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Add leagues to personal account for testing
  const myUserEmail = "huzaifahj29@gmail.com"
  const extractFromUserEmail = "ru.uddin@hotmail.com"
  if (user.email === myUserEmail) {
    const extractFromUser = await userModel.findOne({
      where: { email: extractFromUserEmail },
      include: [{
        model: League,
        as: 'leaguesJoined',
        include: [{
          model: userModel,
          as: 'admins'
        }, {
          model: Match,
          include: [{
            model: userModel,
            as: 'availableUsers'
          }, {
            model: userModel,
            as: 'homeTeamUsers'
          }, {
            model: userModel,
            as: 'awayTeamUsers'
          }]
        }, {
          model: userModel,
          as: 'users',
          include: [{
            model: Match,
            as: 'matchStatistics'
          }]
        }]
      }]
    }) as unknown as { 
      id: string;
      email: string;
      leaguesJoined: League[];
      matchStatistics: Match[];
    };
    if (extractFromUser) {
      const userWithLeagues = user as unknown as { leaguesJoined: League[] };
      userWithLeagues.leaguesJoined = [...userWithLeagues.leaguesJoined, ...extractFromUser.leaguesJoined];
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
  const deleteProperties = (input: InstanceType<typeof userModel>[] | InstanceType<typeof userModel>) => {
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
  for (const league of (user as any).leaguesJoined) {
    deleteProperties(league.admins)
    deleteProperties(league.users)
    for (const match of league.matches) {
      deleteProperties(match.availableUsers)
      deleteProperties(match.homeTeamUsers)
      deleteProperties(match.awayTeamUsers)
    }
  }

  ctx.body = user;
});

router.get("/logout", required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  await Session.destroy({
    where: {
      userId: ctx.session.userId
    }
  });

  ctx.status = 200;
});

export default router;
