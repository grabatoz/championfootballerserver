import { Context } from 'koa';
import models from '../models';
import { Op } from 'sequelize';
import cache from '../utils/cache';

const { User: UserModel, Match: MatchModel, MatchStatistics, League: LeagueModel, Vote } = models;

export const getAllPlayers = async (ctx: Context) => {
  const cacheKey = 'players_all_ultra_fast';
  const cached = cache.get(cacheKey);
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }
  
  try {
    const players = await UserModel.findAll({
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType'],
      where: {
        xp: { [Op.gt]: 0 }
      },
      order: [['xp', 'DESC']],
      limit: 50
    });
    
    const result = {
      success: true,
      players: players.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        profilePicture: p.profilePicture,
        rating: p.xp || 0,
        position: p.position,
        positionType: p.positionType,
      })),
    };
    cache.set(cacheKey, result, 1800);
    ctx.set('X-Cache', 'MISS');
    ctx.body = result;
  } catch (error) {
    console.error('Error fetching all players:', error);
    ctx.throw(500, 'Failed to fetch players.');
  }
};

export const getPlayerById = async (ctx: Context) => {
  const { id } = ctx.params;
  
  try {
    const player = await UserModel.findByPk(id, {
      attributes: { exclude: ['password'] },
      include: [
        {
          model: LeagueModel,
          as: 'leagues',
          attributes: ['id', 'name', 'image']
        },
        {
          model: MatchStatistics,
          as: 'statistics'
        }
      ]
    });

    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    ctx.body = {
      success: true,
      player
    };
  } catch (error) {
    console.error('Error fetching player:', error);
    ctx.throw(500, 'Failed to fetch player.');
  }
};

export const getPlayerStats = async (ctx: Context) => {
  const { id } = ctx.params;
  const { leagueId, year } = ctx.query as { leagueId?: string; year?: string };

  try {
    const player = await UserModel.findByPk(id, {
      attributes: ['id'],
      include: [{ model: LeagueModel, as: 'leagues', attributes: ['id', 'name'] }]
    });

    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    const matchWhere: Record<string, unknown> = {
      status: { [Op.in]: ['RESULT_PUBLISHED', 'RESULT_UPLOADED'] }
    };

    if (leagueId && leagueId !== 'all') {
      matchWhere.leagueId = leagueId;
    }

    if (year && year !== 'all') {
      const y = Number(year);
      if (!Number.isNaN(y)) {
        matchWhere.date = {
          [Op.gte]: new Date(Date.UTC(y, 0, 1)),
          [Op.lt]: new Date(Date.UTC(y + 1, 0, 1))
        };
      }
    }

    const statsRows = await MatchStatistics.findAll({
      where: { user_id: id },
      include: [{
        model: MatchModel,
        as: 'match',
        where: matchWhere,
        attributes: ['id', 'date', 'leagueId', 'homeTeamGoals', 'awayTeamGoals', 'status'],
        include: [
          { model: UserModel, as: 'homeTeamUsers', attributes: ['id'] },
          { model: UserModel, as: 'awayTeamUsers', attributes: ['id'] }
        ]
      }],
      attributes: ['match_id', 'goals', 'assists', 'cleanSheets', 'defence', 'impact', 'xpAwarded']
    });

    const matchIds = Array.from(new Set(
      statsRows
        .map((s: any) => String(s.match_id || s.match?.id || '').trim())
        .filter(Boolean)
    ));

    const votes = matchIds.length
      ? await Vote.findAll({
          where: { matchId: { [Op.in]: matchIds }, votedForId: id },
          attributes: ['matchId'],
          raw: true
        })
      : [];

    const votesByMatch: Record<string, number> = {};
    (votes as any[]).forEach((v) => {
      const mid = String(v.matchId);
      votesByMatch[mid] = (votesByMatch[mid] || 0) + 1;
    });

    let played = 0;
    let wins = 0;
    let draws = 0;
    let losses = 0;
    let goals = 0;
    let assists = 0;
    let cleanSheets = 0;
    let defence = 0;
    let totalImpact = 0;
    let totalXP = 0;
    let teamGoalsConceded = 0;
    let motmVotes = 0;

    statsRows.forEach((stat: any) => {
      const match = stat.match;
      if (!match) return;

      const matchId = String(match.id);
      const homeIds = (match.homeTeamUsers || []).map((u: any) => String(u.id));
      const awayIds = (match.awayTeamUsers || []).map((u: any) => String(u.id));
      const isHome = homeIds.includes(String(id));
      const isAway = awayIds.includes(String(id));
      if (!isHome && !isAway) return;

      const homeGoals = Number(match.homeTeamGoals || 0);
      const awayGoals = Number(match.awayTeamGoals || 0);
      const teamGoals = isHome ? homeGoals : awayGoals;
      const oppGoals = isHome ? awayGoals : homeGoals;

      played += 1;
      goals += Number(stat.goals || 0);
      assists += Number(stat.assists || 0);
      cleanSheets += Number(stat.cleanSheets || 0);
      defence += Number(stat.defence || 0);
      totalImpact += Number(stat.impact || 0);
      totalXP += Number(stat.xpAwarded || 0);
      motmVotes += Number(votesByMatch[matchId] || 0);
      teamGoalsConceded += oppGoals;

      if (teamGoals === oppGoals) draws += 1;
      else if (teamGoals > oppGoals) wins += 1;
      else losses += 1;
    });

    const avgImpact = played > 0 ? +(totalImpact / played).toFixed(2) : 0;
    const avgXP = played > 0 ? +(totalXP / played).toFixed(2) : 0;

    const totalStats = {
      // legacy keys (for old callers)
      goals,
      assists,
      motm: motmVotes,
      rating: avgImpact,
      matches: played,
      // canonical keys
      played,
      wins,
      draws,
      losses,
      cleanSheets,
      defence,
      impact: avgImpact,
      contributionIndex: avgImpact,
      motmVotes,
      teamGoalsConceded,
      totalXP,
      xp: totalXP,
      avgXP,
    };

    const leagues = ((player as any).leagues || []).map((l: any) => ({
      id: String(l.id),
      name: l.name || 'League'
    }));

    ctx.body = {
      success: true,
      stats: totalStats,
      data: { leagues }
    };
  } catch (error) {
    console.error('Error fetching player stats:', error);
    ctx.throw(500, 'Failed to fetch player stats.');
  }
};

