import { Context } from 'koa';
import models from '../models';
import { hash } from 'bcrypt';
import cache from '../utils/cache';

const { User, Session, League, Match } = models;

const SKILL_KEYS = ['dribbling', 'shooting', 'passing', 'pace', 'defending', 'physical'] as const;
type SkillKey = typeof SKILL_KEYS[number];
const DEFAULT_SKILLS: Record<SkillKey, number> = {
  dribbling: 50,
  shooting: 50,
  passing: 50,
  pace: 50,
  defending: 50,
  physical: 50,
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const getProfile = async (ctx: Context) => {
  if (!ctx.state.user?.userId) {
    ctx.throw(401, "User not authenticated");
    return;
  }

  console.log('Profile GET: userId', ctx.state.user.userId);

  const userAttributes = {
    exclude: ['password', 'ipAddress', 'resetCode', 'resetCodeExpiry', 'providerId'],
  };

  const includeFullProfile = ctx.query.include === 'full' || ctx.query.full === '1';
  
  const user = await User.findByPk(
    ctx.state.user.userId,
    includeFullProfile
      ? {
          attributes: userAttributes,
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
        }
      : {
          attributes: userAttributes,
        }
  );

  console.log('Profile GET: found user', user ? user.id : null);
  
  if (!user) {
    ctx.throw(404, "User not found");
    return;
  }

  const userObj = user.toJSON() as any;

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

  // Don't allow updating email or id through this endpoint
  delete updateData.email;
  delete updateData.id;

  // If a new password was provided, hash it before saving
  if (updateData.password && typeof updateData.password === 'string' && updateData.password.trim().length > 0) {
    const pw = updateData.password.trim();
    // Validate: 6-16 chars, 1 uppercase, 1 number, 1 special char
    if (pw.length < 6 || pw.length > 16) {
      ctx.throw(400, "Password must be 6-16 characters");
      return;
    }
    if (!/[A-Z]/.test(pw)) {
      ctx.throw(400, "Please ensure the password includes at least one uppercase letter.");
      return;
    }
    if (!/[0-9]/.test(pw)) {
      ctx.throw(400, "Password must include at least one number");
      return;
    }
    if (!/[^A-Za-z0-9]/.test(pw)) {
      ctx.throw(400, "Password must include at least one special character");
      return;
    }
    updateData.password = await hash(pw, 10);
  } else {
    delete updateData.password;
  }

  if (Object.prototype.hasOwnProperty.call(updateData, 'phoneCountryCode')) {
    const normalizedCode = String(updateData.phoneCountryCode ?? '').trim().toUpperCase();
    if (!normalizedCode) {
      updateData.phoneCountryCode = null;
    } else if (!/^[A-Z]{2}$/.test(normalizedCode)) {
      ctx.throw(400, 'Invalid phone country code');
      return;
    } else {
      updateData.phoneCountryCode = normalizedCode;
    }
  }

  // Merge partial skills payload with existing skills so unchanged values are preserved.
  if (Object.prototype.hasOwnProperty.call(updateData, 'skills')) {
    const incomingSkills = updateData.skills;

    if (incomingSkills == null) {
      delete updateData.skills;
    } else if (!isPlainObject(incomingSkills)) {
      ctx.throw(400, 'Invalid skills payload');
      return;
    } else {
      const currentSkillsRaw = isPlainObject((user as any).skills) ? ((user as any).skills as Record<string, unknown>) : {};
      const mergedSkills: Record<SkillKey, number> = { ...DEFAULT_SKILLS };

      for (const key of SKILL_KEYS) {
        const currentValue = Number(currentSkillsRaw[key]);
        if (Number.isFinite(currentValue)) {
          mergedSkills[key] = currentValue;
        }
      }

      let hasAtLeastOneSkill = false;
      for (const key of SKILL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(incomingSkills, key)) continue;
        const nextRaw = incomingSkills[key];
        if (nextRaw == null || nextRaw === '') continue;

        const nextValue = Number(nextRaw);
        if (!Number.isFinite(nextValue)) {
          ctx.throw(400, `Invalid skill value for ${key}`);
          return;
        }

        mergedSkills[key] = nextValue;
        hasAtLeastOneSkill = true;
      }

      if (hasAtLeastOneSkill) {
        updateData.skills = mergedSkills;
      } else {
        delete updateData.skills;
      }
    }
  }

  await user.update(updateData);

  // Clear user cache
  cache.del(`auth_data_${userId}_ultra_fast`);
  cache.del(`auth_status_${userId}_fast`);

  // Return all non-sensitive user fields
  const updatedUser = user.toJSON() as any;
  delete updatedUser.password;
  delete updatedUser.ipAddress;

  ctx.body = {
    success: true,
    message: "Profile updated successfully",
    user: updatedUser
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

  const nextPassword = String(newPassword || '').trim();
  if (nextPassword.length < 6 || nextPassword.length > 16) {
    ctx.throw(400, "Password must be 6-16 characters");
    return;
  }
  if (!/[A-Z]/.test(nextPassword)) {
    ctx.throw(400, "Please ensure the password includes at least one uppercase letter.");
    return;
  }
  if (!/[0-9]/.test(nextPassword)) {
    ctx.throw(400, "Password must include at least one number");
    return;
  }
  if (!/[^A-Za-z0-9]/.test(nextPassword)) {
    ctx.throw(400, "Password must include at least one special character");
    return;
  }

  // Hash new password
  const hashedPassword = await hash(nextPassword, 10);
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
