import Router from '@koa/router';
import { required } from '../modules/auth';
import { 
  getUserNotifications, 
  markNotificationAsRead, 
  deleteNotification,
  handleSeasonAction
} from '../controllers/notificationController';

const router = new Router({ prefix: '/notifications' });

// GET /notifications - Fetch user's notifications
router.get('/', required, getUserNotifications);

// PATCH /notifications/:id/read - Mark single notification as read
router.patch('/:id/read', required, markNotificationAsRead);

// DELETE /notifications/:id - Delete single notification
router.delete('/:id', required, deleteNotification);

// POST /notifications/:id/season-action - Handle join/decline season action
router.post('/:id/season-action', required, handleSeasonAction);

export default router;