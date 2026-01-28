import { Context } from 'koa';
import models from '../models';
import { hash } from 'bcrypt';
import jwt from 'jsonwebtoken';
import cache from '../utils/cache';

const { User, Session, League, Match } = models;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

export const getProfile = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
    return;
  }

  console.log('Profile GET: userId', ctx.state.user.userId);
  
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
      {
        model: League,
        as: 'administeredLeagues',
        include: [{ model: User, as: 'members', attributes: ['id', 'firstName', 'lastName', 'position', 'positionType'] }],
      },
      { model: Match, as: 'homeTeamMatches' },
      { model: Match, as: 'awayTeamMatches' },
      { model: Match, as: 'availableMatches' },
    ],
  });

  console.log('Profile GET: found user', user ? user.id : null);
  
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  // Delete sensitive data
  const userObj = user.toJSON() as any;
  delete userObj.password;
  delete userObj.ipAddress;

  ctx.body = {
    success: true,
    user: userObj
  };
};

export const updateProfile = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
    return;
  }

  const userId = ctx.state.user.userId;
  const updateData = ctx.request.body as any;

  const user = await User.findByPk(userId);
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  // Don't allow updating email or password through this endpoint
  delete updateData.email;
  delete updateData.password;
  delete updateData.id;

  await user.update(updateData);

  // Clear user cache
  cache.del(`auth_data_${userId}_ultra_fast`);
  cache.del(`auth_status_${userId}_fast`);

  ctx.body = {
    success: true,
    message: "Profile updated successfully",
    user: {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email
    }
  };
};

export const uploadProfilePicture = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
    return;
  }

  const userId = ctx.state.user.userId;
  const { profilePicture } = ctx.request.body as any;

  if (!profilePicture) {
    ctx.throw(400, "Profile picture URL is required");
    return;
  }

  const user = await User.findByPk(userId);
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  await user.update({ profilePicture });

  // Clear user cache
  cache.del(`auth_data_${userId}_ultra_fast`);
  cache.del(`auth_status_${userId}_fast`);

  ctx.body = {
    success: true,
    message: "Profile picture updated successfully",
    profilePicture
  };
};

export const changePassword = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
    return;
  }

  const userId = ctx.state.user.userId;
  const { currentPassword, newPassword } = ctx.request.body as any;

  if (!currentPassword || !newPassword) {
    ctx.throw(400, "Current password and new password are required");
    return;
  }

  const user = await User.findByPk(userId);
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  // Verify current password
  const bcrypt = require('bcrypt');
  const isValid = await bcrypt.compare(currentPassword, user.password);
  if (!isValid) {
    ctx.throw(401, "Current password is incorrect");
    return;
  }

  // Hash new password
  const hashedPassword = await hash(newPassword, 10);
  await user.update({ password: hashedPassword });

  ctx.body = {
    success: true,
    message: "Password changed successfully"
  };
};

export const deleteProfile = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
    return;
  }

  const userId = ctx.state.user.userId;
  const user = await User.findByPk(userId);
  
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  await user.destroy();

  // Clear all user caches
  cache.del(`auth_data_${userId}_ultra_fast`);
  cache.del(`auth_status_${userId}_fast`);
  cache.del(`user_leagues_${userId}`);

  ctx.body = {
    success: true,
    message: "Profile deleted successfully"
  };
};
