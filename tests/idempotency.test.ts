import { describe, it, expect, beforeEach } from 'vitest';
import {
  PersistenceConsumer,
  MemoryMessageRepository,
} from '../worker/src/events/PersistenceConsumer.js';
import { AppEvent } from '@shared/types';

describe('Data Pipeline Idempotency & Deduplication', () => {
  let consumer: PersistenceConsumer;
  let repo: MemoryMessageRepository;

  beforeEach(() => {
    repo = new MemoryMessageRepository();
    consumer = new PersistenceConsumer(repo);
  });

  it('should generate deterministic SHA-256 idempotency keys', () => {
    const key1 = PersistenceConsumer.generateIdempotencyKey('acc_1', 'conv_1', 'msg_100');
    const key2 = PersistenceConsumer.generateIdempotencyKey('acc_1', 'conv_1', 'msg_100');
    const key3 = PersistenceConsumer.generateIdempotencyKey('acc_1', 'conv_1', 'msg_101');

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).toHaveLength(64); // SHA-256 hex string
  });

  it('should ingest unique message events and safely drop duplicate re-deliveries', async () => {
    const event: AppEvent<'MESSAGE_RECEIVED'> = {
      eventId: 'evt_001',
      traceId: 'trace_001',
      eventName: 'MESSAGE_RECEIVED',
      timestamp: Date.now(),
      payload: {
        accountId: 'acc_1',
        conversationId: 'conv_1',
        remoteMessageId: 'remote_999',
        senderId: 'remote_user',
        recipientId: 'acc_1',
        content: 'Hello, this is an enterprise connection request follow-up.',
        sentAt: new Date().toISOString(),
      },
    };

    // First ingestion -> Should save successfully
    const firstResult = await consumer.handleMessageReceived(event);
    expect(firstResult.saved).toBe(true);
    expect(firstResult.isDuplicate).toBe(false);

    // Duplicate re-delivery (e.g. network retry) -> Should detect duplicate and safely skip
    const duplicateResult = await consumer.handleMessageReceived(event);
    expect(duplicateResult.saved).toBe(false);
    expect(duplicateResult.isDuplicate).toBe(true);
  });

  it('should execute bulk message deduplication passes', async () => {
    const key = PersistenceConsumer.generateIdempotencyKey('acc_1', 'conv_1', 'msg_dup');

    await repo.saveMessage({
      id: 'm1',
      accountId: 'acc_1',
      conversationId: 'conv_1',
      remoteMessageId: 'msg_dup',
      senderId: 'user_1',
      recipientId: 'acc_1',
      content: 'Duplicate body',
      direction: 'INBOUND',
      idempotencyKey: key,
      syncStatus: 'SYNCED',
      sentAt: new Date(),
      syncedAt: new Date(),
    });

    await repo.saveMessage({
      id: 'm2',
      accountId: 'acc_1',
      conversationId: 'conv_1',
      remoteMessageId: 'msg_dup',
      senderId: 'user_1',
      recipientId: 'acc_1',
      content: 'Duplicate body',
      direction: 'INBOUND',
      idempotencyKey: key,
      syncStatus: 'SYNCED',
      sentAt: new Date(),
      syncedAt: new Date(),
    });

    const dedupeResult = await repo.deduplicateMessages('acc_1');
    expect(dedupeResult.deletedCount).toBe(1);
    expect(dedupeResult.duplicateIds).toContain('m2');
  });
});
