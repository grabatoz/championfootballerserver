import { Context } from 'koa';
import models from '../models';
import cache from '../utils/cache';

const { User, Match, MatchStatistics, Vote } = models;

export const getDreamTeam = async (ctx: Context) => {
  const leagueId = ctx.query.leagueId as string | undefined;
  if (!leagueId) {
    ctx.throw(400, 'leagueId is required');
    return;
  }

  const cacheKey = `dreamteam_${leagueId}`;
  const cached = cache.get(cacheKey);
  if (cached) { 
    ctx.body = cached; 
    return; 
  }

  try {
    // Get league and its members
    const league = await models.League.findByPk(leagueId, {
      include: [{ model: models.User, as: 'members' }]
    });
    
    if (!league) {
      ctx.throw(404, 'League not found');
      return;
    }
    
    const memberIds = (league as any).members.map((m: any) => m.id);

    // Get users who are members of this league
    const users = await User.findAll({
      where: { id: memberIds },
      include: [
        {
          model: MatchStatistics,
          as: 'statistics',
          include: [{
            model: Match,
            as: 'match',
            where: { status: 'RESULT_PUBLISHED', leagueId },
            include: [
              { model: User, as: 'homeTeamUsers', attributes: ['id'] },
              { model: User, as: 'awayTeamUsers', attributes: ['id'] }
            ]
          }]
        },
        {
          model: Vote,
          as: 'votesReceived',
          include: [{
            model: Match,
            as: 'votedMatch',
            where: { leagueId },
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
      let motm = (user.votesReceived || []).length;

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

    // Group by position type
    const positions = {
      Goalkeeper: playersWithScores.filter(p => p.positionType === 'Goalkeeper').sort((a, b) => b.score - a.score).slice(0, 1),
      Defender: playersWithScores.filter(p => p.positionType === 'Defender').sort((a, b) => b.score - a.score).slice(0, 4),
      Midfielder: playersWithScores.filter(p => p.positionType === 'Midfielder').sort((a, b) => b.score - a.score).slice(0, 3),
      Forward: playersWithScores.filter(p => p.positionType === 'Forward').sort((a, b) => b.score - a.score).slice(0, 3)
    };

    const dreamTeam = [
      ...positions.Goalkeeper,
      ...positions.Defender,
      ...positions.Midfielder,
      ...positions.Forward
    ];

    const result = {
      success: true,
      dreamTeam,
      formation: '1-4-3-3'
    };

    cache.set(cacheKey, result, 3600);
    ctx.body = result;
  } catch (error) {
    console.error('Dream team error:', error);
    ctx.throw(500, 'Failed to generate dream team');
  }
};
