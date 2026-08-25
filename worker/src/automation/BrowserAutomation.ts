import { LinkedInAccount, ProxyNode } from '@shared/types';
import { DynamicProxyPool } from '../proxy/DynamicProxyPool.js';
import { HumanBehavior } from '../policy/HumanBehavior.js';
import { logger } from '../observability/logger.js';

export class BrowserAutomation {
  private proxyPool: DynamicProxyPool;

  constructor(proxyPool: DynamicProxyPool) {
    this.proxyPool = proxyPool;
  }

  /**
   * Initializes browser automation session with sticky residential proxy
   */
  public async launchSession(account: LinkedInAccount): Promise<{ sessionId: string; proxyUsed?: string }> {
    const proxy: ProxyNode | null = this.proxyPool.getProxyForAccount(account.id);
    const sessionId = `session_${account.id}_${Date.now()}`;

    logger.info(
      { accountId: account.id, sessionId, proxyHost: proxy?.host, isResidential: proxy?.isResidential },
      'Launching browser automation session with proxy binding'
    );

    // Simulate session warm-up delay
    await HumanBehavior.sleep(HumanBehavior.calculateDelay(500, 1500));
    return { sessionId, proxyUsed: proxy?.host };
  }

  /**
   * Simulates typing text with natural human-like keystroke intervals
   */
  public async simulateTyping(text: string): Promise<void> {
    for (let i = 0; i < text.length; i++) {
      const delay = HumanBehavior.getKeystrokeDelay();
      await HumanBehavior.sleep(delay);
    }
  }

  /**
   * Simulates browsing pause and page interaction
   */
  public async simulateReadingPause(): Promise<void> {
    const pause = HumanBehavior.getPageReadingPause();
    await HumanBehavior.sleep(pause);
  }
}
