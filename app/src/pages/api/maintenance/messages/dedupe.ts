import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse, MessageDedupeRequest, MessageDedupeResponse } from '@shared/types';
import { prisma } from '@/lib/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<MessageDedupeResponse>>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
      timestamp: new Date().toISOString(),
    });
  }

  const startTime = Date.now();
  const { accountId, dryRun = false }: MessageDedupeRequest = req.body || {};

  try {
    // 1. Fetch messages matching filter
    const messages = await prisma.chatMessage.findMany({
      where: accountId ? { accountId } : undefined,
      select: { id: true, idempotencyKey: true, accountId: true, sentAt: true },
      orderBy: { sentAt: 'asc' },
    });

    const seenKeys = new Map<string, string>(); // idempotencyKey -> originalId
    const duplicateIds: string[] = [];

    for (const msg of messages) {
      if (seenKeys.has(msg.idempotencyKey)) {
        duplicateIds.push(msg.id);
      } else {
        seenKeys.set(msg.idempotencyKey, msg.id);
      }
    }

    let deletedCount = 0;
    if (!dryRun && duplicateIds.length > 0) {
      // 2. Transactionally delete duplicates
      const result = await prisma.chatMessage.deleteMany({
        where: {
          id: { in: duplicateIds },
        },
      });
      deletedCount = result.count;
    }

    const durationMs = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      data: {
        scannedCount: messages.length,
        duplicateCount: duplicateIds.length,
        deletedCount,
        durationMs,
        duplicateIds,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'DEDUPLICATION_FAILED',
        message: err.message || 'Failed to execute deduplication transaction',
      },
      timestamp: new Date().toISOString(),
    });
  }
}
