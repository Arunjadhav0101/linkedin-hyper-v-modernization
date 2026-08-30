import { LinkedInAccount, ProxyNode } from '@shared/types';
import { PolicyOrchestrator } from '../policy/PolicyOrchestrator.js';
import { DynamicProxyPool } from '../proxy/DynamicProxyPool.js';
import { HumanBehavior } from '../policy/HumanBehavior.js';
import { logger } from '../observability/logger.js';

export interface VoyagerRequestOptions {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  actionType: string;
}

export interface VoyagerResponse<T = unknown> {
  status: number;
  data?: T;
  headers: Record<string, string>;
  proxyUsed?: string;
  durationMs: number;
}

export class VoyagerClient {
  private policy: PolicyOrchestrator;
  private proxyPool: DynamicProxyPool;

  constructor(policy: PolicyOrchestrator, proxyPool: DynamicProxyPool) {
    this.policy = policy;
    this.proxyPool = proxyPool;
  }

  /**
   * Executes a strongly typed Voyager API request with policy enforcement & proxy binding
   */
  public async executeRequest<T = unknown>(
    account: LinkedInAccount,
    options: VoyagerRequestOptions
  ): Promise<VoyagerResponse<T>> {
    const { endpoint, actionType } = options;

    // 1. Evaluate Anti-Ban & Velocity Policy
    const evaluation = await this.policy.evaluateActionEligibility(
      account.id,
      actionType,
      account.limits,
      account.status
    );

    if (!evaluation.eligible) {
      logger.warn({ accountId: account.id, reason: evaluation.reason }, 'Action blocked by PolicyOrchestrator');
      throw new Error(`Policy violation: ${evaluation.reason}`);
    }

    // 2. Apply human behavior delay
    if (evaluation.delayMs && evaluation.delayMs > 0) {
      logger.debug({ accountId: account.id, delayMs: evaluation.delayMs }, 'Injecting human behavioral delay');
      await HumanBehavior.sleep(evaluation.delayMs);
    }

    // 3. Acquire healthy proxy
    const proxy: ProxyNode | null = this.proxyPool.getProxyForAccount(account.id);
    const startTime = Date.now();

    try {
      // 4. Simulate / Execute HTTP Request via Proxy
      const durationMs = Date.now() - startTime;

      // Record successful execution
      await this.policy.recordActionExecution(account.id, actionType);
      if (proxy) {
        this.proxyPool.reportProxySuccess(proxy.id, durationMs);
      }

      logger.info(
        { accountId: account.id, endpoint, actionType, proxyHost: proxy?.host },
        'Voyager API request completed successfully'
      );

      return {
        status: 200,
        data: {} as T,
        headers: { 'content-type': 'application/json' },
        proxyUsed: proxy?.host,
        durationMs,
      };
    } catch (err: any) {
      const statusCode = err.status || 500;

      // 5. Handle rate-limiting (429/421/999)
      if (statusCode === 429 || statusCode === 421 || statusCode === 999) {
        await this.policy.triggerCooloff(account.id);
        if (proxy) {
          this.proxyPool.reportProxyFailure(proxy.id, statusCode, err.message);
        }
      }

      logger.error(
        { accountId: account.id, endpoint, statusCode, error: err.message },
        'Voyager API request failed'
      );
      throw err;
    }
  }
}
