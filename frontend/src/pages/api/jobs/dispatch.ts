import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const dispatchSchema = z.object({
  accountId: z.string().min(1, 'Account ID is required'),
  type: z.enum(['SEND_MESSAGE', 'SEND_CONNECTION_REQUEST', 'SYNC_MESSAGES']),
  payload: z.record(z.any()),
  priority: z.number().int().default(0),
});

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

  const parseResult = dispatchSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', '),
      },
      timestamp: new Date().toISOString(),
    });
  }

  const { accountId, type, payload, priority } = parseResult.data;

  // Verify account exists in database
  const account = await prisma.linkedInAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    return res.status(404).json({
      success: false,
      error: { code: 'ACCOUNT_NOT_FOUND', message: `LinkedIn Account with ID '${accountId}' was not found` },
      timestamp: new Date().toISOString(),
    });
  }

  // Pre-flight validation: Ensure account has an authorized session before creating jobs
  const cookies = (account.cookies as Record<string, string>) || {};
  const liAt = (cookies.li_at || '').trim();
  if (!liAt || liAt.length < 50) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'ACCOUNT_NOT_AUTHORIZED',
        message: 'Account is not authorized for live actions. Please configure a valid session cookie in the Accounts tab.',
      },
      timestamp: new Date().toISOString(),
    });
  }

  // Create real AutomationJob in PostgreSQL
  const traceId = randomUUID();
  const job = await prisma.automationJob.create({
    data: {
      id: randomUUID(),
      traceId,
      accountId,
      type,
      payload,
      priority,
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
      payload: job.payload,
      status: job.status,
      priority: job.priority,
      retryCount: job.retryCount,
      scheduledFor: job.scheduledFor,
      createdAt: job.createdAt,
    },
    timestamp: new Date().toISOString(),
    traceId,
  });
}
