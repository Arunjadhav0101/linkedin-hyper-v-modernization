import { DLQRecord, AppEvent } from '@shared/types';
import { logger } from '../observability/logger.js';
import { v4 as uuidv4 } from 'uuid';

export interface IDLQStorage {
  saveRecord(record: DLQRecord): Promise<void>;
  getPendingRecords(limit?: number): Promise<DLQRecord[]>;
  markReplayed(id: string): Promise<void>;
}

export class MemoryDLQStorage implements IDLQStorage {
  private records: Map<string, DLQRecord> = new Map();

  public async saveRecord(record: DLQRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  public async getPendingRecords(limit = 50): Promise<DLQRecord[]> {
    return Array.from(this.records.values())
      .filter((r) => !r.isReplayed)
      .slice(0, limit);
  }

  public async markReplayed(id: string): Promise<void> {
    const r = this.records.get(id);
    if (r) {
      r.isReplayed = true;
      r.replayedAt = new Date();
    }
  }
}

export class DeadLetterQueueManager {
  private storage: IDLQStorage;

  constructor(storage: IDLQStorage = new MemoryDLQStorage()) {
    this.storage = storage;
  }

  /**
   * Calculates exponential backoff with 20% jitter
   */
  public static calculateBackoff(retryCount: number, baseMs = 1000, maxMs = 60000): number {
    const exponential = Math.min(maxMs, baseMs * Math.pow(2, retryCount));
    const jitter = exponential * 0.2 * Math.random();
    return Math.round(exponential + jitter);
  }

  /**
   * Routes exhausted retry event to Dead-Letter Queue
   */
  public async routeToDLQ(
    event: AppEvent,
    error: Error,
    attempts: number,
    accountId: string
  ): Promise<DLQRecord> {
    const record: DLQRecord = {
      id: uuidv4(),
      originalEventId: event.eventId,
      traceId: event.traceId,
      eventName: event.eventName,
      accountId,
      payload: event.payload as Record<string, unknown>,
      errorName: error.name || 'UnknownError',
      errorMessage: error.message || 'Operation failed',
      errorStack: error.stack,
      retryAttempts: attempts,
      isReplayed: false,
      createdAt: new Date(),
    };

    await this.storage.saveRecord(record);
    logger.error(
      {
        dlqId: record.id,
        originalEventId: record.originalEventId,
        eventName: record.eventName,
        accountId: record.accountId,
        error: record.errorMessage,
      },
      'Event routed to Dead-Letter Queue after exceeding max retries'
    );

    return record;
  }

  public async getUnprocessedDLQMessages(limit = 100): Promise<DLQRecord[]> {
    return this.storage.getPendingRecords(limit);
  }

  public async markMessageReplayed(dlqId: string): Promise<void> {
    await this.storage.markReplayed(dlqId);
    logger.info({ dlqId }, 'DLQ message marked as successfully replayed');
  }
}
