import React, { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';

type Tab = 'dashboard' | 'accounts' | 'messages' | 'connections' | 'jobs' | 'sync' | 'health';

export default function HyperVControlPlane() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Form states
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [messageRecipient, setMessageRecipient] = useState('');
  const [messageContent, setMessageContent] = useState('');
  const [targetProfileId, setTargetProfileId] = useState('');
  const [connectionNote, setConnectionNote] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionFeedback, setSubmissionFeedback] = useState<{ type: 'success' | 'error'; message: string; jobId?: string } | null>(null);

  // Account creation / session cookie update form
  const [newAccountEmail, setNewAccountEmail] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [newLiAt, setNewLiAt] = useState('');
  const [newJsessionId, setNewJsessionId] = useState('');

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
      const res = await fetch('/api/jobs?limit=30');
      const json = await res.json();
      if (json.success && json.data) {
        setJobs(json.data);
      }
    } catch {}
  }, []);

  // Fetch Messages
  const fetchMessages = useCallback(async () => {
    try {
      const res = await fetch('/api/messages?limit=30');
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
          },
        }),
      });

      const json = await res.json();
      if (json.success) {
        setSubmissionFeedback({
          type: 'success',
          message: `Job ${json.data.jobId} created with status QUEUED. Background worker is picking it up.`,
          jobId: json.data.jobId,
        });
        setMessageContent('');
        fetchJobs();
      } else {
        setSubmissionFeedback({
          type: 'error',
          message: json.error?.message || 'Failed to queue message job',
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
          message: `Connection Job ${json.data.jobId} created with status QUEUED.`,
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

  // Handle Message Sync
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
        setSubmissionFeedback({ type: 'error', message: json.error?.message || 'Failed to trigger sync' });
      }
    } catch (err: any) {
      setSubmissionFeedback({ type: 'error', message: err.message });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Save / Update Account Credentials
  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountEmail) return;

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newAccountEmail,
          name: newAccountName || undefined,
          cookies: {
            li_at: newLiAt || undefined,
            JSESSIONID: newJsessionId || undefined,
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
        alert('Account configured successfully!');
      } else {
        alert(json.error?.message || 'Failed to save account');
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
      case 'FAILED':
        return <span style={{ backgroundColor: '#991b1b', color: '#fca5a5', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>FAILED</span>;
      case 'RATE_LIMITED':
        return <span style={{ backgroundColor: '#9a3412', color: '#fdba74', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>RATE_LIMITED</span>;
      case 'DLQ_ROUTED':
        return <span style={{ backgroundColor: '#581c87', color: '#d8b4fe', padding: '3px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }}>DLQ_ROUTED</span>;
      default:
        return <span style={{ backgroundColor: '#334155', color: '#cbd5e1', padding: '3px 8px', borderRadius: 4, fontSize: 12 }}>{status}</span>;
    }
  };

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);

  // Calculate metrics
  const pendingCount = jobs.filter((j) => j.status === 'QUEUED' || j.status === 'RUNNING').length;
  const completedCount = jobs.filter((j) => j.status === 'COMPLETED').length;
  const failedCount = jobs.filter((j) => j.status === 'FAILED' || j.status === 'RATE_LIMITED').length;
  const dlqCount = jobs.filter((j) => j.status === 'DLQ_ROUTED').length;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '30px 20px', fontFamily: 'system-ui, -apple-system, sans-serif', color: '#f8fafc' }}>
      <Head>
        <title>LinkedIn Hyper-V | Control Plane & Execution Engine</title>
        <meta name="description" content="Type-safe LinkedIn automation, messaging and sync platform" />
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
            marginBottom: 20,
            padding: 14,
            borderRadius: 8,
            backgroundColor: submissionFeedback.type === 'success' ? '#064e3b' : '#7f1d1d',
            border: `1px solid ${submissionFeedback.type === 'success' ? '#059669' : '#dc2626'}`,
            color: '#f8fafc',
            fontSize: 14,
          }}
        >
          <strong>{submissionFeedback.type === 'success' ? '✓ Success: ' : '✕ Error: '}</strong>
          {submissionFeedback.message}
        </div>
      )}

      {/* TAB 1: DASHBOARD OVERVIEW */}
      {activeTab === 'dashboard' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 24 }}>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Active Accounts</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4 }}>{accounts.length}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Pending Jobs</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#fef08a' }}>{pendingCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Completed / Sent</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#34d399' }}>{completedCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Failed Jobs</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#fca5a5' }}>{failedCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>DLQ Size</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#d8b4fe' }}>{dlqCount}</div>
            </div>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Messages Ingested</div>
              <div style={{ fontSize: 28, fontWeight: 700, marginTop: 4, color: '#38bdf8' }}>{messages.length}</div>
            </div>
          </div>

          {/* Quick Actions & Recent Jobs preview */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 20 }}>
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
              <h3 style={{ marginTop: 0, fontSize: 16, color: '#38bdf8' }}>Quick Control Plane</h3>
              <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.4 }}>
                Select an account and trigger messaging or sync actions.
              </p>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 }}>Managed Account:</label>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6 }}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.email} ({a.hasAuthorizedSession ? 'Authorized' : 'No li_at'})
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <button
                  onClick={() => setActiveTab('messages')}
                  style={{ background: '#0284c7', color: '#fff', border: 'none', padding: 10, borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
                >
                  Open Messages UI →
                </button>
                <button
                  onClick={() => setActiveTab('connections')}
                  style={{ background: '#334155', color: '#fff', border: 'none', padding: 10, borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
                >
                  Open Connection Requests UI →
                </button>
                <button
                  onClick={handleTriggerSync}
                  disabled={isSubmitting}
                  style={{ background: '#0f766e', color: '#fff', border: 'none', padding: 10, borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
                >
                  {isSubmitting ? 'Dispatching...' : 'Sync Messages from LinkedIn'}
                </button>
              </div>
            </div>

            {/* Recent Jobs Preview */}
            <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>Live Automation Jobs</h3>
                <button onClick={() => setActiveTab('jobs')} style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: 12, cursor: 'pointer' }}>
                  View All →
                </button>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                    <th style={{ padding: '8px 0' }}>Job ID</th>
                    <th>Action</th>
                    <th>Account</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.slice(0, 5).map((j) => (
                    <tr key={j.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '8px 0', fontFamily: 'monospace', fontSize: 11 }}>{j.id.slice(0, 8)}...</td>
                      <td>{j.type}</td>
                      <td>{j.accountEmail}</td>
                      <td>{renderStatusBadge(j.status)}</td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr>
                      <td colSpan={4} style={{ padding: 16, textAlign: 'center', color: '#64748b' }}>No automation jobs yet. Create one from Messages or Connection Requests.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: MESSAGES */}
      {activeTab === 'messages' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr', gap: 24 }}>
          {/* Send Message Form */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Message Automation</h2>
            <p style={{ fontSize: 13, color: '#94a3b8' }}>
              Dispatches real LinkedIn messages via background worker. No fake stubs.
            </p>

            <form onSubmit={handleSendMessage}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Selected LinkedIn Account:</label>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6 }}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.email} {a.hasAuthorizedSession ? '✓ (Authorized)' : '⚠️ (Missing li_at)'}
                    </option>
                  ))}
                </select>
                {selectedAccount && !selectedAccount.hasAuthorizedSession && (
                  <div style={{ marginTop: 6, fontSize: 12, color: '#f87171' }}>
                    ⚠️ Account requires a valid `li_at` session cookie. Worker will halt and report missing integration rather than pretending success.
                  </div>
                )}
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Recipient / Profile Identifier:</label>
                <input
                  type="text"
                  placeholder="e.g. member:12345678 or profile-vanity-name"
                  value={messageRecipient}
                  onChange={(e) => setMessageRecipient(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Message Content:</label>
                <textarea
                  rows={4}
                  placeholder="Type your message here..."
                  value={messageContent}
                  onChange={(e) => setMessageContent(e.target.value)}
                  required
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                style={{
                  width: '100%',
                  background: '#0284c7',
                  color: '#fff',
                  border: 'none',
                  padding: '12px 16px',
                  borderRadius: 6,
                  fontWeight: 600,
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                }}
              >
                {isSubmitting ? 'Queueing Job...' : 'Send Message'}
              </button>
            </form>
          </div>

          {/* Synced Messages Log */}
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Synchronized Chat Messages</h2>
              <button onClick={fetchMessages} style={{ background: '#334155', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer' }}>
                Refresh
              </button>
            </div>
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              {messages.map((m) => (
                <div key={m.id} style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: m.direction === 'OUTBOUND' ? '#38bdf8' : '#34d399' }}>
                      {m.direction === 'OUTBOUND' ? 'Sent to: ' + (m.recipientName || m.recipientId) : 'From: ' + (m.senderName || m.senderId)}
                    </span>
                    <span>{new Date(m.sentAt).toLocaleTimeString()}</span>
                  </div>
                  <div style={{ fontSize: 14, color: '#f1f5f9', whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontFamily: 'monospace' }}>Idempotency: {m.idempotencyKey.slice(0, 16)}...</div>
                </div>
              ))}
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', color: '#64748b', padding: 40 }}>
                  No messages found in database. Send a message or trigger Message Sync.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: CONNECTION REQUESTS */}
      {activeTab === 'connections' && (
        <div style={{ maxWidth: 640, margin: '0 auto', background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>Connection Requests</h2>
          <p style={{ fontSize: 13, color: '#94a3b8' }}>
            Sends connection requests with optional personalized invitation notes through the selected authorized account.
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
                    {a.email} {a.hasAuthorizedSession ? '✓ (Authorized)' : '⚠️ (No li_at)'}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Target Profile Identifier / Vanity Name:</label>
              <input
                type="text"
                placeholder="e.g. satyanadella or member:98765432"
                value={targetProfileId}
                onChange={(e) => setTargetProfileId(e.target.value)}
                required
                style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 10, borderRadius: 6, boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>Optional Custom Invitation Note:</label>
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
              disabled={isSubmitting}
              style={{
                width: '100%',
                background: '#0284c7',
                color: '#fff',
                border: 'none',
                padding: '12px 16px',
                borderRadius: 6,
                fontWeight: 600,
                cursor: isSubmitting ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmitting ? 'Queueing Job...' : 'Send Connection Request'}
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
            <button onClick={fetchJobs} style={{ background: '#334155', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
              Refresh Jobs
            </button>
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
                    <td colSpan={8} style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>No automation jobs executed yet.</td>
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
              disabled={isSubmitting}
              style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
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
                    <th>Session Status</th>
                    <th>Hourly Limit</th>
                    <th>Daily Limit</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} style={{ borderBottom: '1px solid #334155' }}>
                      <td style={{ padding: '10px 0' }}>{a.email}</td>
                      <td>
                        {a.hasAuthorizedSession ? (
                          <span style={{ color: '#34d399', background: '#065f46', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>AUTHORIZED</span>
                        ) : (
                          <span style={{ color: '#f87171', background: '#7f1d1d', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>NO LI_AT COOKIE</span>
                        )}
                      </td>
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
            <p style={{ fontSize: 12, color: '#94a3b8' }}>
              Enter real LinkedIn session cookies (`li_at` and `JSESSIONID`) to enable actual live actions.
            </p>

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
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>Display Name (optional):</label>
                <input
                  type="text"
                  placeholder="e.g. John Doe"
                  value={newAccountName}
                  onChange={(e) => setNewAccountName(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>li_at Session Cookie:</label>
                <input
                  type="password"
                  placeholder="AQED..."
                  value={newLiAt}
                  onChange={(e) => setNewLiAt(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, color: '#cbd5e1', marginBottom: 4 }}>JSESSIONID Cookie (CSRF Token):</label>
                <input
                  type="text"
                  placeholder='ajax:...'
                  value={newJsessionId}
                  onChange={(e) => setNewJsessionId(e.target.value)}
                  style={{ width: '100%', background: '#0f172a', border: '1px solid #334155', color: '#fff', padding: 8, borderRadius: 6, boxSizing: 'border-box' }}
                />
              </div>

              <button
                type="submit"
                style={{ width: '100%', background: '#059669', color: '#fff', border: 'none', padding: 10, borderRadius: 6, fontWeight: 600, cursor: 'pointer' }}
              >
                Save Account & Credentials
              </button>
            </form>
          </div>
        </div>
      )}

      {/* TAB 7: HEALTH */}
      {activeTab === 'health' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 24 }}>
          <h2 style={{ marginTop: 0, fontSize: 18, color: '#38bdf8' }}>System Health & Circuit Breakers</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Overall Status</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#34d399', marginTop: 4 }}>{health?.status || 'UNKNOWN'}</div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Database Latency</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#38bdf8', marginTop: 4 }}>{health?.checks?.database?.latencyMs ?? '—'} ms</div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Redis Latency</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#a78bfa', marginTop: 4 }}>{health?.checks?.redis?.latencyMs ?? '—'} ms</div>
            </div>
            <div style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 16 }}>
              <div style={{ color: '#94a3b8', fontSize: 12 }}>Uptime</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#f8fafc', marginTop: 4 }}>{health?.uptimeSeconds ?? 0}s</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
