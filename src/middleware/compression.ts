/**
 * Enhanced Compression Middleware
 * Compresses responses based on content type and size
 */

import { Context, Next } from 'koa';
import { gzip, brotliCompress } from 'zlib';
import { promisify } from 'util';

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

interface CompressionOptions {
  threshold?: number; // Minimum size to compress (bytes)
  level?: number; // Compression level (1-9)
}

const defaultOptions: Required<CompressionOptions> = {
  threshold: 1024, // 1 KB
  level: 6, // Balanced compression
};

/**
 * Check if response should be compressed
 */
function shouldCompress(ctx: Context, threshold: number): boolean {
  // Already compressed
  if (ctx.response.get('Content-Encoding')) {
    return false;
  }
  
  // Check content type
  const type = ctx.response.type;
  if (!type) return false;
  
  const compressibleTypes = [
    'text/',
    'application/json',
    'application/javascript',
    'application/xml',
    'application/x-javascript',
  ];
  
  const isCompressible = compressibleTypes.some(t => type.includes(t));
  if (!isCompressible) return false;
  
  // Check size
  const body = ctx.body;
  if (!body) return false;
  
  let size = 0;
  if (Buffer.isBuffer(body)) {
    size = body.length;
  } else if (typeof body === 'string') {
    size = Buffer.byteLength(body);
  } else {
    size = Buffer.byteLength(JSON.stringify(body));
  }
  
  return size >= threshold;
}

/**
 * Compression middleware
 */
export function compressionMiddleware(options: CompressionOptions = {}) {
  const opts = { ...defaultOptions, ...options };
  
  return async (ctx: Context, next: Next) => {
    await next();
    
    // Only compress successful responses
    if (ctx.status !== 200 || !ctx.body) {
      return;
    }
    
    // Check if should compress
    if (!shouldCompress(ctx, opts.threshold)) {
      return;
    }
    
    // Get accepted encodings
    const acceptEncoding = ctx.request.get('Accept-Encoding') || '';
    const supportsBrotli = acceptEncoding.includes('br');
    const supportsGzip = acceptEncoding.includes('gzip');
    
    if (!supportsBrotli && !supportsGzip) {
      return;
    }
    
    // Convert body to buffer
    let buffer: Buffer;
    if (Buffer.isBuffer(ctx.body)) {
      buffer = ctx.body;
    } else if (typeof ctx.body === 'string') {
      buffer = Buffer.from(ctx.body);
    } else {
      buffer = Buffer.from(JSON.stringify(ctx.body));
    }
    
    try {
      // Prefer Brotli for better compression
      if (supportsBrotli) {
        const compressed = await brotliAsync(buffer, {
          params: {
            [require('zlib').constants.BROTLI_PARAM_QUALITY]: opts.level,
          },
        });
        
        ctx.set('Content-Encoding', 'br');
        ctx.set('Vary', 'Accept-Encoding');
        ctx.body = compressed;
        ctx.length = compressed.length;
      } else if (supportsGzip) {
        const compressed = await gzipAsync(buffer, {
          level: opts.level,
        });
        
        ctx.set('Content-Encoding', 'gzip');
        ctx.set('Vary', 'Accept-Encoding');
        ctx.body = compressed;
        ctx.length = compressed.length;
      }
      
      // Add compression ratio header for debugging
      if (process.env.NODE_ENV !== 'production') {
        const ratio = ((1 - (ctx.length / buffer.length)) * 100).toFixed(2);
        ctx.set('X-Compression-Ratio', `${ratio}%`);
      }
    } catch (error) {
      // If compression fails, send uncompressed
      console.error('Compression error:', error);
      ctx.body = buffer;
    }
  };
}

export default compressionMiddleware;
