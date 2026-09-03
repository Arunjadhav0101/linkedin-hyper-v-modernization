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
   * Cleans and extracts LinkedIn profile vanity identifier from URLs or raw input
   */
  public static cleanProfileIdentifier(input: string): string {
    let clean = input.trim();
    if (clean.includes('linkedin.com/in/')) {
      const match = clean.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/);
      if (match && match[1]) {
        clean = decodeURIComponent(match[1]);
      }
    }
    clean = clean.replace(/\s+/g, '-').replace(/\/+$/, '');
    return clean;
  }

  /**
   * Validates whether an account possesses authorized session credentials
   */
  public validateAccountSession(account: LinkedInAccount): { liAt: string; jsessionId: string } {
    const cookies = account.cookies || {};
    const liAt = (cookies.li_at || cookies['li_at'] || '').trim();
    const jsessionId = (cookies.JSESSIONID || cookies['JSESSIONID'] || '').trim();

    if (!liAt || liAt.length === 0) {
      const msg = `Missing integration: Account '${account.id}' (${account.email}) does not have an authorized session. Missing required 'li_at' cookie.`;
      logger.error({ accountId: account.id, email: account.email }, msg);
      throw new MissingIntegrationError(msg);
    }

    if (liAt.length < 50) {
      const msg = `Invalid LinkedIn session cookie: The 'li_at' cookie for '${account.email}' is only ${liAt.length} chars ('${liAt.slice(0, 8)}...'). A real LinkedIn session cookie is an encrypted ~150-character token starting with 'AQED...'. You entered a password or placeholder instead of the browser session cookie.`;
      logger.error({ accountId: account.id, email: account.email }, msg);
      throw new MissingIntegrationError(msg);
    }

    return { liAt, jsessionId };
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

      // Read response body ONCE as text to safely handle JSON and non-JSON without Body unusable errors
      const rawText = await response.text();
      let parsedData: any = null;
      try {
        parsedData = JSON.parse(rawText);
      } catch {
        parsedData = rawText;
      }

      // 8. Handle non-2xx LinkedIn responses without faking
      if (!response.ok) {
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
            errorBody: typeof parsedData === 'string' ? parsedData.slice(0, 300) : parsedData,
          },
          'LinkedIn Voyager API responded with non-2xx HTTP status'
        );

        const errorDetail = typeof parsedData === 'object' && parsedData?.message
          ? parsedData.message
          : `HTTP ${status}`;
        throw new VoyagerApiError(status, errorDetail, parsedData);
      }

      // 9. Process real success response
      const responseData = parsedData as T;

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
    const cleanRecipient = VoyagerClient.cleanProfileIdentifier(recipientId);
    logger.info(
      { accountId: account.id, recipientId, cleanRecipient, conversationId },
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
            recipients: [cleanRecipient],
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
      `conv_${cleanRecipient}`;

    return { remoteMessageId, conversationId: returnedConvId };
  }

  /**
   * Resolves a public vanity name (e.g. 'arun-jadhav-a80222318') to LinkedIn's internal profileId / URN
   */
  public async resolveProfileId(account: LinkedInAccount, identifier: string): Promise<string> {
    const clean = VoyagerClient.cleanProfileIdentifier(identifier);

    // If already a full URN or internal ID, return directly
    if (clean.startsWith('urn:li:') || clean.startsWith('ACoAA')) {
      return clean;
    }

    try {
      // Query modern profile dash endpoint from LinkedIn Voyager API
      const profileRes = await this.executeRequest<any>(account, {
        endpoint: `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(clean)}`,
        method: 'GET',
        actionType: 'RESOLVE_PROFILE',
      });

      const profileData = profileRes.data;
      const elements = profileData?.['*elements'] || profileData?.elements || [];
      const internalId =
        elements[0] ||
        profileData?.miniProfile?.dashEntityUrn ||
        profileData?.miniProfile?.entityUrn ||
        profileData?.entityUrn ||
        profileData?.plainId;

      if (internalId) {
        logger.info(
          { identifier: clean, resolvedId: internalId },
          'Successfully resolved public vanity name to internal LinkedIn profile ID'
        );
        return internalId;
      }
    } catch (err: any) {
      logger.warn(
        { identifier: clean, error: err.message },
        'Vanity profile resolution encountered error; falling back to clean identifier'
      );
    }

    return clean;
  }

  /**
   * Real implementation to send a LinkedIn connection request invitation
   */
  public async sendConnectionRequest(
    account: LinkedInAccount,
    targetProfileId: string,
    customNote?: string
  ): Promise<{ invitationId: string; resolvedProfileId: string }> {
    const cleanId = VoyagerClient.cleanProfileIdentifier(targetProfileId);
    const resolvedProfileId = await this.resolveProfileId(account, cleanId);

    logger.info(
      { accountId: account.id, targetProfileId, cleanId, resolvedProfileId },
      'Executing real Send Connection Request action on LinkedIn'
    );

    const payload = {
      invitee: {
        'com.linkedin.voyager.growth.invitation.InviteeProfile': {
          profileId: resolvedProfileId,
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

    return { invitationId, resolvedProfileId };
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
