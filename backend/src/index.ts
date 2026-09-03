import { logger } from './observability/logger.js';
import { HealthServer, HealthProvider } from './observability/healthServer.js';
import { PolicyOrchestrator, MemoryPolicyStore } from './policy/PolicyOrchestrator.js';
import { DynamicProxyPool } from './proxy/DynamicProxyPool.js';
import { EventBus } from './events/EventBus.js';
import { PersistenceConsumer } from './events/PersistenceConsumer.js';
import { DeadLetterQueueManager } from './events/DeadLetterQueue.js';
import { OutboxPublisher } from './events/OutboxPublisher.js';
import { VoyagerClient } from './automation/VoyagerClient.js';
import { DistributedLock } from './lock/DistributedLock.js';
import { CircuitBreaker } from './circuit/CircuitBreaker.js';
import { JobProcessor } from './jobs/JobProcessor.js';
import { PrismaMessageRepository } from './persistence/PrismaMessageRepository.js';
import { PrismaDLQStorage } from './persistence/PrismaDLQStorage.js';
import { PrismaOutboxStorage } from './persistence/PrismaOutboxStorage.js';
import { prisma } from './lib/prisma.js';
import { Redis } from 'ioredis';

class WorkerApplication implements HealthProvider {
  private healthServer: HealthServer;
  private proxyPool: DynamicProxyPool;
  private policyOrchestrator: PolicyOrchestrator;
  private eventBus: EventBus;
  private persistenceConsumer: PersistenceConsumer;
  private dlqManager: DeadLetterQueueManager;
  private outboxPublisher: OutboxPublisher;
  private voyagerClient: VoyagerClient;
  private distributedLock: DistributedLock;
  private circuitBreaker: CircuitBreaker;
  private jobProcessor: JobProcessor;
  private redisClient?: Redis;

  private isRunning = false;
  private jobLoopTimer: NodeJS.Timeout | null = null;
  private startTime = Date.now();

  constructor() {
    // 1. Core infrastructure
    this.proxyPool = new DynamicProxyPool();
    this.policyOrchestrator = new PolicyOrchestrator(new MemoryPolicyStore());
    this.eventBus = new EventBus();

    // 2. Real PostgreSQL persistence
    this.persistenceConsumer = new PersistenceConsumer(new PrismaMessageRepository());
    this.dlqManager = new DeadLetterQueueManager(new PrismaDLQStorage());
    this.outboxPublisher = new OutboxPublisher(new PrismaOutboxStorage(), this.eventBus, this.dlqManager);

    // 3. Optional Redis connection for distributed locking
    if (process.env.REDIS_URL) {
      try {
        this.redisClient = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          lazyConnect: true,
        });
        this.redisClient.connect().catch(() => {
          logger.warn('Redis connection failed; DistributedLock will use local memory fallback');
        });
      } catch {
        logger.warn('Failed to initialize Redis client; fallback to in-memory lock');
      }
    }

    this.distributedLock = new DistributedLock(this.redisClient);
    this.circuitBreaker = new CircuitBreaker('linkedin-voyager', {
      failureThreshold: 5,
      cooldownMs: 30000,
      successThreshold: 2,
    });

    // 4. Real Voyager Client (Zero fake 200 responses)
    this.voyagerClient = new VoyagerClient(this.policyOrchestrator, this.proxyPool);

    // 5. Worker Job Execution Engine
    this.jobProcessor = new JobProcessor(
      prisma,
      this.eventBus,
      this.voyagerClient,
      this.distributedLock,
      this.circuitBreaker,
      this.dlqManager,
      this.persistenceConsumer
    );

    this.healthServer = new HealthServer(this, parseInt(process.env.HEALTH_PORT || '8080', 10));

    this.registerEventHandlers();
  }

  private registerEventHandlers(): void {
    // Handle incoming synchronized message
    this.eventBus.subscribe('MESSAGE_RECEIVED', async (event) => {
      try {
        await this.persistenceConsumer.handleMessageReceived(event);
      } catch (err: any) {
        await this.dlqManager.routeToDLQ(event, err, 1, event.payload.accountId);
      }
    });

    // Handle anti-ban rate limiting cooloff
    this.eventBus.subscribe('RATE_LIMIT_TRIGGERED', async (event) => {
      await this.policyOrchestrator.triggerCooloff(event.payload.accountId, event.payload.retryAfterMs);
    });
  }

  /**
   * Continuous job execution loop
   */
  private startJobProcessingLoop(): void {
    const loop = async () => {
      if (!this.isRunning) return;

      try {
        let hasMore = true;
        // Drain available jobs with small pauses
        while (hasMore && this.isRunning) {
          hasMore = await this.jobProcessor.processNextPendingJob();
        }
      } catch (err: any) {
        logger.error({ error: err.message }, 'Error in worker job processing cycle');
      }

      if (this.isRunning) {
        this.jobLoopTimer = setTimeout(loop, 1000);
      }
    };

    this.jobLoopTimer = setTimeout(loop, 500);
  }

  public isHealthy(): boolean {
    return this.isRunning;
  }

  public isReady(): boolean {
    return this.isRunning;
  }

  public getMetrics(): Record<string, unknown> {
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      status: this.isRunning ? 'RUNNING' : 'STOPPED',
      proxyPool: this.proxyPool.getPoolStats(),
      circuitBreaker: this.circuitBreaker.getStats(),
      environment: process.env.NODE_ENV || 'development',
    };
  }

  public async start(): Promise<void> {
    logger.info('Starting LinkedIn Hyper-V Worker Engine v2.0.0...');
    this.isRunning = true;
    await this.healthServer.start();
    this.outboxPublisher.start(parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '2000', 10));
    this.startJobProcessingLoop();
    logger.info('Worker Engine successfully initialized and actively polling for jobs');
  }

  public async stop(): Promise<void> {
    logger.info('Shutting down Worker Engine...');
    this.isRunning = false;

    if (this.jobLoopTimer) {
      clearTimeout(this.jobLoopTimer);
      this.jobLoopTimer = null;
    }

    this.outboxPublisher.stop();
    await this.healthServer.stop();

    if (this.redisClient) {
      try {
        await this.redisClient.quit();
      } catch {}
    }

    await prisma.$disconnect();
    logger.info('Worker Engine gracefully stopped');
  }
}

const app = new WorkerApplication();
app.start().catch((err) => {
  logger.fatal({ error: err.message, stack: err.stack }, 'Worker Engine crashed on startup');
  process.exit(1);
});

const handleSignal = async (signal: string) => {
  logger.info({ signal }, 'Received termination signal');
  await app.stop();
  process.exit(0);
};

process.on('SIGINT', () => handleSignal('SIGINT'));
process.on('SIGTERM', () => handleSignal('SIGTERM'));

export { WorkerApplication };
