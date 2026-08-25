import { AccountVelocityLimits, AccountStatus } from '@shared/types';
import { HumanBehavior } from './HumanBehavior.js';
import { logger } from '../observability/logger.js';

export interface RateLimitState {
  hourlyCount: number;
  dailyCount: number;
  lastActionTime: number;
  hourlyWindowStart: number;
  dailyWindowStart: number;
  cooloffUntil?: number;
}

export interface IPolicyStore {
  getAccountState(accountId: string): Promise<RateLimitState | null>;
  setAccountState(accountId: string, state: RateLimitState): Promise<void>;
  incrementAction(accountId: string, actionType: string): Promise<boolean>;
}

export class MemoryPolicyStore implements IPolicyStore {
  private store = new Map<string, RateLimitState>();

  public async getAccountState(accountId: string): Promise<RateLimitState | null> {
    return this.store.get(accountId) ?? null;
  }

  public async setAccountState(accountId: string, state: RateLimitState): Promise<void> {
    this.store.set(accountId, state);
  }

  public async incrementAction(accountId: string, _actionType: string): Promise<boolean> {
    const now = Date.now();
    const state = this.store.get(accountId) ?? {
      hourlyCount: 0,
      dailyCount: 0,
      lastActionTime: 0,
      hourlyWindowStart: now,
      dailyWindowStart: now,
    };

    // Reset hourly window
    if (now - state.hourlyWindowStart >= 3600000) {
      state.hourlyCount = 0;
      state.hourlyWindowStart = now;
    }

    // Reset daily window
    if (now - state.dailyWindowStart >= 86400000) {
      state.dailyCount = 0;
      state.dailyWindowStart = now;
    }

    state.hourlyCount++;
    state.dailyCount++;
    state.lastActionTime = now;
    this.store.set(accountId, state);
    return true;
  }
}

export class PolicyOrchestrator {
  private store: IPolicyStore;

  constructor(store: IPolicyStore = new MemoryPolicyStore()) {
    this.store = store;
  }

  /**
   * Evaluates if an account is eligible to perform an automation action
   */
  public async evaluateActionEligibility(
    accountId: string,
    _actionType: string,
    limits: AccountVelocityLimits,
    status: AccountStatus
  ): Promise<{ eligible: boolean; delayMs?: number; reason?: string }> {
    const now = Date.now();

    if (status === 'RESTRICTED' || status === 'DISABLED' || status === 'CHALLENGE_REQUIRED') {
      return { eligible: false, reason: `Account status is ${status}` };
    }

    const state = await this.store.getAccountState(accountId);

    if (state?.cooloffUntil && state.cooloffUntil > now) {
      const remainingSec = Math.ceil((state.cooloffUntil - now) / 1000);
      return { eligible: false, reason: `Account in cooldown for another ${remainingSec}s` };
    }

    // Determine current effective limits (warmup scaling)
    const effectiveHourlyLimit = status === 'WARMING' ? Math.floor(limits.hourlyActionLimit * 0.5) : limits.hourlyActionLimit;
    const effectiveDailyLimit = status === 'WARMING' ? Math.floor(limits.dailyActionLimit * 0.5) : limits.dailyActionLimit;

    if (state) {
      // Check hourly limit
      if (now - state.hourlyWindowStart < 3600000 && state.hourlyCount >= effectiveHourlyLimit) {
        return {
          eligible: false,
          reason: `Hourly velocity quota exceeded (${state.hourlyCount}/${effectiveHourlyLimit})`,
        };
      }

      // Check daily limit
      if (now - state.dailyWindowStart < 86400000 && state.dailyCount >= effectiveDailyLimit) {
        return {
          eligible: false,
          reason: `Daily velocity quota exceeded (${state.dailyCount}/${effectiveDailyLimit})`,
        };
      }
    }

    // Synthesize human behavior delay
    const delayMs = HumanBehavior.getActionCooldown();
    return { eligible: true, delayMs };
  }

  /**
   * Records execution of an action and updates distributed counters
   */
  public async recordActionExecution(accountId: string, actionType: string): Promise<void> {
    await this.store.incrementAction(accountId, actionType);
    logger.debug({ accountId, actionType }, 'Action execution recorded in policy store');
  }

  /**
   * Applies rate-limit cooldown upon receiving 429 or security challenge
   */
  public async triggerCooloff(accountId: string, cooloffDurationMs = 3600000): Promise<void> {
    const now = Date.now();
    const state = (await this.store.getAccountState(accountId)) ?? {
      hourlyCount: 0,
      dailyCount: 0,
      lastActionTime: now,
      hourlyWindowStart: now,
      dailyWindowStart: now,
    };
    state.cooloffUntil = now + cooloffDurationMs;
    await this.store.setAccountState(accountId, state);
    logger.warn({ accountId, cooloffDurationMs }, 'Account triggered anti-ban cooloff quarantine');
  }
}
