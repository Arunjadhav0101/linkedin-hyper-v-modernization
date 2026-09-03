import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';

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

  const { action } = req.body || {};

  try {
    if (action === 'CLEAR_DLQ') {
      await prisma.deadLetterQueue.deleteMany({});
      await prisma.automationJob.updateMany({
        where: { status: 'DLQ_ROUTED' },
        data: { status: 'FAILED' },
      });
    } else if (action === 'RETRY_DLQ') {
      await prisma.automationJob.updateMany({
        where: { status: { in: ['DLQ_ROUTED', 'FAILED'] } },
        data: {
          status: 'QUEUED',
          retryCount: 0,
          errorMessage: null,
          scheduledFor: new Date(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        message: 'Maintenance operation executed successfully',
        action: action || 'DEFAULT',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: err.message },
      timestamp: new Date().toISOString(),
    });
  }
}
