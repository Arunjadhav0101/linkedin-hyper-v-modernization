import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker, CircuitBreakerOpenError } from '../backend/src/circuit/CircuitBreaker.js';

describe('CircuitBreaker Resilience System', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-service', {
      failureThreshold: 3,
      cooldownMs: 200,
      successThreshold: 2,
    });
  });

  it('starts in CLOSED state and executes successful calls cleanly', async () => {
    expect(breaker.getState()).toBe('CLOSED');

    const result = await breaker.execute(async () => 'success_data');
    expect(result).toBe('success_data');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('trips to OPEN state when failure threshold is reached', async () => {
    const failingAction = async () => {
      throw new Error('Upstream timeout');
    };

    // 1st failure
    await expect(breaker.execute(failingAction)).rejects.toThrow('Upstream timeout');
    expect(breaker.getState()).toBe('CLOSED');

    // 2nd failure
    await expect(breaker.execute(failingAction)).rejects.toThrow('Upstream timeout');
    expect(breaker.getState()).toBe('CLOSED');

    // 3rd failure: threshold reached
    await expect(breaker.execute(failingAction)).rejects.toThrow('Upstream timeout');
    expect(breaker.getState()).toBe('OPEN');

    // 4th call: Immediately fast-fails with CircuitBreakerOpenError without invoking target
    await expect(breaker.execute(async () => 'wont_run')).rejects.toThrow(CircuitBreakerOpenError);
  });

  it('transitions from OPEN to HALF_OPEN after cooldown and returns to CLOSED on successful probes', async () => {
    const failingAction = async () => {
      throw new Error('Service down');
    };

    // Trigger 3 failures to open circuit
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failingAction)).rejects.toThrow('Service down');
    }
    expect(breaker.getState()).toBe('OPEN');

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 250));

    // State becomes HALF_OPEN
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Probe 1 in HALF_OPEN
    await breaker.execute(async () => 'probe_1_ok');
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Probe 2 in HALF_OPEN -> successThreshold reached, circuit resets to CLOSED
    await breaker.execute(async () => 'probe_2_ok');
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('transitions back to OPEN if a probe fails in HALF_OPEN', async () => {
    // Trip circuit
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    }
    expect(breaker.getState()).toBe('OPEN');

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(breaker.getState()).toBe('HALF_OPEN');

    // Probe fails in HALF_OPEN -> immediately returns to OPEN
    await expect(breaker.execute(async () => { throw new Error('probe_failed'); })).rejects.toThrow('probe_failed');
    expect(breaker.getState()).toBe('OPEN');
  });
});
