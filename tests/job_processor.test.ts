import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobProcessor } from '../backend/src/jobs/JobProcessor.js';
import { EventBus } from '../backend/src/events/EventBus.js';
import { VoyagerClient, VoyagerApiError } from '../backend/src/automation/VoyagerClient.js';
import { DistributedLock } from '../backend/src/lock/DistributedLock.js';
import { CircuitBreaker } from '../backend/src/circuit/CircuitBreaker.js';
import { DeadLetterQueueManager, MemoryDLQStorage } from '../backend/src/events/DeadLetterQueue.js';
import { PersistenceConsumer, MemoryMessageRepository } from '../backend/src/events/PersistenceConsumer.js';
import { PolicyOrchestrator, MemoryPolicyStore } from '../backend/src/policy/PolicyOrchestrator.js';
import { DynamicProxyPool } from '../backend/src/proxy/DynamicProxyPool.js';

describe('JobProcessor Worker Engine & State Machine Verification', () => {
  let processor: JobProcessor;
  let eventBus: EventBus;
  let voyagerClient: VoyagerClient;
  let dlqManager: DeadLetterQueueManager;
  let dlqStorage: MemoryDLQStorage;
  let persistenceConsumer: PersistenceConsumer;
  let circuitBreaker: CircuitBreaker;
  let mockPrisma: any;

  const mockAccount = {
    id: 'acc_worker_test',
    email: 'worker-lead@company.com',
    name: 'Worker Lead',
    status: 'ACTIVE',
    cookies: { li_at: 'AQED_SAMPLE_TOKEN_VALID_SESSION_FOR_TESTING_1234567890_LONGER_THAN_FIFTY', JSESSIONID: 'ajax:123' },
    hourlyActionLimit: 20,
    dailyActionLimit: 60,
    hourlyConnectionLimit: 10,
    dailyConnectionLimit: 30,
    hourlyMessageLimit: 20,
    dailyMessageLimit: 40,
    warmupStartDate: new Date(),
    isWarmedUp: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    assignedProxy: null,
  };

  beforeEach(() => {
    eventBus = new EventBus();
    dlqStorage = new MemoryDLQStorage();
    dlqManager = new DeadLetterQueueManager(dlqStorage);
    persistenceConsumer = new PersistenceConsumer(new MemoryMessageRepository());

    const policy = new PolicyOrchestrator(new MemoryPolicyStore());
    const proxyPool = new DynamicProxyPool();
    voyagerClient = new VoyagerClient(policy, proxyPool);

    const lock = new DistributedLock();
    circuitBreaker = new CircuitBreaker('test-linkedin');

    mockPrisma = {
      automationJob: {
        update: vi.fn().mockResolvedValue({}),
      },
      linkedInAccount: {
        findUnique: vi.fn().mockResolvedValue(mockAccount),
      },
      conversation: {
        upsert: vi.fn().mockResolvedValue({ id: 'conv_internal_1' }),
      },
      chatMessage: {
        create: vi.fn().mockResolvedValue({ id: 'msg_created_1' }),
      },
    };

    processor = new JobProcessor(
      mockPrisma,
      eventBus,
      voyagerClient,
      lock,
      circuitBreaker,
      dlqManager,
      persistenceConsumer
    );
  });

  it('marks job as RETRYING and schedules backoff when transient network error occurs', async () => {
    // Spy on voyagerClient to throw transient network error
    vi.spyOn(voyagerClient, 'sendMessage').mockRejectedValue(new Error('fetch failed: Connection reset by peer'));

    const job = {
      id: 'job_retry_test',
      traceId: 'trace_retry_test',
      accountId: 'acc_worker_test',
      type: 'SEND_MESSAGE',
      payload: { recipientId: 'member:999', content: 'Test message' },
      status: 'QUEUED',
      priority: 0,
      retryCount: 0,
      maxRetries: 3,
    };

    await processor.executeJob(job);

    // Verify job transitioned to RUNNING, then RETRYING with scheduled retry
    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_retry_test' },
        data: expect.objectContaining({ status: 'RUNNING' }),
      })
    );

    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_retry_test' },
        data: expect.objectContaining({
          status: 'RETRYING',
          errorMessage: 'fetch failed: Connection reset by peer',
          retryCount: 1,
        }),
      })
    );
  });

  it('marks job as FAILED immediately without retrying when permanent 422 error occurs', async () => {
    // Permanent HTTP 422 Unprocessable Entity
    vi.spyOn(voyagerClient, 'sendConnectionRequest').mockRejectedValue(
      new VoyagerApiError(422, 'Cannot invite self or already connected', { status: 422 })
    );

    const job = {
      id: 'job_perm_422_test',
      traceId: 'trace_perm_422_test',
      accountId: 'acc_worker_test',
      type: 'SEND_CONNECTION_REQUEST',
      payload: { targetProfileId: 'target-vanity' },
      status: 'QUEUED',
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
    };

    await processor.executeJob(job);

    // Verify job transitioned to FAILED (NOT RETRYING, NOT DLQ_ROUTED)
    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_perm_422_test' },
        data: expect.objectContaining({
          status: 'FAILED',
        }),
      })
    );

    // Verify it did NOT route to DLQ
    const dlqPending = await dlqStorage.getPendingRecords();
    expect(dlqPending).toHaveLength(0);

    // Verify CircuitBreaker state remained CLOSED (client errors must not trip the breaker)
    expect(circuitBreaker.getState()).toBe('CLOSED');
  });

  it('fails immediately when account has no valid session cookie without blind retries', async () => {
    mockPrisma.linkedInAccount.findUnique.mockResolvedValue({
      ...mockAccount,
      cookies: { li_at: 'short_pass' }, // Invalid cookie < 50 chars
    });

    const job = {
      id: 'job_invalid_auth_test',
      traceId: 'trace_invalid_auth_test',
      accountId: 'acc_worker_test',
      type: 'SEND_MESSAGE',
      payload: { recipientId: 'member:123', content: 'Hi' },
      status: 'QUEUED',
      priority: 0,
      retryCount: 0,
      maxRetries: 5,
    };

    await processor.executeJob(job);

    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_invalid_auth_test' },
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringContaining('Account is not authorized for live actions'),
        }),
      })
    );

    // Must NOT route to DLQ on configuration errors
    const dlqPending = await dlqStorage.getPendingRecords();
    expect(dlqPending).toHaveLength(0);
  });

  it('routes job to DLQ when maxRetries is exhausted on transient errors', async () => {
    vi.spyOn(voyagerClient, 'sendMessage').mockRejectedValue(new Error('fetch failed: Persistent network timeout'));

    const job = {
      id: 'job_dlq_test',
      traceId: 'trace_dlq_test',
      accountId: 'acc_worker_test',
      type: 'SEND_MESSAGE',
      payload: { recipientId: 'member:999', content: 'Test message' },
      status: 'RETRYING',
      priority: 0,
      retryCount: 2, // 3rd attempt will equal maxRetries
      maxRetries: 3,
    };

    await processor.executeJob(job);

    // Verify job status updated to DLQ_ROUTED
    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_dlq_test' },
        data: expect.objectContaining({
          status: 'DLQ_ROUTED',
          retryCount: 3,
        }),
      })
    );

    // Verify DLQ storage received record
    const dlqPending = await dlqStorage.getPendingRecords();
    expect(dlqPending).toHaveLength(1);
    expect(dlqPending[0]!.accountId).toBe('acc_worker_test');
    expect(dlqPending[0]!.errorMessage).toBe('fetch failed: Persistent network timeout');
  });

  it('completes successfully and publishes MESSAGE_SENT when real execution succeeds', async () => {
    vi.spyOn(voyagerClient, 'sendMessage').mockResolvedValue({
      remoteMessageId: 'remote_msg_ok',
      conversationId: 'conv_remote_ok',
    });

    const publishedEvents: any[] = [];
    eventBus.subscribe('MESSAGE_SENT', async (evt) => {
      publishedEvents.push(evt);
    });

    const job = {
      id: 'job_success_test',
      traceId: 'trace_success_test',
      accountId: 'acc_worker_test',
      type: 'SEND_MESSAGE',
      payload: { recipientId: 'member:888', content: 'Hello via Hyper-V' },
      status: 'QUEUED',
      priority: 0,
      retryCount: 0,
      maxRetries: 3,
    };

    await processor.executeJob(job);

    // Verify status updated to COMPLETED
    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_success_test' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      })
    );

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]!.payload.remoteMessageId).toBe('remote_msg_ok');
  });

  it('completes CONNECTION_REQUEST_SENT when connection request succeeds', async () => {
    vi.spyOn(voyagerClient, 'sendConnectionRequest').mockResolvedValue({
      invitationId: 'inv_123',
      resolvedProfileId: 'vanity-satya',
    });

    const publishedEvents: any[] = [];
    eventBus.subscribe('CONNECTION_REQUEST_SENT', async (evt) => {
      publishedEvents.push(evt);
    });

    const job = {
      id: 'job_conn_test',
      traceId: 'trace_conn_test',
      accountId: 'acc_worker_test',
      type: 'SEND_CONNECTION_REQUEST',
      payload: { targetProfileId: 'vanity-satya', customNote: 'Connecting on LinkedIn' },
      status: 'QUEUED',
      priority: 0,
      retryCount: 0,
      maxRetries: 3,
    };

    await processor.executeJob(job);

    expect(mockPrisma.automationJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job_conn_test' },
        data: expect.objectContaining({ status: 'COMPLETED' }),
      })
    );

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]!.payload.targetProfileId).toBe('vanity-satya');
  });
});
