import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse, DispatchJobRequest, AutomationTask } from '@shared/types';
import { randomUUID } from 'crypto';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<AutomationTask>>
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
      timestamp: new Date().toISOString(),
    });
  }

  const { accountId, type, payload, priority = 0 }: DispatchJobRequest = req.body || {};

  if (!accountId || !type) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMETERS', message: 'accountId and type are required' },
      timestamp: new Date().toISOString(),
    });
  }

  const job: AutomationTask = {
    jobId: randomUUID(),
    traceId: randomUUID(),
    accountId,
    type: type as any,
    payload: payload || {},
    priority,
    retryCount: 0,
    maxRetries: 5,
    status: 'QUEUED',
    scheduledFor: new Date(),
    createdAt: new Date(),
  };

  return res.status(202).json({
    success: true,
    data: job,
    timestamp: new Date().toISOString(),
    traceId: job.traceId,
  });
}
