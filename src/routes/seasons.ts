import Router from 'koa-router';
import { required } from '../modules/auth';
import * as seasonController from '../controllers/seasonController';

const router = new Router({ prefix: '/api/leagues/:leagueId/seasons' });

// Get all seasons for a league
router.get('/', required, seasonController.getAllSeasons);

// Get active season for a league
router.get('/active', required, seasonController.getActiveSeason);

// Create a new season (ends current season and creates new one)
router.post('/', required, seasonController.createNewSeason);

// Add player to current active season
router.post('/players/:userId', required, seasonController.addPlayerToSeason);

// Remove player from current active season
router.delete('/players/:userId', required, seasonController.removePlayerFromSeason);

// Direct season access router (for updating seasons by ID)
const directSeasonRouter = new Router({ prefix: '/api/seasons' });

// Update season settings (maxGames, showPoints)
directSeasonRouter.patch('/:seasonId', required, seasonController.updateSeason);

// Export both routers
export default router;
export { directSeasonRouter };
