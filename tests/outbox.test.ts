import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  OutboxPublisher,
  MemoryOutboxStorage,
} from '../backend/src/events/OutboxPublisher.js';
import { EventBus } from '../backend/src/events/EventBus.js';
import {
  DeadLetterQueueManager,
  MemoryDLQStorage,
} from '../backend/src/events/DeadLetterQueue.js';

describe('Transactional Outbox Pattern (Feature 1)', () => {
  let storage: MemoryOutboxStorage;
  let eventBus: EventBus;
  let dlqStorage: MemoryDLQStorage;
  let dlqManager: DeadLetterQueueManager;
  let publisher: OutboxPublisher;

  beforeEach(() => {
    storage = new MemoryOutboxStorage();
    eventBus = new EventBus();
    dlqStorage = new MemoryDLQStorage();
    dlqManager = new DeadLetterQueueManager(dlqStorage);
    publisher = new OutboxPublisher(storage, eventBus, dlqManager);
  });

  it('should queue event with PENDING status and initial retry metadata', async () => {
    const record = await publisher.queueEvent({
      eventType: 'MESSAGE_RECEIVED',
      payload: {
        accountId: 'acc_101',
        conversationId: 'conv_202',
        remoteMessageId: 'remote_msg_303',
        senderId: 'user_404',
        recipientId: 'acc_101',
        content: 'Hey, connecting for outbound outreach.',
        sentAt: new Date().toISOString(),
      },
      aggregateId: 'acc_101',
      aggregateType: 'ACCOUNT',
      maxRetries: 3,
    });

    expect(record.id).toBeDefined();
    expect(record.status).toBe('PENDING');
    expect(record.retryCount).toBe(0);
    expect(record.maxRetries).toBe(3);
    expect(record.traceId).toBeDefined();

    const stored = await storage.getRecordById(record.id);
    expect(stored).toEqual(record);
  });

  it('should process pending outbox events, publish to EventBus, and transition status to PROCESSED', async () => {
    const receivedEvents: any[] = [];
    eventBus.subscribe('MESSAGE_RECEIVED', async (evt) => {
      receivedEvents.push(evt);
    });

    const record = await publisher.queueEvent({
      eventType: 'MESSAGE_RECEIVED',
      payload: {
        accountId: 'acc_test_success',
        conversationId: 'conv_1',
        remoteMessageId: 'msg_1',
        senderId: 'sender_1',
        recipientId: 'acc_test_success',
        content: 'Hello World',
        sentAt: new Date().toISOString(),
      },
      aggregateId: 'acc_test_success',
      aggregateType: 'ACCOUNT',
    });

    const batchResult = await publisher.processPendingBatch(10);
    expect(batchResult.processedCount).toBe(1);
    expect(batchResult.successCount).toBe(1);
    expect(batchResult.failedCount).toBe(0);
    expect(batchResult.dlqCount).toBe(0);

    // Verify subscriber received event
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].payload.content).toBe('Hello World');

    // Verify outbox record status updated to PROCESSED
    const updated = await storage.getRecordById(record.id);
    expect(updated?.status).toBe('PROCESSED');
    expect(updated?.processedAt).toBeInstanceOf(Date);
  });

  it('should handle transient event publishing failure, increment retryCount, and schedule exponential backoff', async () => {
    // Force handler to throw a transient network error
    eventBus.subscribe('MESSAGE_RECEIVED', async () => {
      throw new Error('Redis broker connection dropped temporarily');
    });

    const record = await publisher.queueEvent({
      eventType: 'MESSAGE_RECEIVED',
      payload: {
        accountId: 'acc_transient_fail',
        conversationId: 'conv_1',
        remoteMessageId: 'msg_fail_1',
        senderId: 'sender_1',
        recipientId: 'acc_transient_fail',
        content: 'Retry test',
        sentAt: new Date().toISOString(),
      },
      aggregateId: 'acc_transient_fail',
      aggregateType: 'ACCOUNT',
      maxRetries: 5,
    });

    const batchResult = await publisher.processPendingBatch(10);
    expect(batchResult.processedCount).toBe(1);
    expect(batchResult.successCount).toBe(0);
    expect(batchResult.failedCount).toBe(1);
    expect(batchResult.dlqCount).toBe(0);

    const updated = await storage.getRecordById(record.id);
    expect(updated?.status).toBe('FAILED');
    expect(updated?.retryCount).toBe(1);
    expect(updated?.lastError).toContain('Redis broker connection dropped temporarily');
    expect(updated?.nextRetryAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('should route permanently failed outbox event to DeadLetterQueue when retry limit is exceeded and transition status to DLQ_ROUTED', async () => {
    eventBus.subscribe('MESSAGE_RECEIVED', async () => {
      throw new Error('Unrecoverable serialization error');
    });

    // Create record configured with maxRetries = 2
    const record = await publisher.queueEvent({
      eventType: 'MESSAGE_RECEIVED',
      payload: {
        accountId: 'acc_exhausted',
        conversationId: 'conv_exhausted',
        remoteMessageId: 'msg_exhausted',
        senderId: 'sender_1',
        recipientId: 'acc_exhausted',
        content: 'Permanent failure',
        sentAt: new Date().toISOString(),
      },
      aggregateId: 'acc_exhausted',
      aggregateType: 'ACCOUNT',
      maxRetries: 2,
    });

    // 1st failure (retryCount becomes 1, status FAILED)
    await publisher.processPendingBatch(10);
    const afterFirst = await storage.getRecordById(record.id);
    expect(afterFirst?.status).toBe('FAILED');
    expect(afterFirst?.retryCount).toBe(1);

    // Fast-forward nextRetryAt to simulate backoff elapsed
    afterFirst!.nextRetryAt = new Date(Date.now() - 1000);
    await storage.createRecord(afterFirst!);

    // 2nd failure (retryCount reaches 2 == maxRetries, routes to DLQ)
    const secondBatchResult = await publisher.processPendingBatch(10);
    expect(secondBatchResult.dlqCount).toBe(1);

    const afterSecond = await storage.getRecordById(record.id);
    expect(afterSecond?.status).toBe('DLQ_ROUTED');
    expect(afterSecond?.retryCount).toBe(2);

    // Verify event in DLQ storage
    const dlqPending = await dlqStorage.getPendingRecords();
    expect(dlqPending).toHaveLength(1);
    expect(dlqPending[0]?.originalEventId).toBe(record.id);
    expect(dlqPending[0]?.errorMessage).toContain('Unrecoverable serialization error');
    expect(dlqPending[0]?.accountId).toBe('acc_exhausted');
  });
});
