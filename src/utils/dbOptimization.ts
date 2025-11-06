/**
 * Database Query Optimization Utilities
 * Implements connection pooling, query caching, and optimized queries
 */

import { Sequelize, Op, QueryTypes } from 'sequelize';

interface QueryCacheEntry {
  result: unknown;
  timestamp: number;
}

class QueryCache {
  private cache = new Map<string, QueryCacheEntry>();
  private ttl = 5 * 60 * 1000; // 5 minutes
  
  get(key: string): unknown | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    
    const now = Date.now();
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.result;
  }
  
  set(key: string, result: unknown): void {
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
    });
  }
  
  invalidate(pattern?: RegExp): void {
    if (!pattern) {
      this.cache.clear();
      return;
    }
    
    const keysToDelete: string[] = [];
    for (const key of this.cache.keys()) {
      if (pattern.test(key)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.cache.delete(key));
  }
}

const queryCache = new QueryCache();

/**
 * Enhanced Sequelize configuration with connection pooling
 */
export function getOptimizedSequelize(databaseUrl: string): Sequelize {
  return new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    
    // Connection pool optimization
    pool: {
      max: 20, // Maximum connections
      min: 5,  // Minimum connections
      acquire: 60000, // Maximum time to acquire connection (60s)
      idle: 10000, // Maximum idle time (10s)
      evict: 1000, // Eviction interval (1s)
    },
    
    // Query optimization
    define: {
      timestamps: true,
      underscored: true,
      freezeTableName: true,
    },
    
    // Dialect options for SSL
    dialectOptions: {
      ssl: process.env.NODE_ENV === 'production' ? {
        require: true,
        rejectUnauthorized: false,
      } : false,
      
      // Connection timeout
      connectTimeout: 60000,
      
      // Statement timeout (30s)
      statement_timeout: 30000,
      
      // Idle in transaction timeout (5s)
      idle_in_transaction_session_timeout: 5000,
    },
    
    // Retry configuration
    retry: {
      max: 3,
      match: [
        /SequelizeConnectionError/,
        /SequelizeConnectionRefusedError/,
        /SequelizeHostNotFoundError/,
        /SequelizeHostNotReachableError/,
        /SequelizeInvalidConnectionError/,
        /SequelizeConnectionTimedOutError/,
        /TimeoutError/,
      ],
    },
    
    // Benchmark queries in development
    benchmark: process.env.NODE_ENV === 'development',
  });
}

/**
 * Cached query execution
 */
export async function cachedQuery<T = unknown>(
  sequelize: Sequelize,
  sql: string,
  options: {
    type?: QueryTypes;
    replacements?: Record<string, unknown>;
    cacheKey?: string;
    skipCache?: boolean;
  } = {}
): Promise<T> {
  const {
    type = QueryTypes.SELECT,
    replacements = {},
    cacheKey,
    skipCache = false,
  } = options;
  
  // Generate cache key
  const key = cacheKey || `${sql}:${JSON.stringify(replacements)}`;
  
  // Check cache for SELECT queries
  if (type === QueryTypes.SELECT && !skipCache) {
    const cached = queryCache.get(key);
    if (cached !== null) {
      return cached as T;
    }
  }
  
  // Execute query
  const result = await sequelize.query(sql, {
    type,
    replacements,
  });
  
  // Cache SELECT queries
  if (type === QueryTypes.SELECT) {
    queryCache.set(key, result);
  }
  
  return result as T;
}

/**
 * Batch query execution with transaction
 */
export async function batchQuery<T = unknown>(
  sequelize: Sequelize,
  queries: Array<{
    sql: string;
    replacements?: Record<string, unknown>;
  }>
): Promise<T[]> {
  const transaction = await sequelize.transaction();
  
  try {
    const results = await Promise.all(
      queries.map(({ sql, replacements }) =>
        sequelize.query(sql, {
          type: QueryTypes.SELECT,
          replacements,
          transaction,
        })
      )
    );
    
    await transaction.commit();
    return results as T[];
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

/**
 * Optimized pagination helper
 */
export interface PaginationOptions {
  page?: number;
  limit?: number;
  orderBy?: string;
  orderDirection?: 'ASC' | 'DESC';
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export async function paginatedQuery<T = unknown>(
  model: any,
  options: PaginationOptions & {
    where?: Record<string, unknown>;
    include?: unknown[];
    attributes?: string[];
  } = {}
): Promise<PaginatedResult<T>> {
  const {
    page = 1,
    limit = 20,
    orderBy = 'createdAt',
    orderDirection = 'DESC',
    where = {},
    include = [],
    attributes,
  } = options;
  
  const offset = (page - 1) * limit;
  
  // Execute count and data queries in parallel
  const [data, total] = await Promise.all([
    model.findAll({
      where,
      include,
      attributes,
      limit,
      offset,
      order: [[orderBy, orderDirection]],
    }),
    model.count({ where }),
  ]);
  
  const totalPages = Math.ceil(total / limit);
  
  return {
    data: data as T[],
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    },
  };
}

/**
 * Invalidate query cache
 */
export function invalidateQueryCache(pattern?: RegExp): void {
  queryCache.invalidate(pattern);
}

/**
 * Common query operators for easy access
 */
export { Op };

/**
 * Utility to log slow queries
 */
export function logSlowQuery(sql: string, duration: number, threshold = 1000): void {
  if (duration > threshold) {
    console.warn(`[SLOW QUERY] ${duration}ms: ${sql.substring(0, 200)}...`);
  }
}
