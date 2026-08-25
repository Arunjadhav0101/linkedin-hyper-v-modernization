import { describe, it, expect, beforeEach } from 'vitest';
import { PolicyOrchestrator, MemoryPolicyStore } from '../worker/src/policy/PolicyOrchestrator.js';
import { HumanBehavior } from '../worker/src/policy/HumanBehavior.js';
import { AccountVelocityLimits } from '@shared/types';

describe('PolicyOrchestrator & Anti-Ban Architecture', () => {
  let policy: PolicyOrchestrator;
  const mockLimits: AccountVelocityLimits = {
    hourlyActionLimit: 5,
    dailyActionLimit: 20,
    hourlyConnectionLimit: 2,
    dailyConnectionLimit: 10,
    hourlyMessageLimit: 3,
    dailyMessageLimit: 15,
  };

  beforeEach(() => {
    policy = new PolicyOrchestrator(new MemoryPolicyStore());
  });

  it('should allow actions within hourly and daily velocity quotas', async () => {
    const accountId = 'acc_test_1';

    for (let i = 0; i < 5; i++) {
      const evaluation = await policy.evaluateActionEligibility(accountId, 'SEND_MESSAGE', mockLimits, 'ACTIVE');
      expect(evaluation.eligible).toBe(true);
      expect(evaluation.delayMs).toBeGreaterThan(0);
      await policy.recordActionExecution(accountId, 'SEND_MESSAGE');
    }

    // 6th action should be blocked due to hourly quota (5 max)
    const blockedEvaluation = await policy.evaluateActionEligibility(accountId, 'SEND_MESSAGE', mockLimits, 'ACTIVE');
    expect(blockedEvaluation.eligible).toBe(false);
    expect(blockedEvaluation.reason).toContain('Hourly velocity quota exceeded');
  });

  it('should immediately block actions on RESTRICTED or DISABLED accounts', async () => {
    const evaluation = await policy.evaluateActionEligibility('acc_banned', 'PROFILE_VIEW', mockLimits, 'RESTRICTED');
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.reason).toContain('Account status is RESTRICTED');
  });

  it('should enforce account cooloff period when triggered by 429 rate limit', async () => {
    const accountId = 'acc_cooloff_test';
    await policy.triggerCooloff(accountId, 5000); // 5s cooloff

    const evalDuringCooloff = await policy.evaluateActionEligibility(accountId, 'SEND_MESSAGE', mockLimits, 'ACTIVE');
    expect(evalDuringCooloff.eligible).toBe(false);
    expect(evalDuringCooloff.reason).toContain('Account in cooldown');
  });

  it('should generate Gaussian delays with realistic human entropy', () => {
    for (let i = 0; i < 100; i++) {
      const delay = HumanBehavior.calculateDelay(1000, 5000, 3000);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });
});
