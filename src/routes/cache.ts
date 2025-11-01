// Cache Status & Management Route
import Router from '@koa/router';
import cache from '../utils/cache';

const router = new Router({ prefix: '/cache' });

// Get cache status (admin only in production)
router.get('/status', async (ctx) => {
  try {
    const status = cache.getStatus();
    
    ctx.body = {
      success: true,
      timestamp: new Date().toISOString(),
      cache: status,
      environment: process.env.NODE_ENV || 'development'
    };
    
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to get cache status',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Clear all caches (admin only in production)
router.post('/clear', async (ctx) => {
  try {
    cache.clear();
    
    ctx.body = {
      success: true,
      message: 'All caches cleared successfully',
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to clear caches',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Clear specific cache pattern
router.post('/clear/:pattern', async (ctx) => {
  try {
    const { pattern } = ctx.params;
    cache.clearPattern(pattern);
    
    ctx.body = {
      success: true,
      message: `Caches matching pattern "${pattern}" cleared successfully`,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    ctx.status = 500;
    ctx.body = {
      success: false,
      message: 'Failed to clear cache pattern',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
});

// Health check endpoint
router.get('/health', async (ctx) => {
  const status = cache.getStatus();
  const summary = status.summary || { totalEntries: 0, hitRate: '0%' };
  
  ctx.body = {
    success: true,
    healthy: true,
    cacheStats: {
      totalEntries: summary.totalEntries,
      hitRate: summary.hitRate,
      timestamp: new Date().toISOString()
    }
  };
});

export default router;
