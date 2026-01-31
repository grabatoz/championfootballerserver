// Match Routes - Controller-based implementation
import Router from '@koa/router';
import { required } from '../modules/auth';
import * as matchController from '../controllers/matchController.full';

const router = new Router({ prefix: '/matches' });

// Create new match (automatically assigns to active season)
router.post('/', required, matchController.createMatch);

// Vote for MOTM
router.post('/:id/votes', required, matchController.voteForMotm);

// Get match votes
router.get('/:id/votes', required, matchController.getMatchVotes);

// Set match availability
router.post('/:matchId/availability', required, matchController.setMatchAvailability);

// Get match availability
router.get('/:matchId/availability', required, matchController.getMatchAvailability);

// Update match goals
router.patch('/:matchId/goals', required, matchController.updateMatchGoals);

// Update match note
router.patch('/:matchId/note', required, matchController.updateMatchNote);

// Confirm match result (for captains)
router.post('/:matchId/confirm', required, matchController.confirmMatchResult);

// Get stats window
router.get('/:matchId/stats-window', required, matchController.getStatsWindow);

// Submit match stats
router.post('/:matchId/stats', required, matchController.submitMatchStats);

// Get match stats
router.get('/:matchId/stats', required, matchController.getMatchStats);

// Check if match has stats
router.get('/:id/has-stats', required, matchController.hasMatchStats);

// Get captain picks
router.get('/:matchId/captain-picks', required, matchController.getCaptainPicks);

// Submit captain picks
router.post('/:matchId/captain-picks', required, matchController.submitCaptainPicks);

// Get match prediction
router.get('/:matchId/prediction', required, matchController.getMatchPrediction);

// Submit match prediction
router.post('/:matchId/prediction', required, matchController.submitMatchPrediction);

// Get all matches
router.get('/', required, matchController.getAllMatches);

// Get match by ID
router.get('/:matchId', required, matchController.getMatchById);

// Update match
router.put('/:id', required, matchController.updateMatch);

// Delete match
router.delete('/:id', required, matchController.deleteMatch);

export default router;
