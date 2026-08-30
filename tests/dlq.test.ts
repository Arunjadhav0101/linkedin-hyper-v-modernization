import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeadLetterQueueManager,
  MemoryDLQStorage,
} from '../backend/src/events/DeadLetterQueue.js';
import { AppEvent } from '@shared/types';

describe('DeadLetterQueue & Exponential Backoff Subsystem', () => {
  let dlq: DeadLetterQueueManager;
  let storage: MemoryDLQStorage;

  beforeEach(() => {
    storage = new MemoryDLQStorage();
    dlq = new DeadLetterQueueManager(storage);
  });

  it('should compute exponential backoff intervals with jitter', () => {
    const delay0 = DeadLetterQueueManager.calculateBackoff(0, 1000, 30000);
    const delay1 = DeadLetterQueueManager.calculateBackoff(1, 1000, 30000);
    const delay2 = DeadLetterQueueManager.calculateBackoff(2, 1000, 30000);
    const delayMax = DeadLetterQueueManager.calculateBackoff(10, 1000, 30000);

    expect(delay0).toBeGreaterThanOrEqual(1000);
    expect(delay1).toBeGreaterThan(delay0 * 1.5);
    expect(delay2).toBeGreaterThan(delay1 * 1.5);
    expect(delayMax).toBeLessThanOrEqual(36000); // capped at maxMs + 20% jitter
  });

  it('should capture failed events in persistent DLQ with stack traces', async () => {
    const failedEvent: AppEvent<'MESSAGE_RECEIVED'> = {
      eventId: 'evt_fail_1',
      traceId: 'trace_fail_1',
      eventName: 'MESSAGE_RECEIVED',
      timestamp: Date.now(),
      payload: {
        accountId: 'acc_fail_1',
        conversationId: 'conv_1',
        remoteMessageId: 'rem_1',
        senderId: 'usr_1',
        recipientId: 'acc_fail_1',
        content: 'Failed delivery',
        sentAt: new Date().toISOString(),
      },
    };

    const error = new Error('Database connection timeout (5000ms)');
    const record = await dlq.routeToDLQ(failedEvent, error, 5, 'acc_fail_1');

    expect(record.id).toBeDefined();
    expect(record.originalEventId).toBe('evt_fail_1');
    expect(record.errorMessage).toBe('Database connection timeout (5000ms)');
    expect(record.isReplayed).toBe(false);

    const pending = await dlq.getUnprocessedDLQMessages();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(record.id);

    // Mark as replayed
    await dlq.markMessageReplayed(record.id);
    const pendingAfterReplay = await dlq.getUnprocessedDLQMessages();
    expect(pendingAfterReplay).toHaveLength(0);
  });
});
