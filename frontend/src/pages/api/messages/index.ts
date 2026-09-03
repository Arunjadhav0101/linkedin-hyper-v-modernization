import type { NextApiRequest, NextApiResponse } from 'next';
import { ApiResponse } from '@shared/types';
import { prisma } from '../../../lib/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ApiResponse<any>>
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    return res.status(405).json({
      success: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `Method ${req.method} Not Allowed` },
      timestamp: new Date().toISOString(),
    });
  }

  const { accountId, conversationId, limit = '50' } = req.query;

  const whereClause: any = {};
  if (accountId && typeof accountId === 'string') {
    whereClause.accountId = accountId;
  }
  if (conversationId && typeof conversationId === 'string') {
    whereClause.conversationId = conversationId;
  }

  const take = Math.min(parseInt(limit as string, 10) || 50, 100);

  const messages = await prisma.chatMessage.findMany({
    where: whereClause,
    orderBy: { sentAt: 'desc' },
    take,
    include: {
      account: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
      conversation: {
        select: {
          id: true,
          remoteConversationId: true,
          lastMessageSnippet: true,
        },
      },
    },
  });

  return res.status(200).json({
    success: true,
    data: messages.map((m) => ({
      id: m.id,
      accountId: m.accountId,
      accountEmail: m.account.email,
      accountName: m.account.name,
      conversationId: m.conversation.remoteConversationId,
      remoteMessageId: m.remoteMessageId,
      senderId: m.senderId,
      senderName: m.senderName,
      recipientId: m.recipientId,
      recipientName: m.recipientName,
      content: m.content,
      direction: m.direction,
      idempotencyKey: m.idempotencyKey,
      syncStatus: m.syncStatus,
      sentAt: m.sentAt,
      syncedAt: m.syncedAt,
    })),
    timestamp: new Date().toISOString(),
  });
}
