// League Routes - Controller-based implementation
import Router from 'koa-router';
import { required } from '../modules/auth';
import { upload } from '../middleware/upload';
import * as leagueController from '../controllers/leagueController.full';

const router = new Router({ prefix: '/leagues' });

// List all leagues for current user
router.get('/', required, leagueController.getAllLeagues);

// Get trophy room
router.get('/trophy-room', required, leagueController.getTrophyRoom);

// Get user's leagues (with cache)
router.get('/user-leagues', required, leagueController.getUserLeagues);

// Get league by ID
router.get('/:id', required, leagueController.getLeagueById);

// Get league statistics
router.get('/:id/statistics', required, leagueController.getLeagueStatistics);

// Get league XP for all members
router.get('/:id/xp', required, leagueController.getLeagueXP);

// Create league (with optional image upload)
router.post('/', required, upload.single('image'), leagueController.createLeague);

// Update league
router.patch('/:id', required, leagueController.updateLeague);

// Update league status
router.patch('/:id/status', required, leagueController.updateLeagueStatus);

// Delete league
router.delete('/:id', required, leagueController.deleteLeague);

// Join league via invite code
router.post('/join', required, leagueController.joinLeague);

// Leave league
router.post('/:id/leave', required, leagueController.leaveLeague);

// Remove user from league (admin only)
router.delete('/:id/members/:userId', required, leagueController.removeUserFromLeague);

// Create match in league (with optional team images)
router.post('/:id/matches', required, upload.fields([
  { name: 'homeTeamImage', maxCount: 1 },
  { name: 'awayTeamImage', maxCount: 1 }
]), leagueController.createMatchInLeague);

// Get specific match in league
router.get('/:id/matches/:matchId', required, leagueController.getLeagueMatch);

// Update match in league
router.patch('/:id/matches/:matchId', required, upload.fields([
  { name: 'homeTeamImage', maxCount: 1 },
  { name: 'awayTeamImage', maxCount: 1 }
]), leagueController.updateMatchInLeague);

// Get match availability in league
router.get('/:leagueId/matches/:matchId/availability', required, leagueController.getMatchAvailability);

// Get player quick view (MOTM count etc)
router.get('/:id/player/:playerId/quick-view', required, leagueController.getPlayerQuickView);

// Notify members about new season
router.post('/:id/notify-new-season', required, leagueController.notifyMembersNewSeason);

export default router;
