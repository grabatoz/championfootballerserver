import Router from '@koa/router';
import { required } from '../modules/auth';
import  Notification  from '../models/Notification';
import { Op } from 'sequelize';

const router = new Router({ prefix: '/notifications' });

// GET /notifications - Fetch user's notifications
router.get('/', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }

  
  try {
    console.log(`🔔 Fetching notifications for user: ${ctx.state.user.userId}`);
    
    const notifications = await Notification.findAll({
      where: { 
        user_id: ctx.state.user.userId 
      },
      order: [['created_at', 'DESC']],
      limit: 50
    });

    console.log(`📬 Found ${notifications.length} notifications for user ${ctx.state.user.userId}`);

    const formattedNotifications = notifications.map((n: any) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      meta: n.meta ? (typeof n.meta === 'string' ? JSON.parse(n.meta) : n.meta) : null,
      read: n.read,
      created_at: n.created_at,
      updated_at: n.updated_at
    }));

    ctx.body = {
      success: true,
      notifications: formattedNotifications
    };
  } catch (error) {
    console.error('❌ Error fetching notifications:', error);
    ctx.status = 500;
    ctx.body = { success: false, message: "Failed to fetch notifications" };
  }
});

// PATCH /notifications/:id/read - Mark single notification as read
router.patch('/:id/read', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }

  try {
    const notification = await Notification.findOne({
      where: { 
        id: ctx.params.id,
        user_id: ctx.state.user.userId 
      }
    });

    if (!notification) {
      ctx.status = 404;
      ctx.body = { success: false, message: "Notification not found" };
      return;
    }

    await notification.update({ read: true });
    console.log(`📖 Marked notification ${ctx.params.id} as read`);

    ctx.body = { success: true, message: "Notification marked as read" };
  } catch (error) {
    console.error('❌ Error marking notification as read:', error);
    ctx.status = 500;
    ctx.body = { success: false, message: "Failed to mark as read" };
  }
});

// PATCH /notifications/read-all - Mark all notifications as read
router.patch('/read-all', required, async (ctx) => {
  if (!ctx.state.user || !ctx.state.user.userId) {
    ctx.status = 401;
    ctx.body = { success: false, message: "Unauthorized" };
    return;
  }

  try {
    const result = await Notification.update(
      { read: true },
      { 
        where: { 
          user_id: ctx.state.user.userId,
          read: false
        } 
      }
    );

    console.log(`📖 Marked ${result[0]} notifications as read for user ${ctx.state.user.userId}`);

    ctx.body = { 
      success: true, 
      message: `Marked ${result[0]} notifications as read`,
      updated: result[0]
    };
  } catch (error) {
    console.error('❌ Error marking all notifications as read:', error);
    ctx.status = 500;
    ctx.body = { success: false, message: "Failed to mark all as read" };
  }
});

export default router;