// Simple in-memory cache with TTL
// Usage: cache.set(key, value, ttlSeconds); cache.get(key)

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class SimpleCache {
  private store: Record<string, CacheEntry<any>> = {};

  get<T>(key: string): T | undefined {
    const entry = this.store[key];
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      delete this.store[key];
      return undefined;
    }
    return entry.value;
  }

  set<T>(key: string, value: T, ttlSeconds: number) {
    this.store[key] = {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
  }

  del(key: string) {
    delete this.store[key];
  }

  clear() {
    this.store = {};
  }
}

const cache = new SimpleCache();
export default cache; 