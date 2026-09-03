import React, { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';

type Tab = 'dashboard' | 'messages' | 'connections' | 'jobs' | 'sync' | 'accounts' | 'health';

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
  assignedProxy?: any;
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
}

interface SystemHealth {
  status: string;
  database: string;
  redis: string;
  activeAccounts: number;
  activeProxies: number;
  circuitBreaker: {
    state: string;
    failureCount: number;
    nextAttemptTime: number;
  };
}

export default function LinkedInControlPlane() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<AutomationJob[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Form states
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [messageRecipient, setMessageRecipient] = useState('');
  const [messageContent, setMessageContent] = useState('');
  const [targetProfileId, setTargetProfileId] = useState('');
  const [connectionNote, setConnectionNote] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState<string>('');

  // Account config form
  const [newAccountEmail, setNewAccountEmail] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newLiAt, setNewLiAt] = useState('');
  const [newJsessionId, setNewJsessionId] = useState('');

  // UI status
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ verified: boolean; message: string } | null>(null);
  const [submissionFeedback, setSubmissionFeedback] = useState<{ type: 'success' | 'error' | 'info'; message: string; jobId?: string } | null>(null);

  // Fetch Accounts
  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch('/api/accounts');
      const json = await res.json();
      if (json.success && json.data) {
        setAccounts(json.data);
        if (!selectedAccountId && json.data.length > 0) {
          setSelectedAccountId(json.data[0].id);
        }
      }
    } catch {}
  }, [selectedAccountId]);

  // Fetch Jobs
  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs?limit=50');
      const json = await res.json();
      if (json.success && json.data) {
        setJobs(json.data);
      }
    } catch {}
  }, []);

  // Fetch Messages
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/messages?limit=50');
      const json = await res.json();
      if (json.success && json.data) {
        setMessages(json.data);
      }
    } catch {}
  }, []);

  // Fetch Health
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health');
      const json = await res.json();
      if (json.success && json.data) {
        setHealth(json.data);
      }
    } catch {}
  }, []);

  // Polling loop
  useEffect(() => {
    fetchAccounts();
    fetchJobs();
    fetchMessages();
    fetchHealth();

    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchJobs();
      fetchMessages();
      fetchHealth();
    }, 2500);

    return () => clearInterval(interval);
  }, [autoRefresh, fetchAccounts, fetchJobs, fetchMessages, fetchHealth]);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Handle Send Message
  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !messageRecipient || !messageContent) return;

    setIsSubmitting(true);
    setSubmissionFeedback(null);

    try {
      const res = await fetch('/api/jobs/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          type: 'SEND_MESSAGE',
          payload: {
            recipientId: messageRecipient,
            content: messageContent,
            conversationId: selectedConversationId || undefined,
          },
        }),
      });

      const json = await res.json();
      if (json.success) {
        setSubmissionFeedback({
          type: 'success',
          message: `Message Job ${json.data.jobId} created with status QUEUED. Dispatched to worker.`,
          jobId: json.data.jobId,
        });
        setMessageContent('');
        fetchJobs();
      } else {
        setSubmissionFeedback({
          type: 'error',
          message: json.error?.message || 'Failed to dispatch message job',
        });
      }
    } catch (err: any) {
      setSubmissionFeedback({ type: 'error', message: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Send Connection Request
  const handleSendConnection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAccountId || !targetProfileId) return;

    setIsSubmitting(true);
    setSubmissionFeedback(null);

    try {
      const res = await fetch('/api/jobs/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedAccountId,
          type: 'SEND_CONNECTION_REQUEST',
          payload: {
            targetProfileId,
            customNote: connectionNote || undefined,
          },
        }),
      });

      const json = await res.json();
      if (json.success) {
        setSubmissionFeedback({
          type: 'success',
          message: `Connection Job ${json.data.jobId} created with status QUEUED. Dispatched to worker.`,
          jobId: json.data.jobId,
        });
        setTargetProfileId('');
        setConnectionNote('');
        fetchJobs();
      } else {
        setSubmissionFeedback({
          type: 'error',
          message: json.error?.message || 'Failed to dispatch connection request job',
        });
      }
    } catch (err: any) {
      setSubmissionFeedback({ type: 'error', message: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Trigger Sync
  const handleTriggerSync = async () => {
    if (!selectedAccountId) return;
    setIsSubmitting(true);
    setSubmissionFeedback(null);

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: selectedAccountId, limit: 20 }),
      });

      const json = await res.json();
      if (json.success) {
        setSubmissionFeedback({
          type: 'success',
          message: `Sync job ${json.data.jobId} created. Syncing messages from LinkedIn.`,
          jobId: json.data.jobId,
        });
        fetchJobs();
      } else {
        setSubmissionFeedback({
          type: 'error',
          message: json.error?.message || 'Failed to dispatch sync job',
        });
      }
    } catch (err: any) {
      setSubmissionFeedback({ type: 'error', message: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle Save Account
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountEmail) return;

    const trimmedLiAt = newLiAt.trim();
    if (trimmedLiAt.length > 0 && trimmedLiAt.length < 50) {
      alert(
        `Invalid 'li_at' cookie: You entered ${trimmedLiAt.length} characters ('${trimmedLiAt.slice(0, 8)}...').\n\n` +
        `A real LinkedIn session cookie is ~150 characters long and begins with 'AQED...'.\n` +
        `You entered your account password or placeholder instead of the browser session cookie.\n\n` +
        `To get the real cookie:\n1. Log into linkedin.com in Chrome\n2. Press F12 -> Application -> Storage -> Cookies -> https://www.linkedin.com\n3. Copy the 'li_at' value.`
      );
      return;
    }

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newAccountEmail,
          name: newAccountName || undefined,
          cookies: {
            li_at: trimmedLiAt || undefined,
            JSESSIONID: newJsessionId.trim() || undefined,
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
        alert('Account credentials successfully saved and validated!');
      } else {
        alert(json.error?.message || 'Failed to save account');
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Handle Verify Session with LinkedIn directly
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
      const json = await res.json();
      if (json.success) {
        setVerifyResult({
          verified: true,
          message: `✓ Valid Session! Logged in as: ${json.data.publicIdentifier || 'LinkedIn Member'} (Status 200 OK)`,
        });
        fetchAccounts();
      } else {
        setVerifyResult({
          verified: false,
          message: `❌ ${json.error?.message || 'Verification failed'}`,
        });
      }
    } catch (err: any) {
      setVerifyResult({ verified: false, message: `❌ Error: ${err.message}` });
    } finally {
      setIsVerifying(false);
    }
  };

  // Handle Maintenance Actions (Retry failed, clear DLQ)
  const handleMaintenance = async (action: 'RETRY_DLQ' | 'CLEAR_DLQ') => {
    try {
      const res = await fetch('/api/maintenance/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await res.json();
      if (json.success) {
        alert(action === 'RETRY_DLQ' ? 'All failed and DLQ jobs re-queued for execution!' : 'DLQ cleared!');
        fetchJobs();
        fetchHealth();
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  // Status badge styling
  const renderStatusBadge = (status: string) => {
    switch (status) {
      case 'QUEUED':
        return <span style={{ backgroundColor: '#854d0e', color: '#fef08a', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>QUEUED</span>;
      case 'RUNNING':
        return <span style={{ backgroundColor: '#1e40af', color: '#93c5fd', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>RUNNING</span>;
      case 'COMPLETED':
      case 'SENT':
        return <span style={{ backgroundColor: '#065f46', color: '#34d399', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>COMPLETED</span>;
      case 'RETRYING':
        return <span style={{ backgroundColor: '#c2410c', color: '#fed7aa', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>RETRYING</span>;
      case 'FAILED':
        return <span style={{ backgroundColor: '#991b1b', color: '#fca5a5', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>FAILED</span>;
      case 'RATE_LIMITED':
        return <span style={{ backgroundColor: '#9a3412', color: '#fdba74', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>RATE_LIMITED</span>;
      case 'DLQ_ROUTED':
        return <span style={{ backgroundColor: '#581c87', color: '#d8b4fe', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>DLQ_ROUTED</span>;
      case 'TIMED_OUT':
        return <span style={{ backgroundColor: '#475569', color: '#cbd5e1', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>TIMED_OUT</span>;
      default:
        return <span style={{ backgroundColor: '#334155', color: '#cbd5e1', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>{status}</span>;
    }
  };

  const renderAuthBadge = (authStatus?: string) => {
    switch (authStatus) {
      case 'AUTHORIZED':
        return <span style={{ color: '#34d399', background: '#065f46', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>AUTHORIZED</span>;
      case 'SESSION_INVALID':
        return <span style={{ color: '#fca5a5', background: '#7f1d1d', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>SESSION_INVALID</span>;
      case 'DISABLED':
        return <span style={{ color: '#94a3b8', background: '#334155', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>DISABLED</span>;
      default:
        return <span style={{ color: '#fde047', background: '#713f12', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>NOT_CONFIGURED</span>;
    }
  };

  // Group messages by conversation / contact
  const conversationMap = new Map<string, ChatMessage[]>();
  messages.forEach((m) => {
    const key = m.conversationId || m.recipientId || m.senderId;
    if (!conversationMap.has(key)) conversationMap.set(key, []);
    conversationMap.get(key)!.push(m);
  });
  const conversationKeys = Array.from(conversationMap.keys());
  const activeChatMessages = (selectedConversationId && conversationMap.get(selectedConversationId)) || messages;

  // Calculate metrics
  const pendingCount = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING' || j.status === 'RETRYING').length;
  const completedCount = jobs.filter((j) => j.status === 'COMPLETED').length;
  const failedCount = jobs.filter((j) => j.status === 'FAILED' || j.status === 'RATE_LIMITED').length;
  const dlqCount = jobs.filter((j) => j.status === 'DLQ_ROUTED').length;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '30px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#f8fafc' }}>
      <Head>
        <title>LinkedIn Hyper-V 2.0 | Control Plane</title>
        <meta name="description" content="Type-safe LinkedIn automation and execution engine" />
      </Head>

      {/* Header */}
      <header style={{ borderBottom: '1px solid #334155', paddingBottom: 16, marginBottom: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: 26, margin: 0, fontWeight: 700, color: '#38bdf8' }}>LinkedIn Hyper-V 2.0</h1>
          <p style={{ margin: '4px 0 0', color: '#94a3b8', fontSize: 13 }}>Enterprise Control Plane & Background Automation Engine</p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <button
            onClick={() => setAutoRefresh(!autoRefresh)}
            style={{ background: autoRefresh ? '#065f46' : '#334155', color: autoRefresh ? '#34d399' : '#94a3b8', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}
          >
            {autoRefresh ? '● Live Polling (2.5s)' : '○ Paused'}
          </button>
          <span style={{ backgroundColor: health?.status === 'healthy' ? '#065f46' : '#991b1b', color: '#fff', padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>
            {health?.status === 'healthy' ? 'System Online' : 'Checking Probes...'}
          </span>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav style={{ display: 'flex', gap: 8, borderBottom: '1px solid #334155', paddingBottom: 12, marginBottom: 24, overflowX: 'auto' }}>
        {(['dashboard', 'messages', 'connections', 'jobs', 'sync', 'accounts', 'health'] as Tab[]).map((tab) => {
          const labels: Record<Tab, string> = {
            dashboard: 'Dashboard',
            messages: 'Messages',
            connections: 'Connection Requests',
            jobs: 'Automation Jobs',
            sync: 'Synchronization',
            accounts: 'Accounts',
            health: 'System Health',
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
                whiteSpace: 'nowrap',
              }}
            >
              {labels[tab]}
            </button>
          );
        })}
      </nav>

      {/* Global Feedback Alert */}
      {submissionFeedback && (
        <div
          style={{
            backgroundColor: submissionFeedback.type === 'success' ? '#064e3b' : submissionFeedback.type === 'error' ? '#7f1d1d' : '#1e3a8a',
            border: `1px solid ${submissionFeedback.type === 'success' ? '#059669' : submissionFeedback.type === 'error' ? '#dc2626' : '#3b82f6'}`,
            color: '#fff',
            padding: '12px 16px',
            borderRadius: 8,
            marginBottom: 20,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{submissionFeedback.type === 'success' ? '✓ ' : '⚠️ '} {submissionFeedback.message}</span>
          <button onClick={() => setSubmissionFeedback(null)} style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: 16 }}>×</button>
        </div>
      )}

      {/* TAB 1: DASHBOARD */}
      {activeTab === 'dashboard' && (
        <div>
          {/* Top KPI Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Active Accounts</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#38bdf8', marginTop: 4 }}>{accounts.length}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Pending / Active Jobs</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#facc15', marginTop: 4 }}>{pendingCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Completed / Sent</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#34d399', marginTop: 4 }}>{completedCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Failed Jobs</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#f87171', marginTop: 4 }}>{failedCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>DLQ Routed</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#c084fc', marginTop: 4 }}>{dlqCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18 }}>
              <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Messages Ingested</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: '#60a5fa', marginTop: 4 }}>{messages.length}</div>
            </div>
          </div>

          {/* Quick Actions & Recent Jobs */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h2 style={{ margin: 0, fontSize: 17, color: '#f1f5f9' }}>Recent Automation Jobs</h2>
              <button onClick={() => setActiveTab('jobs')} style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', fontSize: 13 }}>View All Jobs →</button>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                    <th style={{ padding: '8px 0' }}>Job ID</th>
                    <th>Action</th>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Created At</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.slice(0, 6).map((j) => (
                    <tr key={j.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '8px 0', fontFamily: 'monospace', fontSize: 11 }}>{j.id.slice(0, 8)}...</td>
                      <td>{j.type}</td>
                      <td>{j.accountEmail}</td>
                      <td>{renderStatusBadge(j.status)}</td>
                      <td style={{ color: '#94a3b8', fontSize: 12 }}>{new Date(j.createdAt).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>No automation jobs yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MESSAGES & CHAT */}
      {activeTab === 'messages' && (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 20, height: 600 }}>
          {/* Left Pane: Conversations & Send New */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 18, display: 'flex', flexDirection: 'column' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16, color: '#38bdf8' }}>Conversations</h3>
            
            {/* Account Selector */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: 'block', fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>DISPATCH FROM ACCOUNT:</label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, fontSize: 12 }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email} ({a.hasAuthorizedSession ? '✓ Authorized' : '⚠️ No Cookie'})
                  </option>
                ))}
              </select>
            </div>

            {/* Conversation List */}
            <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #334155', paddingTop: 8 }}>
              {conversationKeys.map((k) => {
                const thread = conversationMap.get(k) || [];
                const lastMsg = thread[thread.length - 1];
                const isSelected = selectedConversationId === k;
                return (
                  <div
                    key={k}
                    onClick={() => {
                      setSelectedConversationId(k);
                      if (lastMsg) setMessageRecipient(lastMsg.recipientId === selectedAccount?.id ? lastMsg.senderId : lastMsg.recipientId);
                    }}
                    style={{
                      background: isSelected ? '#0284c7' : '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: 6,
                      padding: 10,
                      marginBottom: 8,
                      cursor: 'pointer',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#f1f5f9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {lastMsg?.recipientName || lastMsg?.recipientId || k}
                    </div>
                    <div style={{ fontSize: 11, color: isSelected ? '#e0f2fe' : '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 3 }}>
                      {lastMsg?.content || 'No messages'}
                    </div>
                  </div>
                );
              })}
              {conversationKeys.length === 0 && (
                <div style={{ textAlign: 'center', color: '#64748b', fontSize: 12, padding: 24 }}>
                  No active conversations. Start a new message below.
                </div>
              )}
            </div>
          </div>

          {/* Right Pane: Chat Window */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, display: 'flex', flexDirection: 'column' }}>
            {/* Chat Header */}
            <div style={{ padding: '14px 18px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Recipient / Profile: </span>
                <input
                  type="text"
                  placeholder="e.g. member:12345 or profile-vanity-name"
                  value={messageRecipient}
                  onChange={(e) => setMessageRecipient(e.target.value)}
                  style={{ background: '#0f172a', border: '1px solid #334155', color: '#38bdf8', padding: '4px 10px', borderRadius: 6, fontSize: 13, width: 260 }}
                />
              </div>
              <button onClick={fetchMessages} style={{ background: '#334155', color: '#fff', border: 'none', padding: '5px 10px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                Refresh Chat
              </button>
            </div>

            {/* Chat Bubble Stream */}
            <div style={{ flex: 1, padding: 18, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {activeChatMessages.map((m) => {
                const isOutbound = m.direction === 'OUTBOUND';
                return (
                  <div
                    key={m.id}
                    style={{
                      alignSelf: isOutbound ? 'flex-end' : 'flex-start',
                      maxWidth: '70%',
                      background: isOutbound ? '#0284c7' : '#334155',
                      color: '#fff',
                      padding: '10px 14px',
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ fontSize: 11, opacity: 0.8, marginBottom: 4 }}>
                      {isOutbound ? 'You (Outbound)' : m.senderName || m.senderId} • {new Date(m.sentAt).toLocaleTimeString()}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>{m.content}</div>
                    <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4, fontFamily: 'monospace' }}>
                      Status: {m.syncStatus}
                    </div>
                  </div>
                );
              })}
              {activeChatMessages.length === 0 && (
                <div style={{ margin: 'auto', color: '#64748b', fontSize: 13 }}>
                  No messages in this thread. Type your message below to send via worker.
                </div>
              )}
            </div>

            {/* Chat Input Bar */}
            <form onSubmit={handleSendMessage} style={{ padding: 14, borderTop: '1px solid #334155', background: '#0f172a', borderBottomLeftRadius: 10, borderBottomRightRadius: 10 }}>
              {selectedAccount && !selectedAccount.hasAuthorizedSession && (
                <div style={{ color: '#f87171', fontSize: 12, marginBottom: 8 }}>
                  ⚠️ Account '{selectedAccount.email}' is not authorized. Configure valid `li_at` in Accounts tab.
                </div>
              )}
              <div style={{ display: 'flex', gap: 10 }}>
                <input
                  type="text"
                  placeholder="Type a real LinkedIn message..."
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  disabled={!selectedAccount?.hasAuthorizedSession || isSubmitting}
                  style={{ flex: 1, background: '#1e293b', border: '1px solid #334155', color: '#fff', padding: '10px 14px', borderRadius: 6, fontSize: 13 }}
                />
                <button
                  type="submit"
                  disabled={!selectedAccount?.hasAuthorizedSession || isSubmitting || !messageRecipient || !messageContent}
                  style={{
                    background: selectedAccount?.hasAuthorizedSession ? '#0284c7' : '#475569',
                    color: '#fff',
                    border: 'none',
                    padding: '0 20px',
                    borderRadius: 6,
                    fontWeight: 600,
                    cursor: selectedAccount?.hasAuthorizedSession ? 'pointer' : 'not-allowed',
                  }}
                >
                  {isSubmitting ? 'Sending...' : 'Send Message'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TAB 3: CONNECTION REQUESTS */}
      {activeTab === 'connections' && (
        <div style={{ maxWidth: 640, margin: '0 auto', background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Connection Requests</h2>
          <p style={{ fontSize: 13, color: '#94a3b8' }}>
            Sends connection requests with optional personalized invitation messages through the selected authorized account.
          </p>

          <form onSubmit={handleSendConnection}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Account:</label>
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6 }}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.email} ({a.hasAuthorizedSession ? '✓ Authorized' : '⚠️ Missing Cookie'})
                  </option>
                ))}
              </select>
              {selectedAccount && !selectedAccount.hasAuthorizedSession && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#f87171' }}>
                  ⚠️ Account is not authorized for live actions. Enter real `li_at` session cookie in Accounts tab.
                </div>
              )}
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Target Profile Identifier or Vanity URL:</label>
              <input
                type="text"
                placeholder="e.g. satyanadella or https://www.linkedin.com/in/satyanadella/"
                value={targetProfileId}
                onChange={(e) => setTargetProfileId(e.target.value)}
                required
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
              />
              {selectedAccount && targetProfileId.toLowerCase().includes(selectedAccount.email.toLowerCase()) && (
                <div style={{ marginTop: 6, fontSize: 12, color: '#f87171' }}>
                  ⚠️ You cannot send an invitation or message to your own profile.
                </div>
              )}
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Optional Invitation Message / Note:</label>
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
              disabled={isSubmitting || !selectedAccount?.hasAuthorizedSession}
              style={{
                width: '100%',
                background: selectedAccount?.hasAuthorizedSession ? '#0284c7' : '#475569',
                color: '#fff',
                border: 'none',
                padding: '12px 16px',
                borderRadius: 6,
                fontWeight: 600,
                cursor: selectedAccount?.hasAuthorizedSession ? 'pointer' : 'not-allowed',
              }}
            >
              {isSubmitting ? 'Queueing Job...' : 'Send Connection Request & Message'}
            </button>
          </form>
        </div>
      )}

      {/* TAB 4: AUTOMATION JOBS */}
      {activeTab === 'jobs' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h2 style={{ margin: 0, fontSize: 18 }}>Real-Time Automation Jobs Monitor</h2>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: '#94a3b8' }}>Live state machine tracking: QUEUED → RUNNING → COMPLETED / FAILED → RETRYING → DLQ</p>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => handleMaintenance('RETRY_DLQ')}
                style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
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
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                  <th style={{ padding: '10px 8px' }}>Job ID</th>
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
                      <td style={{ padding: '10px 8px', fontFamily: 'monospace', fontSize: 11 }}>{j.id.slice(0, 8)}...</td>
                      <td>{j.type}</td>
                      <td>{j.accountEmail}</td>
                      <td style={{ color: '#38bdf8' }}>{target}</td>
                      <td>{renderStatusBadge(j.status)}</td>
                      <td>{j.retryCount} / {j.maxRetries}</td>
                      <td style={{ color: '#94a3b8', fontSize: 12 }}>{new Date(j.createdAt).toLocaleTimeString()}</td>
                      <td style={{ color: j.errorMessage ? '#f87171' : '#64748b', fontSize: 12, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.errorMessage || '—'}
                      </td>
                    </tr>
                  );
                })}
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={8} style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>No automation jobs recorded yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 5: SYNCHRONIZATION */}
      {activeTab === 'sync' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Two-Way Message Synchronization</h2>
          <p style={{ fontSize: 13, color: '#94a3b8' }}>
            Retrieves conversation history and inbound messages from authorized accounts using deterministic SHA-256 idempotency.
          </p>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 20 }}>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              style={{ background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6 }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.email}</option>
              ))}
            </select>
            <button
              onClick={handleTriggerSync}
              disabled={isSubmitting || !selectedAccount?.hasAuthorizedSession}
              style={{
                background: selectedAccount?.hasAuthorizedSession ? '#0284c7' : '#475569',
                color: '#fff',
                border: 'none',
                padding: '8px 16px',
                borderRadius: 6,
                fontWeight: 600,
                cursor: selectedAccount?.hasAuthorizedSession ? 'pointer' : 'not-allowed',
              }}
            >
              {isSubmitting ? 'Syncing...' : 'Trigger Immediate Sync'}
            </button>
          </div>

          <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8, color: '#38bdf8' }}>Idempotency & Deduplication Engine</div>
            <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.5 }}>
              All ingested messages are indexed with deterministic SHA-256 hash: <br />
              <code style={{ background: '#1e293b', padding: '2px 6px', borderRadius: 4 }}>sha256(accountId:conversationId:remoteMessageId)</code>
              <br />
              Running sync multiple times never creates duplicate database rows.
            </div>
          </div>
        </div>
      )}

      {/* TAB 6: ACCOUNTS */}
      {activeTab === 'accounts' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 24 }}>
          {/* Accounts List */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>Managed LinkedIn Accounts</h2>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                    <th style={{ padding: '8px 0' }}>Email</th>
                    <th>Status</th>
                    <th>Pending</th>
                    <th>Hourly Limit</th>
                    <th>Daily Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '10px 0' }}>
                        <div style={{ fontWeight: 600 }}>{a.email}</div>
                        {a.lastError && <div style={{ color: '#f87171', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Error: {a.lastError}</div>}
                      </td>
                      <td>{renderAuthBadge(a.authStatus)}</td>
                      <td>{a.pendingJobsCount || 0}</td>
                      <td>{a.hourlyActionLimit}</td>
                      <td>{a.dailyActionLimit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Configure Account Form */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Configure Authorized Account</h2>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 12, color: '#cbd5e1', lineHeight: 1.5 }}>
              <strong style={{ color: '#38bdf8' }}>How to extract session cookies:</strong><br />
              1. Open <strong>linkedin.com</strong> in Chrome/Edge (must be logged in).<br />
              2. Press <code>F12</code> &rarr; click <strong>Application</strong> tab.<br />
              3. Left sidebar &rarr; <strong>Storage</strong> &rarr; <strong>Cookies</strong> &rarr; <code>https://www.linkedin.com</code>.<br />
              4. Copy <code>li_at</code> (~150 chars starting with AQED...) and <code>JSESSIONID</code>.
            </div>

            <form onSubmit={handleSaveAccount}>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Account Email:</label>
                <input
                  type="email"
                  placeholder="name@company.com"
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
                  placeholder="e.g. Arun Jadhav"
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>
                  `li_at` Session Cookie (Starts with AQED..., ~150 chars):
                </label>
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
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>`JSESSIONID` Cookie:</label>
                <input
                  type="text"
                  placeholder='ajax:1234567890...'
                  value={newJsessionId}
                  onChange={(e) => setNewJsessionId(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box', fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>

              {verifyResult && (
                <div
                  style={{
                    marginBottom: 14,
                    padding: '10px 14px',
                    borderRadius: 6,
                    fontSize: 12,
                    backgroundColor: verifyResult.verified ? '#064e3b' : '#7f1d1d',
                    color: '#fff',
                    lineHeight: 1.4,
                  }}
                >
                  {verifyResult.message}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="submit"
                  style={{ flex: 1, background: '#0284c7', color: '#fff', border: 'none', padding: '10px 14px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
                >
                  Save Account & Credentials
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

      {/* TAB 7: SYSTEM HEALTH */}
      {activeTab === 'health' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>System Architecture & Resilience Probes</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginTop: 16 }}>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>PostgreSQL Database</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: health?.database === 'connected' ? '#34d399' : '#f87171', marginTop: 4 }}>
                {health?.database || 'connected'}
              </div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Redis / Distributed Lock</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#34d399', marginTop: 4 }}>
                {health?.redis || 'connected'}
              </div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Circuit Breaker State</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: health?.circuitBreaker?.state === 'CLOSED' ? '#34d399' : '#f87171', marginTop: 4 }}>
                {health?.circuitBreaker?.state || 'CLOSED'}
              </div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Dynamic Proxy Pool</div>
              <div style={{ fontSize: 18, fontWeight: 600, color: '#38bdf8', marginTop: 4 }}>
                {health?.activeProxies ?? 0} Nodes
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
