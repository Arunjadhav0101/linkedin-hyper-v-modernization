import { describe, it, expect, beforeEach, vi } from 'vitest';
import { JobProcessor } from '../backend/src/jobs/JobProcessor.js';
import { EventBus } from '../backend/src/events/EventBus.js';
import { VoyagerClient } from '../backend/src/automation/VoyagerClient.js';
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
    const circuitBreaker = new CircuitBreaker('test-linkedin');

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

  it('marks job as FAILED and schedules retry if execution fails with retries remaining', async () => {
    // Spy on voyagerClient to throw network error
    vi.spyOn(voyagerClient, 'sendMessage').mockRejectedValue(new Error('Connection reset by peer'));

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

    // Verify job transitioned to RUNNING, then FAILED with scheduled retry
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
          status: 'FAILED',
          errorMessage: 'Connection reset by peer',
          retryCount: 1,
        }),
      })
    );
  });

  it('routes job to DLQ when maxRetries is exhausted', async () => {
    vi.spyOn(voyagerClient, 'sendMessage').mockRejectedValue(new Error('Persistent LinkedIn API outage'));

    const job = {
      id: 'job_dlq_test',
      traceId: 'trace_dlq_test',
      accountId: 'acc_worker_test',
      type: 'SEND_MESSAGE',
      payload: { recipientId: 'member:999', content: 'Test message' },
      status: 'FAILED',
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
    expect(dlqPending[0]!.errorMessage).toBe('Persistent LinkedIn API outage');
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

    // Verify MESSAGE_SENT was emitted with correct payload
    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]!.payload.remoteMessageId).toBe('remote_msg_ok');
    expect(publishedEvents[0]!.payload.recipientId).toBe('member:888');
  });

  it('completes CONNECTION_REQUEST_SENT when connection request succeeds', async () => {
    vi.spyOn(voyagerClient, 'sendConnectionRequest').mockResolvedValue({
      invitationId: 'inv_123',
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
