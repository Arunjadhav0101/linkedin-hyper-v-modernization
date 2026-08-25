export interface DLQRecord {
  id: string;
  originalEventId: string;
  traceId: string;
  eventName: string;
  accountId: string;
  payload: Record<string, unknown>;
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  retryAttempts: number;
  isReplayed: boolean;
  replayedAt?: Date;
  createdAt: Date;
}
