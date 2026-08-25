import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse, ProxyNode } from '@shared/types';

const MOCK_PROXIES: ProxyNode[] = [
  {
    id: 'prx-01',
    host: '198.51.100.24',
    port: 8080,
    protocol: 'HTTP',
    countryCode: 'US',
    isResidential: true,
    status: 'HEALTHY',
    healthScore: 98,
    latencyMs: 140,
    consecutiveFailures: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'prx-02',
    host: '198.51.100.25',
    port: 8080,
    protocol: 'HTTP',
    countryCode: 'US',
    isResidential: true,
    status: 'HEALTHY',
    healthScore: 94,
    latencyMs: 180,
    consecutiveFailures: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'prx-03',
    host: '198.51.100.26',
    port: 8080,
    protocol: 'HTTP',
    countryCode: 'GB',
    isResidential: true,
    status: 'DEGRADED',
    healthScore: 45,
    latencyMs: 820,
    consecutiveFailures: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<ProxyNode[]>>
) {
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      data: MOCK_PROXIES,
      timestamp: new Date().toISOString(),
    });
  }

  res.setHeader('Allow', ['GET']);
  return res.status(405).json({
    success: false,
    error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
    timestamp: new Date().toISOString(),
  });
}
