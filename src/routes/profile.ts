import Router from '@koa/router';
import { required } from '../modules/auth';
import { CustomContext } from '../types';
import { 
  getProfile, 
  updateProfile,
  changePassword
} from '../controllers/profileController';
import models from '../models';
import { upload, uploadToCloudinary } from '../middleware/upload';
import cache from '../utils/cache';

const { User, Session, League, Match } = models;

const router = new Router({ prefix: '/profile' });

// Get user profile with all associations
router.get('/', required, getProfile);

// Patch (partial update) user profile
router.patch('/', required, updateProfile);

// Change password (requires current password verification)
router.patch('/password', required, changePassword);

// Delete profile picture
router.delete('/picture', required, async (ctx: CustomContext) => {
  if (!ctx.state.user?.userId) ctx.throw(401, 'User not authenticated');

  const user = await User.findByPk(ctx.state.user.userId);
  if (!user) ctx.throw(404, 'User not found');

  (user as any).profilePicture = null;
  await user.save();

  // Clear user cache
  cache.del(`auth_data_${ctx.state.user.userId}_ultra_fast`);
  cache.del(`auth_status_${ctx.state.user.userId}_fast`);

  // Update players cache
  const updatedUserData = {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    profilePicture: null,
    position: user.position,
    positionType: user.positionType,
    xp: user.xp || 0
  };
  cache.updateArray('players_all', updatedUserData);

  ctx.body = { success: true, message: 'Profile picture removed', user: updatedUserData };
});

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

router.get('/me', required, async (ctx) => {
  ctx.body = { success: true, user: ctx.state.user };
});

export default router;
