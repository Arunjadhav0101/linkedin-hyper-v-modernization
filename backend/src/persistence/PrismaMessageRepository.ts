import { ChatMessage } from '@shared/types';
import { IMessageRepository } from '../events/PersistenceConsumer.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../observability/logger.js';

export class PrismaMessageRepository implements IMessageRepository {
  public async findMessageByIdempotencyKey(key: string): Promise<ChatMessage | null> {
    const record = await prisma.chatMessage.findUnique({
      where: { idempotencyKey: key },
    });

    if (!record) return null;

    return {
      id: record.id,
      accountId: record.accountId,
      conversationId: record.conversationId,
      remoteMessageId: record.remoteMessageId,
      senderId: record.senderId,
      senderName: record.senderName ?? undefined,
      recipientId: record.recipientId,
      recipientName: record.recipientName ?? undefined,
      content: record.content,
      direction: record.direction,
      idempotencyKey: record.idempotencyKey,
      syncStatus: record.syncStatus,
      sentAt: record.sentAt,
      syncedAt: record.syncedAt,
    };
  }

  public async saveMessage(message: ChatMessage): Promise<ChatMessage> {
    return await prisma.$transaction(async (tx) => {
      // 1. Ensure conversation exists for this account & remote conversation ID
      const conversation = await tx.conversation.upsert({
        where: {
          accountId_remoteConversationId: {
            accountId: message.accountId,
            remoteConversationId: message.conversationId,
          },
        },
        update: {
          lastMessageSnippet: message.content.slice(0, 200),
          lastActivityAt: message.sentAt,
        },
        create: {
          accountId: message.accountId,
          remoteConversationId: message.conversationId,
          participantIds: [message.senderId, message.recipientId].filter(Boolean),
          lastMessageSnippet: message.content.slice(0, 200),
          lastActivityAt: message.sentAt,
        },
      });

      // 2. Persist chat message with FK to conversation
      const record = await tx.chatMessage.create({
        data: {
          id: message.id,
          accountId: message.accountId,
          conversationId: conversation.id,
          remoteMessageId: message.remoteMessageId,
          senderId: message.senderId,
          senderName: message.senderName,
          recipientId: message.recipientId,
          recipientName: message.recipientName,
          content: message.content,
          direction: message.direction,
          idempotencyKey: message.idempotencyKey,
          syncStatus: message.syncStatus,
          sentAt: message.sentAt,
          syncedAt: message.syncedAt,
        },
      });

      logger.info(
        {
          messageId: record.id,
          conversationId: conversation.id,
          idempotencyKey: record.idempotencyKey,
          accountId: record.accountId,
        },
        'Message persisted to PostgreSQL successfully'
      );

      return {
        id: record.id,
        accountId: record.accountId,
        conversationId: record.conversationId,
        remoteMessageId: record.remoteMessageId,
        senderId: record.senderId,
        senderName: record.senderName ?? undefined,
        recipientId: record.recipientId,
        recipientName: record.recipientName ?? undefined,
        content: record.content,
        direction: record.direction,
        idempotencyKey: record.idempotencyKey,
        syncStatus: record.syncStatus,
        sentAt: record.sentAt,
        syncedAt: record.syncedAt,
      };
    });
  }

  public async deduplicateMessages(accountId?: string): Promise<{ deletedCount: number; duplicateIds: string[] }> {
    const whereClause = accountId ? { accountId } : {};
    const allMessages = await prisma.chatMessage.findMany({
      where: whereClause,
      orderBy: { sentAt: 'asc' },
      select: { id: true, idempotencyKey: true },
    });

    const seenKeys = new Set<string>();
    const duplicateIds: string[] = [];

    for (const msg of allMessages) {
      if (seenKeys.has(msg.idempotencyKey)) {
        duplicateIds.push(msg.id);
      } else {
        seenKeys.add(msg.idempotencyKey);
      }
    }

    if (duplicateIds.length > 0) {
      await prisma.chatMessage.deleteMany({
        where: { id: { in: duplicateIds } },
      });
      logger.warn({ count: duplicateIds.length, duplicateIds }, 'Cleaned duplicate messages from PostgreSQL');
    }

    return { deletedCount: duplicateIds.length, duplicateIds };
  }
}
