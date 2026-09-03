import { PrismaClient } from '@prisma/client';
import { EventBus } from '../events/EventBus.js';
import { VoyagerClient } from '../automation/VoyagerClient.js';
import { DistributedLock } from '../lock/DistributedLock.js';
import { CircuitBreaker } from '../circuit/CircuitBreaker.js';
import { DeadLetterQueueManager } from '../events/DeadLetterQueue.js';
import { PersistenceConsumer } from '../events/PersistenceConsumer.js';
import { logger } from '../observability/logger.js';
import { LinkedInAccount } from '@shared/types';

export class JobProcessor {
  private prisma: PrismaClient;
  private eventBus: EventBus;
  private voyagerClient: VoyagerClient;
  private lock: DistributedLock;
  private circuitBreaker: CircuitBreaker;
  private dlqManager: DeadLetterQueueManager;
  private persistenceConsumer: PersistenceConsumer;

  constructor(
    prisma: PrismaClient,
    eventBus: EventBus,
    voyagerClient: VoyagerClient,
    lock: DistributedLock,
    circuitBreaker: CircuitBreaker,
    dlqManager: DeadLetterQueueManager,
    persistenceConsumer: PersistenceConsumer
  ) {
    this.prisma = prisma;
    this.eventBus = eventBus;
    this.voyagerClient = voyagerClient;
    this.lock = lock;
    this.circuitBreaker = circuitBreaker;
    this.dlqManager = dlqManager;
    this.persistenceConsumer = persistenceConsumer;
  }

  /**
   * Fetches and processes the next pending or retrying job
   */
  public async processNextPendingJob(): Promise<boolean> {
    const now = new Date();

    // Look for pending QUEUED jobs or FAILED jobs whose backoff scheduledFor has arrived
    const job = await this.prisma.automationJob.findFirst({
      where: {
        OR: [
          { status: 'QUEUED' },
          {
            status: 'FAILED',
            retryCount: { lt: 5 },
            scheduledFor: { lte: now },
          },
        ],
      },
      orderBy: [{ priority: 'desc' }, { scheduledFor: 'asc' }],
    });

    if (!job) {
      return false;
    }

    // Try to acquire distributed lock for this account
    const lockResource = `account_${job.accountId}`;
    const acquired = await this.lock.acquire(lockResource, { ttlMs: 15000 });

    if (!acquired) {
      logger.debug({ accountId: job.accountId, jobId: job.id }, 'Account is currently locked by another worker');
      return false;
    }

    try {
      await this.executeJob(job);
      return true;
    } finally {
      await this.lock.release(lockResource);
    }
  }

