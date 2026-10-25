import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../App.jsx';

const Meter = ({ label, value, max }) => (
  <div className="meter-row">
    <div className="row between"><span>{label}</span><span className="muted">{value.toLocaleString()} / {max.toLocaleString()}</span></div>
    <div className="meter" role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      <div style={{ width: `${Math.min(100, (value / max) * 100)}%` }} className={value / max > 0.9 ? 'hot' : ''} />
    </div>
  </div>
);

export default function Settings() {
  const { me, refresh } = useSession();
  const [usage, setUsage] = useState(null);
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState(null);
  const isOwner = me.workspaces.find((w) => w.id === me.currentWorkspaceId)?.role === 'owner';

  const load = () => { api('/usage').then(setUsage); api('/workspace/members').then(setMembers); };
  useEffect(load, []);

  const upgrade = async (plan) => {
    setMsg(null);
    try {
      const { url } = await api('/billing/checkout', { method: 'POST', body: { plan } });
      window.location.assign(url);
    } catch (e) {
      if (e.status === 501) {
        // Stripe is not configured (local/dev): offer the demo switch instead.
        if (window.confirm('Billing is not configured on this server. Switch plan in demo mode (no payment)?')) {
          try { setUsage({ ...usage, ...(await api('/billing/dev-plan', { method: 'POST', body: { plan } })) }); await refresh(); load(); } catch (err) { setMsg({ kind: 'error', text: err.message }); }
        }
      } else setMsg({ kind: 'error', text: e.message });
    }
  };

  const invite = async (e) => {
    e.preventDefault();
    setMsg(null);
    try { await api('/workspace/invite', { method: 'POST', body: { email } }); setEmail(''); setMsg({ kind: 'ok', text: 'Member added' }); load(); } catch (err) { setMsg({ kind: 'error', text: err.message }); }
  };

  if (!usage) return <div className="page"><p className="muted">Loading…</p></div>;
  const { plan } = usage;

  return (
    <div className="page">
      <div className="page-head"><h1>Usage &amp; plan</h1></div>
      {msg && <div className={msg.kind === 'error' ? 'error' : 'ok'} role="status">{msg.text}</div>}

      <div className="card stack">
        <h3>Current plan: {plan.name}</h3>
        <Meter label="Runs this month" value={usage.runsThisMonth} max={plan.runsPerMonth} />
        <Meter label="Active workflows" value={usage.activeWorkflows} max={plan.activeWorkflows} />
        <Meter label="Members" value={usage.members} max={plan.members} />
        <p className="muted small">Runs are counted per workflow execution — never per step or node — and execution logs are kept for {plan.logRetentionDays} days.</p>
      </div>

      <h3>Plans</h3>
      <div className="grid">
        {usage.plans.map((p) => (
          <div className={`card plan ${p.id === plan.id ? 'current' : ''}`} key={p.id}>
            <h3>{p.name}</h3>
            <div className="price">${p.priceUsd}<span className="muted small">/month</span></div>
            <ul>
              <li>{p.activeWorkflows.toLocaleString()} active workflows</li>
              <li>{p.runsPerMonth.toLocaleString()} runs / month</li>
              <li>{p.members} member{p.members > 1 ? 's' : ''}</li>
              <li>{p.logRetentionDays}-day execution history</li>
            </ul>
            {p.id === plan.id ? <button disabled>Current plan</button>
              : p.priceUsd > 0 && <button className="primary" disabled={!isOwner} onClick={() => upgrade(p.id)}>Switch to {p.name}</button>}
          </div>
        ))}
      </div>

      <h3>Members</h3>
      <div className="card stack">
        <ul className="plain">{members.map((m) => <li key={m.id}><b>{m.name}</b> <span className="muted">{m.email} · {m.role}</span></li>)}</ul>
        {isOwner && (
          <form className="row gap" onSubmit={invite}>
            <input type="email" required placeholder="teammate@company.com (must already have an account)" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Invite by email" />
            <button className="primary">Add member</button>
          </form>
        )}
      </div>
    </div>
  );
}
