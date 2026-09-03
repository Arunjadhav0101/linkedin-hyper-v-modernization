import { OutboxRecord } from '@shared/types';
import { IOutboxStorage } from '../events/OutboxPublisher.js';
import { prisma } from '../lib/prisma.js';

export class PrismaOutboxStorage implements IOutboxStorage {
  public async createRecord(record: OutboxRecord): Promise<OutboxRecord> {
    const row = await prisma.outboxEvent.create({
      data: {
        id: record.id,
        eventType: record.eventType,
        payload: record.payload as any,
        aggregateId: record.aggregateId,
        aggregateType: record.aggregateType,
        traceId: record.traceId,
        status: record.status as any,
        retryCount: record.retryCount,
        maxRetries: record.maxRetries,
        lastError: record.lastError,
        nextRetryAt: record.nextRetryAt,
        processedAt: record.processedAt,
        createdAt: record.createdAt,
      },
    });

    return {
      id: row.id,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
      traceId: row.traceId,
      status: row.status as any,
      retryCount: row.retryCount,
      maxRetries: row.maxRetries,
      lastError: row.lastError ?? undefined,
      nextRetryAt: row.nextRetryAt,
      processedAt: row.processedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  public async fetchPendingRecords(limit = 50): Promise<OutboxRecord[]> {
    const now = new Date();
    const rows = await prisma.outboxEvent.findMany({
      where: {
        OR: [
          { status: 'PENDING' },
          {
            status: { in: ['FAILED', 'PROCESSING'] },
            nextRetryAt: { lte: now },
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
      traceId: row.traceId,
      status: row.status as any,
      retryCount: row.retryCount,
      maxRetries: row.maxRetries,
      lastError: row.lastError ?? undefined,
      nextRetryAt: row.nextRetryAt,
      processedAt: row.processedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  public async markProcessed(id: string): Promise<void> {
    await prisma.outboxEvent.update({
      where: { id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
      },
    });
  }

  public async recordFailure(
    id: string,
    error: string,
    nextRetryAt: Date,
    retryCount: number,
    isDlq: boolean
  ): Promise<void> {
    await prisma.outboxEvent.update({
      where: { id },
      data: {
        status: isDlq ? 'DLQ_ROUTED' : 'FAILED',
        lastError: error,
        nextRetryAt,
        retryCount,
      },
    });
  }

  public async getRecordById(id: string): Promise<OutboxRecord | null> {
    const row = await prisma.outboxEvent.findUnique({
      where: { id },
    });

    if (!row) return null;

    return {
      id: row.id,
      eventType: row.eventType,
      payload: row.payload as Record<string, unknown>,
      aggregateId: row.aggregateId,
      aggregateType: row.aggregateType,
      traceId: row.traceId,
      status: row.status as any,
      retryCount: row.retryCount,
      maxRetries: row.maxRetries,
      lastError: row.lastError ?? undefined,
      nextRetryAt: row.nextRetryAt,
      processedAt: row.processedAt ?? undefined,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
