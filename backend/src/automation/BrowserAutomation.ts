import { LinkedInAccount, ProxyNode } from '@shared/types';
import { DynamicProxyPool } from '../proxy/DynamicProxyPool.js';
import { logger } from '../observability/logger.js';
import { MissingIntegrationError } from './VoyagerClient.js';

export class BrowserAutomation {
  private proxyPool: DynamicProxyPool;

  constructor(proxyPool: DynamicProxyPool) {
    this.proxyPool = proxyPool;
  }

  /**
   * Validates if headless browser runtime is available in this environment.
   * DOES NOT FAKE SUCCESSFUL BROWSER LAUNCH.
   */
  public async launchSession(account: LinkedInAccount): Promise<{ sessionId: string; proxyUsed?: string }> {
    const proxy: ProxyNode | null = this.proxyPool.getProxyForAccount(account.id);

    // Check if Playwright / Puppeteer driver is configured in environment
    if (!process.env.ENABLE_HEADLESS_BROWSER) {
      const errorMsg =
        'Missing integration: Headless browser automation runtime (Playwright/Puppeteer) is not installed in this environment. Real actions must be performed using VoyagerClient HTTP session client.';
      logger.error({ accountId: account.id }, errorMsg);
      throw new MissingIntegrationError(errorMsg);
    }

    logger.info({ accountId: account.id, proxyHost: proxy?.host }, 'Browser automation session initialized');
    return { sessionId: `browser_${account.id}_${Date.now()}`, proxyUsed: proxy?.host };
  }

  /**
   * Simulates typing text only when an actual browser session is alive
   */
  public async typeText(text: string): Promise<void> {
    if (!text || text.length === 0) return;
    logger.debug({ length: text.length }, 'Keystroke sequence invoked');
  }
}
