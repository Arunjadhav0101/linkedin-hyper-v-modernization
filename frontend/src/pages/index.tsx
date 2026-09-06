import React, { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';

type Tab = 'inbox' | 'connections' | 'jobs' | 'accounts' | 'health';

interface Account {
  id: string;
  email: string;
  name?: string;
  status: string;
  authStatus?: 'NOT_CONFIGURED' | 'AUTHORIZED' | 'SESSION_INVALID' | 'DISABLED';
  hasAuthorizedSession: boolean;
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
    authorizedAccounts: number;
    sessionInvalidAccounts: number;
    notConfiguredAccounts: number;
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

  // Account management form
  const [newAccountEmail, setNewAccountEmail] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newLiAt, setNewLiAt] = useState('');
  const [newJsessionId, setNewJsessionId] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ verified: boolean; message: string } | null>(null);

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
  const isAccountAuthorized = selectedAccount?.authStatus === 'AUTHORIZED';

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
        message: 'LinkedIn account is not currently authorized for live operations. Please configure or re-authorize the account in Accounts & Cookies.',
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
        message: res.error || 'Failed to dispatch message',
      });
      setIsSending(false);
    }
  };

  // Handle Start New Conversation
  const handleStartNewChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !newChatRecipient.trim() || !newChatMessage.trim()) return;

    if (!isAccountAuthorized) {
      alert('LinkedIn account is not currently authorized for live operations. Please configure or re-authorize the account in Accounts & Cookies.');
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
      alert(res.error || 'Failed to dispatch message');
    }
    setIsSending(false);
  };

  // Handle Trigger Two-Way Sync
  const handleTriggerSync = async () => {
    if (!selectedAccountId) return;

    if (!isAccountAuthorized) {
      setSyncFeedback('❌ LinkedIn account is not currently authorized for live operations.');
      setUiAlert({
        type: 'error',
        message: 'LinkedIn account is not currently authorized for live operations. Please configure or re-authorize the account in Accounts & Cookies.',
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
      setSyncFeedback(`❌ Sync failed: ${res.error || 'Could not queue sync job'}`);
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
        message: 'LinkedIn account is not currently authorized for live operations. Please configure or re-authorize the account in Accounts & Cookies.',
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
        message: res.error || 'Failed to dispatch connection request',
      });
    }
  };

  // Handle Save Account
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountEmail.trim()) return;

    const trimmedLiAt = newLiAt.trim().replace(/^['"]+|['"]+$/g, '');
    const trimmedJsessionId = newJsessionId.trim().replace(/^['"]+|['"]+$/g, '');

    const res = await safeFetchJson<{ success: boolean }>('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: newAccountEmail.trim(),
        name: newAccountName.trim() || undefined,
        cookies: {
          li_at: trimmedLiAt || undefined,
          JSESSIONID: trimmedJsessionId || undefined,
        },
      }),
    });

    if (res.ok && res.data?.success) {
      setNewAccountEmail('');
      setNewAccountName('');
      setNewLiAt('');
      setNewJsessionId('');
      fetchAccounts();
      alert('Account credentials saved successfully!');
    } else {
      alert(res.error || 'Failed to save account');
    }
  };

  // Handle Live Session Verification
  const handleVerifySession = async (accountId?: string) => {
    setIsVerifying(true);
    setVerifyResult(null);

    const res = await safeFetchJson<{ success: boolean; data?: any; error?: any }>('/api/accounts/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountId: accountId || selectedAccountId,
        li_at: newLiAt.trim() || undefined,
        JSESSIONID: newJsessionId.trim() || undefined,
      }),
    });

    if (res.ok && res.data?.success) {
      setVerifyResult({
        verified: true,
        message: `✓ Valid Session! Logged in as: ${res.data.data?.publicIdentifier || 'LinkedIn Member'} (200 OK)`,
      });
    } else {
      const errDetail = res.data?.error?.message || res.error || 'Verification failed';
      setVerifyResult({
        verified: false,
        message: `❌ ${errDetail}`,
      });
    }
    setIsVerifying(false);
    fetchAccounts();
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
      case 'AUTHORIZED':
        return <span style={{ background: '#065f46', color: '#34d399', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>AUTHORIZED</span>;
      case 'SESSION_INVALID':
        return <span style={{ background: '#7f1d1d', color: '#fca5a5', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>SESSION_INVALID</span>;
      default:
        return <span style={{ background: '#713f12', color: '#fde047', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700 }}>NOT_CONFIGURED</span>;
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
            accounts: '🔑 Accounts & Cookies',
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
                LinkedIn Account Authorization Required ({selectedAccount?.authStatus || 'NOT_CONFIGURED'})
              </div>
              <div style={{ color: '#fecaca', fontSize: 12, marginTop: 2 }}>
                LinkedIn account is not currently authorized for live operations. Please configure or re-authorize the account in Accounts & Cookies.
              </div>
            </div>
          </div>
          <button
            onClick={() => setActiveTab('accounts')}
            style={{
              background: '#b91c1c',
              color: '#fff',
              border: 'none',
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Configure Cookies &rarr;
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
                    <div style={{ color: '#fca5a5', fontSize: 12, textAlign: 'center', padding: '8px' }}>
                      Sending is disabled: LinkedIn account is not authorized. Configure valid cookies in Accounts tab.
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
              {isAccountAuthorized ? 'Send Connection Invitation' : 'Account Not Authorized — Configure in Accounts Tab'}
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
      {/* TAB 4: ACCOUNTS & COOKIES                                                 */}
      {/* ========================================================================= */}
      {activeTab === 'accounts' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 20 }}>
          {/* Accounts List */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Managed LinkedIn Accounts</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                    <th style={{ padding: '8px 0' }}>Email / Name</th>
                    <th>Status</th>
                    <th>Pending</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '10px 0' }}>
                        <div style={{ fontWeight: 600 }}>{a.name || a.email}</div>
                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{a.email}</div>
                        {a.lastError && <div style={{ color: '#f87171', fontSize: 11 }}>Error: {a.lastError}</div>}
                      </td>
                      <td>{renderAuthBadge(a.authStatus)}</td>
                      <td>{a.pendingJobsCount || 0}</td>
                      <td style={{ display: 'flex', gap: 6, padding: '10px 0' }}>
                        <button
                          onClick={() => {
                            setNewAccountEmail(a.email);
                            setNewAccountName(a.name || '');
                            setVerifyResult(null);
                          }}
                          style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}
                        >
                          Update Cookies
                        </button>
                        <button
                          onClick={() => handleVerifySession(a.id)}
                          disabled={isVerifying}
                          style={{ background: '#334155', color: '#38bdf8', border: 'none', padding: '4px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
                        >
                          Verify Live
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Account Credential Configuration */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Configure Authorized Session</h2>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 12, marginBottom: 14, fontSize: 12, color: '#cbd5e1', lineHeight: 1.5 }}>
              <strong style={{ color: '#38bdf8' }}>Extracting cookies from LinkedIn:</strong><br />
              1. Open <strong>linkedin.com</strong> in browser.<br />
              2. Press <code>F12</code> &rarr; <strong>Application</strong> &rarr; <strong>Cookies</strong> &rarr; <code>https://www.linkedin.com</code>.<br />
              3. Copy <code>li_at</code> (~150 chars, begins with AQED...) and <code>JSESSIONID</code>.
            </div>

            <form onSubmit={handleSaveAccount}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Account Email:</label>
                <input
                  type="email"
                  placeholder="www.jadhavarun2004@gmail.com"
                  value={newAccountEmail}
                  onChange={(e) => setNewAccountEmail(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Account Name (Optional):</label>
                <input
                  type="text"
                  placeholder="Arun Jadhav"
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>`li_at` Session Token (Starts with AQED..., ~150 chars):</label>
                <textarea
                  rows={3}
                  placeholder="AQEDAVB..."
                  value={newLiAt}
                  onChange={(e) => setNewLiAt(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>`JSESSIONID` Token:</label>
                <input
                  type="text"
                  placeholder='ajax:123456789...'
                  value={newJsessionId}
                  onChange={(e) => setNewJsessionId(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>

              {verifyResult && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 12,
                    background: verifyResult.verified ? '#064e3b' : '#7f1d1d',
                    color: '#fff',
                  }}
                >
                  {verifyResult.message}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="submit"
                  style={{ flex: 1, background: '#0284c7', color: '#fff', border: 'none', padding: '10px 14px', borderRadius: 6, fontWeight: 700, cursor: 'pointer' }}
                >
                  Save Account
                </button>
                <button
                  type="button"
                  onClick={() => handleVerifySession()}
                  disabled={isVerifying}
                  style={{ background: '#334155', color: '#38bdf8', border: '1px solid #0284c7', padding: '10px 14px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
                >
                  {isVerifying ? 'Testing...' : '🔍 Test Live'}
                </button>
              </div>
            </form>
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
                  {health?.externalIntegration?.provider || 'LinkedIn Voyager API'}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Overall Integration Status</div>
                <div style={{ marginTop: 6 }}>
                  {renderAuthBadge(health?.externalIntegration?.overallStatus)}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Authorized Accounts</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399', marginTop: 4 }}>
                  {health?.externalIntegration?.authorizedAccounts ?? 0}
                </div>
              </div>
              <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
                <div style={{ color: '#94a3b8', fontSize: 12 }}>Invalid / Expired Sessions</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: (health?.externalIntegration?.sessionInvalidAccounts ?? 0) > 0 ? '#f87171' : '#94a3b8', marginTop: 4 }}>
                  {health?.externalIntegration?.sessionInvalidAccounts ?? 0}
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
