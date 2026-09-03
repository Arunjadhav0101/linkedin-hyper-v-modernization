export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
  traceId?: string;
}

export interface MessageDedupeRequest {
  accountId?: string;
  dryRun?: boolean;
  batchSize?: number;
}

export interface MessageDedupeResponse {
  scannedCount: number;
  duplicateCount: number;
  deletedCount: number;
  durationMs: number;
  duplicateIds: string[];
}

export interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptimeSeconds: number;
  timestamp: string;
  version: string;
  checks: {
    database: { status: 'up' | 'down'; latencyMs?: number };
    redis: { status: 'up' | 'down'; latencyMs?: number };
    proxyPool: { total: number; healthy: number; degraded: number; banned: number };
  };
}

export interface DispatchJobRequest {
  accountId: string;
  type: 'SEND_MESSAGE' | 'SEND_CONNECTION_REQUEST' | 'SYNC_MESSAGES' | string;
  payload: Record<string, unknown>;
  priority?: number;
}

export interface SendMessagePayload {
  recipientId: string;
  recipientName?: string;
  conversationId?: string;
  content: string;
}

export interface SendConnectionRequestPayload {
  targetProfileId: string;
  customNote?: string;
}

export interface SyncMessagesPayload {
  since?: string;
  limit?: number;
}

export interface CreateAccountDTO {
  email: string;
  name?: string;
  linkedinId?: string;
  cookies?: {
    li_at?: string;
    JSESSIONID?: string;
    [key: string]: string | undefined;
  };
  assignedProxyId?: string;
}
