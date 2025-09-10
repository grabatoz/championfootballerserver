// Performance optimization utilities
import cache from './cache';

// Fast response wrapper with automatic caching
export function withCache<T>(
  cacheKey: string, 
  ttl: number = 300,
  fetcher: () => Promise<T>
) {
  return async (): Promise<T> => {
    const cached = cache.get<T>(cacheKey);
    if (cached) return cached;
    
    const result = await fetcher();
    cache.set(cacheKey, result, ttl);
    return result;
  };
}

// Debounce database queries to prevent hammering
const queryDebounce = new Map<string, Promise<any>>();

export function debounceQuery<T>(
  key: string,
  query: () => Promise<T>,
  timeout: number = 100
): Promise<T> {
  if (queryDebounce.has(key)) {
    return queryDebounce.get(key)!;
  }

  const promise = query().finally(() => {
    setTimeout(() => queryDebounce.delete(key), timeout);
  });

  queryDebounce.set(key, promise);
  return promise;
}

// Batch database operations
export class BatchProcessor<T, R> {
  private batch: T[] = [];
  private timer: NodeJS.Timeout | null = null;
  
  constructor(
    private processor: (items: T[]) => Promise<R[]>,
    private batchSize: number = 10,
    private delay: number = 50
  ) {}

  add(item: T): Promise<R> {
    return new Promise((resolve, reject) => {
      this.batch.push(item);
      
      const processNow = () => {
        if (this.timer) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        
        const currentBatch = this.batch.splice(0, this.batchSize);
        this.processor(currentBatch)
          .then(results => resolve(results[currentBatch.length - 1]))
          .catch(reject);
      };

      if (this.batch.length >= this.batchSize) {
        processNow();
      } else if (!this.timer) {
        this.timer = setTimeout(processNow, this.delay);
      }
    });
  }
}
