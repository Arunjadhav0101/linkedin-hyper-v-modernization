export type EventPayloadMap = {
  'MESSAGES_SYNC_REQUESTED': { accountId: string; since?: string };
  'MESSAGE_RECEIVED': {
    accountId: string;
    conversationId: string;
    remoteMessageId: string;
    senderId: string;
    senderName?: string;
    recipientId: string;
    content: string;
    sentAt: string;
  };
  'MESSAGE_SENT': {
    accountId: string;
    conversationId: string;
    remoteMessageId: string;
    recipientId: string;
    content: string;
  };
  'CONNECTION_REQUEST_SENT': {
    accountId: string;
    targetProfileId: string;
    customNote?: string;
  };
  'AUTOMATION_JOB_CREATED': {
    jobId: string;
    accountId: string;
    type: string;
    payload: Record<string, unknown>;
  };
  'AUTOMATION_JOB_COMPLETED': {
    jobId: string;
    accountId: string;
    type: string;
    result?: Record<string, unknown>;
  };
  'AUTOMATION_JOB_FAILED': {
    jobId: string;
    accountId: string;
    type: string;
    error: string;
    retryCount: number;
  };
  'RATE_LIMIT_TRIGGERED': {
    accountId: string;
    endpoint: string;
    retryAfterMs: number;
    proxyIp?: string;
    statusCode: number;
  };
  'PROXY_ROTATED': {
    accountId: string;
    oldProxyId?: string;
    newProxyId: string;
    reason: string;
  };
  'ACCOUNT_STATUS_CHANGED': {
    accountId: string;
    previousStatus: string;
    newStatus: string;
    reason: string;
  };
  'DLQ_MESSAGE_ROUTED': {
    dlqId: string;
    originalEventId: string;
    eventName: string;
    error: string;
  };
};

export type EventName = keyof EventPayloadMap;

export interface AppEvent<K extends EventName = EventName> {
  eventId: string;
  traceId: string;
  eventName: K;
  timestamp: number;
  payload: EventPayloadMap[K];
}

export interface IPCMessage<T = unknown> {
  id: string;
  channel: string;
  sender: string;
  traceId: string;
  data: T;
  sentAt: number;
}
