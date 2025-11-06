// 🚀 ULTRA FAST DATABASE HELPER UTILITIES
// Optimized query helpers for ChampionFootballer API

import { FindOptions, Includeable } from 'sequelize';

/**
 * 🔥 Common optimized attributes for different models
 * Use these to select only necessary fields
 */
export const OptimizedAttributes = {
  // User minimal (for lists, relationships)
  UserMinimal: ['id', 'firstName', 'lastName', 'profilePicture', 'positionType'],
  
  // User profile (for profiles, detailed views)
  UserProfile: [
    'id', 'firstName', 'lastName', 'email', 'profilePicture', 
    'shirtNumber', 'level', 'xp', 'positionType', 'preferredFoot',
    'createdAt', 'updatedAt'
  ],
  
  // Match minimal (for lists)
  MatchMinimal: [
    'id', 'homeTeamName', 'awayTeamName', 'date', 'start', 'end',
    'location', 'status', 'leagueId', 'homeTeamGoals', 'awayTeamGoals'
  ],
  
  // Match detailed (for match page)
  MatchDetailed: [
    'id', 'homeTeamName', 'awayTeamName', 'date', 'start', 'end',
    'location', 'status', 'leagueId', 'homeTeamGoals', 'awayTeamGoals',
    'homeCaptainId', 'awayCaptainId', 'homeTeamImage', 'awayTeamImage',
    'notes', 'createdAt', 'updatedAt'
  ],
  
  // League minimal (for lists)
  LeagueMinimal: ['id', 'name', 'image', 'maxGames', 'active', 'createdAt'],
  
  // League detailed (for league page)
  LeagueDetailed: [
    'id', 'name', 'inviteCode', 'image', 'maxGames', 
    'showPoints', 'active', 'createdAt', 'updatedAt'
  ],
  
  // Statistics (for match stats)
  MatchStatistics: [
    'user_id', 'match_id', 'goals', 'assists', 'cleanSheets',
    'penalties', 'freeKicks', 'defence', 'impact', 'xpAwarded'
  ],
  
  // Votes (for MOTM)
  Vote: ['matchId', 'voterId', 'votedForId', 'createdAt']
};

/**
 * 🔥 Optimized include options for common relationships
 */
export const OptimizedIncludes = {
  // Minimal user include (for team lists)
  UserMinimal: {
    attributes: OptimizedAttributes.UserMinimal,
    required: false
  },
  
  // Match with teams (for match lists)
  MatchWithTeams: (models: any) => [
    {
      model: models.User,
      as: 'homeTeamUsers',
      attributes: OptimizedAttributes.UserMinimal,
      through: { attributes: [] } // Don't include junction table
    },
    {
      model: models.User,
      as: 'awayTeamUsers',
      attributes: OptimizedAttributes.UserMinimal,
      through: { attributes: [] }
    }
  ],
  
  // League with members (for league pages)
  LeagueWithMembers: (models: any) => [
    {
      model: models.User,
      as: 'members',
      attributes: OptimizedAttributes.UserMinimal,
      through: { attributes: [] },
      required: false
    },
    {
      model: models.User,
      as: 'administeredLeagues',
      attributes: ['id', 'firstName', 'lastName'],
      through: { attributes: [] },
      required: false
    }
  ]
};

/**
 * 🔥 Query optimization helper
 * Adds performance hints to Sequelize queries
 */
export class QueryOptimizer {
  /**
   * Add limit to prevent huge result sets
   */
  static limitResults(options: FindOptions, defaultLimit = 100): FindOptions {
    if (!options.limit) {
      options.limit = defaultLimit;
    }
    return options;
  }
  
  /**
   * Add pagination support
   */
  static paginate(options: FindOptions, page = 1, pageSize = 20): FindOptions {
    options.limit = pageSize;
    options.offset = (page - 1) * pageSize;
    return options;
  }
  
  /**
   * Remove unnecessary includes for count queries
   */
  static forCount(options: FindOptions): FindOptions {
    const countOptions = { ...options };
    delete countOptions.include;
    delete countOptions.order;
    return countOptions;
  }
  
  /**
   * Add subQuery: false for better performance with includes
   */
  static optimizeIncludes(options: FindOptions): FindOptions {
    if (options.include && (options.include as Includeable[]).length > 0) {
      options.subQuery = false;
    }
    return options;
  }
  
