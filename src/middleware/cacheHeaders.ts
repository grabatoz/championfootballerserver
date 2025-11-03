// 🚀 CACHE HEADERS MIDDLEWARE - Optimize Frontend Caching
//
// Adds proper cache headers to GET responses
// Helps frontend cache system work even better
//
// Usage in api/src/index.ts:
//   import { addCacheHeaders } from './middleware/cacheHeaders';
//   app.use(addCacheHeaders());

import { Context, Next } from 'koa';

interface CacheConfig {
  // Cache duration in seconds
  maxAge?: number;
  // Allow CDN/proxy caching
  public?: boolean;
  // Must revalidate after expiry
  mustRevalidate?: boolean;
  // Add ETag for conditional requests
  useETag?: boolean;
}

const defaultConfig: CacheConfig = {
  maxAge: 300, // 5 minutes
  public: true,
  mustRevalidate: true,
  useETag: true,
};

/**
 * Route-specific cache configurations
 */
const routeConfigs: Record<string, CacheConfig> = {
  '/leagues': { maxAge: 300 }, // 5 minutes
  '/matches': { maxAge: 180 }, // 3 minutes  
  '/players': { maxAge: 600 }, // 10 minutes
  '/leaderboard': { maxAge: 300 }, // 5 minutes
  '/auth/data': { maxAge: 600 }, // 10 minutes
  '/notifications': { maxAge: 60 }, // 1 minute (more dynamic)
};

/**
 * Generate ETag from response body
 */
function generateETag(body: any): string {
  const crypto = require('crypto');
  return crypto
    .createHash('md5')
    .update(JSON.stringify(body))
    .digest('hex');
}

/**
 * Main middleware to add cache headers
 */
export function addCacheHeaders(config: CacheConfig = {}) {
  const finalConfig = { ...defaultConfig, ...config };

  return async (ctx: Context, next: Next) => {
    await next();

    // Only cache successful GET requests
    if (ctx.status !== 200 || ctx.method !== 'GET' || !ctx.body) {
      return;
    }

    // Get route-specific config
    let routeConfig = finalConfig;
    for (const [route, cfg] of Object.entries(routeConfigs)) {
      if (ctx.path.startsWith(route)) {
        routeConfig = { ...finalConfig, ...cfg };
        break;
      }
    }

    // Build Cache-Control header
    const parts: string[] = [];
    
    if (routeConfig.public) {
      parts.push('public');
    } else {
      parts.push('private');
    }

    if (routeConfig.maxAge !== undefined) {
      parts.push(`max-age=${routeConfig.maxAge}`);
    }

    if (routeConfig.mustRevalidate) {
      parts.push('must-revalidate');
    }

    ctx.set('Cache-Control', parts.join(', '));

    // Add custom header to identify cacheable responses
    ctx.set('X-Cache-Strategy', 'instant-cache');
    ctx.set('X-Cache-Duration', String(routeConfig.maxAge));

    // Add ETag if configured
    if (routeConfig.useETag && ctx.body) {
      const etag = generateETag(ctx.body);
      ctx.set('ETag', `"${etag}"`);

      // Check if client has cached version
      const clientETag = ctx.get('If-None-Match');
      if (clientETag === `"${etag}"` || clientETag === etag) {
        ctx.status = 304; // Not Modified
        ctx.body = null;
        return;
      }
    }

    // Add timestamp for debugging
    ctx.set('X-Response-Time', String(Date.now()));
  };
}

/**
 * Disable caching for specific routes
 */
export function noCache() {
  return async (ctx: Context, next: Next) => {
    await next();
    
    if (ctx.method === 'GET') {
      ctx.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
      ctx.set('Pragma', 'no-cache');
      ctx.set('Expires', '0');
    }
  };
}

/**
 * Short cache (1 minute) for dynamic data
 */
export function shortCache() {
  return addCacheHeaders({ maxAge: 60 });
}

/**
 * Medium cache (5 minutes) for semi-static data
 */
export function mediumCache() {
  return addCacheHeaders({ maxAge: 300 });
}

/**
 * Long cache (1 hour) for static data
 */
export function longCache() {
  return addCacheHeaders({ maxAge: 3600 });
}

export default addCacheHeaders;
