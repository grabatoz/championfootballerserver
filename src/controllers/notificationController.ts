import { Context } from 'koa';
import Notification from '../models/Notification';
import User from '../models/User';

const importWithFallback = async <T = any>(specifier: string): Promise<T> => {
  try {
    return await import(specifier);
  } catch (err) {
    if (specifier.endsWith('.js')) {
      return await import(specifier.slice(0, -3) + '.ts');
    }
    throw err;
  }
};

export const getUserNotifications = async (ctx: Context) => {
  const userId = ctx.state.user?.userId;

  if (!userId) {
    ctx.throw(401, 'Not authenticated');
    return;
  }

  const notifications = await Notification.findAll({
    where: { user_id: userId },
    order: [['created_at', 'DESC']],
    limit: 50
  });

  ctx.body = {
    success: true,
    notifications
  };
};

export const markNotificationAsRead = async (ctx: Context) => {
  const { id } = ctx.params;
  const userId = ctx.state.user?.userId;

  const notification = await Notification.findOne({
    where: { 
      id,
      user_id: userId 
    }
  });

  if (!notification) {
    ctx.throw(404, 'Notification not found');
    return;
  }

  await notification.update({ read: true });

  ctx.body = {
    success: true,
    message: 'Notification marked as read'
  };
};

export const markAllAsRead = async (ctx: Context) => {
  const userId = ctx.state.user?.userId;

  if (!userId) {
    ctx.throw(401, 'Not authenticated');
    return;
  }

  await Notification.update(
    { read: true },
    { where: { user_id: userId, read: false } }
  );

  ctx.body = {
    success: true,
    message: 'All notifications marked as read'
  };
};

export const deleteNotification = async (ctx: Context) => {
  const { id } = ctx.params;
  const userId = ctx.state.user?.userId;

  const notification = await Notification.findOne({
    where: { 
      id,
      user_id: userId 
    }
  });

  if (!notification) {
    ctx.throw(404, 'Notification not found');
    return;
  }

  await notification.destroy();

  ctx.status = 204;
};

export const getUnreadCount = async (ctx: Context) => {
  const userId = ctx.state.user?.userId;

  if (!userId) {
    ctx.throw(401, 'Not authenticated');
    return;
  }

  const count = await Notification.count({
    where: { 
      user_id: userId,
      read: false 
    }
  });

  ctx.body = {
    success: true,
    unreadCount: count
  };
};

export const handleSeasonAction = async (ctx: Context) => {
  const { id } = ctx.params;
  const { action } = ctx.request.body as { action: 'join' | 'decline' };
  const userId = ctx.state.user?.userId;

  if (!userId) {
    ctx.throw(401, 'Not authenticated');
    return;
  }

  // Find the notification
  const notification = await Notification.findOne({
    where: { 
      id,
      user_id: userId,
      type: 'NEW_SEASON'
    }
  });

  if (!notification) {
    ctx.throw(404, 'Notification not found');
    return;
  }

  const meta = notification.meta || {};
  const leagueId = meta.leagueId;
  const seasonNumber = meta.seasonNumber;

  if (!leagueId) {
    ctx.throw(400, 'Invalid notification data');
    return;
  }

  try {
    // Import Season and User models
    const Season = (await importWithFallback('../models/Season.js')).default as any;
    const League = (await importWithFallback('../models/League.js')).default as any;

    // Get the season from notification meta (this is the exact season the notification is about)
    const seasonId = meta.seasonId;
    
    let targetSeason;
    if (seasonId) {
      // Use the specific season from notification
      targetSeason = await Season.findByPk(seasonId);
    } else {
      // Fallback to active season for old notifications without seasonId
      targetSeason = await Season.findOne({
        where: {
          leagueId,
          isActive: true
        }
      });
    }

    if (!targetSeason) {
      ctx.throw(404, 'Season not found');
      return;
    }

    if (action === 'join') {
      // Add user to the target season
      console.log(`📌 Adding user ${userId} to season ${targetSeason.id} (Season ${seasonNumber})`);
      try {
        await (targetSeason as any).addPlayer(userId);
      } catch (addError) {
        const err = addError as { message?: string; original?: { code?: string }; parent?: { code?: string } };
        const msg = String(err?.message || '').toLowerCase();
        const code = String(err?.original?.code || err?.parent?.code || '').toLowerCase();
        const isDuplicateMembership = code === '23505' || msg.includes('duplicate') || msg.includes('unique');
        if (!isDuplicateMembership) {
          throw addError;
        }
      }
      console.log(`✅ User ${userId} successfully added to season ${targetSeason.id}`);
      
      // Mark notification as read and update meta to show action taken
      await notification.update({ 
        read: true,
        meta: {
          ...meta,
          actionTaken: 'joined',
          actionDate: new Date()
        }
      });

      ctx.body = {
        success: true,
        message: `You have joined Season ${seasonNumber}!`,
        action: 'joined',
        seasonId: targetSeason.id
      };
    } else if (action === 'decline') {
      try {
        await (targetSeason as any).removePlayer(userId);
        console.log(`Removed user ${userId} from season ${targetSeason.id} after decline`);
      } catch (removeError) {
        console.error(`Error removing user ${userId} from season ${targetSeason.id}:`, removeError);
      }

      // Just mark as read and update meta
      await notification.update({ 
        read: true,
        meta: {
          ...meta,
          actionTaken: 'declined',
          actionDate: new Date()
        }
      });

      ctx.body = {
        success: true,
        message: 'You have declined to join the new season',
        action: 'declined'
      };
    } else {
      ctx.throw(400, 'Invalid action');
      return;
    }
  } catch (error) {
    console.error('Error handling season action:', error);
    ctx.throw(500, 'Failed to process season action');
  }
};
