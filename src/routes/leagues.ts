// League Routes - Controller-based implementation
import Router from 'koa-router';
import { required } from '../modules/auth';
import { upload } from '../middleware/upload';
import * as leagueController from '../controllers/leagueController.full';
import * as seasonController from '../controllers/seasonController';

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

// Get league-wide player averages (for career page influence radar)
router.get('/:id/player-averages', required, leagueController.getLeaguePlayerAverages);

// Get all seasons for a league
router.get('/:id/seasons', required, async (ctx) => {
  // Map :id param to :leagueId for season controller
  ctx.params.leagueId = ctx.params.id;
  await seasonController.getAllSeasons(ctx);
});

// Create league (with optional image upload)
router.post('/', required, upload.single('image'), leagueController.createLeague);

// Update league (with optional image upload)
router.patch('/:id', required, upload.single('image'), leagueController.updateLeague);

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

// Team-view (pitch formation screen)
router.get('/:id/matches/:matchId/team-view', required, leagueController.getTeamView);

// Save pitch layout positions
router.patch('/:id/matches/:matchId/layout', required, leagueController.saveLayout);

// Remove player from match team
router.post('/:id/matches/:matchId/remove', required, leagueController.removePlayerFromTeam);

// Make captain
router.post('/:id/matches/:matchId/make-captain', required, leagueController.makeCaptain);

// Switch player between teams
router.post('/:id/matches/:matchId/switch', required, leagueController.switchPlayerTeam);

// Replace player in match
router.post('/:id/matches/:matchId/replace', required, leagueController.replacePlayer);

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
