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

    // 1. Fetch matches in the league/season that have status 'RESULT_PUBLISHED'
    const matches = await Match.findAll({
      where: matchWhere,
      include: [
        { model: User, as: 'homeTeamUsers', attributes: ['id'] },
        { model: User, as: 'awayTeamUsers', attributes: ['id'] }
      ]
    });

    const matchIds = matches.map(m => m.id);

    // If there are no published matches, return empty dream team immediately
    if (matchIds.length === 0) {
      const result = {
        success: true,
        dreamTeam: {
          goalkeeper: [],
          defenders: [],
          midfielders: [],
          forwards: []
        },
        formation: '1-1-1-2'
      };
      cache.set(cacheKey, result, 3600);
      ctx.body = result;
      return;
    }

    // 2. Fetch match statistics for the league members in these matches
    const statistics = await MatchStatistics.findAll({
      where: {
        user_id: memberIds,
        match_id: matchIds
      }
    });

    // 3. Fetch votes for these matches
    const votes = await Vote.findAll({
      where: {
        votedForId: memberIds,
        matchId: matchIds
      }
    });

    // 4. Fetch basic user details for these members
    const users = await User.findAll({
      where: { id: memberIds },
      attributes: ['id', 'firstName', 'lastName', 'position', 'positionType', 'profilePicture']
    });

    // Map statistics and votes by userId for fast O(1) lookup
    const statsByUser = new Map<string, any[]>();
    statistics.forEach((stat: any) => {
      if (!statsByUser.has(stat.user_id)) {
        statsByUser.set(stat.user_id, []);
      }
      statsByUser.get(stat.user_id)!.push(stat);
    });

    const votesByUser = new Map<string, any[]>();
    votes.forEach((vote: any) => {
      if (!votesByUser.has(vote.votedForId)) {
        votesByUser.set(vote.votedForId, []);
      }
      votesByUser.get(vote.votedForId)!.push(vote);
    });

    const matchesMap = new Map<string, any>();
    matches.forEach((m: any) => {
      matchesMap.set(m.id, m);
    });

    // Calculate player scores
    const playersWithScores = users.map((user: any) => {
      const stats = statsByUser.get(user.id) || [];
      const userVotes = votesByUser.get(user.id) || [];
      
      let totalGoals = 0;
      let totalAssists = 0;
      let totalRating = 0;
      let wins = 0;
      let matchesPlayed = stats.length;
      let motm = userVotes.length;

      stats.forEach((stat: any) => {
        totalGoals += stat.goals || 0;
        totalAssists += stat.assists || 0;
        totalRating += stat.rating || 0;

        const match = matchesMap.get(stat.match_id);
        if (match) {
          const homeTeamIds = match.homeTeamUsers?.map((u: any) => u.id) || [];
          const awayTeamIds = match.awayTeamUsers?.map((u: any) => u.id) || [];
          const isHome = homeTeamIds.includes(user.id);
          const isAway = awayTeamIds.includes(user.id);

          if (isHome && match.homeTeamGoals > match.awayTeamGoals) wins++;
          if (isAway && match.awayTeamGoals > match.homeTeamGoals) wins++;
        }
      });

      const avgRating = matchesPlayed > 0 ? totalRating / matchesPlayed : 0;
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
          matches: matchesPlayed,
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
