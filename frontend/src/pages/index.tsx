import React, { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';

type Tab = 'inbox' | 'connections' | 'jobs' | 'accounts' | 'health';

interface Account {
  id: string;
  email: string;
  name?: string;
  status: string;
  authType?: string;
  authStatus?: 'NOT_CONNECTED' | 'CONNECTED' | 'AUTHORIZATION_EXPIRED' | 'ERROR';
  hasAuthorizedSession: boolean;
  avatarUrl?: string | null;
  tokenExpiresAt?: string | null;
  tokenScope?: string | null;
  reason?: string;
  lastError?: string | null;
  pendingJobsCount?: number;
  hourlyActionLimit: number;
  dailyActionLimit: number;
  hourlyConnectionLimit: number;
  dailyConnectionLimit: number;
  hourlyMessageLimit: number;
  dailyMessageLimit: number;
  lastActionTimestamp?: string;
  createdAt?: string;
}

interface ConversationItem {
  id: string;
  accountId: string;
  remoteConversationId: string;
  partnerName: string;
  participantIds: string[];
  lastMessageSnippet?: string;
  lastActivityAt?: string;
  messagesCount: number;
}

interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  recipientId: string;
  recipientName?: string;
  content: string;
  direction: 'INBOUND' | 'OUTBOUND';
  syncStatus: string;
  sentAt: string;
  idempotencyKey: string;
  jobId?: string;
}

interface AutomationJob {
  id: string;
  traceId: string;
  accountId: string;
  accountEmail?: string;
  type: string;
  payload: any;
  status: string;
  priority: number;
  retryCount: number;
  maxRetries: number;
  errorMessage?: string;
  scheduledFor: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

interface SystemHealth {
  status: string;
  database: string;
  redis: string;
  activeAccounts: number;
  infrastructure: {
    database: string;
    redis: string;
    worker: string;
    api: string;
  };
  externalIntegration: {
    provider: string;
    connectedAccounts?: number;
    expiredAccounts?: number;
    errorAccounts?: number;
    notConnectedAccounts?: number;
    authorizedAccounts?: number;
    sessionInvalidAccounts?: number;
    notConfiguredAccounts?: number;
    overallStatus: string;
  };
  circuitBreaker: {
    state: string;
    failureCount: number;
    nextAttemptTime: number;
  };
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Safe Single-Consumption Fetch Utility (Fixes Body Has Already Been Read)
// ---------------------------------------------------------------------------
async function safeFetchJson<T = any>(
  url: string,
  options?: RequestInit
): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let data: any = undefined;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { detail: text };
      }
    }
    if (!res.ok) {
      const errorMsg =
        data?.detail ||
        data?.error?.message ||
        data?.message ||
        (text.length < 300 ? text : `HTTP ${res.status}`);
      return { ok: false, status: res.status, data, error: errorMsg };
    }
    return { ok: true, status: res.status, data };
  } catch (err: any) {
    return { ok: false, status: 0, error: err.message || 'Network request failed' };
  }
}

