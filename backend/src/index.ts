import { logger } from './observability/logger.js';
import { HealthServer, HealthProvider } from './observability/healthServer.js';
import { PolicyOrchestrator, MemoryPolicyStore } from './policy/PolicyOrchestrator.js';
import { DynamicProxyPool } from './proxy/DynamicProxyPool.js';
import { EventBus } from './events/EventBus.js';
import { PersistenceConsumer, MemoryMessageRepository } from './events/PersistenceConsumer.js';
import { DeadLetterQueueManager, MemoryDLQStorage } from './events/DeadLetterQueue.js';
import { OutboxPublisher, MemoryOutboxStorage } from './events/OutboxPublisher.js';

class WorkerApplication implements HealthProvider {
  private healthServer: HealthServer;
  private proxyPool: DynamicProxyPool;
  private policyOrchestrator: PolicyOrchestrator;
  private eventBus: EventBus;
  private persistenceConsumer: PersistenceConsumer;
  private dlqManager: DeadLetterQueueManager;
  private outboxPublisher: OutboxPublisher;
  private isRunning = false;
  private startTime = Date.now();

  constructor() {
    this.proxyPool = new DynamicProxyPool();
    this.policyOrchestrator = new PolicyOrchestrator(new MemoryPolicyStore());
    this.eventBus = new EventBus();
    this.persistenceConsumer = new PersistenceConsumer(new MemoryMessageRepository());
    this.dlqManager = new DeadLetterQueueManager(new MemoryDLQStorage());
    this.outboxPublisher = new OutboxPublisher(
      new MemoryOutboxStorage(),
      this.eventBus,
      this.dlqManager
    );
    this.healthServer = new HealthServer(this, parseInt(process.env.HEALTH_PORT || '8080', 10));

    this.registerEventHandlers();
  }

  private registerEventHandlers(): void {
    this.eventBus.subscribe('MESSAGE_RECEIVED', async (event) => {
      try {
        await this.persistenceConsumer.handleMessageReceived(event);
      } catch (err: any) {
        await this.dlqManager.routeToDLQ(event, err, 1, event.payload.accountId);
      }
    });

    this.eventBus.subscribe('RATE_LIMIT_TRIGGERED', async (event) => {
      await this.policyOrchestrator.triggerCooloff(event.payload.accountId, event.payload.retryAfterMs);
    });
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
      environment: process.env.NODE_ENV || 'development',
    };
  }

  public async start(): Promise<void> {
    logger.info('Starting LinkedIn Hyper-V Worker Engine v2.0.0...');
    this.isRunning = true;
    await this.healthServer.start();
    this.outboxPublisher.start(parseInt(process.env.OUTBOX_POLL_INTERVAL_MS || '2000', 10));
    logger.info('Worker Engine successfully initialized and ready for jobs');
  }

  public async stop(): Promise<void> {
    logger.info('Shutting down Worker Engine...');
    this.isRunning = false;
    this.outboxPublisher.stop();
    await this.healthServer.stop();
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
