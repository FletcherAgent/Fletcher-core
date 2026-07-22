// Simple In-Memory Cache with TTL
interface CacheEntry<T> {
  data: T;
  expiry: number;
}

const memoryCache = new Map<string, CacheEntry<any>>();

export class GMGNCache {
  /**
   * Retrieves an item from cache. Returns null if expired or missing.
   */
  public static get<T>(key: string): T | null {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    
    if (Date.now() > entry.expiry) {
      memoryCache.delete(key);
      return null;
    }
    
    return entry.data;
  }

  /**
   * Sets an item in cache with a TTL (Time To Live) in seconds.
   */
  public static set<T>(key: string, data: T, ttlSeconds: number): void {
    const expiry = Date.now() + (ttlSeconds * 1000);
    memoryCache.set(key, { data, expiry });
  }

  /**
   * Clears the cache memory.
   */
  public static clear(): void {
    memoryCache.clear();
  }
}
