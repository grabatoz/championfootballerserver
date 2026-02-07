import { Context } from 'koa';
import models from '../models';
import cache from '../utils/cache';

const { User, Match, MatchStatistics, Vote } = models;

export const getDreamTeam = async (ctx: Context) => {
  const leagueId = ctx.query.leagueId as string | undefined;
  const seasonId = ctx.query.seasonId as string | undefined;
  
  if (!leagueId) {
    ctx.throw(400, 'leagueId is required');
    return;
  }

  const cacheKey = `dreamteam_${leagueId}_${seasonId || 'all'}`;
  const cached = cache.get(cacheKey);
  if (cached) { 
    ctx.body = cached; 
    return; 
  }

  try {
    // Get league and its members (optionally filtered by season)
    const leagueInclude: any = [{ model: models.User, as: 'members' }];
    
    const league = await models.League.findByPk(leagueId, {
      include: leagueInclude
    });
    
    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }
    
    let memberIds: string[];
    
    // If seasonId is provided, get members for that season
    if (seasonId) {
      const season = await models.Season.findOne({
        where: { id: seasonId, leagueId },
        include: [{ model: models.User, as: 'players' }]
      });
      
      if (!season) {
        ctx.throw(404, 'Season not found');
        return;
      }
      
      memberIds = (season as any).players?.map((m: any) => m.id) || [];
    } else {
      memberIds = (league as any).members.map((m: any) => m.id);
    }

    // Build match where clause
    const matchWhere: any = { status: 'RESULT_PUBLISHED', leagueId };
    if (seasonId) {
      matchWhere.seasonId = seasonId;
    }

    // Get users who are members of this league/season
    const users = await User.findAll({
      where: { id: memberIds },
      include: [
        {
          model: MatchStatistics,
          as: 'statistics',
          include: [{
            model: Match,
            as: 'match',
            where: matchWhere,
            include: [
              { model: User, as: 'homeTeamUsers', attributes: ['id'] },
              { model: User, as: 'awayTeamUsers', attributes: ['id'] }
            ]
          }]
        },
        {
          model: Vote,
          as: 'receivedVotes',
          include: [{
            model: Match,
            as: 'votedMatch',
            where: matchWhere,
            attributes: []
          }]
        }
      ]
    });

    // Calculate player scores
    const playersWithScores = users.map((user: any) => {
      const stats = user.statistics || [];
      let totalGoals = 0;
      let totalAssists = 0;
      let totalRating = 0;
      let wins = 0;
      let matches = stats.length;
      let motm = (user.receivedVotes || []).length;

      stats.forEach((stat: any) => {
        totalGoals += stat.goals || 0;
        totalAssists += stat.assists || 0;
        totalRating += stat.rating || 0;

        const match = stat.match;
        if (match) {
          const homeTeamIds = match.homeTeamUsers?.map((u: any) => u.id) || [];
          const awayTeamIds = match.awayTeamUsers?.map((u: any) => u.id) || [];
          const isHome = homeTeamIds.includes(user.id);
          const isAway = awayTeamIds.includes(user.id);

          if (isHome && match.homeTeamGoals > match.awayTeamGoals) wins++;
          if (isAway && match.awayTeamGoals > match.homeTeamGoals) wins++;
        }
      });

      const avgRating = matches > 0 ? totalRating / matches : 0;
      const score = (totalGoals * 3) + (totalAssists * 2) + (avgRating * 0.5) + (wins * 1) + (motm * 5);

      return {
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        name: `${user.firstName} ${user.lastName}`,
        position: user.position,
        positionType: user.positionType,
        profilePicture: user.profilePicture,
        stats: {
          goals: totalGoals,
          assists: totalAssists,
          rating: parseFloat(avgRating.toFixed(1)),
          matches,
          wins,
          motm
        },
        score: parseFloat(score.toFixed(2))
      };
    });

    // Group by position type - 1-1-1-2 formation for 5-a-side (1 GK, 1 defender, 1 midfielder, 2 forwards)
    // Also check the position field as fallback if positionType is not set
    const getPositionType = (player: any) => {
      if (player.positionType) return player.positionType;
      
      // Fallback: check position field for keywords
      const pos = (player.position || '').toLowerCase();
      if (pos.includes('goalkeeper') || pos.includes('gk')) return 'Goalkeeper';
      if (pos.includes('back') || pos.includes('defender') || pos.includes('cb') || pos.includes('rb') || pos.includes('lb')) return 'Defender';
      if (pos.includes('midfield') || pos.includes('cm') || pos.includes('dm') || pos.includes('am') || pos.includes('cdm') || pos.includes('cam')) return 'Midfielder';
      if (pos.includes('forward') || pos.includes('striker') || pos.includes('winger') || pos.includes('st') || pos.includes('cf') || pos.includes('lw') || pos.includes('rw')) return 'Forward';
      
      return 'Forward'; // Default to forward if unknown
    };

    const positions = {
      Goalkeeper: playersWithScores.filter(p => getPositionType(p) === 'Goalkeeper').sort((a, b) => b.score - a.score).slice(0, 1), // Top 1 goalkeeper
      Defender: playersWithScores.filter(p => getPositionType(p) === 'Defender').sort((a, b) => b.score - a.score).slice(0, 1), // Top 1 defender
      Midfielder: playersWithScores.filter(p => getPositionType(p) === 'Midfielder').sort((a, b) => b.score - a.score).slice(0, 1), // Top 1 midfielder
      Forward: playersWithScores.filter(p => getPositionType(p) === 'Forward').sort((a, b) => b.score - a.score).slice(0, 2) // Top 2 forwards
    };

    const result = {
      success: true,
      dreamTeam: {
        goalkeeper: positions.Goalkeeper,
        defenders: positions.Defender,
        midfielders: positions.Midfielder,
        forwards: positions.Forward
      },
      formation: '1-1-1-2' // 5-a-side: 1 GK, 1 DEF, 1 MID, 2 FWD
    };

    cache.set(cacheKey, result, 3600);
    ctx.body = result;
  } catch (error) {
    console.error('Dream team error:', error);
    ctx.throw(500, 'Failed to generate dream team');
  }
};
