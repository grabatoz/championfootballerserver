import Router from '@koa/router';
import { required } from '../modules/auth';
import { CustomContext } from '../types';
import models from '../models';
import { upload } from '../middleware/upload';
import { hash } from 'bcrypt';
import jwt from 'jsonwebtoken';
const { User, Session } = models;

const router = new Router({ prefix: '/profile' });

// Get user profile with all associations
router.get('/', required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }
  console.log('Profile GET: userId', ctx.session.userId);
  const user = await User.findByPk(ctx.session.userId, {
    include: [{
      model: User,
      as: 'joinedLeagues',
      include: [{
        model: User,
        as: 'administrators'
      }, {
        model: User,
        as: 'members'
      }]
    }, {
      model: User,
      as: 'managedLeagues'
    }, {
      model: User,
      as: 'homeTeamMatches'
    }, {
      model: User,
      as: 'awayTeamMatches'
    }, {
      model: User,
      as: 'availableMatches'
    }]
  });
  console.log('Profile GET: found user', user ? user.id : null);
  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Delete sensitive data
  const propertiesToDelete = [
    "password",
    "ipAddress",
  ];

  for (const property of propertiesToDelete) {
    delete (user as any)[property];
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
      positionType: user.positionType,
      style: user.style,
      preferredFoot: user.preferredFoot,
      shirtNumber: user.shirtNumber,
      profilePicture: user.profilePicture,
      skills: user.skills,
      joinedLeagues: (user as any).joinedLeagues || [],
      managedLeagues: (user as any).managedLeagues || [],
      homeTeamMatches: (user as any).homeTeamMatches || [],
      awayTeamMatches: (user as any).awayTeamMatches || [],
      availableMatches: (user as any).availableMatches || []
    }
  };
});

// Update user profile
router.put('/', required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }
  console.log('Profile PUT: userId', ctx.session.userId, 'update data', ctx.request.body);
  const { firstName, lastName, email, age, gender, position, positionType, style, preferredFoot, shirtNumber, skills, password } = ctx.request.body;
  console.log('Extracted positionType:', positionType);
  const user = await User.findByPk(ctx.session.userId);
  console.log('Profile PUT: found user', user ? user.id : null);
  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Prepare update data
  const updateData: any = {
    ...(firstName !== undefined && { firstName }),
    ...(lastName !== undefined && { lastName }),
    ...(email !== undefined && { email: email.toLowerCase() }),
    ...(age !== undefined && { age }),
    ...(gender !== undefined && { gender }),
    ...(position !== undefined && { position }),
    ...(positionType !== undefined && { positionType }),
    ...(style !== undefined && { style }),
    ...(preferredFoot !== undefined && { preferredFoot }),
    ...(shirtNumber !== undefined && { shirtNumber }),
    ...(skills !== undefined && { skills }),
  };
  
  console.log('Update data to be saved:', updateData);

  // Handle password update with hashing
  if (password !== undefined && password !== "") {
    console.log('🔐 Password update detected:', {
      hasPassword: !!password,
      passwordLength: password?.length,
      willHash: true
    });
    updateData.password = await hash(password, 10);
    console.log('🔐 Password hashed successfully, new hash length:', updateData.password.length);
  } else {
    console.log('🔐 No password update - keeping existing password');
  }

  // Only update fields that are present in the request
  await user.update(updateData);
  
  console.log('✅ User updated successfully');
  if (updateData.password) {
    console.log('🔐 Password was updated in database');
  }

  // Delete sensitive data
  const propertiesToDelete = [
    "password",
    "ipAddress",
  ];

  for (const property of propertiesToDelete) {
    delete (user as any)[property];
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
      positionType: user.positionType,
      style: user.style,
      preferredFoot: user.preferredFoot,
      shirtNumber: user.shirtNumber,
      profilePicture: user.profilePicture,
      skills: user.skills
    }
  };
});

// Get user statistics
router.get('/statistics', required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await User.findByPk(ctx.session.userId, {
    include: [{
      model: User,
      as: 'homeTeamMatches'
    }, {
      model: User,
      as: 'awayTeamMatches'
    }]
  });

  if (!user) {
    ctx.throw(404, "User not found");
  }

  // Calculate statistics
  const homeMatches = (user as any).homeTeamMatches || [];
  const awayMatches = (user as any).awayTeamMatches || [];
  const totalMatches = homeMatches.length + awayMatches.length;

  const statistics = {
    totalMatches,
    homeMatches: homeMatches.length,
    awayMatches: awayMatches.length,
    // Add more statistics as needed
  };

  ctx.body = { 
    success: true,
    statistics 
  };
});

// Get user's league history
router.get('/leagues', required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await User.findByPk(ctx.session.userId, {
    include: [{
      model: User,
      as: 'joinedLeagues',
      include: [{
        model: User,
        as: 'administrators'
      }, {
        model: User,
        as: 'members'
      }]
    }, {
      model: User,
      as: 'managedLeagues'
    }]
  });

  if (!user) {
    ctx.throw(404, "User not found");
  }

  const leagues = {
    joined: (user as any).joinedLeagues || [],
    managed: (user as any).managedLeagues || []
  };

  ctx.body = { 
    success: true,
    leagues 
  };
});

// Get user's match history
router.get('/matches', required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await User.findByPk(ctx.session.userId, {
    include: [{
      model: User,
      as: 'homeTeamMatches'
    }, {
      model: User,
      as: 'awayTeamMatches'
    }, {
      model: User,
      as: 'availableMatches'
    }]
  });

  if (!user) {
    ctx.throw(404, "User not found");
  }

  const matches = {
    home: (user as any).homeTeamMatches || [],
    away: (user as any).awayTeamMatches || [],
    available: (user as any).availableMatches || []
  };

  ctx.body = { 
    success: true,
    matches 
  };
});

// Delete user profile
router.delete('/', required, async (ctx: CustomContext) => {
  if (!ctx.session?.userId) {
    ctx.throw(401, "User not authenticated");
  }
  // Delete all sessions for this user before deleting the user
  await Session.destroy({ where: { userId: ctx.session.userId } });
  const user = await User.findByPk(ctx.session.userId);
  if (!user) {
    ctx.throw(404, "User not found");
  }
  await user.destroy();
  ctx.body = { success: true, message: "User deleted" };
});

// Add after other routes, before export default router
router.post('/picture', required, upload.single('profilePicture'), async (ctx: CustomContext) => {
  if (!ctx.session?.userId) ctx.throw(401, "User not authenticated");
  const user = await User.findByPk(ctx.session.userId);
  if (!user) ctx.throw(404, "User not found");

  // Save file path to user
  user.profilePicture = `/uploads/${ctx.file.filename}`;
  await user.save();

  ctx.body = { success: true, user };
});

// JWT-protected /me route
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

function jwtRequired(ctx: any, next: any) {
  const auth = ctx.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) ctx.throw(401, 'No token');
  const token = auth.split(' ')[1];
  try {
    ctx.state.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    ctx.throw(401, 'Invalid token');
  }
}

router.get('/me', jwtRequired, async (ctx) => {
  console.log('JWT user:', ctx.state.user);
  ctx.body = { success: true, user: ctx.state.user };
});

export default router; 