/**
 * API Response Caching Middleware
 * Implements in-memory caching for GET requests
 */

import { Context, Next } from 'koa';

interface CacheEntry {
  body: unknown;
  timestamp: number;
  etag: string;
}

class ResponseCache {
  private cache = new Map<string, CacheEntry>();
  private defaultTTL = 5 * 60 * 1000; // 5 minutes
  
  get(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    
    if (!entry) return undefined;
    
    // Check if entry is still valid
    const now = Date.now();
    if (now - entry.timestamp > this.defaultTTL) {
      this.cache.delete(key);
      return undefined;
    }
    
    return entry;
  }
  
  set(key: string, body: unknown): void {
    const etag = this.generateETag(body);
    
    this.cache.set(key, {
      body,
      timestamp: Date.now(),
      etag,
    });
  }
  
  clear(pattern?: RegExp): void {
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
  
  private generateETag(body: unknown): string {
    const str = JSON.stringify(body);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `W/"${hash.toString(36)}"`;
  }
  
  cleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.defaultTTL) {
        keysToDelete.push(key);
      }
    }
    
    keysToDelete.forEach(key => this.cache.delete(key));
  }
}

const cache = new ResponseCache();

// Cleanup every 5 minutes
setInterval(() => {
  cache.cleanup();
}, 5 * 60 * 1000);

/**
 * Middleware to cache GET responses
 */
export function cacheMiddleware() {
  return async (ctx: Context, next: Next) => {
    // Only cache GET requests
    if (ctx.method !== 'GET') {
      await next();
      return;
    }
    
    // Skip caching for authenticated requests (can be customized)
    const skipCache = ctx.query.skipCache === 'true' || 
                      ctx.headers['cache-control'] === 'no-cache';
    
    if (skipCache) {
      await next();
      return;
    }
    
    // Generate cache key from URL and query params
    const cacheKey = `${ctx.path}${JSON.stringify(ctx.query)}`;
    
    // Check for If-None-Match header (ETag validation)
    const ifNoneMatch = ctx.headers['if-none-match'];
    const cached = cache.get(cacheKey);
    
    if (cached) {
      // Set ETag header
      ctx.set('ETag', cached.etag);
      
      // If client has matching ETag, return 304
      if (ifNoneMatch === cached.etag) {
        ctx.status = 304;
        return;
      }
      
      // Return cached response
      ctx.set('X-Cache', 'HIT');
      ctx.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=120');
      ctx.body = cached.body;
      return;
    }
    
    // Execute route handler
    await next();
    
    // Cache successful responses
    if (ctx.status === 200 && ctx.body) {
      cache.set(cacheKey, ctx.body);
      ctx.set('X-Cache', 'MISS');
      ctx.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=120');
    }
  };
}

/**
 * Helper function to invalidate cache
 */
export function invalidateCache(pattern?: RegExp): void {
  cache.clear(pattern);
}

export default cacheMiddleware;
