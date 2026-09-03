import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';
import { randomUUID } from 'crypto';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<any>>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
      timestamp: new Date().toISOString(),
    });
  }

  const { accountId, limit = 20 } = req.body || {};

  if (!accountId) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMETERS', message: 'accountId is required for synchronization' },
      timestamp: new Date().toISOString(),
    });
  }

  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    return res.status(404).json({
      success: false,
      error: { code: 'ACCOUNT_NOT_FOUND', message: `Account '${accountId}' not found` },
      timestamp: new Date().toISOString(),
    });
  }

  const traceId = randomUUID();
  const job = await prisma.automationJob.create({
    data: {
      id: randomUUID(),
      traceId,
      accountId,
      type: 'SYNC_MESSAGES',
      payload: { limit: parseInt(limit, 10) || 20 },
      priority: 1,
      status: 'QUEUED',
      scheduledFor: new Date(),
    },
  });

  return res.status(202).json({
    success: true,
    data: {
      jobId: job.id,
      traceId: job.traceId,
      accountId: job.accountId,
      type: job.type,
      status: job.status,
      scheduledFor: job.scheduledFor,
    },
    timestamp: new Date().toISOString(),
    traceId,
  });
}
