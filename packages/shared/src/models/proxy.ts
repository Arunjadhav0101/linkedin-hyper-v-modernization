export type ProxyStatus = 'HEALTHY' | 'DEGRADED' | 'BANNED' | 'INACTIVE';
export type ProxyProtocol = 'HTTP' | 'HTTPS' | 'SOCKS5';

export interface ProxyNode {
  id: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  username?: string;
  password?: string;
  countryCode?: string;
  isResidential: boolean;
  status: ProxyStatus;
  healthScore: number; // 0 - 100
  latencyMs: number;
  consecutiveFailures: number;
  lastCheckedAt?: Date;
  bannedUntil?: Date;
  assignedAccountId?: string;
  createdAt: Date;
  updatedAt: Date;
}
