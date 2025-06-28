import Router from '@koa/router';
import { required } from '../modules/auth';
import models from '../models';
import { Op } from 'sequelize';
const { User, Match, MatchStatistics, Vote } = models;

const router = new Router({ prefix: '/dream-team' });

// Get dream team - best players by position
router.get('/', required, async (ctx) => {
  try {
    const leagueId = ctx.query.leagueId as string | undefined;
    // Get all users with their statistics for the selected league
    const userWhere: any = {};
    const statsWhere: any = {};
    if (leagueId) {
      statsWhere['$statistics.match.leagueId$'] = leagueId;
    }
    const users = await User.findAll({
      where: userWhere,
      include: [
        {
          model: MatchStatistics,
          as: 'statistics',
          include: [{
            model: Match,
            as: 'match',
            where: { status: 'completed', ...(leagueId ? { leagueId } : {}) }
          }]
        },
        {
          model: Vote,
          as: 'receivedVotes'
        }
      ]
    });

    // Calculate player stats
    const playersWithStats = users.map(user => {
      const stats = (user as any).statistics || [];
      const votes = (user as any).receivedVotes || [];
      
      // Calculate total stats
      const totalStats = {
        matchesPlayed: stats.length,
        goals: stats.reduce((sum: number, stat: any) => sum + (stat.goals || 0), 0),
        assists: stats.reduce((sum: number, stat: any) => sum + (stat.assists || 0), 0),
        cleanSheets: stats.reduce((sum: number, stat: any) => sum + (stat.cleanSheets || 0), 0),
        motm: votes.length,
        winPercentage: 0,
        points: 0
      };

      // Calculate win percentage and points
      let wins = 0;
      stats.forEach((stat: any) => {
        if (stat.match) {
          const isHome = stat.match.homeTeamUsers?.some((u: any) => u.id === user.id);
          const isAway = stat.match.awayTeamUsers?.some((u: any) => u.id === user.id);
          
          if (isHome && (stat.match.homeTeamGoals || 0) > (stat.match.awayTeamGoals || 0)) {
            wins++;
            totalStats.points += 3;
          } else if (isAway && (stat.match.awayTeamGoals || 0) > (stat.match.homeTeamGoals || 0)) {
            wins++;
            totalStats.points += 3;
          } else if ((stat.match.homeTeamGoals || 0) === (stat.match.awayTeamGoals || 0)) {
            totalStats.points += 1;
          }
        }
      });

      totalStats.winPercentage = totalStats.matchesPlayed > 0 ? Math.round((wins / totalStats.matchesPlayed) * 100) : 0;

      return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        position: user.position,
        profilePicture: user.profilePicture,
        xp: user.xp || 0,
        achievements: user.achievements || [],
        stats: totalStats
      };
    });

    // Categorize players by position
    const categorizePlayer = (position: string) => {
      if (position?.includes('Goalkeeper')) return 'goalkeeper';
      if (position?.includes('Back') || position?.includes('Wing-back')) return 'defenders';
      if (position?.includes('Midfielder')) return 'midfielders';
      if (position?.includes('Forward') || position?.includes('Striker') || position?.includes('Winger')) return 'forwards';
      return 'midfielders'; // default fallback
    };

    // Sort players by performance score
    const calculatePerformanceScore = (player: any) => {
      const { stats, xp } = player;
      const position = categorizePlayer(player.position);
      
      let score = 0;
      
      // Base score from XP
      score += xp * 0.1;
      
      // Position-specific scoring
      if (position === 'goalkeeper') {
        score += stats.cleanSheets * 50;
        score += stats.motm * 30;
        score += stats.matchesPlayed * 10;
      } else if (position === 'defenders') {
        score += stats.goals * 40;
        score += stats.assists * 30;
        score += stats.cleanSheets * 20;
        score += stats.motm * 25;
        score += stats.points * 5;
      } else if (position === 'midfielders') {
        score += stats.goals * 35;
        score += stats.assists * 40;
        score += stats.motm * 30;
        score += stats.points * 5;
      } else if (position === 'forwards') {
        score += stats.goals * 50;
        score += stats.assists * 25;
        score += stats.motm * 35;
        score += stats.points * 5;
      }
      
      return score;
    };

    // Sort players by performance score
    playersWithStats.sort((a, b) => calculatePerformanceScore(b) - calculatePerformanceScore(a));

    // Group by position (1 GK, 2 DEF, 1 MID, 1 FWD)
    const dreamTeam = {
      goalkeeper: playersWithStats.filter(p => categorizePlayer(p.position) === 'goalkeeper').slice(0, 1),
      defenders: playersWithStats.filter(p => categorizePlayer(p.position) === 'defenders').slice(0, 2),
      midfielders: playersWithStats.filter(p => categorizePlayer(p.position) === 'midfielders').slice(0, 1),
      forwards: playersWithStats.filter(p => categorizePlayer(p.position) === 'forwards').slice(0, 1)
    };

    ctx.body = {
      success: true,
      dreamTeam,
      totalPlayers: playersWithStats.length
    };

  } catch (error) {
    console.error('Error fetching dream team:', error);
    ctx.throw(500, 'Failed to fetch dream team');
  }
});

export default router; 