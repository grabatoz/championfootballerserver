import { Context } from 'koa';
import models from '../models';
import { Op, fn, col } from 'sequelize';
import cache from '../utils/cache';

export const getWorldRanking = async (ctx: Context) => {
  const cacheKey = 'world_ranking_global';
  const cached = cache.get(cacheKey);
  
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  ctx.set('X-Cache', 'MISS');

  try {
    const players = await models.User.findAll({
      where: {
        xp: { [Op.gt]: 0 }
      },
      attributes: [
        'id',
        'firstName',
        'lastName',
        'profilePicture',
        'position',
        'positionType',
        'xp',
        'country'
      ],
      order: [['xp', 'DESC']],
      limit: 100
    });

    const rankings = players.map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: `${player.firstName} ${player.lastName}`,
      profilePicture: player.profilePicture,
      position: player.position,
      positionType: player.positionType,
      xp: player.xp || 0,
      country: player.country
    }));

    const result = {
      success: true,
      rankings
    };

    cache.set(cacheKey, result, 3600); // Cache for 1 hour
    ctx.body = result;
  } catch (error) {
    console.error('World ranking error:', error);
    ctx.throw(500, 'Failed to fetch world ranking');
  }
};

export const getCountryRanking = async (ctx: Context) => {
  const { country } = ctx.params;

  if (!country) {
    ctx.throw(400, 'Country is required');
    return;
  }

  const cacheKey = `country_ranking_${country}`;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  ctx.set('X-Cache', 'MISS');

  try {
    const players = await models.User.findAll({
      where: {
        country,
        xp: { [Op.gt]: 0 }
      },
      attributes: [
        'id',
        'firstName',
        'lastName',
        'profilePicture',
        'position',
        'positionType',
        'xp'
      ],
      order: [['xp', 'DESC']],
      limit: 50
    });

    const rankings = players.map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: `${player.firstName} ${player.lastName}`,
      profilePicture: player.profilePicture,
      position: player.position,
      positionType: player.positionType,
      xp: player.xp || 0
    }));

    const result = {
      success: true,
      country,
      rankings
    };

    cache.set(cacheKey, result, 3600);
    ctx.body = result;
  } catch (error) {
    console.error('Country ranking error:', error);
    ctx.throw(500, 'Failed to fetch country ranking');
  }
};

export const getPositionRanking = async (ctx: Context) => {
  const { positionType } = ctx.params;

  if (!positionType) {
    ctx.throw(400, 'Position type is required');
    return;
  }

  const cacheKey = `position_ranking_${positionType}`;
  const cached = cache.get(cacheKey);
  
  if (cached) {
    ctx.set('X-Cache', 'HIT');
    ctx.body = cached;
    return;
  }

  ctx.set('X-Cache', 'MISS');

  try {
    const players = await models.User.findAll({
      where: {
        positionType,
        xp: { [Op.gt]: 0 }
      },
      attributes: [
        'id',
        'firstName',
        'lastName',
        'profilePicture',
        'position',
        'xp',
        'country'
      ],
      order: [['xp', 'DESC']],
      limit: 50
    });

    const rankings = players.map((player, index) => ({
      rank: index + 1,
      id: player.id,
      name: `${player.firstName} ${player.lastName}`,
      profilePicture: player.profilePicture,
      position: player.position,
      xp: player.xp || 0,
      country: player.country
    }));

    const result = {
      success: true,
      positionType,
      rankings
    };

    cache.set(cacheKey, result, 3600);
    ctx.body = result;
  } catch (error) {
    console.error('Position ranking error:', error);
    ctx.throw(500, 'Failed to fetch position ranking');
  }
};
