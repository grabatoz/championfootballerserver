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
  const { leagueId, year } = ctx.query;

  try {
    const statsQuery: any = {
      include: [{
        model: MatchModel,
        as: 'match',
        where: { status: 'RESULT_PUBLISHED' }
      }],
      where: { user_id: id }
    };

    // Only filter by leagueId if it's not "all" and is provided
    if (leagueId && leagueId !== 'all') {
      statsQuery.include[0].where.leagueId = leagueId;
    }

    // Only filter by year if it's not "all" and is provided
    if (year && year !== 'all') {
      // Assuming match has a year field or we need to extract from date
      // This can be refined based on your actual schema
      statsQuery.include[0].where.year = year;
    }

    const stats = await MatchStatistics.findAll(statsQuery);

    const totalStats = {
      goals: 0,
      assists: 0,
      motm: 0,
      rating: 0,
      matches: stats.length
    };

    stats.forEach((stat: any) => {
      totalStats.goals += stat.goals || 0;
      totalStats.assists += stat.assists || 0;
      totalStats.rating += stat.rating || 0;
    });

    if (stats.length > 0) {
      totalStats.rating = totalStats.rating / stats.length;
    }

    ctx.body = {
      success: true,
      stats: totalStats
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
        }]
      }],
      where: { user_id: id },
      attributes: ['id', 'goals', 'assists', 'cleanSheets', 'penalties', 'freeKicks', 'defence', 'impact', 'rating', 'match_id']
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
        votes: match.votes || [],
        playerStats: {
          goals: stat.goals || 0,
          assists: stat.assists || 0,
          cleanSheets: stat.cleanSheets || 0,
          penalties: stat.penalties || 0,
          freeKicks: stat.freeKicks || 0,
          defence: stat.defence || 0,
          impact: stat.impact || 0,
          rating: stat.rating || 0
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
