/**
 * Hierarchical Two-Tier Cache Architecture.
 * L1 in-memory LRU cache + clustered Redis L2 VPC cache for cross-team schema deduplication.
 */

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface TwoTierCacheStats {
  l1Hits: number;
  l2Hits: number;
  misses: number;
  totalRequests: number;
  hitRatio: number;
}

export interface RedisVpcAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, val: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class InMemoryL1Cache<T> {
  private readonly capacity: number;
  private readonly store = new Map<string, CacheEntry<T>>();

  constructor(capacity = 1000) {
    this.capacity = capacity;
  }

  public get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // Refresh position for LRU
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: T, ttlSeconds = 3600): void {
    if (this.store.size >= this.capacity) {
      // Evict oldest (first inserted in Map)
      const oldestKey = this.store.keys().next().value;
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  public delete(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  public size(): number {
    return this.store.size;
  }
}

/**
 * Mock/InMemory Redis adapter for zero-dependency local execution,
 * seamlessly pluggable with real ioredis or redis clients in private VPC.
 */
export class MockRedisVpcAdapter implements RedisVpcAdapter {
  private readonly store = new Map<string, { val: string; expiresAt: number }>();

  public async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.val;
  }

  public async set(key: string, val: string, ttlSeconds = 3600): Promise<void> {
    this.store.set(key, {
      val,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  public async del(key: string): Promise<void> {
    this.store.delete(key);
  }
}

export class TwoTierCache<T> {
  private readonly l1: InMemoryL1Cache<T>;
  private readonly l2: RedisVpcAdapter;
  private l1Hits = 0;
  private l2Hits = 0;
  private misses = 0;

  constructor(l1Capacity = 1000, l2Adapter?: RedisVpcAdapter) {
    this.l1 = new InMemoryL1Cache<T>(l1Capacity);
    this.l2 = l2Adapter ?? new MockRedisVpcAdapter();
  }

  public async get(key: string): Promise<T | null> {
    // 1. Check L1 in-memory cache (sub-microsecond)
    const l1Val = this.l1.get(key);
    if (l1Val !== null) {
      this.l1Hits++;
      return l1Val;
    }

    // 2. Check L2 Redis VPC cache
    try {
      const l2Raw = await this.l2.get(key);
      if (l2Raw !== null) {
        this.l2Hits++;
        const parsed: T = JSON.parse(l2Raw);
        // Promote to L1
        this.l1.set(key, parsed);
        return parsed;
      }
    } catch {
      // Degrade gracefully to miss on network error
    }

    this.misses++;
    return null;
  }

  public async set(key: string, value: T, ttlSeconds = 3600): Promise<void> {
    // Write to L1
    this.l1.set(key, value, ttlSeconds);

    // Write to L2
    try {
      await this.l2.set(key, JSON.stringify(value), ttlSeconds);
    } catch {
      // Non-blocking L2 write failure
    }
  }

  public async invalidate(key: string): Promise<void> {
    this.l1.delete(key);
    try {
      await this.l2.del(key);
    } catch {
      // ignore
    }
  }

  public getStats(): TwoTierCacheStats {
    const total = this.l1Hits + this.l2Hits + this.misses;
    return {
      l1Hits: this.l1Hits,
      l2Hits: this.l2Hits,
      misses: this.misses,
      totalRequests: total,
      hitRatio: total > 0 ? (this.l1Hits + this.l2Hits) / total : 0,
    };
  }
}
