/**
 * Simple In-Memory Cache Middleware
 * No Redis required - uses Node.js Map
 * Perfect for VPS deployment
 */

import type { Context, Next } from 'koa';

interface CacheEntry {
  data: any;
  expires: number;
  etag: string;
}

// In-memory cache storage
const cache = new Map<string, CacheEntry>();

/**
 * Generate simple ETag from response
 */
function generateETag(data: any): string {
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `"${Math.abs(hash).toString(36)}"`;
}

/**
 * Simple cache middleware
 * @param ttl Time to live in milliseconds (default: 5 minutes)
 * @param cacheKey Optional custom cache key function
 */
export const simpleCache = (
  ttl: number = 300000, // 5 minutes default
  cacheKey?: (ctx: Context) => string
) => {
  return async (ctx: Context, next: Next) => {
    // Only cache GET requests
    if (ctx.method !== 'GET') {
      return await next();
    }

    // Generate cache key
    const key = cacheKey ? cacheKey(ctx) : `${ctx.url}:${ctx.header.authorization || 'public'}`;
    
    // Check cache
    const cached = cache.get(key);
    const now = Date.now();

    if (cached && cached.expires > now) {
      // Handle ETag / If-None-Match
      const clientETag = ctx.header['if-none-match'];
      if (clientETag && clientETag === cached.etag) {
        ctx.status = 304; // Not Modified
        ctx.set('X-Cache', 'HIT-304');
        ctx.set('ETag', cached.etag);
        return;
      }

      // Return cached response
      ctx.body = cached.data;
      ctx.status = 200;
      ctx.set('X-Cache', 'HIT');
      ctx.set('ETag', cached.etag);
      ctx.set('Cache-Control', `public, max-age=${Math.floor((cached.expires - now) / 1000)}`);
      return;
    }

    // Cache miss - proceed with request
    await next();

    // Only cache successful responses
    if (ctx.status === 200 && ctx.body) {
      const etag = generateETag(ctx.body);
      cache.set(key, {
        data: ctx.body,
        expires: now + ttl,
        etag: etag
      });
      ctx.set('X-Cache', 'MISS');
      ctx.set('ETag', etag);
      ctx.set('Cache-Control', `public, max-age=${Math.floor(ttl / 1000)}`);
    }
  };
};

/**
 * Cache invalidation helpers
 */
export const cacheInvalidate = {
  /**
   * Clear specific cache key
   */
  clear(key: string) {
    cache.delete(key);
  },

  /**
   * Clear all cache entries matching pattern
   */
  clearPattern(pattern: string | RegExp) {
    const regex = typeof pattern === 'string' 
      ? new RegExp(pattern.replace(/\*/g, '.*'))
      : pattern;
    
    for (const key of cache.keys()) {
      if (regex.test(key)) {
        cache.delete(key);
      }
    }
  },

  /**
   * Clear all cache
   */
  clearAll() {
    cache.clear();
  },

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    let active = 0;
    let expired = 0;

    for (const entry of cache.values()) {
      if (entry.expires > now) {
        active++;
      } else {
        expired++;
      }
    }

    return {
      total: cache.size,
      active,
      expired,
      memoryMB: Math.round(
        JSON.stringify([...cache.entries()]).length / 1024 / 1024
      )
    };
  }
};

/**
 * Automatic cache cleanup
 * Runs every 5 minutes to remove expired entries
 */
const CLEANUP_INTERVAL = 300000; // 5 minutes

setInterval(() => {
  const now = Date.now();
  let removed = 0;

  for (const [key, value] of cache.entries()) {
    if (value.expires < now) {
      cache.delete(key);
      removed++;
    }
  }

  if (removed > 0) {
    console.log(`[SimpleCache] Cleaned up ${removed} expired entries`);
  }
}, CLEANUP_INTERVAL);

/**
 * Predefined cache durations
 */
export const CacheDuration = {
  SHORT: 60000,      // 1 minute
  MEDIUM: 300000,    // 5 minutes
  LONG: 600000,      // 10 minutes
  VERY_LONG: 1800000 // 30 minutes
};

/**
 * Route-specific cache helpers
 */
export const cacheFor = {
  leagues: () => simpleCache(CacheDuration.MEDIUM),
  matches: () => simpleCache(CacheDuration.SHORT),
  players: () => simpleCache(CacheDuration.LONG),
  leaderboard: () => simpleCache(CacheDuration.SHORT),
  worldRanking: () => simpleCache(CacheDuration.MEDIUM)
};

export default simpleCache;
