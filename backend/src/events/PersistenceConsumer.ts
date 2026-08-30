import { AppEvent, ChatMessage } from '@shared/types';
import { logger } from '../observability/logger.js';
import crypto from 'crypto';

export interface IMessageRepository {
  findMessageByIdempotencyKey(key: string): Promise<ChatMessage | null>;
  saveMessage(message: ChatMessage): Promise<ChatMessage>;
  deduplicateMessages(accountId?: string): Promise<{ deletedCount: number; duplicateIds: string[] }>;
}

export class MemoryMessageRepository implements IMessageRepository {
  private messages: Map<string, ChatMessage> = new Map();

  public async findMessageByIdempotencyKey(key: string): Promise<ChatMessage | null> {
    for (const msg of this.messages.values()) {
      if (msg.idempotencyKey === key) return msg;
    }
    return null;
  }

  public async saveMessage(message: ChatMessage): Promise<ChatMessage> {
    this.messages.set(message.id, { ...message });
    return message;
  }

  public async deduplicateMessages(accountId?: string): Promise<{ deletedCount: number; duplicateIds: string[] }> {
    const seenKeys = new Set<string>();
    const duplicateIds: string[] = [];

    for (const [id, msg] of Array.from(this.messages.entries())) {
      if (accountId && msg.accountId !== accountId) continue;
      if (seenKeys.has(msg.idempotencyKey)) {
        duplicateIds.push(id);
        this.messages.delete(id);
      } else {
        seenKeys.add(msg.idempotencyKey);
      }
    }

    return { deletedCount: duplicateIds.length, duplicateIds };
  }
}

export class PersistenceConsumer {
  private repository: IMessageRepository;

  constructor(repository: IMessageRepository = new MemoryMessageRepository()) {
    this.repository = repository;
  }

  /**
   * Generates a deterministic SHA256 idempotency key
   */
  public static generateIdempotencyKey(
    accountId: string,
    conversationId: string,
    remoteMessageId: string
  ): string {
    const raw = `${accountId}:${conversationId}:${remoteMessageId}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Idempotent message ingestion handler
   */
  public async handleMessageReceived(event: AppEvent<'MESSAGE_RECEIVED'>): Promise<{ saved: boolean; isDuplicate: boolean }> {
    const { accountId, conversationId, remoteMessageId, senderId, senderName, recipientId, content, sentAt } =
      event.payload;

    const idempotencyKey = PersistenceConsumer.generateIdempotencyKey(
      accountId,
      conversationId,
      remoteMessageId
    );

    const existing = await this.repository.findMessageByIdempotencyKey(idempotencyKey);
    if (existing) {
      logger.info(
        { traceId: event.traceId, idempotencyKey, remoteMessageId },
        'Duplicate message event detected and safely discarded'
      );
      return { saved: false, isDuplicate: true };
    }

    const message: ChatMessage = {
      id: crypto.randomUUID(),
      accountId,
      conversationId,
      remoteMessageId,
      senderId,
      senderName,
      recipientId,
      content,
      direction: senderId === accountId ? 'OUTBOUND' : 'INBOUND',
      idempotencyKey,
      syncStatus: 'SYNCED',
      sentAt: new Date(sentAt),
      syncedAt: new Date(),
    };

    await this.repository.saveMessage(message);
    logger.info({ traceId: event.traceId, messageId: message.id, idempotencyKey }, 'Message ingested idempotently');
    return { saved: true, isDuplicate: false };
  }
}
