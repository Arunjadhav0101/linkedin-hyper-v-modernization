import { describe, it, expect, beforeEach, vi } from 'vitest';
import { VoyagerClient, MissingIntegrationError, VoyagerApiError } from '../backend/src/automation/VoyagerClient.js';
import { PolicyOrchestrator, MemoryPolicyStore } from '../backend/src/policy/PolicyOrchestrator.js';
import { DynamicProxyPool } from '../backend/src/proxy/DynamicProxyPool.js';
import { HumanBehavior } from '../backend/src/policy/HumanBehavior.js';
import { LinkedInAccount } from '@shared/types';

describe('VoyagerClient Real Integration & Zero-Simulation Verification', () => {
  let policy: PolicyOrchestrator;
  let proxyPool: DynamicProxyPool;
  let client: VoyagerClient;

  const validAccount: LinkedInAccount = {
    id: 'acc_real_test',
    email: 'test-user@company.com',
    name: 'Real Tester',
    status: 'ACTIVE',
    isWarmedUp: true,
    cookies: {
      li_at: 'AQED_REAL_LINKEDIN_AUTH_TOKEN_SAMPLE_123_LONG_SESSION_CREDENTIAL_KEY_TEST',
      JSESSIONID: 'ajax:987654321',
    },
    limits: {
      hourlyActionLimit: 50,
      dailyActionLimit: 200,
      hourlyConnectionLimit: 20,
      dailyConnectionLimit: 100,
      hourlyMessageLimit: 30,
      dailyMessageLimit: 100,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const accountWithoutCookies: LinkedInAccount = {
    ...validAccount,
    id: 'acc_no_cookies',
    cookies: {},
  };

  beforeEach(() => {
    vi.spyOn(HumanBehavior, 'sleep').mockResolvedValue();
    policy = new PolicyOrchestrator(new MemoryPolicyStore());
    proxyPool = new DynamicProxyPool();
    client = new VoyagerClient(policy, proxyPool);
  });

  it('rejects execution and throws MissingIntegrationError if li_at cookie is missing (DO NOT FAKE SUCCESS)', async () => {
    // Attempting to execute any request without authorized session cookie MUST fail explicitly
    await expect(
      client.executeRequest(accountWithoutCookies, {
        endpoint: '/messaging/conversations',
        method: 'GET',
        actionType: 'SYNC_MESSAGES',
      })
    ).rejects.toThrow(MissingIntegrationError);

    await expect(
      client.sendMessage(accountWithoutCookies, 'member:123', 'Hello world')
    ).rejects.toThrow(/Missing integration.*missing required 'li_at' cookie/i);
  });

  it('correctly validates session and extracts li_at and JSESSIONID for authorized accounts', () => {
    const session = client.validateAccountSession(validAccount);
    expect(session.liAt).toBe('AQED_REAL_LINKEDIN_AUTH_TOKEN_SAMPLE_123_LONG_SESSION_CREDENTIAL_KEY_TEST');
    expect(session.jsessionId).toBe('ajax:987654321');
  });

  it('does NOT fake status 200 when LinkedIn returns 401 Unauthorized or 429 Rate Limit', async () => {
    // Mock global fetch to return real HTTP 401 response
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify({ status: 401, message: 'Invalid or expired li_at session cookie' }),
    });
    global.fetch = mockFetch;

    await expect(
      client.executeRequest(validAccount, {
        endpoint: '/messaging/conversations',
        method: 'GET',
        actionType: 'SYNC_MESSAGES',
      })
    ).rejects.toThrow(VoyagerApiError);

    // Verify fetch was called with real LinkedIn headers
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1].headers;
    expect(headers['Cookie']).toContain('li_at=AQED_REAL_LINKEDIN_AUTH_TOKEN_SAMPLE_123_LONG_SESSION_CREDENTIAL_KEY_TEST');
    expect(headers['csrf-token']).toBe('ajax:987654321');
    expect(headers['x-restli-protocol-version']).toBe('2.0.0');
  });

  it('returns parsed response data only when LinkedIn returns true HTTP 200', async () => {
    const mockData = {
      elements: [
        {
          id: 'conv_123',
          entityUrn: 'urn:li:fs_conversation:conv_123',
          events: [],
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(mockData),
    });

    const response = await client.fetchConversations(validAccount, 10);
    expect(response).toHaveLength(1);
    expect(response[0]!.conversationId).toBe('conv_123');
  });
});
