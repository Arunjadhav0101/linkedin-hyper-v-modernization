export type MessageDirection = 'INBOUND' | 'OUTBOUND';
export type MessageSyncStatus = 'SYNCED' | 'PENDING' | 'FAILED' | 'DUPLICATE';

export interface ChatMessage {
  id: string;
  accountId: string;
  conversationId: string;
  remoteMessageId: string;
  senderId: string;
  senderName?: string;
  recipientId: string;
  recipientName?: string;
  content: string;
  direction: MessageDirection;
  idempotencyKey: string;
  syncStatus: MessageSyncStatus;
  sentAt: Date;
  syncedAt: Date;
}

export interface Conversation {
  id: string;
  accountId: string;
  remoteConversationId: string;
  participantIds: string[];
  lastMessageSnippet?: string;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
