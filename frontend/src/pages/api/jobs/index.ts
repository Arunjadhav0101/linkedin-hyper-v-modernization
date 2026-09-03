import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<any>>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
      timestamp: new Date().toISOString(),
    });
  }

  const { accountId, status, limit = '50' } = req.query;

  const whereClause: any = {};
  if (accountId && typeof accountId === 'string') {
    whereClause.accountId = accountId;
  }
  if (status && typeof status === 'string') {
    whereClause.status = status;
  }

  const take = Math.min(parseInt(limit as string, 10) || 50, 100);

  const jobs = await prisma.automationJob.findMany({
    where: whereClause,
    orderBy: { createdAt: 'desc' },
    take,
    include: {
      account: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });

  return res.status(200).json({
    success: true,
    data: jobs.map((j) => ({
      id: j.id,
      jobId: j.id,
      traceId: j.traceId,
      accountId: j.accountId,
      accountEmail: j.account.email,
      accountName: j.account.name,
      type: j.type,
      payload: j.payload,
      priority: j.priority,
      status: j.status,
      retryCount: j.retryCount,
      maxRetries: j.maxRetries,
      scheduledFor: j.scheduledFor,
      startedAt: j.startedAt,
      completedAt: j.completedAt,
      errorMessage: j.errorMessage,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    })),
    timestamp: new Date().toISOString(),
  });
}
