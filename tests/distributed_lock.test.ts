import { describe, it, expect, beforeEach } from 'vitest';
import { DistributedLock } from '../backend/src/lock/DistributedLock.js';

describe('DistributedLock Subsystem', () => {
  let lockA: DistributedLock;
  let lockB: DistributedLock;

  beforeEach(() => {
    DistributedLock.clearMemoryLocks();
    lockA = new DistributedLock(undefined, 'worker_A');
    lockB = new DistributedLock(undefined, 'worker_B');
  });

  it('allows a worker to acquire and safely release a lock', async () => {
    const resource = 'account_123';
    const acquired = await lockA.acquire(resource, { ttlMs: 2000 });
    expect(acquired).toBe(true);

    const released = await lockA.release(resource);
    expect(released).toBe(true);
  });

  it('prevents a second worker from acquiring the same resource simultaneously', async () => {
    const resource = 'account_concurrent';
    const acquiredA = await lockA.acquire(resource, { ttlMs: 5000 });
    expect(acquiredA).toBe(true);

    // Worker B attempts to acquire same resource
    const acquiredB = await lockB.acquire(resource, { ttlMs: 5000 });
    expect(acquiredB).toBe(false);

    // After Worker A releases, Worker B can acquire
    await lockA.release(resource);
    const acquiredBRetry = await lockB.acquire(resource, { ttlMs: 5000 });
    expect(acquiredBRetry).toBe(true);
    await lockB.release(resource);
  });

  it('prevents a worker from releasing another worker lock', async () => {
    const resource = 'account_protected';
    await lockA.acquire(resource, { ttlMs: 5000 });

    // Worker B tries to unlock Worker A's lock
    const releasedByB = await lockB.release(resource);
    expect(releasedByB).toBe(false);

    // Resource is still locked for Worker A
    const acquireAgain = await lockB.acquire(resource);
    expect(acquireAgain).toBe(false);

    await lockA.release(resource);
  });

  it('automatically releases lock after TTL expires', async () => {
    const resource = 'account_ttl_test';
    await lockA.acquire(resource, { ttlMs: 150 });

    // Immediately locked
    expect(await lockB.acquire(resource)).toBe(false);

    // Wait for TTL expiry
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Worker B can now acquire because TTL expired
    expect(await lockB.acquire(resource)).toBe(true);
    await lockB.release(resource);
  });

  it('runs an action within runWithLock and automatically releases upon completion or error', async () => {
    const resource = 'account_wrapped';

    const result = await lockA.runWithLock(resource, async () => {
      return 'processed_data';
    });
    expect(result).toBe('processed_data');

    // Verify lock is already released
    const canAcquire = await lockB.acquire(resource);
    expect(canAcquire).toBe(true);
    await lockB.release(resource);
  });
});
