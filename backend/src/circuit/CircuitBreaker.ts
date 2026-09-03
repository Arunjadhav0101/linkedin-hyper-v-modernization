import { logger } from '../observability/logger.js';
import { ErrorClassifier } from '../errors/ErrorClassifier.js';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold?: number; // Number of failures before opening (default: 5)
  cooldownMs?: number; // Cooldown before entering HALF_OPEN (default: 30000ms)
  successThreshold?: number; // Successes in HALF_OPEN to close (default: 2)
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly serviceName: string, public readonly cooldownRemainingMs: number) {
    super(`Circuit breaker for ${serviceName} is OPEN. Cooldown remaining: ${cooldownRemainingMs}ms`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private static instances: Map<string, CircuitBreaker> = new Map();

  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private nextAttemptTime = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;

  constructor(
    public readonly serviceName: string,
    config: CircuitBreakerConfig = {}
  ) {
    this.failureThreshold = config.failureThreshold ?? 5;
    this.cooldownMs = config.cooldownMs ?? 30000;
    this.successThreshold = config.successThreshold ?? 2;
    CircuitBreaker.instances.set(serviceName, this);
  }

  public static get(serviceName: string): CircuitBreaker | undefined {
    return CircuitBreaker.instances.get(serviceName);
  }

  public static resetAll(): void {
    for (const breaker of CircuitBreaker.instances.values()) {
      breaker.reset();
    }
    logger.info('All circuit breakers have been reset to CLOSED');
  }

  public getState(): CircuitState {
    this.evaluateState();
    return this.state;
  }

  public getStats() {
    this.evaluateState();
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      nextAttemptTime: this.nextAttemptTime,
    };
  }

  private evaluateState(): void {
    if (this.state === 'OPEN' && Date.now() >= this.nextAttemptTime) {
      this.state = 'HALF_OPEN';
      this.successCount = 0;
      logger.info({ service: this.serviceName }, 'Circuit breaker transitioning from OPEN to HALF_OPEN (probing)');
    }
  }

  public async execute<T>(action: () => Promise<T>): Promise<T> {
    this.evaluateState();

    if (this.state === 'OPEN') {
      const remaining = Math.max(0, this.nextAttemptTime - Date.now());
      throw new CircuitBreakerOpenError(this.serviceName, remaining);
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (err: any) {
      // CRITICAL FIX: Only record failure for transient upstream errors.
      // Permanent client/auth/validation errors (400, 401, 403, 404, 422) MUST NOT trip the circuit breaker!
      if (!ErrorClassifier.isPermanent(err)) {
        this.onFailure(err);
      } else {
        logger.debug(
          { service: this.serviceName, error: err.message },
          'Permanent client error encountered; ignored by circuit breaker failure counter'
        );
      }
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = 'CLOSED';
        this.failureCount = 0;
        this.successCount = 0;
        logger.info({ service: this.serviceName }, 'Circuit breaker recovered and transitioned to CLOSED');
      }
    } else if (this.state === 'CLOSED') {
      this.failureCount = 0;
    }
  }

  private onFailure(err: any): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.cooldownMs;
      logger.warn(
        { service: this.serviceName, error: err?.message },
        'Circuit breaker probe failed in HALF_OPEN. Transitioned back to OPEN'
      );
    } else if (this.state === 'CLOSED' && this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.cooldownMs;
      logger.error(
        { service: this.serviceName, failureCount: this.failureCount, threshold: this.failureThreshold },
        'Circuit breaker tripped to OPEN state due to consecutive upstream failures'
      );
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.nextAttemptTime = 0;
    logger.info({ service: this.serviceName }, 'Circuit breaker manually reset to CLOSED');
  }
}
