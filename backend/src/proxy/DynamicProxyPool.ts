import { ProxyNode } from '@shared/types';
import { logger } from '../observability/logger.js';

export class DynamicProxyPool {
  private proxies: Map<string, ProxyNode> = new Map();
  private accountSessionMap: Map<string, string> = new Map(); // accountId -> proxyId

  constructor(initialProxies: ProxyNode[] = []) {
    for (const proxy of initialProxies) {
      this.proxies.set(proxy.id, { ...proxy });
    }
  }

  public addProxy(proxy: ProxyNode): void {
    this.proxies.set(proxy.id, { ...proxy });
  }

  public removeProxy(proxyId: string): void {
    this.proxies.delete(proxyId);
    // Cleanup any account sessions using this proxy
    for (const [accountId, pId] of this.accountSessionMap.entries()) {
      if (pId === proxyId) {
        this.accountSessionMap.delete(accountId);
      }
    }
  }

  /**
   * Acquires a healthy proxy for an account with sticky session affinity
   */
  public getProxyForAccount(accountId: string): ProxyNode | null {
    const existingProxyId = this.accountSessionMap.get(accountId);

    if (existingProxyId) {
      const existing = this.proxies.get(existingProxyId);
      if (existing && existing.status === 'HEALTHY') {
        return existing;
      }
      // Stale or degraded proxy assigned, rotate
      this.accountSessionMap.delete(accountId);
    }

    // Find best available healthy proxy
    const healthyProxies = Array.from(this.proxies.values())
      .filter((p) => p.status === 'HEALTHY')
      .sort((a, b) => a.latencyMs - b.latencyMs);

    if (healthyProxies.length === 0) {
      logger.warn({ accountId }, 'No healthy proxies available in dynamic pool');
      return null;
    }

    const selected = healthyProxies[0]!;
    this.accountSessionMap.set(accountId, selected.id);
    logger.debug({ accountId, proxyId: selected.id, host: selected.host }, 'Assigned sticky proxy to account session');
    return selected;
  }

  /**
   * Records failure and auto-rotates proxy if rate-limited (429/421) or banned
   */
  public reportProxyFailure(
    proxyId: string,
    statusCode?: number,
    errorMsg?: string
  ): { rotated: boolean; newProxyId?: string } {
    const proxy = this.proxies.get(proxyId);
    if (!proxy) return { rotated: false };

    proxy.consecutiveFailures++;
    proxy.healthScore = Math.max(0, proxy.healthScore - 25);

    const isHardBlock = statusCode === 429 || statusCode === 421 || statusCode === 999;

    if (isHardBlock || proxy.consecutiveFailures >= 3) {
      proxy.status = 'BANNED';
      proxy.bannedUntil = new Date(Date.now() + 3600000); // 1-hour quarantine
      logger.warn(
        { proxyId, host: proxy.host, statusCode, errorMsg },
        'Proxy placed in quarantine due to rate-limit / consecutive failures'
      );

      // Invalidate all account sessions mapped to this proxy
      for (const [accId, pId] of this.accountSessionMap.entries()) {
        if (pId === proxyId) {
          this.accountSessionMap.delete(accId);
        }
      }
      return { rotated: true };
    }

    if (proxy.healthScore < 50) {
      proxy.status = 'DEGRADED';
    }

    return { rotated: false };
  }

  /**
   * Records successful proxy request and improves health score
   */
  public reportProxySuccess(proxyId: string, latencyMs: number): void {
    const proxy = this.proxies.get(proxyId);
    if (!proxy) return;

    proxy.consecutiveFailures = 0;
    proxy.latencyMs = Math.round((proxy.latencyMs * 0.7) + (latencyMs * 0.3));
    proxy.healthScore = Math.min(100, proxy.healthScore + 5);
    if (proxy.status === 'DEGRADED' && proxy.healthScore >= 70) {
      proxy.status = 'HEALTHY';
    }
  }

  /**
   * Returns current pool statistics
   */
  public getPoolStats(): { total: number; healthy: number; degraded: number; banned: number } {
    let healthy = 0;
    let degraded = 0;
    let banned = 0;

    for (const p of this.proxies.values()) {
      if (p.status === 'HEALTHY') healthy++;
      else if (p.status === 'DEGRADED') degraded++;
      else if (p.status === 'BANNED') banned++;
    }

    return { total: this.proxies.size, healthy, degraded, banned };
  }
}
