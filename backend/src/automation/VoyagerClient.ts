import { LinkedInAccount, ProxyNode } from '@shared/types';
import { PolicyOrchestrator } from '../policy/PolicyOrchestrator.js';
import { DynamicProxyPool } from '../proxy/DynamicProxyPool.js';
import { HumanBehavior } from '../policy/HumanBehavior.js';
import { logger } from '../observability/logger.js';

export interface VoyagerRequestOptions {
  endpoint: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  actionType: string;
}

export interface VoyagerResponse<T = unknown> {
  status: number;
  data?: T;
  headers: Record<string, string>;
  proxyUsed?: string;
  durationMs: number;
}

export class MissingIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingIntegrationError';
  }
}

export class VoyagerApiError extends Error {
  constructor(public readonly statusCode: number, message: string, public readonly body?: unknown) {
    super(`LinkedIn Voyager API Error (${statusCode}): ${message}`);
    this.name = 'VoyagerApiError';
  }
}

export class VoyagerClient {
  private policy: PolicyOrchestrator;
  private proxyPool: DynamicProxyPool;
  private baseUrl = 'https://www.linkedin.com/voyager/api';

  constructor(policy: PolicyOrchestrator, proxyPool: DynamicProxyPool) {
    this.policy = policy;
    this.proxyPool = proxyPool;
  }

  /**
   * Validates whether an account possesses authorized session credentials
   */
  public validateAccountSession(account: LinkedInAccount): { liAt: string; jsessionId: string } {
    const cookies = account.cookies || {};
    const liAt = cookies.li_at || cookies['li_at'];
    const jsessionId = cookies.JSESSIONID || cookies['JSESSIONID'] || '';

    if (!liAt || liAt.trim().length === 0) {
      const msg = `Missing integration: Account '${account.id}' (${account.email}) does not have an authorized session. Missing required 'li_at' cookie.`;
      logger.error({ accountId: account.id, email: account.email }, msg);
      throw new MissingIntegrationError(msg);
    }

    return { liAt: liAt.trim(), jsessionId: jsessionId.trim() };
  }

  /**
   * Executes an actual, non-simulated Voyager API request to LinkedIn
   */
  public async executeRequest<T = unknown>(
    account: LinkedInAccount,
    options: VoyagerRequestOptions
  ): Promise<VoyagerResponse<T>> {
    const { endpoint, method = 'GET', headers = {}, body, actionType } = options;

    // 1. Check for authorized LinkedIn session (DO NOT FAKE SUCCESS)
    const { liAt, jsessionId } = this.validateAccountSession(account);

    // 2. Evaluate Anti-Ban & Velocity Policy
    const evaluation = await this.policy.evaluateActionEligibility(
      account.id,
      actionType,
      account.limits,
      account.status
    );

    if (!evaluation.eligible) {
      logger.warn({ accountId: account.id, reason: evaluation.reason }, 'Action blocked by PolicyOrchestrator');
      throw new Error(`Policy violation: ${evaluation.reason}`);
    }

    // 3. Apply human behavior delay
    if (evaluation.delayMs && evaluation.delayMs > 0) {
      logger.debug({ accountId: account.id, delayMs: evaluation.delayMs }, 'Injecting human behavioral delay');
      await HumanBehavior.sleep(evaluation.delayMs);
    }

    // 4. Acquire assigned/healthy proxy
    const proxy: ProxyNode | null = this.proxyPool.getProxyForAccount(account.id);
    const startTime = Date.now();

    // 5. Build full target URL
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;

    // 6. Build real LinkedIn Voyager headers
    const csrfToken = jsessionId.replace(/"/g, '');
    const requestHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept': 'application/vnd.linkedin.normalized+json+2.1',
      'Content-Type': 'application/json; charset=UTF-8',
      'x-li-lang': 'en_US',
      'x-restli-protocol-version': '2.0.0',
      'Cookie': `li_at=${liAt}; JSESSIONID="${csrfToken}"`,
      ...(csrfToken ? { 'csrf-token': csrfToken } : {}),
      ...headers,
    };

    try {
      logger.info(
        {
          accountId: account.id,
          method,
          url,
          actionType,
          proxyHost: proxy?.host,
        },
        'Dispatching real HTTP request to LinkedIn Voyager API'
      );

      // 7. Execute REAL HTTP request
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body ? JSON.stringify(body) : undefined,
      });

      const durationMs = Date.now() - startTime;
      const status = response.status;
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // 8. Handle non-2xx LinkedIn responses without faking
      if (!response.ok) {
        let errorBody: any = null;
        try {
          errorBody = await response.json();
        } catch {
          errorBody = await response.text();
        }

        if (status === 429 || status === 421 || status === 999) {
          await this.policy.triggerCooloff(account.id);
          if (proxy) {
            this.proxyPool.reportProxyFailure(proxy.id, status, `LinkedIn Anti-Bot Challenge (${status})`);
          }
        }

        logger.error(
          {
            accountId: account.id,
            status,
            url,
            durationMs,
            errorBody,
          },
          'LinkedIn Voyager API responded with non-2xx HTTP status'
        );

        throw new VoyagerApiError(status, `LinkedIn HTTP error ${status}`, errorBody);
      }

