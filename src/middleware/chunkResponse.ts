// 🚀 CHUNK-BASED RESPONSE MIDDLEWARE - Backend Optimization
//
// Purpose: Send data in chunks (20 items each) to match frontend cache system
// Benefits:
// • Faster initial response (send first chunk immediately)
// • Surgical cache updates on frontend
// • Reduced memory usage
// • Better pagination support
//
// Usage:
//   router.get('/leagues', required, chunkify(20), async (ctx) => {
//     const leagues = await League.findAll();
//     ctx.body = { success: true, leagues };
//   });

import { Context, Next } from 'koa';

const CHUNK_SIZE = 20; // Default chunk size

interface ChunkifyOptions {
  chunkSize?: number;
  resourceKey?: string; // Key in response body that contains the array
  includeMetadata?: boolean; // Include chunk metadata
}

/**
 * Middleware to automatically chunk array responses
 * Frontend can request specific chunks using ?page=N&limit=20
 */
export function chunkify(options: ChunkifyOptions = {}) {
  const chunkSize = options.chunkSize || CHUNK_SIZE;
  const resourceKey = options.resourceKey || null;
  const includeMetadata = options.includeMetadata !== false;

  return async (ctx: Context, next: Next) => {
    await next();

    // Only process successful responses
    if (ctx.status !== 200 || !ctx.body) {
      return;
    }

    // Check if client requested chunked response
    const page = parseInt(String(ctx.query.page || '1'), 10);
    const limit = parseInt(String(ctx.query.limit || String(chunkSize)), 10);
    const wantsChunks = ctx.query.page !== undefined || ctx.query.chunked === 'true';

    if (!wantsChunks) {
      return; // Client doesn't want chunks, send full response
    }

    const body = ctx.body as any;

    // Find the array in response
    let dataArray: any[] | null = null;
    let arrayKey: string | null = null;

    if (resourceKey && body[resourceKey] && Array.isArray(body[resourceKey])) {
      dataArray = body[resourceKey];
      arrayKey = resourceKey;
    } else if (body.data && Array.isArray(body.data)) {
      dataArray = body.data;
      arrayKey = 'data';
    } else if (body.leagues && Array.isArray(body.leagues)) {
      dataArray = body.leagues;
      arrayKey = 'leagues';
    } else if (body.matches && Array.isArray(body.matches)) {
      dataArray = body.matches;
      arrayKey = 'matches';
    } else if (body.users && Array.isArray(body.users)) {
      dataArray = body.users;
      arrayKey = 'users';
    } else if (body.players && Array.isArray(body.players)) {
      dataArray = body.players;
      arrayKey = 'players';
    } else if (Array.isArray(body)) {
      dataArray = body;
      arrayKey = null;
    }

    if (!dataArray) {
      return; // No array found, return as-is
    }

    // Calculate chunk boundaries
    const totalItems = dataArray.length;
    const totalChunks = Math.ceil(totalItems / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = Math.min(startIndex + limit, totalItems);
    const chunk = dataArray.slice(startIndex, endIndex);

    // Build chunked response
    const chunkedResponse: any = {
      success: body.success !== false,
      chunk: {
        page,
        limit,
        totalItems,
        totalChunks,
        hasMore: page < totalChunks,
        items: chunk.length,
      },
    };

    if (arrayKey) {
      chunkedResponse[arrayKey] = chunk;
    } else {
      chunkedResponse.data = chunk;
    }

    // Include metadata if requested
    if (includeMetadata && body.metadata) {
      chunkedResponse.metadata = body.metadata;
    }

    // Preserve other fields
    Object.keys(body).forEach((key) => {
      if (
        key !== arrayKey &&
        key !== 'data' &&
        key !== 'success' &&
        key !== 'metadata'
      ) {
        chunkedResponse[key] = body[key];
      }
    });

    ctx.body = chunkedResponse;
    
    // Add chunk headers for debugging
    ctx.set('X-Chunk-Page', String(page));
    ctx.set('X-Chunk-Total', String(totalChunks));
    ctx.set('X-Total-Items', String(totalItems));
  };
}

/**
 * Helper to manually chunk data in route handlers
 */
export function createChunkedResponse(
  data: any[],
  page: number = 1,
  limit: number = CHUNK_SIZE
) {
  const totalItems = data.length;
  const totalChunks = Math.ceil(totalItems / limit);
  const startIndex = (page - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalItems);
  const chunk = data.slice(startIndex, endIndex);

  return {
    success: true,
    chunk: {
      page,
      limit,
      totalItems,
      totalChunks,
      hasMore: page < totalChunks,
      items: chunk.length,
    },
    data: chunk,
  };
}

/**
 * Check if request wants chunked response
 */
export function wantsChunks(ctx: Context): boolean {
  return ctx.query.page !== undefined || ctx.query.chunked === 'true';
}

/**
 * Get pagination params from request
 */
export function getPaginationParams(ctx: Context) {
  const page = Math.max(1, parseInt(String(ctx.query.page || '1'), 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(String(ctx.query.limit || String(CHUNK_SIZE)), 10))
  );
  
  return { page, limit, offset: (page - 1) * limit };
}

export default chunkify;
