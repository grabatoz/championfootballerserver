// Enhanced in-memory cache with TTL and smart updates - ULTRA FAST VERSION
// Usage: cache.set(key, value, ttlSeconds); cache.get(key)
// Smart updates: cache.updateArray(key, newItem, idField, ttlSeconds)
// Default TTL for all endpoints is now 15 minutes (900 seconds) for MAXIMUM SPEED

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  hits: number; // Track cache hit count
}

class SuperFastCache {
  private store: Record<string, CacheEntry<any>> = {};
  private hitStats: Record<string, number> = {};

  get<T>(key: string): T | undefined {
    const entry = this.store[key];
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      delete this.store[key];
      return undefined;
    }
    entry.hits++;
    this.hitStats[key] = (this.hitStats[key] || 0) + 1;
    return entry.value;
  }

  set<T>(key: string, value: T, ttlSeconds: number = 900) { // Default 15 min for speed
    this.store[key] = {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
      hits: 0
    };
  }

  // Smart update for array-based caches (leagues, matches, players, etc.)
  updateArray<T extends { id: string }>(key: string, newItem: T, ttlSeconds: number = 600) {
    const existing = this.get(key) as any;
    if (existing && existing.success && Array.isArray(existing.data)) {
      // Find and update existing item or add new one
      const index = existing.data.findIndex((item: any) => item.id === newItem.id);
      if (index !== -1) {
        existing.data[index] = { ...existing.data[index], ...newItem };
        console.log(`🔄 Updated existing item in cache: ${key} - ${newItem.id}`);
      } else {
        existing.data.unshift(newItem); // Add to beginning
        console.log(`➕ Added new item to cache: ${key} - ${newItem.id}`);
      }
      this.set(key, existing, ttlSeconds);
    } else if (existing && existing.success && Array.isArray(existing.leagues)) {
      // Special case for leagues cache structure
      const index = existing.leagues.findIndex((item: any) => item.id === newItem.id);
      if (index !== -1) {
        existing.leagues[index] = { ...existing.leagues[index], ...newItem };
        console.log(`🔄 Updated existing league in cache: ${key} - ${newItem.id}`);
      } else {
        existing.leagues.unshift(newItem);
        console.log(`➕ Added new league to cache: ${key} - ${newItem.id}`);
      }
      this.set(key, existing, ttlSeconds);
    } else if (existing && existing.success && Array.isArray(existing.matches)) {
      // Special case for matches cache structure
      const index = existing.matches.findIndex((item: any) => item.id === newItem.id);
      if (index !== -1) {
        existing.matches[index] = { ...existing.matches[index], ...newItem };
        console.log(`🔄 Updated existing match in cache: ${key} - ${newItem.id}`);
      } else {
        existing.matches.unshift(newItem);
        console.log(`➕ Added new match to cache: ${key} - ${newItem.id}`);
      }
      this.set(key, existing, ttlSeconds);
    } else if (existing && existing.success && Array.isArray(existing.players)) {
      // Special case for players cache structure
      const index = existing.players.findIndex((item: any) => item.id === newItem.id);
      if (index !== -1) {
        existing.players[index] = { ...existing.players[index], ...newItem };
        console.log(`🔄 Updated existing player in cache: ${key} - ${newItem.id}`);
      } else {
        existing.players.unshift(newItem);
        console.log(`➕ Added new player to cache: ${key} - ${newItem.id}`);
      }
      this.set(key, existing, ttlSeconds);
    } else {
      console.log(`📝 No existing cache found for: ${key}, creating new one`);
      this.set(key, { success: true, data: [newItem] }, ttlSeconds);
    }
  }

  // Remove item from array-based cache
  removeFromArray(key: string, itemId: string, ttlSeconds: number = 600) {
    const existing = this.get(key) as any;
    if (existing && existing.success && Array.isArray(existing.data)) {
      existing.data = existing.data.filter((item: any) => item.id !== itemId);
      this.set(key, existing, ttlSeconds);
      console.log(`🗑️ Removed item from cache: ${key} - ${itemId}`);
    } else if (existing && existing.success && Array.isArray(existing.leagues)) {
      existing.leagues = existing.leagues.filter((item: any) => item.id !== itemId);
      this.set(key, existing, ttlSeconds);
      console.log(`🗑️ Removed league from cache: ${key} - ${itemId}`);
    } else if (existing && existing.success && Array.isArray(existing.matches)) {
      existing.matches = existing.matches.filter((item: any) => item.id !== itemId);
      this.set(key, existing, ttlSeconds);
      console.log(`🗑️ Removed match from cache: ${key} - ${itemId}`);
    } else if (existing && existing.success && Array.isArray(existing.players)) {
      existing.players = existing.players.filter((item: any) => item.id !== itemId);
      this.set(key, existing, ttlSeconds);
      console.log(`🗑️ Removed player from cache: ${key} - ${itemId}`);
    }
  }

  // Update leaderboard cache with new stats
  updateLeaderboard(key: string, newStats: any, ttlSeconds: number = 600) {
    const existing = this.get(key) as any;
    if (existing && existing.players) {
      const index = existing.players.findIndex((player: any) => player.id === newStats.playerId);
      if (index !== -1) {
        existing.players[index] = { ...existing.players[index], ...newStats };
        console.log(`🔄 Updated leaderboard cache for player: ${newStats.playerId}`);
      } else {
        existing.players.unshift(newStats);
        console.log(`➕ Added new player to leaderboard cache: ${newStats.playerId}`);
      }
      this.set(key, existing, ttlSeconds);
    }
  }

  // Clear specific cache patterns
  clearPattern(pattern: string) {
    const keys = Object.keys(this.store);
    keys.forEach(key => {
      if (key.includes(pattern)) {
        delete this.store[key];
        console.log(`🗑️ Cleared cache pattern: ${pattern} - ${key}`);
      }
    });
  }

  del(key: string) {
    delete this.store[key];
    console.log(`🗑️ Cleared cache: ${key}`);
  }

  clear() {
    this.store = {};
    console.log('🗑️ Cleared all caches');
  }

  // Get cache status for debugging
  getStatus() {
    const keys = Object.keys(this.store);
    const status: Record<string, any> = {};
    keys.forEach(key => {
      const entry = this.store[key];
      status[key] = {
        hasData: !!entry,
        expiresIn: entry ? Math.max(0, entry.expiresAt - Date.now()) : 0
      };
    });
    return status;
  }
}

const cache = new SuperFastCache();
export default cache; 