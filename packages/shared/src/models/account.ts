export type AccountStatus =
  | 'ACTIVE'
  | 'WARMING'
  | 'RESTRICTED'
  | 'RATE_LIMITED'
  | 'CHALLENGE_REQUIRED'
  | 'DISABLED';

export type AccountAuthStatus =
  | 'NOT_CONFIGURED'
  | 'AUTHORIZED'
  | 'SESSION_INVALID'
  | 'DISABLED';

export interface AccountVelocityLimits {
  hourlyActionLimit: number;
  dailyActionLimit: number;
  hourlyConnectionLimit: number;
  dailyConnectionLimit: number;
  hourlyMessageLimit: number;
  dailyMessageLimit: number;
}

export interface LinkedInAccount {
  id: string;
  email: string;
  linkedinId?: string;
  publicIdentifier?: string;
  name?: string;
  status: AccountStatus;
  authStatus?: AccountAuthStatus;
  proxySessionId?: string;
  assignedProxyId?: string;
  cookies?: Record<string, string>;
  warmupStartDate?: Date;
  isWarmedUp: boolean;
  limits: AccountVelocityLimits;
  lastActionTimestamp?: Date;
  createdAt: Date;
  updatedAt: Date;
}
