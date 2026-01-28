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
  const { leagueId } = ctx.query;

  try {
    const statsQuery: any = {
      include: [{
        model: MatchModel,
        as: 'match',
        where: { status: 'RESULT_PUBLISHED' }
      }],
      where: { userId: id }
    };

    if (leagueId) {
      statsQuery.include[0].where.leagueId = leagueId;
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
