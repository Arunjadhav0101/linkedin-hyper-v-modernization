import React, { useState } from 'react';
import Head from 'next/head';

export default function Dashboard() {
  const [deduping, setDeduping] = useState(false);
  const [dedupeResult, setDedupeResult] = useState<any>(null);

  const runDeduplication = async () => {
    setDeduping(true);
    try {
      const res = await fetch('/api/maintenance/messages/dedupe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dryRun: false }),
      });
      const json = await res.json();
      setDedupeResult(json.data);
    } catch (err: any) {
      setDedupeResult({ error: err.message });
    } finally {
      setDeduping(false);
    }
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 20px', fontFamily: 'system-ui, sans-serif' }}>
      <Head>
        <title>LinkedIn Hyper-V | Control Plane</title>
        <meta name="description" content="Enterprise-grade LinkedIn Automation & Data Sync Platform" />
      </Head>

      <header style={{ borderBottom: '1px solid #334155', paddingBottom: 20, marginBottom: 30 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: 28, margin: 0, fontWeight: 700, color: '#38bdf8' }}>LinkedIn Hyper-V 2.0</h1>
            <p style={{ margin: '4px 0 0', color: '#94a3b8' }}>Type-Safe Enterprise Automation Engine & Control Plane</p>
          </div>
          <div>
            <span style={{ backgroundColor: '#065f46', color: '#34d399', padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600 }}>
              System Healthy
            </span>
          </div>
        </div>
      </header>

      {/* Metrics Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 20, marginBottom: 30 }}>
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
          <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Active Accounts</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 8, color: '#f8fafc' }}>12</div>
          <div style={{ color: '#34d399', fontSize: 12, marginTop: 4 }}>100% within velocity limits</div>
        </div>
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
          <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Proxy Pool Health</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 8, color: '#f8fafc' }}>94%</div>
          <div style={{ color: '#38bdf8', fontSize: 12, marginTop: 4 }}>9 Healthy / 1 Degraded</div>
        </div>
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
          <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>DLQ Queue Size</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 8, color: '#f8fafc' }}>0</div>
          <div style={{ color: '#34d399', fontSize: 12, marginTop: 4 }}>All events processed</div>
        </div>
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 20 }}>
          <div style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Sync Idempotency</div>
          <div style={{ fontSize: 32, fontWeight: 700, marginTop: 8, color: '#f8fafc' }}>100%</div>
          <div style={{ color: '#a78bfa', fontSize: 12, marginTop: 4 }}>Zero duplicate rows</div>
        </div>
      </div>

      {/* Main Content Sections */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 20 }}>
        {/* Left Column: Accounts & Policies */}
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 18, marginTop: 0, color: '#f8fafc', marginBottom: 16 }}>Managed LinkedIn Accounts</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #334155', color: '#94a3b8', textAlign: 'left' }}>
                <th style={{ paddingBottom: 10 }}>Account</th>
                <th style={{ paddingBottom: 10 }}>Status</th>
                <th style={{ paddingBottom: 10 }}>Hourly Action Limit</th>
                <th style={{ paddingBottom: 10 }}>Daily Limit</th>
                <th style={{ paddingBottom: 10 }}>Assigned Proxy</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #334155' }}>
                <td style={{ padding: '12px 0', color: '#f8fafc' }}>enterprise-lead-1@company.com</td>
                <td><span style={{ color: '#34d399', background: '#065f46', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>ACTIVE</span></td>
                <td>14 / 20</td>
                <td>42 / 60</td>
                <td>198.51.100.24 (US)</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #334155' }}>
                <td style={{ padding: '12px 0', color: '#f8fafc' }}>recruiter-east@company.com</td>
                <td><span style={{ color: '#fbbf24', background: '#78350f', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>WARMING</span></td>
                <td>6 / 10</td>
                <td>18 / 30</td>
                <td>198.51.100.25 (US)</td>
              </tr>
              <tr>
                <td style={{ padding: '12px 0', color: '#f8fafc' }}>sales-emea@company.com</td>
                <td><span style={{ color: '#34d399', background: '#065f46', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>ACTIVE</span></td>
                <td>11 / 20</td>
                <td>35 / 60</td>
                <td>198.51.100.26 (GB)</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Right Column: Maintenance & Actions */}
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 24 }}>
          <h2 style={{ fontSize: 18, marginTop: 0, color: '#f8fafc', marginBottom: 16 }}>Pipeline Maintenance</h2>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.5 }}>
            Trigger idempotent database passes to verify and clean message duplicates across all active accounts.
          </p>
          <button
            onClick={runDeduplication}
            disabled={deduping}
            style={{
              width: '100%',
              backgroundColor: '#0284c7',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 16px',
              fontSize: 14,
              fontWeight: 600,
              cursor: deduping ? 'not-allowed' : 'pointer',
              marginTop: 10,
            }}
          >
            {deduping ? 'Running Deduplication Pass...' : 'Run /api/maintenance/messages/dedupe'}
          </button>

          {dedupeResult && (
            <div style={{ marginTop: 16, background: '#0f172a', border: '1px solid #334155', borderRadius: 8, padding: 12, fontSize: 12 }}>
              <div style={{ fontWeight: 600, color: '#38bdf8', marginBottom: 6 }}>Deduplication Result</div>
              <div>Scanned: {dedupeResult.scannedCount ?? 0}</div>
              <div>Duplicates Found: {dedupeResult.duplicateCount ?? 0}</div>
              <div>Deleted: {dedupeResult.deletedCount ?? 0}</div>
              <div>Duration: {dedupeResult.durationMs ?? 0}ms</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
