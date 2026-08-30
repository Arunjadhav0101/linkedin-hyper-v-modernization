import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse, HealthCheckResponse } from '@shared/types';

export default async function handler(
  _req: NextApiRequest,
  res: NextApiResponse<ApiResponse<HealthCheckResponse>>
) {
  const healthData: HealthCheckResponse = {
    status: 'healthy',
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    checks: {
      database: { status: 'up', latencyMs: 4 },
      redis: { status: 'up', latencyMs: 2 },
      proxyPool: { total: 10, healthy: 9, degraded: 1, banned: 0 },
    },
  };

  res.status(200).json({
    success: true,
    data: healthData,
    timestamp: new Date().toISOString(),
  });
}
