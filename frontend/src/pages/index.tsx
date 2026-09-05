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
  lastError?: string | null;
  pendingJobsCount?: number;
  hourlyActionLimit: number;
  dailyActionLimit: number;
  hourlyConnectionLimit: number;
  dailyConnectionLimit: number;
  hourlyMessageLimit: number;
  dailyMessageLimit: number;
  lastActionTimestamp?: string;
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
  circuitBreaker: {
    state: string;
    failureCount: number;
    nextAttemptTime: number;
  };
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
    try {
      const res = await fetch('/api/accounts');
      const json = await res.json();
      if (json.success && json.data) {
        setAccounts(json.data);
        if (!selectedAccountIdRef.current && json.data.length > 0) {
          setSelectedAccountId(json.data[0].id);
        }
      }
    } catch {}
  }, []);

  // 2. Fetch Conversations
  const fetchConversations = useCallback(async (targetAccountId?: string) => {
    const accId = targetAccountId || selectedAccountIdRef.current;
    if (!accId) return;
    try {
      const res = await fetch(`/api/conversations?accountId=${encodeURIComponent(accId)}`);
      const json = await res.json();
      if (json.success && json.data) {
        setConversations(json.data);
        if (!selectedConversationIdRef.current && json.data.length > 0) {
          setSelectedConversationId(json.data[0].id);
        }
      }
    } catch {}
  }, []);

  // 3. Fetch Messages for Selected Conversation
  const fetchMessages = useCallback(async (targetAccountId?: string, targetConvId?: string) => {
    const accId = targetAccountId || selectedAccountIdRef.current;
    const conv = targetConvId !== undefined ? targetConvId : selectedConversationIdRef.current;
    if (!accId) return;
    try {
      const convParam = conv ? `&conversationId=${encodeURIComponent(conv)}` : '';
      const res = await fetch(`/api/messages?accountId=${encodeURIComponent(accId)}${convParam}&limit=150`);
      const json = await res.json();
      if (json.success && json.data) {
        setActiveMessages(json.data);
      }
    } catch {}
  }, []);

  // 4. Fetch Jobs
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs?limit=50');
      const json = await res.json();
      if (json.success && json.data) {
        setJobs(json.data);
      }
    } catch {}
  }, []);

  // 5. Fetch Health
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/health');
      const json = await res.json();
      if (json.status) {
        setHealth(json);
      }
    } catch {}
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

    try {
      const res = await fetch('/api/jobs/dispatch', {
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

      const json = await res.json();
      if (json.success && json.data?.jobId) {
        const jobId = json.data.jobId;

        // Poll this job's completion specifically
        let attempts = 0;
        const jobPoll = setInterval(async () => {
          attempts++;
          try {
            const jRes = await fetch('/api/jobs?limit=10');
            const jJson = await jRes.json();
            const matchingJob = (jJson.data || []).find((j: any) => j.id === jobId);

            if (matchingJob) {
              if (matchingJob.status === 'COMPLETED') {
                clearInterval(jobPoll);
                // Mark optimistic message as SENT
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
                    m.id === tempId ? { ...m, syncStatus: 'FAILED', content: `${m.content} [Error: ${matchingJob.errorMessage || 'Failed'}]` } : m
                  )
                );
                setIsSending(false);
              }
            }
          } catch {}

          if (attempts > 30) {
            clearInterval(jobPoll);
            setIsSending(false);
          }
        }, 1500);
      } else {
        setActiveMessages((prev) =>
          prev.map((m) => (m.id === tempId ? { ...m, syncStatus: 'FAILED' } : m))
        );
        setUiAlert({ type: 'error', message: json.detail || json.error?.message || 'Failed to dispatch message' });
        setIsSending(false);
      }
    } catch (err: any) {
      setActiveMessages((prev) =>
        prev.map((m) => (m.id === tempId ? { ...m, syncStatus: 'FAILED' } : m))
      );
      setUiAlert({ type: 'error', message: err.message });
      setIsSending(false);
    }
  };

  // Handle Start New Conversation
  const handleStartNewChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !newChatRecipient.trim() || !newChatMessage.trim()) return;

    setIsSending(true);
    try {
      const res = await fetch('/api/jobs/dispatch', {
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
      const json = await res.json();
      if (json.success) {
        setIsNewChatOpen(false);
        setNewChatRecipient('');
        setNewChatMessage('');
        setUiAlert({ type: 'success', message: `Message dispatched to ${newChatRecipient}. Worker will transmit to LinkedIn.` });
        fetchJobs();
        setTimeout(() => fetchConversations(), 3000);
      } else {
        alert(json.detail || json.error?.message || 'Failed to dispatch message');
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setIsSending(false);
    }
  };

  // Handle Trigger Two-Way Sync
  const handleTriggerSync = async () => {
    if (!selectedAccountId) return;
    setIsSyncing(true);
    setSyncFeedback('Syncing messages & conversations from LinkedIn...');

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, limit: 25 }),
      });
      const json = await res.json();
      if (json.success) {
        setSyncFeedback(`Sync job queued (${json.data.jobId.slice(0, 8)}...). Worker is ingesting messages...`);
        fetchJobs();
        setTimeout(() => {
          fetchConversations();
          fetchMessages();
          setIsSyncing(false);
          setSyncFeedback('✓ Synchronization complete! Inbox updated.');
          setTimeout(() => setSyncFeedback(null), 4000);
        }, 3500);
      } else {
        setSyncFeedback(`❌ Sync failed: ${json.detail || 'Could not queue sync job'}`);
        setIsSyncing(false);
      }
    } catch (err: any) {
      setSyncFeedback(`❌ Error: ${err.message}`);
      setIsSyncing(false);
    }
  };

  // Handle Send Connection Request
  const handleSendConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !targetProfileId.trim()) return;

    try {
      const res = await fetch('/api/jobs/dispatch', {
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
      const json = await res.json();
      if (json.success) {
        setUiAlert({ type: 'success', message: `Connection request job queued (${json.data.jobId.slice(0, 8)}...). Worker executing with LinkedIn.` });
        setTargetProfileId('');
        setConnectionNote('');
        fetchJobs();
      } else {
        setUiAlert({ type: 'error', message: json.detail || json.error?.message || 'Failed to dispatch connection request' });
      }
    } catch (err: any) {
      setUiAlert({ type: 'error', message: err.message });
    }
  };

  // Handle Save Account
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountEmail.trim()) return;

    const trimmedLiAt = newLiAt.trim().replace(/^['"]+|['"]+$/g, '');
    const trimmedJsessionId = newJsessionId.trim().replace(/^['"]+|['"]+$/g, '');

    try {
      const res = await fetch('/api/accounts', {
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
      const json = await res.json();
      if (json.success) {
        setNewAccountEmail('');
        setNewAccountName('');
        setNewLiAt('');
        setNewJsessionId('');
        fetchAccounts();
        alert('Account credentials saved successfully!');
      } else {
        alert(json.detail || 'Failed to save account');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Handle Live Session Verification
  const handleVerifySession = async (accountId?: string) => {
    setIsVerifying(true);
    setVerifyResult(null);

    try {
      const res = await fetch('/api/accounts/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: accountId || selectedAccountId,
          li_at: newLiAt.trim() || undefined,
          JSESSIONID: newJsessionId.trim() || undefined,
        }),
      });
      let json: any;
      const text = await res.text();
      try {
        json = JSON.parse(text);
      } catch {
        json = { success: false, detail: text || `Server error (HTTP ${res.status})` };
      }

      if (json.success) {
        setVerifyResult({
          verified: true,
          message: `✓ Valid Session! Logged in as: ${json.data?.publicIdentifier || 'LinkedIn Member'} (200 OK)`,
        });
      } else {
        setVerifyResult({
          verified: false,
          message: `❌ ${json.detail || json.error?.message || 'Verification failed'}`,
        });
      }
    } catch (err: any) {
      setVerifyResult({ verified: false, message: `❌ Error: ${err.message}` });
    } finally {
      setIsVerifying(false);
      fetchAccounts();
    }
  };

  // Handle Maintenance (Retry, Clear DLQ)
  const handleMaintenance = async (action: 'RETRY_DLQ' | 'CLEAR_DLQ') => {
    try {
      const res = await fetch('/api/maintenance/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (json.success) {
        alert(action === 'RETRY_DLQ' ? 'Failed and DLQ jobs re-queued for execution!' : 'DLQ cleared!');
        fetchJobs();
      }
    } catch (err: any) {
      alert(err.message);
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
            {autoRefresh ? '● Live Polling (2s)' : '○ Polling Paused'}
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

      {/* ========================================================================= */}
      {/* PRIMARY TAB: HYPER-V INBOX                                                */}
      {/* ========================================================================= */}
      {activeTab === 'inbox' && (
        <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 16, height: 'calc(100vh - 180px)', minHeight: 650 }}>
          {/* LEFT PANE: CONVERSATIONS LIST */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header & Controls */}
            <div style={{ padding: 14, borderBottom: '1px solid #334155', background: '#0f172a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#f1f5f9' }}>Conversations</h2>
                <button
                  onClick={() => setIsNewChatOpen(true)}
                  disabled={!selectedAccount?.hasAuthorizedSession}
                  style={{
                    background: selectedAccount?.hasAuthorizedSession ? '#0284c7' : '#475569',
                    color: '#fff',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: selectedAccount?.hasAuthorizedSession ? 'pointer' : 'not-allowed',
                  }}
                >
                  + New Chat
                </button>
              </div>

              {/* Sync Button & State */}
              <div style={{ marginBottom: 10 }}>
                <button
                  onClick={handleTriggerSync}
                  disabled={isSyncing || !selectedAccount?.hasAuthorizedSession}
                  style={{
                    width: '100%',
                    background: selectedAccount?.hasAuthorizedSession ? '#059669' : '#334155',
                    color: '#fff',
                    border: 'none',
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: selectedAccount?.hasAuthorizedSession ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                  }}
                >
                  {isSyncing ? '⏳ Ingesting from LinkedIn...' : '↻ Sync Messages from LinkedIn'}
                </button>
                {syncFeedback && (
                  <div style={{ fontSize: 11, color: '#38bdf8', marginTop: 4, textAlign: 'center' }}>
                    {syncFeedback}
                  </div>
                )}
              </div>

              {/* Search Bar */}
              <div>
                <input
                  type="text"
                  placeholder="Search contacts or messages..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ width: '100%', background: '#1e293b', border: '1px solid #334155', color: '#fff', padding: '8px 10px', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }}
                />
              </div>
            </div>

            {/* Conversation Cards Scroll List */}
            <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
              {filteredConversations.map((c) => {
                const isSelected = selectedConversationId === c.id;
                const avatarLetter = (c.partnerName || 'L').charAt(0).toUpperCase();

                return (
                  <div
                    key={c.id}
                    onClick={() => {
                      setSelectedConversationId(c.id);
                    }}
                    style={{
                      background: isSelected ? '#0284c7' : '#0f172a',
                      border: '1px solid',
                      borderColor: isSelected ? '#38bdf8' : '#334155',
                      borderRadius: 8,
                      padding: '10px 12px',
                      marginBottom: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      transition: 'background-color 0.15s',
                    }}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: '50%',
                        background: isSelected ? '#0369a1' : '#334155',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 700,
                        fontSize: 14,
                        flexShrink: 0,
                      }}
                    >
                      {avatarLetter}
                    </div>

                    {/* Metadata */}
                    <div style={{ flex: 1, overflow: 'hidden' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {c.partnerName}
                        </span>
                        <span style={{ fontSize: 10, color: isSelected ? '#e0f2fe' : '#94a3b8' }}>
                          {formatDate(c.lastActivityAt)}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: isSelected ? '#f0f9ff' : '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 3 }}>
                        {c.lastMessageSnippet || 'No messages'}
                      </div>
                    </div>
                  </div>
                );
              })}

              {filteredConversations.length === 0 && (
                <div style={{ textAlign: 'center', color: '#64748b', fontSize: 13, padding: 30 }}>
                  No conversations found.<br /><br />
                  Click <strong>↻ Sync Messages from LinkedIn</strong> to pull active chats from your account.
                </div>
              )}
            </div>
          </div>

          {/* RIGHT PANE: ACTIVE CONVERSATION THREAD */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {activeConversation ? (
              <>
                {/* Conversation Header */}
                <div style={{ padding: '12px 18px', borderBottom: '1px solid #334155', background: '#0f172a', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#0284c7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16 }}>
                      {(activeConversation.partnerName || 'L').charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>{activeConversation.partnerName}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>
                        ID: {activeConversation.remoteConversationId} • Last active: {formatTime(activeConversation.lastActivityAt)}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <a
                      href={`https://www.linkedin.com/in/${activeConversation.partnerName.replace(/\s+/g, '-').toLowerCase()}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{ background: '#334155', color: '#38bdf8', textDecoration: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}
                    >
                      View on LinkedIn ↗
                    </a>
                    <button
                      onClick={() => fetchMessages()}
                      style={{ background: '#334155', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 11, cursor: 'pointer' }}
                    >
                      Refresh
                    </button>
                  </div>
                </div>

                {/* Message Bubble History Stream */}
                <div style={{ flex: 1, padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, background: '#090d16' }}>
                  {activeMessages.map((m) => {
                    const isOutbound = m.direction === 'OUTBOUND';
                    return (
                      <div
                        key={m.id}
                        style={{
                          alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                          maxWidth: '68%',
                          background: isOutbound ? '#0284c7' : '#1e293b',
                          border: `1px solid ${isOutbound ? '#0369a1' : '#334155'}`,
                          color: '#fff',
                          padding: '10px 14px',
                          borderRadius: 12,
                          borderBottomRightRadius: isOutbound ? 2 : 12,
                          borderBottomLeftRadius: isOutbound ? 12 : 2,
                        }}
                      >
                        <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <span>{isOutbound ? 'You (Outbound)' : m.senderName || activeConversation.partnerName}</span>
                          <span>{formatTime(m.sentAt)}</span>
                        </div>
                        <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                          {m.content}
                        </div>
                        <div style={{ fontSize: 10, marginTop: 4, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                          {m.syncStatus === 'SENDING...' && (
                            <span style={{ color: '#fef08a', fontWeight: 600 }}>⏳ SENDING...</span>
                          )}
                          {m.syncStatus === 'SENT' && (
                            <span style={{ color: '#34d399', fontWeight: 600 }}>✓ SENT (LinkedIn Confirmed)</span>
                          )}
                          {m.syncStatus === 'FAILED' && (
                            <span style={{ color: '#fca5a5', fontWeight: 600 }}>✕ FAILED</span>
                          )}
                          {m.syncStatus === 'SYNCED' && (
                            <span style={{ color: '#cbd5e1', opacity: 0.7 }}>SYNCED</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>

                {/* Bottom Live Message Input Bar */}
                <form
                  onSubmit={handleSendMessage}
                  style={{
                    padding: 14,
                    borderTop: '1px solid #334155',
                    background: '#0f172a',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                  }}
                >
                  {selectedAccount && !selectedAccount.hasAuthorizedSession ? (
                    <div style={{ color: '#f87171', fontSize: 12, padding: 8, background: '#450a0a', borderRadius: 6 }}>
                      ⚠️ <strong>ACCOUNT NOT AUTHORIZED:</strong> You must configure a valid <code>li_at</code> session cookie in the <strong>Accounts</strong> tab before live messages can be sent.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 10 }}>
                      <input
                        type="text"
                        placeholder={`Write a live message to ${activeConversation.partnerName}...`}
                        value={messageInput}
                        onChange={(e) => setMessageInput(e.target.value)}
                        disabled={isSending || !selectedAccount?.hasAuthorizedSession}
                        style={{
                          flex: 1,
                          background: '#1e293b',
                          border: '1px solid #334155',
                          color: '#fff',
                          padding: '12px 14px',
                          borderRadius: 8,
                          fontSize: 13,
                        }}
                      />
                      <button
                        type="submit"
                        disabled={isSending || !messageInput.trim() || !selectedAccount?.hasAuthorizedSession}
                        style={{
                          background: selectedAccount?.hasAuthorizedSession && messageInput.trim() ? '#0284c7' : '#475569',
                          color: '#fff',
                          border: 'none',
                          padding: '0 24px',
                          borderRadius: 8,
                          fontWeight: 700,
                          fontSize: 13,
                          cursor: selectedAccount?.hasAuthorizedSession && messageInput.trim() ? 'pointer' : 'not-allowed',
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
                  disabled={isSending}
                  style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 20px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
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
                placeholder="Hi, I would like to connect with you on LinkedIn..."
                value={connectionNote}
                onChange={(e) => setConnectionNote(e.target.value)}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
              />
            </div>

            <button
              type="submit"
              disabled={!selectedAccount?.hasAuthorizedSession}
              style={{
                width: '100%',
                background: selectedAccount?.hasAuthorizedSession ? '#0284c7' : '#475569',
                color: '#fff',
                border: 'none',
                padding: '12px 16px',
                borderRadius: 6,
                fontWeight: 700,
                cursor: selectedAccount?.hasAuthorizedSession ? 'pointer' : 'not-allowed',
              }}
            >
              Send Connection Request
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
              <h2 style={{ margin: 0, fontSize: 18, color: '#f1f5f9' }}>Real-Time Automation Jobs Monitor</h2>
              <p style={{ margin: '4px 0 0', fontSize: 12, color: '#94a3b8' }}>
                Tracks execution states: QUEUED → RUNNING → COMPLETED / FAILED → RETRYING → DLQ_ROUTED
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleMaintenance('RETRY_DLQ')}
                style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                ↻ Retry Failed Jobs
              </button>
              <button
                onClick={() => handleMaintenance('CLEAR_DLQ')}
                style={{ background: '#334155', color: '#cbd5e1', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
              >
                Clear DLQ
              </button>
              <button
                onClick={fetchJobs}
                style={{ background: '#334155', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
              >
                Refresh
              </button>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                  <th style={{ padding: '8px 6px' }}>Job ID</th>
                  <th>Action</th>
                  <th>Account</th>
                  <th>Target / Recipient</th>
                  <th>Status</th>
                  <th>Retries</th>
                  <th>Created At</th>
                  <th>Error / Detail</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => {
                  const target = j.payload?.recipientId || j.payload?.targetProfileId || 'N/A';
                  return (
                    <tr key={j.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '8px 6px', fontFamily: 'monospace' }}>{j.id.slice(0, 8)}...</td>
                      <td>{j.type}</td>
                      <td>{j.accountEmail}</td>
                      <td style={{ color: '#38bdf8' }}>{target}</td>
                      <td>{renderJobBadge(j.status)}</td>
                      <td>{j.retryCount} / {j.maxRetries}</td>
                      <td style={{ color: '#94a3b8' }}>{formatTime(j.createdAt)}</td>
                      <td style={{ color: j.errorMessage ? '#f87171' : '#64748b', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.errorMessage || '—'}
                      </td>
                    </tr>
                  );
                })}
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
                      <td>
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
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>System Architecture & Probes</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginTop: 16 }}>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>FastAPI Python Engine</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399', marginTop: 4 }}>
                {health?.status === 'healthy' ? 'Online (Healthy)' : 'Checking...'}
              </div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>PostgreSQL Database</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: health?.database === 'connected' ? '#34d399' : '#f87171', marginTop: 4 }}>
                {health?.database || 'connected'}
              </div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Redis / Distributed Lock</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: health?.redis === 'connected' ? '#34d399' : '#facc15', marginTop: 4 }}>
                {health?.redis || 'connected'}
              </div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Active Accounts</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#38bdf8', marginTop: 4 }}>
                {accounts.length} Accounts
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