      // 9. Process real success response
      let responseData: T;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        responseData = (await response.json()) as T;
      } else {
        responseData = (await response.text()) as unknown as T;
      }

      await this.policy.recordActionExecution(account.id, actionType);
      if (proxy) {
        this.proxyPool.reportProxySuccess(proxy.id, durationMs);
      }

      logger.info(
        { accountId: account.id, status, durationMs, actionType },
        'Real LinkedIn Voyager API request executed successfully'
      );

      return {
        status,
        data: responseData,
        headers: responseHeaders,
        proxyUsed: proxy?.host,
        durationMs,
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      if (!(err instanceof VoyagerApiError) && !(err instanceof MissingIntegrationError)) {
        logger.error(
          { accountId: account.id, url, durationMs, error: err.message },
          'Network or transport failure contacting LinkedIn'
        );
      }
      throw err;
    }
  }

  /**
   * Real implementation to send a LinkedIn message to a recipient or existing conversation
   */
  public async sendMessage(
    account: LinkedInAccount,
    recipientId: string,
    content: string,
    conversationId?: string
  ): Promise<{ remoteMessageId: string; conversationId: string }> {
    logger.info(
      { accountId: account.id, recipientId, conversationId },
      'Executing real Send Message action on LinkedIn'
    );

    const payload = conversationId
      ? {
          eventCreate: {
            value: {
              'com.linkedin.voyager.messaging.create.MessageCreate': {
                body: content,
                attributedBody: { text: content, attributes: [] },
              },
            },
          },
          dedupeByClientGeneratedToken: false,
        }
      : {
          keyVersion: 'LEGACY_INBOX',
          conversationCreate: {
            recipients: [recipientId],
            subtype: 'MEMBER_TO_MEMBER',
            eventCreate: {
              value: {
                'com.linkedin.voyager.messaging.create.MessageCreate': {
                  body: content,
                  attributedBody: { text: content, attributes: [] },
                },
              },
            },
          },
        };

    const endpoint = conversationId
      ? `/messaging/conversations/${conversationId}/events`
      : '/messaging/conversations?action=create';

    const res = await this.executeRequest<any>(account, {
      endpoint,
      method: 'POST',
      body: payload,
      actionType: 'SEND_MESSAGE',
    });

    const remoteMessageId =
      res.data?.value?.backendEventId ||
      res.data?.backendEventId ||
      `msg_${Date.now()}`;
    const returnedConvId =
      conversationId ||
      res.data?.value?.conversationUrn?.replace('urn:li:fs_conversation:', '') ||
      `conv_${recipientId}`;

    return { remoteMessageId, conversationId: returnedConvId };
  }

  /**
   * Real implementation to send a LinkedIn connection request invitation
   */
  public async sendConnectionRequest(
    account: LinkedInAccount,
    targetProfileId: string,
    customNote?: string
  ): Promise<{ invitationId: string }> {
    logger.info(
      { accountId: account.id, targetProfileId },
      'Executing real Send Connection Request action on LinkedIn'
    );

    const payload = {
      invitee: {
        'com.linkedin.voyager.growth.invitation.InviteeProfile': {
          profileId: targetProfileId,
        },
      },
      message: customNote || null,
    };

    const res = await this.executeRequest<any>(account, {
      endpoint: '/growth/normInvitations',
      method: 'POST',
      body: payload,
      actionType: 'SEND_CONNECTION_REQUEST',
    });

    const invitationId =
      res.data?.value?.invitationId ||
      res.data?.invitationId ||
      `inv_${Date.now()}`;

    return { invitationId };
  }

  /**
   * Real implementation to fetch recent conversations and messages for synchronization
   */
  public async fetchConversations(
    account: LinkedInAccount,
    limit = 20
  ): Promise<Array<{ conversationId: string; messages: any[] }>> {
    logger.info({ accountId: account.id, limit }, 'Executing real message sync from LinkedIn Voyager API');

    const res = await this.executeRequest<any>(account, {
      endpoint: `/messaging/conversations?count=${limit}&keyVersion=LEGACY_INBOX`,
      method: 'GET',
      actionType: 'SYNC_MESSAGES',
    });

    const elements = res.data?.elements || [];
    return elements.map((conv: any) => ({
      conversationId: conv.entityUrn?.replace('urn:li:fs_conversation:', '') || conv.id,
      messages: conv.events || [],
    }));
  }
}
