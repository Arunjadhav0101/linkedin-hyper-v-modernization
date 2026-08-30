import { OutboxRecord } from '@shared/types';
import { EventBus } from './EventBus.js';
import { DeadLetterQueueManager } from './DeadLetterQueue.js';
import { logger } from '../observability/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface IOutboxStorage {
  createRecord(record: OutboxRecord): Promise<OutboxRecord>;
  fetchPendingRecords(limit?: number): Promise<OutboxRecord[]>;
  markProcessed(id: string): Promise<void>;
  recordFailure(
    id: string,
    error: string,
    nextRetryAt: Date,
    retryCount: number,
    isDlq: boolean
  ): Promise<void>;
  getRecordById(id: string): Promise<OutboxRecord | null>;
}

export class MemoryOutboxStorage implements IOutboxStorage {
  private records: Map<string, OutboxRecord> = new Map();

  public async createRecord(record: OutboxRecord): Promise<OutboxRecord> {
    const copy = { ...record };
    this.records.set(copy.id, copy);
    return copy;
  }

  public async fetchPendingRecords(limit = 50): Promise<OutboxRecord[]> {
    const now = Date.now();
    return Array.from(this.records.values())
      .filter((r) => {
        if (r.status === 'PROCESSED' || r.status === 'DLQ_ROUTED') return false;
        if (r.status === 'PENDING') return true;
        if (r.status === 'FAILED' || r.status === 'PROCESSING') {
          return r.nextRetryAt.getTime() <= now;
        }
        return false;
      })
      .slice(0, limit);
  }

  public async markProcessed(id: string): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.status = 'PROCESSED';
      record.processedAt = new Date();
      record.updatedAt = new Date();
    }
  }

  public async recordFailure(
    id: string,
    error: string,
    nextRetryAt: Date,
    retryCount: number,
    isDlq: boolean
  ): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.status = isDlq ? 'DLQ_ROUTED' : 'FAILED';
      record.lastError = error;
      record.nextRetryAt = nextRetryAt;
      record.retryCount = retryCount;
      record.updatedAt = new Date();
    }
  }

  public async getRecordById(id: string): Promise<OutboxRecord | null> {
    return this.records.get(id) ?? null;
  }
}

export interface OutboxBatchResult {
  processedCount: number;
  successCount: number;
  failedCount: number;
  dlqCount: number;
}

export class OutboxPublisher {
  private storage: IOutboxStorage;
  private eventBus: EventBus;
  private dlqManager: DeadLetterQueueManager;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    storage: IOutboxStorage,
    eventBus: EventBus,
    dlqManager: DeadLetterQueueManager
  ) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.dlqManager = dlqManager;
  }

  /**
   * Helper to create a new OutboxRecord
   */
  public async queueEvent<T = Record<string, unknown>>(params: {
    eventType: string;
    payload: T;
    aggregateId: string;
    aggregateType: string;
    traceId?: string;
    maxRetries?: number;
  }): Promise<OutboxRecord<T>> {
    const record: OutboxRecord<T> = {
      id: uuidv4(),
      eventType: params.eventType,
      payload: params.payload,
      aggregateId: params.aggregateId,
      aggregateType: params.aggregateType,
      traceId: params.traceId ?? uuidv4(),
      status: 'PENDING',
      retryCount: 0,
      maxRetries: params.maxRetries ?? 5,
      nextRetryAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.storage.createRecord(record as unknown as OutboxRecord);
    logger.debug(
      {
        outboxId: record.id,
        eventType: record.eventType,
        aggregateId: record.aggregateId,
        traceId: record.traceId,
      },
      'Transactional outbox record queued'
    );
    return record;
  }

  /**
   * Publishes a single outbox record to the existing EventBus with retry & DLQ routing
   */
  public async publishRecord(record: OutboxRecord): Promise<boolean> {
    try {
      logger.info(
        {
          outboxId: record.id,
          eventType: record.eventType,
          traceId: record.traceId,
          attempt: record.retryCount + 1,
        },
        'Publishing transactional outbox event to EventBus'
      );

      // Re-use existing EventBus
      await this.eventBus.publish(
        record.eventType as any,
        record.payload as any,
        record.traceId
      );

      // Mark as successfully processed
      await this.storage.markProcessed(record.id);
      logger.info(
        { outboxId: record.id, eventType: record.eventType },
        'Outbox event successfully published and marked PROCESSED'
      );
      return true;
    } catch (err: any) {
      const nextAttempt = record.retryCount + 1;
      const isExhausted = nextAttempt >= record.maxRetries;

      logger.warn(
        {
          outboxId: record.id,
          eventType: record.eventType,
          attempt: nextAttempt,
          maxRetries: record.maxRetries,
          error: err.message,
        },
        'Failed to publish outbox event'
      );

      if (isExhausted) {
        // Move to existing DLQ subsystem
        await this.dlqManager.routeToDLQ(
          {
            eventId: record.id,
            traceId: record.traceId,
            eventName: record.eventType as any,
            timestamp: Date.now(),
            payload: record.payload as any,
          },
          err,
          nextAttempt,
          record.aggregateId
        );

        await this.storage.recordFailure(
          record.id,
          err.message,
          new Date(),
          nextAttempt,
          true
        );

        logger.error(
          { outboxId: record.id, eventType: record.eventType },
          'Outbox event exhausted retries and moved to Dead Letter Queue (DLQ_ROUTED)'
        );
      } else {
        // Compute exponential backoff with jitter
        const backoffMs = DeadLetterQueueManager.calculateBackoff(nextAttempt);
        const nextRetryAt = new Date(Date.now() + backoffMs);

        await this.storage.recordFailure(
          record.id,
          err.message,
          nextRetryAt,
          nextAttempt,
          false
        );

        logger.info(
          {
            outboxId: record.id,
            nextRetryAt: nextRetryAt.toISOString(),
            backoffMs,
          },
          'Outbox event scheduled for exponential retry'
        );
      }

      return false;
    }
  }

  /**
   * Processes a batch of pending/retryable outbox records
   */
  public async processPendingBatch(batchSize = 50): Promise<OutboxBatchResult> {
    const pendingRecords = await this.storage.fetchPendingRecords(batchSize);
    const result: OutboxBatchResult = {
      processedCount: pendingRecords.length,
      successCount: 0,
      failedCount: 0,
      dlqCount: 0,
    };

    for (const record of pendingRecords) {
      const success = await this.publishRecord(record);
      if (success) {
        result.successCount++;
      } else if (record.retryCount + 1 >= record.maxRetries) {
        result.dlqCount++;
      } else {
        result.failedCount++;
      }
    }

    return result;
  }

  /**
   * Starts background outbox publisher polling
   */
  public start(pollIntervalMs = 2000): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info({ pollIntervalMs }, 'Starting Transactional Outbox Publisher loop');

    const poll = async () => {
      if (!this.isRunning) return;
      try {
        await this.processPendingBatch();
      } catch (err: any) {
        logger.error({ error: err.message }, 'Error in Outbox Publisher polling cycle');
      } finally {
        if (this.isRunning) {
          this.pollTimer = setTimeout(poll, pollIntervalMs);
        }
      }
    };

    void poll();
  }

  /**
   * Stops background polling
   */
  public stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Transactional Outbox Publisher loop stopped');
  }
}
