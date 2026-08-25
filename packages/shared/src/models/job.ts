export type JobType =
  | 'SYNC_MESSAGES'
  | 'SEND_MESSAGE'
  | 'SEND_CONNECTION_REQUEST'
  | 'PROFILE_VIEW'
  | 'HEALTH_CHECK'
  | 'WARMUP_TICK';

export type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RATE_LIMITED'
  | 'DLQ_ROUTED'
  | 'CANCELLED';

export interface AutomationTask<T = Record<string, unknown>> {
  jobId: string;
  traceId: string;
  accountId: string;
  type: JobType;
  payload: T;
  priority: number;
  retryCount: number;
  maxRetries: number;
  status: JobStatus;
  scheduledFor: Date;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
  createdAt: Date;
}
