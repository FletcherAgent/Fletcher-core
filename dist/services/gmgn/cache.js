const memoryCache = new Map();
export class GMGNCache {
    /**
     * Retrieves an item from cache. Returns null if expired or missing.
     */
    static get(key) {
        const entry = memoryCache.get(key);
        if (!entry)
            return null;
        if (Date.now() > entry.expiry) {
            memoryCache.delete(key);
            return null;
        }
        return entry.data;
    }
    /**
     * Sets an item in cache with a TTL (Time To Live) in seconds.
     */
    static set(key, data, ttlSeconds) {
        const expiry = Date.now() + (ttlSeconds * 1000);
        memoryCache.set(key, { data, expiry });
    }
    /**
     * Clears the cache memory.
     */
    static clear() {
        memoryCache.clear();
    }
}
