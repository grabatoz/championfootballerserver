import Router from '@koa/router';
import { required } from '../modules/auth';
import { CustomContext } from '../types';
import { 
  getProfile, 
  updateProfile
} from '../controllers/profileController';
import models from '../models';
import { upload, uploadToCloudinary } from '../middleware/upload';
import jwt from 'jsonwebtoken';
import cache from '../utils/cache';

const { User, Session, League, Match } = models;

const router = new Router({ prefix: '/profile' });

// Get user profile with all associations
router.get('/', required, getProfile);

// Patch (partial update) user profile
router.patch('/', required, updateProfile);

// Get user statistics
router.get('/statistics', required, async (ctx: CustomContext) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await User.findByPk(ctx.state.user.userId, {
    include: [
      { model: Match, as: 'homeTeamMatches' },
      { model: Match, as: 'awayTeamMatches' },
    ],
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
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await User.findByPk(ctx.state.user.userId, {
    include: [
      {
        model: League,
        as: 'leagues',
        include: [
          { model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] },
          { model: User, as: 'administeredLeagues', attributes: ['id'] },
        ],
      },
      { model: League, as: 'administeredLeagues' },
    ],
  });

  if (!user) {
    ctx.throw(404, "User not found");
  }

  const leagues = {
    joined: (user as any).leagues || [],
    managed: (user as any).administeredLeagues || [],
  };

  ctx.body = { 
    success: true,
    leagues 
  };
});

// Get user's match history
router.get('/matches', required, async (ctx: CustomContext) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
  }

  const user = await User.findByPk(ctx.state.user.userId, {
    include: [
      { model: Match, as: 'homeTeamMatches' },
      { model: Match, as: 'awayTeamMatches' },
      { model: Match, as: 'availableMatches' },
    ],
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
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
  }
  // Delete all sessions for this user before deleting the user
  await Session.destroy({ where: { userId: ctx.state.user.userId } });
  const user = await User.findByPk(ctx.state.user.userId);
  if (!user) {
    ctx.throw(404, "User not found");
  }
  await user.destroy();
  ctx.body = { success: true, message: "User deleted" };
});

// Add after other routes, before export default router
router.post('/picture', required, upload.single('profilePicture'), async (ctx: CustomContext) => {
  if (!ctx.state.user?.userId) ctx.throw(401, 'User not authenticated');

  const user = await User.findByPk(ctx.state.user.userId);
  if (!user) ctx.throw(404, 'User not found');
  if (!ctx.file) ctx.throw(400, 'No file uploaded');

  // Upload to Cloudinary and save URL
  const imageUrl = await uploadToCloudinary(ctx.file.buffer, 'profile-pictures');
  user.profilePicture = imageUrl;
  await user.save();

  // Update players cache
  const updatedUserData = {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    profilePicture: user.profilePicture,
    position: user.position,
    positionType: user.positionType,
    xp: user.xp || 0
  };
  cache.updateArray('players_all', updatedUserData);

  // Build a cacheBuster using Cloudinary version in URL (e.g. .../v1696000000/...)
  const m = typeof imageUrl === 'string' ? imageUrl.match(/\/v(\d+)\//) : null;
  const cacheBuster = m ? Number(m[1]) : Date.now();
  ctx.set('Cache-Control', 'no-store');
  ctx.body = { success: true, user: updatedUserData, cacheBuster };
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