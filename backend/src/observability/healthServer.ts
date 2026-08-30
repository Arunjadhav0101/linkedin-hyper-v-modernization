import http from 'http';
import { logger } from './logger.js';

export interface HealthProvider {
  isHealthy(): boolean;
  isReady(): boolean;
  getMetrics(): Record<string, unknown>;
}

export class HealthServer {
  private server: http.Server | null = null;
  private provider: HealthProvider;
  private port: number;

  constructor(provider: HealthProvider, port = 8080) {
    this.provider = provider;
    this.port = port;
  }

  public start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const url = req.url || '/';

        if (url === '/healthz' || url === '/live') {
          const healthy = this.provider.isHealthy();
          res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: healthy ? 'UP' : 'DOWN', timestamp: new Date().toISOString() }));
          return;
        }

        if (url === '/readyz' || url === '/ready') {
          const ready = this.provider.isReady();
          res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: ready ? 'READY' : 'NOT_READY', timestamp: new Date().toISOString() }));
          return;
        }

        if (url === '/metrics') {
          const metrics = this.provider.getMetrics();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(metrics, null, 2));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      });

      this.server.listen(this.port, () => {
        logger.info({ port: this.port }, 'Health check server listening');
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