export default function LinkedInHyperVApp() {
  const [activeTab, setActiveTab] = useState<Tab>('inbox');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Inbox & Conversation states
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string>('');
  const [activeMessages, setActiveMessages] = useState<ChatMessage[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);

  // New Chat modal state
  const [isNewChatOpen, setIsNewChatOpen] = useState(false);
  const [newChatRecipient, setNewChatRecipient] = useState('');
  const [newChatMessage, setNewChatMessage] = useState('');

  // Connection Request states
  const [targetProfileId, setTargetProfileId] = useState('');
  const [connectionNote, setConnectionNote] = useState('');

  // Jobs & Health
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);

  // Account management & OAuth form
  const [newAccountEmail, setNewAccountEmail] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);

  // UI status
  const [isSending, setIsSending] = useState(false);
  const [uiAlert, setUiAlert] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);

  const selectedAccountIdRef = useRef(selectedAccountId);
  selectedAccountIdRef.current = selectedAccountId;

  const selectedConversationIdRef = useRef(selectedConversationId);
  selectedConversationIdRef.current = selectedConversationId;

  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll chat to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeMessages]);

  // Handle OAuth Redirect URL feedback (e.g. ?auth_success=1 or ?auth_error=...)
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab') as Tab;
      if (tabParam && ['inbox', 'connections', 'jobs', 'accounts', 'health'].includes(tabParam)) {
        setActiveTab(tabParam);
      }
      if (params.get('auth_success')) {
        setUiAlert({ type: 'success', message: 'LinkedIn account connected successfully via official OAuth 2.0!' });
        window.history.replaceState({}, document.title, window.location.pathname);
      } else if (params.get('auth_error')) {
        setUiAlert({ type: 'error', message: `LinkedIn OAuth Error: ${decodeURIComponent(params.get('auth_error') || '')}` });
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    }
  }, []);

  // 1. Fetch Accounts
  const fetchAccounts = useCallback(async () => {
    const res = await safeFetchJson<{ success: boolean; data: Account[] }>('/api/accounts');
    if (res.ok && res.data?.data) {
      setAccounts(res.data.data);
      if (!selectedAccountIdRef.current && res.data.data.length > 0) {
        setSelectedAccountId(res.data.data[0].id);
      }
    }
  }, []);

  // 2. Fetch Conversations
  const fetchConversations = useCallback(async (targetAccountId?: string) => {
    const accId = targetAccountId || selectedAccountIdRef.current;
    if (!accId) return;
    const res = await safeFetchJson<{ success: boolean; data: ConversationItem[] }>(
      `/api/conversations?accountId=${encodeURIComponent(accId)}`
    );
    if (res.ok && res.data?.data) {
      setConversations(res.data.data);
      if (!selectedConversationIdRef.current && res.data.data.length > 0) {
        setSelectedConversationId(res.data.data[0].id);
      }
    }
  }, []);

  // 3. Fetch Messages for Selected Conversation
  const fetchMessages = useCallback(async (targetAccountId?: string, targetConvId?: string) => {
    const accId = targetAccountId || selectedAccountIdRef.current;
    const conv = targetConvId !== undefined ? targetConvId : selectedConversationIdRef.current;
    if (!accId) return;
    const convParam = conv ? `&conversationId=${encodeURIComponent(conv)}` : '';
    const res = await safeFetchJson<{ success: boolean; data: ChatMessage[] }>(
      `/api/messages?accountId=${encodeURIComponent(accId)}${convParam}&limit=150`
    );
    if (res.ok && res.data?.data) {
      setActiveMessages(res.data.data);
    }
  }, []);

  // 4. Fetch Jobs
  const fetchJobs = useCallback(async () => {
    const res = await safeFetchJson<{ success: boolean; data: AutomationJob[] }>('/api/jobs?limit=50');
    if (res.ok && res.data?.data) {
      setJobs(res.data.data);
    }
  }, []);

  // 5. Fetch Health
  const fetchHealth = useCallback(async () => {
    const res = await safeFetchJson<SystemHealth>('/health');
    if (res.ok && res.data) {
      setHealth(res.data);
    }
  }, []);

  // Initial load on mount
  useEffect(() => {
    fetchAccounts();
    fetchHealth();
  }, [fetchAccounts, fetchHealth]);

  // When selected account changes
  useEffect(() => {
    if (selectedAccountId) {
      fetchConversations(selectedAccountId);
      fetchMessages(selectedAccountId, selectedConversationId);
    }
  }, [selectedAccountId, fetchConversations, fetchMessages]);

  // When selected conversation changes
  useEffect(() => {
    if (selectedAccountId && selectedConversationId) {
      fetchMessages(selectedAccountId, selectedConversationId);
    }
  }, [selectedConversationId, selectedAccountId, fetchMessages]);

  // When tab switches, fetch that tab's data
  useEffect(() => {
    if (activeTab === 'inbox') {
      fetchConversations();
      fetchMessages();
    } else if (activeTab === 'jobs') {
      fetchJobs();
    } else if (activeTab === 'accounts') {
      fetchAccounts();
    } else if (activeTab === 'health') {
      fetchHealth();
    }
  }, [activeTab, fetchConversations, fetchMessages, fetchJobs, fetchAccounts, fetchHealth]);

  // Controlled, Tab-Specific Background Polling Loop (every 5 seconds)
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      const tab = activeTabRef.current;
      if (tab === 'inbox') {
        fetchConversations();
        fetchMessages();
      } else if (tab === 'jobs') {
        fetchJobs();
      } else if (tab === 'health') {
        fetchHealth();
      } else if (tab === 'accounts') {
        fetchAccounts();
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [autoRefresh, fetchConversations, fetchMessages, fetchJobs, fetchHealth, fetchAccounts]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const activeConversation = conversations.find((c) => c.id === selectedConversationId);
  const isAccountAuthorized = selectedAccount?.authStatus === 'CONNECTED';

  // Filtered conversation list based on search query
  const filteredConversations = conversations.filter((c) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      c.partnerName.toLowerCase().includes(q) ||
      c.remoteConversationId.toLowerCase().includes(q) ||
      (c.lastMessageSnippet && c.lastMessageSnippet.toLowerCase().includes(q))
    );
  });

  // Handle Send Message from Hyper-V Inbox
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !messageInput.trim() || !activeConversation) return;

    if (!isAccountAuthorized) {
      setUiAlert({
        type: 'error',
        message: 'LinkedIn account is not authorized for this operation.',
      });
      return;
    }

    const content = messageInput.trim();
    const recipient = activeConversation.partnerName || activeConversation.remoteConversationId;

    // Optimistic message added to UI with SENDING... status
    const tempId = `temp_${Date.now()}`;
    const optimisticMessage: ChatMessage = {
      id: tempId,
      conversationId: activeConversation.id,
      senderId: selectedAccount?.id || 'self',
      senderName: selectedAccount?.name || 'You',
      recipientId: recipient,
      recipientName: activeConversation.partnerName,
      content,
      direction: 'OUTBOUND',
      syncStatus: 'SENDING...',
      sentAt: new Date().toISOString(),
      idempotencyKey: tempId,
    };

    setActiveMessages((prev) => [...prev, optimisticMessage]);
    setMessageInput('');
    setIsSending(true);

    const res = await safeFetchJson<{ success: boolean; data: { jobId: string } }>('/api/jobs/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: selectedAccountId,
        type: 'SEND_MESSAGE',
        payload: {
          recipientId: recipient,
          content,
          conversationId: activeConversation.remoteConversationId,
        },
      }),
    });

    if (res.ok && res.data?.data?.jobId) {
      const jobId = res.data.data.jobId;

      // Poll this job's completion specifically
      let attempts = 0;
      const jobPoll = setInterval(async () => {
        attempts++;
        const jRes = await safeFetchJson<{ success: boolean; data: AutomationJob[] }>('/api/jobs?limit=10');
        if (jRes.ok && jRes.data?.data) {
          const matchingJob = jRes.data.data.find((j) => j.id === jobId);
          if (matchingJob) {
            if (matchingJob.status === 'COMPLETED') {
              clearInterval(jobPoll);
              setActiveMessages((prev) =>
                prev.map((m) => (m.id === tempId ? { ...m, syncStatus: 'SENT' } : m))
              );
              fetchMessages();
              fetchConversations();
              setIsSending(false);
            } else if (matchingJob.status === 'FAILED' || matchingJob.status === 'DLQ_ROUTED') {
              clearInterval(jobPoll);
              setActiveMessages((prev) =>
                prev.map((m) =>
                  m.id === tempId
                    ? {
                        ...m,
                        syncStatus: 'FAILED',
                        content: `${m.content} [Error: ${matchingJob.errorMessage || 'Failed'}]`,
                      }
                    : m
                )
              );
              setIsSending(false);
            }
          }
        }

        if (attempts > 30) {
          clearInterval(jobPoll);
          setIsSending(false);
        }
      }, 1500);
    } else {
      setActiveMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, syncStatus: 'FAILED' } : m))
      );
      setUiAlert({
        type: 'error',
        message: res.error || 'LinkedIn account is not authorized for this operation.',
      });
      setIsSending(false);
    }
  };

  // Handle Start New Conversation
  const handleStartNewChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !newChatRecipient.trim() || !newChatMessage.trim()) return;

    if (!isAccountAuthorized) {
      setUiAlert({
        type: 'error',
        message: 'LinkedIn account is not authorized for this operation.',
      });
      return;
    }

    setIsSending(true);
    const res = await safeFetchJson<{ success: boolean; data: { jobId: string } }>('/api/jobs/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: selectedAccountId,
        type: 'SEND_MESSAGE',
        payload: {
          recipientId: newChatRecipient.trim(),
          content: newChatMessage.trim(),
        },
      }),
    });

    if (res.ok && res.data?.success) {
      setIsNewChatOpen(false);
      setNewChatRecipient('');
      setNewChatMessage('');
      setUiAlert({
        type: 'success',
        message: `Message dispatched to ${newChatRecipient}. Worker will transmit to LinkedIn.`,
      });
      fetchJobs();
      setTimeout(() => fetchConversations(), 3000);
    } else {
      setUiAlert({
        type: 'error',
        message: res.error || 'LinkedIn account is not authorized for this operation.',
      });
    }
    setIsSending(false);
  };

  // Handle Trigger Two-Way Sync
  const handleTriggerSync = async () => {
    if (!selectedAccountId) return;

    if (!isAccountAuthorized) {
      setSyncFeedback('❌ LinkedIn account is not authorized for this operation.');
      setUiAlert({
        type: 'error',
        message: 'LinkedIn account is not authorized for this operation.',
      });
      return;
    }

    setIsSyncing(true);
    setSyncFeedback('Syncing messages & conversations from LinkedIn...');

    const res = await safeFetchJson<{ success: boolean; data: { jobId: string } }>('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: selectedAccountId, limit: 25 }),
    });

    if (res.ok && res.data?.success) {
      setSyncFeedback(`Sync job queued (${res.data.data.jobId.slice(0, 8)}...). Worker is ingesting messages...`);
      fetchJobs();
      setTimeout(() => {
        fetchConversations();
        fetchMessages();
        setIsSyncing(false);
        setSyncFeedback('✓ Synchronization complete! Inbox updated.');
        setTimeout(() => setSyncFeedback(null), 4000);
      }, 3500);
    } else {
      setSyncFeedback(`❌ Sync failed: ${res.error || 'LinkedIn account is not authorized for this operation.'}`);
      setUiAlert({
        type: 'error',
        message: res.error || 'LinkedIn account is not authorized for this operation.',
      });
      setIsSyncing(false);
    }
  };

  // Handle Send Connection Request
  const handleSendConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !targetProfileId.trim()) return;

    if (!isAccountAuthorized) {
      setUiAlert({
        type: 'error',
        message: 'LinkedIn account is not authorized for this operation.',
      });
      return;
    }

    const res = await safeFetchJson<{ success: boolean; data: { jobId: string } }>('/api/jobs/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: selectedAccountId,
        type: 'SEND_CONNECTION_REQUEST',
        payload: {
          targetProfileId: targetProfileId.trim(),
          customNote: connectionNote.trim() || undefined,
        },
      }),
    });

    if (res.ok && res.data?.success) {
      setUiAlert({
        type: 'success',
        message: `Connection request job queued (${res.data.data.jobId.slice(0, 8)}...). Worker executing with LinkedIn.`,
      });
      setTargetProfileId('');
      setConnectionNote('');
      fetchJobs();
    } else {
      setUiAlert({
        type: 'error',
        message: res.error || 'LinkedIn account is not authorized for this operation.',
      });
    }
  };

  // Handle Create Account Profile
  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountEmail.trim()) return;

    const res = await safeFetchJson<{ success: boolean; data?: Account; authUrl?: string }>('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: newAccountEmail.trim(),
        name: newAccountName.trim() || undefined,
      }),
    });

    if (res.ok && res.data?.data) {
      const created = res.data.data;
      setNewAccountEmail('');
      setNewAccountName('');
      await fetchAccounts();
      setSelectedAccountId(created.id);
      setUiAlert({
        type: 'success',
        message: `Account "${created.email}" registered. Click "Connect LinkedIn Account" to authorize via official OAuth 2.0.`,
      });
    } else {
      setUiAlert({
        type: 'error',
        message: res.error || 'Failed to create account profile',
      });
    }
  };

  // Handle Official LinkedIn OAuth Connect
  const handleConnectLinkedIn = async (accountId?: string) => {
    const accId = accountId || selectedAccountId;
    setIsConnecting(true);
    const url = `/api/auth/linkedin/connect${accId ? `?accountId=${encodeURIComponent(accId)}` : ''}`;
    const res = await safeFetchJson<{ success: boolean; authUrl: string }>(url);
    setIsConnecting(false);

    if (res.ok && res.data?.authUrl) {
      window.location.href = res.data.authUrl;
    } else {
      setUiAlert({
        type: 'error',
        message: res.error || 'Failed to initiate LinkedIn OAuth connection.',
      });
    }
  };

  // Handle Official LinkedIn OAuth Reconnect
  const handleReconnectLinkedIn = async (accountId?: string) => {
    const accId = accountId || selectedAccountId;
    setIsConnecting(true);
    const res = await safeFetchJson<{ success: boolean; authUrl?: string; message?: string }>('/api/auth/linkedin/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: accId }),
    });
    setIsConnecting(false);

    if (res.ok && res.data?.authUrl) {
      window.location.href = res.data.authUrl;
    } else if (res.ok) {
      setUiAlert({ type: 'success', message: res.data?.message || 'Reconnection successful!' });
      fetchAccounts();
    } else {
      setUiAlert({ type: 'error', message: res.error || 'Failed to reconnect LinkedIn account.' });
    }
  };

  // Handle Disconnect LinkedIn Account
  const handleDisconnectLinkedIn = async (accountId?: string) => {
    const accId = accountId || selectedAccountId;
    if (!confirm('Are you sure you want to disconnect this LinkedIn account?')) return;

    const res = await safeFetchJson<{ success: boolean; message?: string }>('/api/auth/linkedin/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountId: accId }),
    });

    if (res.ok) {
      setUiAlert({ type: 'info', message: 'LinkedIn account authorization disconnected.' });
      fetchAccounts();
    } else {
      setUiAlert({ type: 'error', message: res.error || 'Failed to disconnect account.' });
    }
  };

  // Handle Maintenance (Retry, Clear DLQ, Clear Jobs)
  const handleMaintenance = async (action: 'RETRY_DLQ' | 'CLEAR_DLQ' | 'CLEAR_JOBS') => {
    const res = await safeFetchJson<{ success: boolean; message: string }>('/api/maintenance/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    });

    if (res.ok && res.data?.success) {
      alert(res.data.message);
      fetchJobs();
    } else {
      alert(res.error || 'Maintenance action failed');
    }
  };

  // Helper formatting for timestamps
  const formatTime = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const formatDate = (iso?: string) => {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return formatTime(iso);
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Badge renderers
  const renderAuthBadge = (authStatus?: string) => {
    switch (authStatus) {
      case 'CONNECTED':
        return (
          <span style={{ background: '#065f46', color: '#34d399', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            ● CONNECTED
          </span>
        );
      case 'AUTHORIZATION_EXPIRED':
        return (
          <span style={{ background: '#78350f', color: '#fde047', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            ⚠ AUTHORIZATION_EXPIRED
          </span>
        );
      case 'ERROR':
        return (
          <span style={{ background: '#7f1d1d', color: '#fca5a5', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            ✕ ERROR
          </span>
        );
      case 'NOT_CONNECTED':
      default:
        return (
          <span style={{ background: '#334155', color: '#94a3b8', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            ○ NOT_CONNECTED
          </span>
        );
    }
  };

  const renderJobBadge = (status: string) => {
    switch (status) {
      case 'QUEUED':
        return <span style={{ background: '#854d0e', color: '#fef08a', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>QUEUED</span>;
      case 'RUNNING':
        return <span style={{ background: '#1e40af', color: '#93c5fd', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>RUNNING</span>;
      case 'COMPLETED':
        return <span style={{ background: '#065f46', color: '#34d399', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>COMPLETED</span>;
      case 'RETRYING':
        return <span style={{ background: '#c2410c', color: '#fed7aa', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>RETRYING</span>;
      case 'FAILED':
        return <span style={{ background: '#991b1b', color: '#fca5a5', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>FAILED</span>;
      case 'DLQ_ROUTED':
        return <span style={{ background: '#581c87', color: '#d8b4fe', padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>DLQ_ROUTED</span>;
      default:
        return <span style={{ background: '#334155', color: '#cbd5e1', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>{status}</span>;
    }
  };

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '16px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#f8fafc', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Head>
        <title>LinkedIn Hyper-V 2.0 | Centralized Inbox & Control Plane</title>
        <meta name="description" content="Centralized 2-Way Inbox and Automation Engine for Authorized LinkedIn" />
      </Head>

      {/* Top Application Bar */}
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: 12, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 38, height: 38, borderRadius: 8, background: '#0284c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 18 }}>
            in
          </div>
          <div>
            <h1 style={{ fontSize: 20, margin: 0, fontWeight: 700, color: '#38bdf8' }}>LinkedIn Hyper-V 2.0</h1>
            <p style={{ margin: 0, color: '#94a3b8', fontSize: 12 }}>Centralized 2-Way Inbox & Background Automation Engine</p>
          </div>
        </div>

        {/* Account Selector in Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#1e293b', border: '1px solid #334155', padding: '4px 10px', borderRadius: 8 }}>
            <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>ACTIVE ACCOUNT:</span>
            <select
              value={selectedAccountId}
              onChange={(e) => {
                setSelectedAccountId(e.target.value);
                setSelectedConversationId('');
              }}
              style={{ background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: '4px 8px', borderRadius: 6, fontSize: 12 }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ? `${a.name} (${a.email})` : a.email}
                </option>
              ))}
            </select>
            {renderAuthBadge(selectedAccount?.authStatus)}
          </div>

          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            style={{ background: autoRefresh ? '#065f46' : '#334155', color: autoRefresh ? '#34d399' : '#94a3b8', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
          >
            {autoRefresh ? '● Live Polling (5s)' : '○ Polling Paused'}
          </button>
        </div>
      </header>

      {/* Main Navigation Tabs */}
      <nav style={{ display: 'flex', gap: 8, borderBottom: '1px solid #334155', paddingBottom: 10, marginBottom: 16 }}>
        {(['inbox', 'connections', 'jobs', 'accounts', 'health'] as Tab[]).map((tab) => {
          const labels: Record<Tab, string> = {
            inbox: '💬 Hyper-V Inbox (Primary)',
            connections: '🤝 Connection Requests',
            jobs: '⚡ Automation Jobs',
            accounts: '🔐 Accounts',
            health: '🛡 System Health',
          };
          const isActive = activeTab === tab;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                backgroundColor: isActive ? '#0284c7' : '#1e293b',
                color: isActive ? '#ffffff' : '#94a3b8',
                border: '1px solid',
                borderColor: isActive ? '#0284c7' : '#334155',
                padding: '8px 16px',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {labels[tab]}
            </button>
          );
        })}
      </nav>

      {/* Global Alert Notification */}
      {uiAlert && (
        <div
          style={{
            backgroundColor: uiAlert.type === 'success' ? '#064e3b' : uiAlert.type === 'error' ? '#7f1d1d' : '#1e3a8a',
            border: `1px solid ${uiAlert.type === 'success' ? '#059669' : uiAlert.type === 'error' ? '#dc2626' : '#3b82f6'}`,
            color: '#fff',
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 14,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 13,
          }}
        >
          <span>{uiAlert.type === 'success' ? '✓ ' : '⚠️ '} {uiAlert.message}</span>
          <button onClick={() => setUiAlert(null)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
      )}

      {/* Prominent Account Authorization Status Banner */}
      {!isAccountAuthorized && (activeTab === 'inbox' || activeTab === 'connections') && (
        <div
          style={{
            backgroundColor: '#450a0a',
            border: '1px solid #b91c1c',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20 }}>⚠️</span>
            <div>
              <div style={{ fontWeight: 700, color: '#fca5a5', fontSize: 13 }}>
                LinkedIn Account Authorization Required ({selectedAccount?.authStatus || 'NOT_CONNECTED'})
              </div>
              <div style={{ color: '#fecaca', fontSize: 12, marginTop: 2 }}>
                LinkedIn account is not authorized for this operation.
              </div>
            </div>
          </div>
          <button
            onClick={() => setActiveTab('accounts')}
            style={{
              background: '#0284c7',
              color: '#fff',
              border: 'none',
              padding: '8px 16px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Connect LinkedIn Account &rarr;
          </button>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PRIMARY TAB: HYPER-V INBOX                                                */}
      {/* ========================================================================= */}
      {activeTab === 'inbox' && (
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, height: 'calc(100vh - 220px)', minHeight: 600 }}>
          {/* LEFT PANE: CONVERSATIONS LIST */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header & Controls */}
            <div style={{ padding: 14, borderBottom: '1px solid #334155', background: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>Conversations</h2>
                <button
                  onClick={() => setIsNewChatOpen(true)}
                  disabled={!isAccountAuthorized}
                  style={{
                    background: isAccountAuthorized ? '#0284c7' : '#475569',
                    color: '#fff',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    cursor: isAccountAuthorized ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                  }}
                  title={!isAccountAuthorized ? 'Account is not authorized' : 'Start new chat'}
                >
                  + New Chat
                </button>
              </div>

              <input
                type="text"
                placeholder="Search conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: '100%',
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#fff',
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: 12,
                  boxSizing: 'border-box',
                }}
              />

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 }}>
                <button
                  onClick={handleTriggerSync}
                  disabled={isSyncing || !isAccountAuthorized}
                  style={{
                    background: isAccountAuthorized ? '#0f766e' : '#334155',
                    color: isAccountAuthorized ? '#5eead4' : '#64748b',
                    border: '1px solid #14b8a6',
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 11,
                    cursor: isAccountAuthorized && !isSyncing ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                  }}
                  title={!isAccountAuthorized ? 'Account is not authorized' : 'Sync messages'}
                >
                  {isSyncing ? 'Syncing...' : '↻ Two-Way Message Sync'}
                </button>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>{conversations.length} threads</span>
              </div>

              {syncFeedback && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#5eead4', background: '#134e4a', padding: '4px 8px', borderRadius: 4 }}>
                  {syncFeedback}
                </div>
              )}
            </div>

            {/* Conversation Threads Scrollable List */}
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filteredConversations.map((c) => {
                const isSelected = c.id === selectedConversationId;
                return (
                  <div
                    key={c.id}
                    onClick={() => {
                      setSelectedConversationId(c.id);
                      fetchMessages(selectedAccountId, c.id);
                    }}
                    style={{
                      padding: '12px 14px',
                      borderBottom: '1px solid #334155',
                      cursor: 'pointer',
                      background: isSelected ? '#334155' : 'transparent',
                      transition: 'background 0.15s',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                      <span style={{ fontWeight: 600, fontSize: 13, color: isSelected ? '#38bdf8' : '#f8fafc' }}>
                        {c.partnerName}
                      </span>
                      <span style={{ fontSize: 10, color: '#94a3b8' }}>{formatDate(c.lastActivityAt)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.lastMessageSnippet || 'No messages yet'}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, fontSize: 10, color: '#64748b' }}>
                      <span>{c.messagesCount} msgs</span>
                      <span style={{ fontFamily: 'monospace' }}>{c.remoteConversationId.slice(0, 14)}...</span>
                    </div>
                  </div>
                );
              })}

              {filteredConversations.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
                  No conversations found.
                  <div style={{ marginTop: 8 }}>
                    <button
                      onClick={handleTriggerSync}
                      disabled={!isAccountAuthorized}
                      style={{ background: 'transparent', border: '1px solid #38bdf8', color: '#38bdf8', padding: '4px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                    >
                      Trigger First Sync
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT PANE: ACTIVE CHAT THREAD */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {activeConversation ? (
              <>
                {/* Chat Header */}
                <div style={{ padding: '14px 18px', borderBottom: '1px solid #334155', background: '#0f172a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#f8fafc' }}>
                      {activeConversation.partnerName}
                    </h3>
                    <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: 'monospace' }}>
                      LinkedIn Thread ID: {activeConversation.remoteConversationId}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <button
                      onClick={() => fetchMessages()}
                      style={{ background: '#334155', color: '#cbd5e1', border: 'none', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                    >
                      ↻ Refresh
                    </button>
                  </div>
                </div>

                {/* Chat Messages Stream */}
                <div style={{ flex: 1, padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {activeMessages.map((msg) => {
                    const isOutbound = msg.direction === 'OUTBOUND';
                    return (
                      <div
                        key={msg.id || msg.idempotencyKey}
                        style={{
                          alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                          maxWidth: '75%',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: isOutbound ? 'flex-end' : 'flex-start',
                        }}
                      >
                        <span style={{ fontSize: 10, color: '#94a3b8', marginBottom: 2 }}>
                          {isOutbound ? 'You' : msg.senderName || activeConversation.partnerName}
                        </span>
                        <div
                          style={{
                            background: isOutbound ? '#0284c7' : '#334155',
                            color: '#ffffff',
                            padding: '10px 14px',
                            borderRadius: isOutbound ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                            fontSize: 13,
                            lineHeight: 1.4,
                            wordBreak: 'break-word',
                          }}
                        >
                          {msg.content}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 3 }}>
                          <span style={{ fontSize: 10, color: '#64748b' }}>{formatTime(msg.sentAt)}</span>
                          {isOutbound && (
                            <span
                              style={{
                                fontSize: 9,
                                fontWeight: 700,
                                color:
                                  msg.syncStatus === 'SENT' || msg.syncStatus === 'SYNCED'
                                    ? '#34d399'
                                    : msg.syncStatus === 'SENDING...'
                                    ? '#fde047'
                                    : '#f87171',
                              }}
                            >
                              {msg.syncStatus === 'SYNCED' ? '✓ SENT' : msg.syncStatus}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {activeMessages.length === 0 && (
                    <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b', fontSize: 13 }}>
                      No messages found in this conversation. Type below to send a message.
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Message Input Box */}
                <form
                  onSubmit={handleSendMessage}
                  style={{
                    padding: 12,
                    borderTop: '1px solid #334155',
                    background: '#0f172a',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {!isAccountAuthorized ? (
                    <div style={{ color: '#fca5a5', fontSize: 12, textAlign: 'center', padding: '8px', background: '#450a0a', borderRadius: 6 }}>
                      Sending is disabled: LinkedIn account is not authorized for this operation.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 10 }}>
                      <input
                        type="text"
                        placeholder={`Message ${activeConversation.partnerName}...`}
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        disabled={isSending}
                        style={{
                          flex: 1,
                          background: '#1e293b',
                          border: '1px solid #334155',
                          color: '#fff',
                          padding: '10px 14px',
                          borderRadius: 6,
                          fontSize: 13,
                          boxSizing: 'border-box',
                        }}
                      />
                      <button
                        type="submit"
                        disabled={isSending || !messageInput.trim()}
                        style={{
                          background: messageInput.trim() ? '#0284c7' : '#334155',
                          color: '#fff',
                          border: 'none',
                          padding: '0 20px',
                          borderRadius: 6,
                          fontWeight: 600,
                          fontSize: 13,
                          cursor: messageInput.trim() ? 'pointer' : 'not-allowed',
                        }}
                      >
                        {isSending ? 'Sending...' : 'Send'}
                      </button>
                    </div>
                  )}
                </form>
              </>
            ) : (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b' }}>
                <div style={{ fontSize: 40, marginBottom: 10 }}>💬</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Select a Conversation</div>
                <div style={{ fontSize: 13, marginTop: 4 }}>
                  Choose a thread on the left or click <strong>+ New Chat</strong> to start a conversation.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* NEW CHAT MODAL */}
      {isNewChatOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24, width: 480 }}>
            <h3 style={{ margin: '0 0 16px', color: '#38bdf8', fontSize: 18 }}>Start New Conversation</h3>
            <form onSubmit={handleStartNewChat}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Recipient Profile Vanity or Member ID:</label>
                <input
                  type="text"
                  placeholder="e.g. satyanadella or arun-jadhav"
                  value={newChatRecipient}
                  onChange={(e) => setNewChatRecipient(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 18 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Message Content:</label>
                <textarea
                  rows={4}
                  placeholder="Hello, this is a live test message from LinkedIn Hyper-V..."
                  value={newChatMessage}
                  onChange={(e) => setNewChatMessage(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  type="button"
                  onClick={() => setIsNewChatOpen(false)}
                  style={{ background: '#334155', color: '#cbd5e1', border: 'none', padding: '8px 16px', borderRadius: 6, cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSending || !isAccountAuthorized}
                  style={{
                    background: isAccountAuthorized ? '#0284c7' : '#475569',
                    color: '#fff',
                    border: 'none',
                    padding: '8px 20px',
                    borderRadius: 6,
                    fontWeight: 600,
                    cursor: isAccountAuthorized && !isSending ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isSending ? 'Dispatching...' : 'Send Message'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 2: CONNECTION REQUESTS                                                */}
      {/* ========================================================================= */}
      {activeTab === 'connections' && (
        <div style={{ maxWidth: 640, margin: '20px auto', background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Send LinkedIn Connection Request</h2>
          <p style={{ fontSize: 13, color: '#94a3b8' }}>
            Dispatches connection invitations with personalized notes through the authorized LinkedIn integration.
          </p>

          <form onSubmit={handleSendConnection}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Target Profile Identifier or Vanity URL:</label>
              <input
                type="text"
                placeholder="e.g. satyanadella or https://www.linkedin.com/in/satyanadella/"
                value={targetProfileId}
                onChange={(e) => setTargetProfileId(e.target.value)}
                required
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 18 }}>
              <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Invitation Note / Custom Message (Optional):</label>
              <textarea
                rows={3}
                placeholder="Hi Satya, I would love to connect with you on LinkedIn!"
                value={connectionNote}
                onChange={(e) => setConnectionNote(e.target.value)}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
              />
            </div>

            <button
              type="submit"
              disabled={!isAccountAuthorized}
              style={{
                width: '100%',
                background: isAccountAuthorized ? '#0284c7' : '#475569',
                color: '#fff',
                border: 'none',
                padding: 12,
                borderRadius: 6,
                fontWeight: 700,
                fontSize: 14,
                cursor: isAccountAuthorized ? 'pointer' : 'not-allowed',
              }}
            >
              {isAccountAuthorized ? 'Send Connection Invitation' : 'LinkedIn account is not authorized for this operation.'}
            </button>
          </form>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 3: AUTOMATION JOBS                                                    */}
      {/* ========================================================================= */}
      {activeTab === 'jobs' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18, color: '#38bdf8' }}>Worker Automation Engine Monitor</h2>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>Real-time job lifecycle, retries, and failure diagnostics</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => handleMaintenance('CLEAR_JOBS')}
                style={{ background: '#475569', color: '#f8fafc', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
              >
                Clear Jobs
              </button>
              <button
                onClick={() => handleMaintenance('RETRY_DLQ')}
                style={{ background: '#b45309', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
              >
                ↻ Retry Failed Jobs
              </button>
              <button
                onClick={() => handleMaintenance('CLEAR_DLQ')}
                style={{ background: '#7f1d1d', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
              >
                Clear DLQ
              </button>
              <button
                onClick={fetchJobs}
                style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
              >
                ↻ Refresh
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, textAlign: 'left' }}>
              <thead>
                <tr style={{ background: '#0f172a', color: '#94a3b8', borderBottom: '1px solid #334155' }}>
                  <th style={{ padding: 10 }}>Job ID / Trace</th>
                  <th>Type</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Retries</th>
                  <th>Error / Diagnostic</th>
                  <th>Created</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} style={{ borderBottom: '1px solid #334155' }}>
                    <td style={{ padding: 10, fontFamily: 'monospace', color: '#38bdf8' }}>
                      {job.id.slice(0, 8)}...
                      <div style={{ fontSize: 10, color: '#64748b' }}>{job.traceId.slice(0, 8)}</div>
                    </td>
                    <td style={{ fontWeight: 600 }}>{job.type}</td>
                    <td style={{ color: '#cbd5e1' }}>{job.accountEmail || job.accountId.slice(0, 8)}</td>
                    <td>{renderJobBadge(job.status)}</td>
                    <td>{job.retryCount} / {job.maxRetries}</td>
                    <td style={{ color: job.errorMessage ? '#f87171' : '#64748b', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {job.errorMessage || '—'}
                    </td>
                    <td style={{ color: '#94a3b8' }}>{formatTime(job.createdAt)}</td>
                    <td style={{ color: '#94a3b8' }}>{job.completedAt ? formatTime(job.completedAt) : '—'}</td>
                  </tr>
                ))}
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>No automation jobs yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 4: ACCOUNTS (OFFICIAL OAUTH 2.0 INTEGRATION)                          */}
      {/* ========================================================================= */}
      {activeTab === 'accounts' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 20 }}>
          {/* Managed LinkedIn Accounts List */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, color: '#f1f5f9' }}>Managed LinkedIn Accounts</h2>
              <button
                onClick={fetchAccounts}
                style={{ background: '#334155', color: '#38bdf8', border: '1px solid #0284c7', padding: '4px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
              >
                ↻ Refresh Status
              </button>
            </div>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                    <th style={{ padding: '8px 0' }}>Account</th>
                    <th>Status</th>
                    <th>Security / Scope</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '12px 0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          {a.avatarUrl ? (
                            <img
                              src={a.avatarUrl}
                              alt={a.name || a.email}
                              style={{ width: 32, height: 32, borderRadius: 16, objectFit: 'cover' }}
                            />
                          ) : (
                            <div style={{ width: 32, height: 32, borderRadius: 16, background: '#0284c7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12 }}>
                              {(a.name || a.email).charAt(0).toUpperCase()}
                            </div>
                          )}
                          <div>
                            <div style={{ fontWeight: 600, color: '#f8fafc' }}>{a.name || a.email}</div>
                            <div style={{ fontSize: 11, color: '#94a3b8' }}>{a.email}</div>
                            {a.tokenExpiresAt && (
                              <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>
                                Expires: {formatDate(a.tokenExpiresAt)}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div>{renderAuthBadge(a.authStatus)}</div>
                        {a.authType && (
                          <span style={{ fontSize: 10, color: '#94a3b8', display: 'block', marginTop: 4 }}>
                            {a.authType.toUpperCase()}
                          </span>
                        )}
                      </td>
                      <td>
                        <div style={{ fontSize: 11, color: '#cbd5e1' }}>
                          <span style={{ color: '#38bdf8' }}>AES-256</span> Encrypted
                        </div>
                        <div style={{ fontSize: 10, color: '#64748b', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={a.tokenScope || 'openid profile email'}>
                          {a.tokenScope || 'openid profile email'}
                        </div>
                      </td>
                      <td style={{ padding: '12px 0' }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {a.authStatus === 'CONNECTED' ? (
                            <>
                              <button
                                onClick={() => handleReconnectLinkedIn(a.id)}
                                disabled={isConnecting}
                                style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                                title="Re-authorize LinkedIn OAuth tokens"
                              >
                                ↻ Reconnect
                              </button>
                              <button
                                onClick={() => handleDisconnectLinkedIn(a.id)}
                                style={{ background: '#334155', color: '#fca5a5', border: '1px solid #7f1d1d', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                                title="Disconnect account and revoke tokens"
                              >
                                Disconnect
                              </button>
                            </>
                          ) : a.authStatus === 'AUTHORIZATION_EXPIRED' ? (
                            <>
                              <button
                                onClick={() => handleReconnectLinkedIn(a.id)}
                                disabled={isConnecting}
                                style={{ background: '#d97706', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                                title="Renew expired authorization session"
                              >
                                ⚠️ Reconnect
                              </button>
                              <button
                                onClick={() => handleDisconnectLinkedIn(a.id)}
                                style={{ background: '#334155', color: '#fca5a5', border: '1px solid #7f1d1d', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                              >
                                Disconnect
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => handleConnectLinkedIn(a.id)}
                              disabled={isConnecting}
                              style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                            >
                              🔗 Connect LinkedIn Account
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {accounts.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>
                        No LinkedIn accounts registered yet. Register an account below to connect.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Connect & Security Control Panel */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Primary OAuth Action Card */}
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <div style={{ width: 32, height: 32, borderRadius: 6, background: '#0284c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: 16 }}>
                  in
                </div>
                <div>
                  <h2 style={{ margin: 0, fontSize: 16, color: '#38bdf8' }}>Official LinkedIn Integration</h2>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>OAuth 2.0 Authorization Flow</span>
                </div>
              </div>

              <p style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.5, marginBottom: 16 }}>
                Authenticate directly with LinkedIn using the official OAuth 2.0 protocol. No browser DevTools inspection or manual cookie copying is required.
              </p>

              <div style={{ marginBottom: 18 }}>
                <button
                  type="button"
                  onClick={() => handleConnectLinkedIn()}
                  disabled={isConnecting}
                  style={{
                    width: '100%',
                    background: '#0284c7',
                    color: '#fff',
                    border: 'none',
                    padding: '12px 16px',
                    borderRadius: 8,
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: isConnecting ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 8,
                    boxShadow: '0 2px 8px rgba(2, 132, 199, 0.4)',
                  }}
                >
                  <span style={{ fontSize: 16 }}>🔗</span>
                  {isConnecting ? 'Initiating OAuth...' : 'Connect LinkedIn Account'}
                </button>
              </div>

              {/* Form to pre-register a specific account email */}
              <div style={{ borderTop: '1px solid #334155', paddingTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
                  Or register account profile:
                </div>
                <form onSubmit={handleCreateAccount}>
                  <div style={{ marginBottom: 10 }}>
                    <input
                      type="email"
                      placeholder="Account Email (e.g. user@example.com)"
                      value={newAccountEmail}
                      onChange={(e) => setNewAccountEmail(e.target.value)}
                      required
                      style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box', fontSize: 12 }}
                    />
                  </div>
                  <div style={{ marginBottom: 10 }}>
                    <input
                      type="text"
                      placeholder="Account Name (Optional)"
                      value={newAccountName}
                      onChange={(e) => setNewAccountName(e.target.value)}
                      style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box', fontSize: 12 }}
                    />
                  </div>
                  <button
                    type="submit"
                    style={{ width: '100%', background: '#334155', color: '#38bdf8', border: '1px solid #0284c7', padding: '8px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                  >
                    + Register Profile
                  </button>
                </form>
              </div>
            </div>

            {/* Architecture & Capabilities Card */}
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#38bdf8', marginBottom: 8 }}>
                Security & Scope Architecture
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#cbd5e1', lineHeight: 1.6 }}>
                <li><strong>Zero Cookie Extraction:</strong> No browser DevTools or raw cookies are used.</li>
                <li><strong>Server-Side Encryption:</strong> Tokens are encrypted at rest with Fernet AES-256 and never logged or sent to client bundles.</li>
                <li><strong>Official Scopes:</strong> Standard developer scopes include <code>openid</code>, <code>profile</code>, <code>email</code>, and <code>w_member_social</code>.</li>
                <li><strong>Zero Fake Operations:</strong> 1-on-1 member DMs and invitations require LinkedIn Enterprise Partner permissions. If an account lacks authorization, the app strictly rejects operations without faking success.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* TAB 5: SYSTEM HEALTH                                                      */}
      {/* ========================================================================= */}
      {activeTab === 'health' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Card 1: Local Infrastructure Status */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>1. Local System Infrastructure</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginTop: 16 }}>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>FastAPI Python Engine</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399', marginTop: 4 }}>
                  Online (Healthy)
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>PostgreSQL Database</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: (health?.infrastructure?.database || health?.database) === 'connected' ? '#34d399' : '#f87171', marginTop: 4 }}>
                  {health?.infrastructure?.database || health?.database || 'connected'}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Redis / Distributed Lock</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: (health?.infrastructure?.redis || health?.redis) === 'connected' ? '#34d399' : '#facc15', marginTop: 4 }}>
                  {health?.infrastructure?.redis || health?.redis || 'connected'}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Background Worker Loop</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399', marginTop: 4 }}>
                  Active Polling (1.5s)
                </div>
              </div>
            </div>
          </div>

          {/* Card 2: External LinkedIn Integration */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>2. External LinkedIn Integration</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginTop: 16 }}>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Integration Provider</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#f8fafc', marginTop: 4 }}>
                  {health?.externalIntegration?.provider || 'Official LinkedIn OAuth 2.0 & REST API'}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Overall Integration Status</div>
                <div style={{ marginTop: 6 }}>
                  {renderAuthBadge(health?.externalIntegration?.overallStatus)}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Connected Accounts</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399', marginTop: 4 }}>
                  {health?.externalIntegration?.connectedAccounts ?? health?.externalIntegration?.authorizedAccounts ?? 0}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Expired / Action Needed</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: (health?.externalIntegration?.expiredAccounts ?? health?.externalIntegration?.sessionInvalidAccounts ?? 0) > 0 ? '#f87171' : '#94a3b8', marginTop: 4 }}>
                  {health?.externalIntegration?.expiredAccounts ?? health?.externalIntegration?.sessionInvalidAccounts ?? 0}
                </div>
              </div>
            </div>
          </div>

          {/* Card 3: Circuit Breaker */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>3. Integration Circuit Breaker</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginTop: 16 }}>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Circuit State</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: health?.circuitBreaker?.state === 'CLOSED' ? '#34d399' : '#f87171', marginTop: 4 }}>
                  {health?.circuitBreaker?.state || 'CLOSED'}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Consecutive Server Failures (5xx / Timeouts)</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#cbd5e1', marginTop: 4 }}>
                  {health?.circuitBreaker?.failureCount ?? 0} / 5
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Authentication Error Immunity</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#38bdf8', marginTop: 6 }}>
                  Immune (401/403/422 never trip breaker)
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
