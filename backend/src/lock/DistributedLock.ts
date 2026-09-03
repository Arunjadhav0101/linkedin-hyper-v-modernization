import { Redis } from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../observability/logger.js';

export interface LockOptions {
  ttlMs?: number;
  retryAttempts?: number;
  retryDelayMs?: number;
}

export class DistributedLock {
  private redis?: Redis;
  private ownerId: string;
  private static memoryLocks: Map<string, { owner: string; expiresAt: number }> = new Map();

  // Lua script for atomic unlock: only delete if the value matches the lock owner token
  private static readonly UNLOCK_SCRIPT = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  constructor(redisClient?: Redis, ownerId?: string) {
    this.redis = redisClient;
    this.ownerId = ownerId ?? `worker_${uuidv4()}`;
  }

  public getOwnerId(): string {
    return this.ownerId;
  }

  public static clearMemoryLocks(): void {
    DistributedLock.memoryLocks.clear();
  }

  /**
   * Attempts to acquire a distributed lock on a resource
   */
  public async acquire(resource: string, options: LockOptions = {}): Promise<boolean> {
    const { ttlMs = 10000, retryAttempts = 0, retryDelayMs = 200 } = options;
    const lockKey = `hyperv:lock:${resource}`;

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      if (this.redis) {
        try {
          // SET key value NX PX ttlMs
          const result = await this.redis.set(lockKey, this.ownerId, 'PX', ttlMs, 'NX');
          if (result === 'OK') {
            logger.debug({ resource, ownerId: this.ownerId, ttlMs }, 'Distributed lock acquired via Redis');
            return true;
          }
        } catch (err: any) {
          logger.warn({ resource, error: err.message }, 'Redis lock acquisition error; checking memory fallback');
        }
      } else {
        // Shared in-memory fallback
        const now = Date.now();
        const existing = DistributedLock.memoryLocks.get(lockKey);
        if (!existing || existing.expiresAt <= now) {
          DistributedLock.memoryLocks.set(lockKey, { owner: this.ownerId, expiresAt: now + ttlMs });
          logger.debug({ resource, ownerId: this.ownerId, ttlMs }, 'Distributed lock acquired via Memory');
          return true;
        }
      }

      if (attempt < retryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }

    logger.warn({ resource, ownerId: this.ownerId }, 'Failed to acquire distributed lock (already locked)');
    return false;
  }

  /**
   * Safely releases a distributed lock using Lua script to verify owner token
   */
  public async release(resource: string): Promise<boolean> {
    const lockKey = `hyperv:lock:${resource}`;

    if (this.redis) {
      try {
        const result = await this.redis.eval(DistributedLock.UNLOCK_SCRIPT, 1, lockKey, this.ownerId);
        const released = result === 1;
        if (released) {
          logger.debug({ resource, ownerId: this.ownerId }, 'Distributed lock released cleanly');
        } else {
          logger.warn({ resource, ownerId: this.ownerId }, 'Lock was not released: owner token mismatch or expired');
        }
        return released;
      } catch (err: any) {
        logger.error({ resource, error: err.message }, 'Error releasing distributed lock in Redis');
        return false;
      }
    } else {
      const existing = DistributedLock.memoryLocks.get(lockKey);
      if (existing && existing.owner === this.ownerId) {
        DistributedLock.memoryLocks.delete(lockKey);
        logger.debug({ resource, ownerId: this.ownerId }, 'Memory lock released cleanly');
        return true;
      }
      return false;
    }
  }

  /**
   * Runs an action wrapped in an acquired lock, guaranteeing release on completion or failure
   */
  public async runWithLock<T>(resource: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
    const acquired = await this.acquire(resource, options);
    if (!acquired) {
      throw new Error(`Could not acquire distributed lock for resource: ${resource}`);
    }

    try {
      return await fn();
    } finally {
      await this.release(resource);
    }
  }
}