  /**
   * Executes a single automation job through state transitions and real LinkedIn integration
   */
  public async executeJob(job: any): Promise<void> {
    logger.info({ jobId: job.id, action: job.type, accountId: job.accountId }, 'Transitioning job status to RUNNING');

    // 1. Transition to RUNNING
    await this.prisma.automationJob.update({
      where: { id: job.id },
      data: {
        status: 'RUNNING',
        startedAt: new Date(),
        errorMessage: null,
      },
    });

    // 2. Load managed account from PostgreSQL
    const accountRecord = await this.prisma.linkedInAccount.findUnique({
      where: { id: job.accountId },
      include: { assignedProxy: true },
    });

    if (!accountRecord) {
      const err = `LinkedIn account '${job.accountId}' was not found in database`;
      logger.error({ jobId: job.id, accountId: job.accountId }, err);
      await this.markJobFailed(job, new Error(err), false);
      return;
    }

    const account: LinkedInAccount = {
      id: accountRecord.id,
      email: accountRecord.email,
      linkedinId: accountRecord.linkedinId ?? undefined,
      publicIdentifier: accountRecord.publicIdentifier ?? undefined,
      name: accountRecord.name ?? undefined,
      status: accountRecord.status as any,
      proxySessionId: accountRecord.proxySessionId ?? undefined,
      assignedProxyId: accountRecord.assignedProxyId ?? undefined,
      cookies: (accountRecord.cookies as Record<string, string>) ?? {},
      warmupStartDate: accountRecord.warmupStartDate,
      isWarmedUp: accountRecord.isWarmedUp,
      limits: {
        hourlyActionLimit: accountRecord.hourlyActionLimit,
        dailyActionLimit: accountRecord.dailyActionLimit,
        hourlyConnectionLimit: accountRecord.hourlyConnectionLimit,
        dailyConnectionLimit: accountRecord.dailyConnectionLimit,
        hourlyMessageLimit: accountRecord.hourlyMessageLimit,
        dailyMessageLimit: accountRecord.dailyMessageLimit,
      },
      lastActionTimestamp: accountRecord.lastActionTimestamp ?? undefined,
      createdAt: accountRecord.createdAt,
      updatedAt: accountRecord.updatedAt,
    };

    try {
      const payload = (job.payload as Record<string, any>) || {};

      switch (job.type) {
        case 'SEND_MESSAGE':
          await this.handleSendMessage(job, account, payload);
          break;

        case 'SEND_CONNECTION_REQUEST':
          await this.handleSendConnectionRequest(job, account, payload);
          break;

        case 'SYNC_MESSAGES':
          await this.handleMessageSync(job, account, payload);
          break;

        default:
          throw new Error(`Unhandled automation job type: ${job.type}`);
      }

      // 3. Mark COMPLETED on confirmed success
      await this.prisma.automationJob.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          errorMessage: null,
        },
      });

      await this.eventBus.publish(
        'AUTOMATION_JOB_COMPLETED',
        {
          jobId: job.id,
          accountId: job.accountId,
          type: job.type,
          result: { completedAt: new Date().toISOString() },
        },
        job.traceId
      );

      logger.info({ jobId: job.id, action: job.type }, 'Automation job successfully completed');
    } catch (err: any) {
      await this.markJobFailed(job, err, true);
    }
  }

  /**
   * Real handler for SEND_MESSAGE
   */
  private async handleSendMessage(job: any, account: LinkedInAccount, payload: Record<string, any>): Promise<void> {
    const { recipientId, content, conversationId } = payload;

    if (!recipientId || !content) {
      throw new Error("Missing required payload fields: 'recipientId' and 'content' are required for SEND_MESSAGE");
    }

    // Execute via Circuit Breaker & Real Voyager HTTP client
    const result = await this.circuitBreaker.execute(() =>
      this.voyagerClient.sendMessage(account, recipientId, content, conversationId)
    );

    // Persist outbound chat message into PostgreSQL
    const idempotencyKey = PersistenceConsumer.generateIdempotencyKey(
      account.id,
      result.conversationId,
      result.remoteMessageId
    );

    const conv = await this.prisma.conversation.upsert({
      where: {
        accountId_remoteConversationId: {
          accountId: account.id,
          remoteConversationId: result.conversationId,
        },
      },
      update: {
        lastMessageSnippet: content.slice(0, 200),
        lastActivityAt: new Date(),
      },
      create: {
        accountId: account.id,
        remoteConversationId: result.conversationId,
        participantIds: [account.id, recipientId],
        lastMessageSnippet: content.slice(0, 200),
        lastActivityAt: new Date(),
      },
    });

    await this.prisma.chatMessage.create({
      data: {
        id: result.remoteMessageId,
        accountId: account.id,
        conversationId: conv.id,
        remoteMessageId: result.remoteMessageId,
        senderId: account.id,
        senderName: account.name ?? account.email,
        recipientId,
        content,
        direction: 'OUTBOUND',
        idempotencyKey,
        syncStatus: 'SYNCED',
        sentAt: new Date(),
      },
    });

    // Publish MESSAGE_SENT event
    await this.eventBus.publish(
      'MESSAGE_SENT',
      {
        accountId: account.id,
        conversationId: result.conversationId,
        remoteMessageId: result.remoteMessageId,
        recipientId,
        content,
      },
      job.traceId
    );
  }

  /**
   * Real handler for SEND_CONNECTION_REQUEST
   */
  private async handleSendConnectionRequest(
    job: any,
    account: LinkedInAccount,
    payload: Record<string, any>
  ): Promise<void> {
    const { targetProfileId, customNote } = payload;

    if (!targetProfileId) {
      throw new Error("Missing required payload field: 'targetProfileId' is required for SEND_CONNECTION_REQUEST");
    }

    // Execute via Circuit Breaker & Real Voyager HTTP client
    await this.circuitBreaker.execute(() =>
      this.voyagerClient.sendConnectionRequest(account, targetProfileId, customNote)
    );

    // Publish CONNECTION_REQUEST_SENT event
    await this.eventBus.publish(
      'CONNECTION_REQUEST_SENT',
      {
        accountId: account.id,
        targetProfileId,
        customNote,
      },
      job.traceId
    );
  }

  /**
   * Real handler for SYNC_MESSAGES
   */
  private async handleMessageSync(job: any, account: LinkedInAccount, payload: Record<string, any>): Promise<void> {
    const limit = payload.limit ? parseInt(payload.limit, 10) : 20;

    // Fetch actual conversations from LinkedIn Voyager API
    const conversations = await this.circuitBreaker.execute(() =>
      this.voyagerClient.fetchConversations(account, limit)
    );

    let syncedCount = 0;

    for (const conv of conversations) {
      for (const event of conv.messages) {
        const remoteMessageId = event.backendEventId || event.entityUrn || `evt_${Date.now()}`;
        const senderId = event.from?.['com.linkedin.voyager.messaging.MessagingMember']?.miniProfile?.entityUrn || 'unknown';
        const senderName = event.from?.['com.linkedin.voyager.messaging.MessagingMember']?.miniProfile?.firstName || undefined;
        const content = event.eventContent?.['com.linkedin.voyager.messaging.eventContent.MessageEvent']?.attributedBody?.text || '';
        const sentAt = event.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString();

        // Ingest idempotently via PersistenceConsumer
        await this.persistenceConsumer.handleMessageReceived({
          eventId: remoteMessageId,
          traceId: job.traceId,
          eventName: 'MESSAGE_RECEIVED',
          timestamp: Date.now(),
          payload: {
            accountId: account.id,
            conversationId: conv.conversationId,
            remoteMessageId,
            senderId,
            senderName,
            recipientId: account.id,
            content,
            sentAt,
          },
        });
        syncedCount++;
      }
    }

    logger.info({ accountId: account.id, syncedCount }, 'Message sync completed');
  }

  /**
   * Handles failure with retry scheduling, exponential backoff, and DLQ routing
   */
  private async markJobFailed(job: any, err: Error, retryable: boolean): Promise<void> {
    const newRetryCount = job.retryCount + 1;
    const isExhausted = newRetryCount >= job.maxRetries;

    logger.error(
      {
        jobId: job.id,
        action: job.type,
        error: err.message,
        retryCount: newRetryCount,
        maxRetries: job.maxRetries,
        isExhausted,
      },
      'Job execution failed'
    );

    if (isExhausted || !retryable) {
      // Exceeded max retries or permanent non-retryable error -> Route to DLQ
      await this.prisma.automationJob.update({
        where: { id: job.id },
        data: {
          status: isExhausted ? 'DLQ_ROUTED' : 'FAILED',
          errorMessage: err.message,
          retryCount: newRetryCount,
        },
      });

      await this.dlqManager.routeToDLQ(
        {
          eventId: job.id,
          traceId: job.traceId,
          eventName: 'AUTOMATION_JOB_FAILED' as any,
          timestamp: Date.now(),
          payload: {
            jobId: job.id,
            accountId: job.accountId,
            type: job.type,
            error: err.message,
            retryCount: newRetryCount,
          } as any,
        },
        err,
        newRetryCount,
        job.accountId
      );

      await this.eventBus.publish(
        'AUTOMATION_JOB_FAILED',
        {
          jobId: job.id,
          accountId: job.accountId,
          type: job.type,
          error: err.message,
          retryCount: newRetryCount,
        },
        job.traceId
      );
    } else {
      // Calculate exponential backoff with jitter
      const backoffMs = DeadLetterQueueManager.calculateBackoff(newRetryCount);
      const nextScheduled = new Date(Date.now() + backoffMs);

      await this.prisma.automationJob.update({
        where: { id: job.id },
        data: {
          status: 'FAILED',
          errorMessage: err.message,
          retryCount: newRetryCount,
          scheduledFor: nextScheduled,
        },
      });

      logger.info(
        { jobId: job.id, backoffMs, nextScheduled: nextScheduled.toISOString() },
        'Job scheduled for exponential retry'
      );
    }
  }
}
