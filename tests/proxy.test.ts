import { describe, it, expect, beforeEach } from 'vitest';
import { DynamicProxyPool } from '../backend/src/proxy/DynamicProxyPool.js';
import { ProxyNode } from '@shared/types';

describe('DynamicProxyPool Resilience Engine', () => {
  let pool: DynamicProxyPool;

  const mockProxies: ProxyNode[] = [
    {
      id: 'prx-1',
      host: '10.0.0.1',
      port: 8080,
      protocol: 'HTTP',
      isResidential: true,
      status: 'HEALTHY',
      healthScore: 100,
      latencyMs: 120,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'prx-2',
      host: '10.0.0.2',
      port: 8080,
      protocol: 'HTTP',
      isResidential: true,
      status: 'HEALTHY',
      healthScore: 90,
      latencyMs: 250,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  beforeEach(() => {
    pool = new DynamicProxyPool(mockProxies);
  });

  it('should assign the lowest-latency healthy proxy and maintain sticky session affinity', () => {
    const accountId = 'acc_sticky_1';

    const firstProxy = pool.getProxyForAccount(accountId);
    expect(firstProxy).toBeDefined();
    expect(firstProxy?.id).toBe('prx-1'); // Lower latency (120ms vs 250ms)

    // Second call for same account must return the same sticky proxy
    const secondProxy = pool.getProxyForAccount(accountId);
    expect(secondProxy?.id).toBe('prx-1');
  });

  it('should auto-quarantine proxy and re-assign on HTTP 429/421 rate limit', () => {
    const accountId = 'acc_rotate_1';
    const proxy = pool.getProxyForAccount(accountId);
    expect(proxy?.id).toBe('prx-1');

    // Report HTTP 429 Hard Rate Limit
    const report = pool.reportProxyFailure(proxy!.id, 429, 'Too Many Requests');
    expect(report.rotated).toBe(true);

    const stats = pool.getPoolStats();
    expect(stats.banned).toBe(1);
    expect(stats.healthy).toBe(1);

    // Next proxy acquisition should auto-rotate to healthy proxy prx-2
    const rotatedProxy = pool.getProxyForAccount(accountId);
    expect(rotatedProxy?.id).toBe('prx-2');
  });
});
