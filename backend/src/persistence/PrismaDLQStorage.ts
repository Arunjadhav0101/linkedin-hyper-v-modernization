import { DLQRecord } from '@shared/types';
import { IDLQStorage } from '../events/DeadLetterQueue.js';
import { prisma } from '../lib/prisma.js';

export class PrismaDLQStorage implements IDLQStorage {
  public async saveRecord(record: DLQRecord): Promise<void> {
    await prisma.deadLetterQueue.create({
      data: {
        id: record.id,
        originalEventId: record.originalEventId,
        traceId: record.traceId,
        eventName: record.eventName,
        accountId: record.accountId,
        payload: record.payload as any,
        errorName: record.errorName,
        errorMessage: record.errorMessage,
        errorStack: record.errorStack,
        retryAttempts: record.retryAttempts,
        isReplayed: record.isReplayed,
        createdAt: record.createdAt,
      },
    });
  }

  public async getPendingRecords(limit = 50): Promise<DLQRecord[]> {
    const rows = await prisma.deadLetterQueue.findMany({
      where: { isReplayed: false },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((r) => ({
      id: r.id,
      originalEventId: r.originalEventId,
      traceId: r.traceId,
      eventName: r.eventName,
      accountId: r.accountId,
      payload: r.payload as Record<string, unknown>,
      errorName: r.errorName,
      errorMessage: r.errorMessage,
      errorStack: r.errorStack ?? undefined,
      retryAttempts: r.retryAttempts,
      isReplayed: r.isReplayed,
      replayedAt: r.replayedAt ?? undefined,
      createdAt: r.createdAt,
    }));
  }

  public async markReplayed(id: string): Promise<void> {
    await prisma.deadLetterQueue.update({
      where: { id },
      data: {
        isReplayed: true,
        replayedAt: new Date(),
      },
    });
  }
}