  /**
   * Combine all optimizations
   */
  static optimize(
    options: FindOptions, 
    config: {
      limit?: number;
      page?: number;
      pageSize?: number;
      optimizeIncludes?: boolean;
    } = {}
  ): FindOptions {
    let optimized = { ...options };
    
    // Add limit if specified
    if (config.limit) {
      optimized = this.limitResults(optimized, config.limit);
    }
    
    // Add pagination if specified
    if (config.page && config.pageSize) {
      optimized = this.paginate(optimized, config.page, config.pageSize);
    }
    
    // Optimize includes
    if (config.optimizeIncludes !== false) {
      optimized = this.optimizeIncludes(optimized);
    }
    
    return optimized;
  }
}

/**
 * 🔥 Raw query helpers for maximum performance
 */
export class RawQueryHelper {
  /**
   * Fast user XP ranking query
   */
  static async getUserRanking(
    sequelize: any,
    userId: string,
    positionType?: string
  ): Promise<{ rank: number; total: number }> {
    const positionFilter = positionType
      ? `AND "positionType" = :positionType`
      : '';
    
    const [result] = await sequelize.query(
      `
      WITH ranked_users AS (
        SELECT id, 
               ROW_NUMBER() OVER (ORDER BY xp DESC NULLS LAST) as rank
        FROM users
        WHERE xp > 0 
        AND "deletedAt" IS NULL
        ${positionFilter}
      )
      SELECT 
        (SELECT rank FROM ranked_users WHERE id = :userId) as rank,
        (SELECT COUNT(*) FROM ranked_users) as total
      `,
      {
        replacements: { userId, positionType },
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    return result || { rank: 0, total: 0 };
  }
  
  /**
   * Fast leaderboard query
   */
  static async getLeaderboard(
    sequelize: any,
    metric: string,
    leagueId?: string,
    limit = 10
  ): Promise<any[]> {
    const leagueFilter = leagueId
      ? `AND m."leagueId" = :leagueId`
      : '';
    
    const metricColumn = metric === 'motm' 
      ? 'COUNT(DISTINCT v."matchId")' 
      : `SUM(ms.${metric})`;
    
    const query = metric === 'motm'
      ? `
        SELECT 
          u.id,
          u."firstName",
          u."lastName",
          u."profilePicture",
          u."positionType",
          COUNT(DISTINCT v."matchId") as value
        FROM users u
        INNER JOIN "Votes" v ON v.voted_for_id = u.id
        INNER JOIN "Matches" m ON m.id = v."matchId"
        WHERE u."deletedAt" IS NULL
        ${leagueFilter}
        GROUP BY u.id, u."firstName", u."lastName", u."profilePicture", u."positionType"
        HAVING COUNT(DISTINCT v."matchId") > 0
        ORDER BY value DESC
        LIMIT :limit
      `
      : `
        SELECT 
          u.id,
          u."firstName",
          u."lastName",
          u."profilePicture",
          u."positionType",
          ${metricColumn} as value
        FROM users u
        INNER JOIN match_statistics ms ON ms.user_id = u.id
        INNER JOIN "Matches" m ON m.id = ms.match_id
        WHERE u."deletedAt" IS NULL
        AND ms.${metric} > 0
        ${leagueFilter}
        GROUP BY u.id, u."firstName", u."lastName", u."profilePicture", u."positionType"
        ORDER BY value DESC
        LIMIT :limit
      `;
    
    return await sequelize.query(query, {
      replacements: { leagueId, limit },
      type: sequelize.QueryTypes.SELECT
    });
  }
  
  /**
   * Fast match statistics for a user
   */
  static async getUserMatchStats(
    sequelize: any,
    userId: string,
    leagueId?: string
  ): Promise<any> {
    const leagueFilter = leagueId
      ? `AND m."leagueId" = :leagueId`
      : '';
    
    const [result] = await sequelize.query(
      `
      SELECT 
        COUNT(DISTINCT ms.match_id) as matches_played,
        SUM(ms.goals) as total_goals,
        SUM(ms.assists) as total_assists,
        SUM(ms.defence) as total_defence,
        SUM(ms.clean_sheets) as total_clean_sheets,
        SUM(ms.xp_awarded) as total_xp,
        AVG(ms.xp_awarded) as avg_xp_per_match
      FROM match_statistics ms
      INNER JOIN "Matches" m ON m.id = ms.match_id
      WHERE ms.user_id = :userId
      ${leagueFilter}
      `,
      {
        replacements: { userId, leagueId },
        type: sequelize.QueryTypes.SELECT
      }
    );
    
    return result || {
      matches_played: 0,
      total_goals: 0,
      total_assists: 0,
      total_defence: 0,
      total_clean_sheets: 0,
      total_xp: 0,
      avg_xp_per_match: 0
    };
  }
}

export default {
  OptimizedAttributes,
  OptimizedIncludes,
  QueryOptimizer,
  RawQueryHelper
};
