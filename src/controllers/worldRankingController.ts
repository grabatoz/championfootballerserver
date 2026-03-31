import { Context } from 'koa';
import models from '../models';
import { Op, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import cache from '../utils/cache';

const getTableName = (model: any): string => {
  const tn = model.getTableName?.() ?? model.tableName;
  return typeof tn === 'object' ? `"${tn.schema}"."${tn.tableName}"` : `"${tn}"`;
};

export const getWorldRanking = async (ctx: Context) => {
  const mode = (ctx.query.mode as string) === 'avg' ? 'avg' : 'total';
  const positionType = ctx.query.positionType as string | undefined;
  const country = ctx.query.country as string | undefined;
  const yearRaw = ctx.query.year as string | undefined;
  const year = yearRaw ? Number(yearRaw) : undefined;
  const playerId = ctx.query.playerId as string | undefined;
  const requestedLimit = Number(ctx.query.limit);
  const requestedPage = Number(ctx.query.page);
  const MAX_LIMIT = 500;
  const DEFAULT_LIMIT = 100;
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(Math.floor(requestedLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const page = Number.isFinite(requestedPage) && requestedPage > 0
    ? Math.floor(requestedPage)
    : 1;
  const offset = (page - 1) * limit;
  const fresh = ctx.query.fresh === '1';

  if (yearRaw && !Number.isFinite(year)) {
    ctx.throw(400, 'Invalid year');
    return;
  }

  const cacheKey = `wr_${mode}_${positionType || ''}_${country || ''}_${year || ''}_${page}_${limit}`;

  if (!fresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      ctx.set('X-Cache', 'HIT');
      ctx.body = cached;
      return;
    }
  }

  ctx.set('X-Cache', 'MISS');

  try {
    const usersTable = getTableName(models.User);
    const matchStatsTable = getTableName(models.MatchStatistics);
    const matchesTable = getTableName(models.Match);

    const whereConditions: string[] = ['1=1'];
    const replacements: Record<string, any> = {};
    const rankingMetric = mode === 'avg' ? '"avgXP"' : '"totalXP"';

    whereConditions.push(`u."lastName" != 'Guest'`);

    if (positionType) {
      whereConditions.push(`u."positionType" = :positionType`);
      replacements.positionType = positionType;
    }
    if (country) {
      whereConditions.push(`u."country" = :country`);
      replacements.country = country;
    }

    let query: string;

    if (year) {
      replacements.year = year;
      query = `
        WITH base AS (
          SELECT
            u."id",
            u."firstName",
            u."lastName",
            u."profilePicture",
            u."position",
            u."positionType",
            u."country",
            COALESCE(stats."totalXP", 0)::int AS "totalXP",
            COALESCE(stats."matchCount", 0)::int AS "matches",
            CASE
              WHEN COALESCE(stats."matchCount", 0) > 0
              THEN ROUND(COALESCE(stats."totalXP", 0)::numeric / stats."matchCount", 2)
              ELSE 0
            END AS "avgXP"
          FROM ${usersTable} u
          LEFT JOIN (
            SELECT
              ms2."user_id",
              SUM(ms2."xpAwarded") AS "totalXP",
              COUNT(DISTINCT ms2."match_id") AS "matchCount"
            FROM ${matchStatsTable} ms2
            INNER JOIN ${matchesTable} m2 ON m2."id" = ms2."match_id"
              AND m2."status" = 'RESULT_PUBLISHED'
              AND EXTRACT(YEAR FROM m2."date") = :year
            GROUP BY ms2."user_id"
          ) stats ON stats."user_id" = u."id"
          WHERE ${whereConditions.join(' AND ')}
            AND COALESCE(stats."totalXP", 0) > 0
        )
        SELECT
          b.*,
          DENSE_RANK() OVER (ORDER BY ${rankingMetric} DESC) AS "rank",
          COUNT(*) OVER ()::int AS "totalCount"
        FROM base b
        ORDER BY ${rankingMetric} DESC, b."id" ASC
        LIMIT :limit OFFSET :offset
      `;
    } else {
      query = `
        WITH base AS (
          SELECT
            u."id",
            u."firstName",
            u."lastName",
            u."profilePicture",
            u."position",
            u."positionType",
            u."country",
            COALESCE(u."xp", 0)::int AS "totalXP",
            COALESCE(stats."matchCount", 0)::int AS "matches",
            CASE
              WHEN COALESCE(stats."matchCount", 0) > 0
              THEN ROUND(COALESCE(u."xp", 0)::numeric / stats."matchCount", 2)
              ELSE 0
            END AS "avgXP"
          FROM ${usersTable} u
          LEFT JOIN (
            SELECT
              ms2."user_id",
              COUNT(DISTINCT ms2."match_id") AS "matchCount"
            FROM ${matchStatsTable} ms2
            INNER JOIN ${matchesTable} m2 ON m2."id" = ms2."match_id"
              AND m2."status" = 'RESULT_PUBLISHED'
            GROUP BY ms2."user_id"
          ) stats ON stats."user_id" = u."id"
          WHERE ${whereConditions.join(' AND ')}
        )
        SELECT
          b.*,
          DENSE_RANK() OVER (ORDER BY ${rankingMetric} DESC) AS "rank",
          COUNT(*) OVER ()::int AS "totalCount"
        FROM base b
        ORDER BY ${rankingMetric} DESC, b."id" ASC
        LIMIT :limit OFFSET :offset
      `;
    }

    replacements.limit = limit;
    replacements.offset = offset;

    const rows: any[] = await sequelize.query(query, {
      replacements,
      type: QueryTypes.SELECT,
    });

    const metricKey = mode === 'avg' ? 'avgXP' : 'totalXP';
    const total = rows.length > 0 ? Number(rows[0].totalCount) || 0 : 0;
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

    const rankings = rows.map((row: any) => ({
      rank: Number(row.rank) || 0,
      id: row.id,
      name: `${row.firstName || ''} ${row.lastName || ''}`.trim(),
      profilePicture: row.profilePicture,
      position: row.position,
      positionType: row.positionType,
      totalXP: Number(row.totalXP) || 0,
      avgXP: Number(row.avgXP) || 0,
      matches: Number(row.matches) || 0,
      xp: Number(row[metricKey]) || 0,
      country: row.country || null,
    }));

    const playerEntry = playerId ? rankings.find((entry: any) => entry.id === playerId) : undefined;
    const playerRank = playerEntry?.rank;

    const result: any = {
      success: true,
      mode,
      page,
      limit,
      total,
      totalPages,
      rankings,
      playerRank,
    };

    cache.set(cacheKey, result, 600);
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
