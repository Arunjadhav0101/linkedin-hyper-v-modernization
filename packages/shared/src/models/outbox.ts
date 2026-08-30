export type OutboxStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'FAILED'
  | 'DLQ_ROUTED';

export interface OutboxRecord<T = Record<string, unknown>> {
  id: string;
  eventType: string;
  payload: T;
  aggregateId: string;
  aggregateType: string;
  traceId: string;
  status: OutboxStatus;
  retryCount: number;
  maxRetries: number;
  lastError?: string;
  nextRetryAt: Date;
  processedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