export const searchPlayers = async (ctx: Context) => {
  const { q } = ctx.query;

  if (!q || typeof q !== 'string') {
    ctx.throw(400, 'Search query is required');
    return;
  }

  try {
    const players = await UserModel.findAll({
      where: {
        [Op.or]: [
          { firstName: { [Op.iLike]: `%${q}%` } },
          { lastName: { [Op.iLike]: `%${q}%` } },
          { email: { [Op.iLike]: `%${q}%` } }
        ]
      },
      attributes: ['id', 'firstName', 'lastName', 'email', 'profilePicture', 'position', 'xp'],
      limit: 20
    });

    ctx.body = {
      success: true,
      players: players.map(p => ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`,
        email: p.email,
        profilePicture: p.profilePicture,
        position: p.position,
        rating: p.xp || 0
      }))
    };
  } catch (error) {
    console.error('Error searching players:', error);
    ctx.throw(500, 'Failed to search players.');
  }
};

// GET COMPLETE PLAYER PROFILE WITH LEAGUES, MATCHES AND STATS
export const getPlayerProfile = async (ctx: Context) => {
  const { id } = ctx.params;
  const { leagueId, year } = ctx.query;

  try {
    // 1. Get player basic info
    const player = await UserModel.findByPk(id, {
      attributes: ['id', 'firstName', 'lastName', 'profilePicture', 'xp', 'position', 'positionType', 'shirtNumber', 'email'],
      include: [{
        model: LeagueModel,
        as: 'leagues',
        attributes: ['id', 'name', 'image']
      }]
    });

    if (!player) {
      ctx.throw(404, 'Player not found');
      return;
    }

    // 2. Get all match stats for this player
    const statsQuery: any = {
      include: [{
        model: MatchModel,
        as: 'match',
        where: { status: 'RESULT_PUBLISHED' },
        attributes: [
          'id', 
          'date', 
          'homeTeamName', 
          'awayTeamName', 
          'location', 
          'leagueId', 
          'end',
          'homeDefensiveImpactId',
          'awayDefensiveImpactId',
          'homeMentalityId',
          'awayMentalityId',
          'homeTeamGoals',
          'awayTeamGoals'
        ],
        include: [{
          model: Vote,
          as: 'votes',
          attributes: ['voterId', 'votedForId', 'matchId']
        }, {
          model: UserModel,
          as: 'homeTeamUsers',
          attributes: ['id']
        }, {
          model: UserModel,
          as: 'awayTeamUsers',
          attributes: ['id']
        }]
      }],
      where: { user_id: id },
      attributes: ['id', 'goals', 'assists', 'cleanSheets', 'penalties', 'freeKicks', 'defence', 'impact', 'rating', 'xpAwarded', 'match_id']
    };

    const allStats = await MatchStatistics.findAll(statsQuery);

    // 3. Group matches by league
    const leaguesMap = new Map();
    const playerLeagues = (player as any).leagues || [];
    
    playerLeagues.forEach((league: any) => {
      leaguesMap.set(league.id, {
        id: league.id,
        name: league.name,
        matches: []
      });
    });

    // Add matches with player stats to respective leagues
    allStats.forEach((stat: any) => {
      const match = stat.match;
      if (!match) return;
      
      const leagueId = match.leagueId;
      if (!leaguesMap.has(leagueId)) {
        leaguesMap.set(leagueId, {
          id: leagueId,
          name: 'League',
          matches: []
        });
      }

      console.log(`🔍 Match ${match.id} data:`, {
        homeDefensiveImpactId: match.homeDefensiveImpactId,
        awayDefensiveImpactId: match.awayDefensiveImpactId,
        votesCount: match.votes?.length || 0,
        votes: match.votes
      });

      const homeIds = (match.homeTeamUsers || []).map((u: any) => String(u.id));
      const awayIds = (match.awayTeamUsers || []).map((u: any) => String(u.id));
      const isHomePlayer = homeIds.includes(String(id));
      const homeGoals = Number(match.homeTeamGoals || 0);
      const awayGoals = Number(match.awayTeamGoals || 0);
      const teamGoals = isHomePlayer ? homeGoals : awayGoals;
      const oppGoals = isHomePlayer ? awayGoals : homeGoals;
      const result: 'W' | 'D' | 'L' =
        teamGoals === oppGoals ? 'D' : (teamGoals > oppGoals ? 'W' : 'L');

      // Count MOTM votes for this player in this match
      const matchVotes = match.votes || [];
      const motmVotesCount = matchVotes.filter((v: any) => String(v.votedForId) === String(id)).length;

      leaguesMap.get(leagueId).matches.push({
        id: match.id,
        date: match.date,
        homeTeamName: match.homeTeamName,
        awayTeamName: match.awayTeamName,
        location: match.location,
        end: match.end,
        homeDefensiveImpactId: match.homeDefensiveImpactId,
        awayDefensiveImpactId: match.awayDefensiveImpactId,
        homeMentalityId: match.homeMentalityId,
        awayMentalityId: match.awayMentalityId,
        homeTeamGoals: match.homeTeamGoals,
        awayTeamGoals: match.awayTeamGoals,
        result,
        votes: match.votes || [],
        playerStats: {
          goals: stat.goals || 0,
          assists: stat.assists || 0,
          cleanSheets: stat.cleanSheets || 0,
          penalties: stat.penalties || 0,
          freeKicks: stat.freeKicks || 0,
          defence: stat.defence || 0,
          impact: stat.impact || 0,
          contributionIndex: stat.impact || 0,
          contributionIndexPercent: `${Number(stat.impact || 0)}%`,
          rating: stat.rating || 0,
          xpAwarded: Number(stat.xpAwarded || 0),
          result,
          teamGoals,
          opponentGoals: oppGoals,
          motmVotes: motmVotesCount
        }
      });
    });

    const leagues = Array.from(leaguesMap.values());

    // 4. Build response
    const response = {
      success: true,
      data: {
        player: {
          id: player.id,
          name: `${player.firstName} ${player.lastName}`,
          avatar: player.profilePicture,
          profilePicture: player.profilePicture,
          position: player.position,
          positionType: player.positionType,
          shirtNo: player.shirtNumber,
          rating: player.xp || 0
        },
        leagues: leagues,
        years: [...new Set(allStats.map((s: any) => new Date(s.match?.date).getFullYear()))].filter(Boolean),
        currentStats: {},
        accumulativeStats: {},
        trophies: {}
      }
    };

    ctx.body = response;
  } catch (error) {
    console.error('Error fetching player profile:', error);
    ctx.throw(500, 'Failed to fetch player profile.');
  }
};
