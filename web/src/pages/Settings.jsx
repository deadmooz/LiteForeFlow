import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../App.jsx';
import { Loading } from '../components/common.jsx';

const Meter = ({ label, value, max }) => (
  <div className="meter-row">
    <div className="row between"><span>{label}</span><span className="muted">{value.toLocaleString()} / {max.toLocaleString()}</span></div>
    <div className="meter" role="progressbar" aria-valuenow={value} aria-valuemax={max} aria-label={label}>
      <div style={{ width: `${Math.min(100, (value / max) * 100)}%` }} className={value / max > 0.9 ? 'hot' : ''} />
    </div>
  </div>
);

export default function Settings() {
  const { me } = useSession();
  const [usage, setUsage] = useState(null);
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState(null);
  const isOwner = me.workspaces.find((w) => w.id === me.currentWorkspaceId)?.role === 'owner';

  const load = () => { api('/usage').then(setUsage); api('/workspace/members').then(setMembers); };
  useEffect(load, []);

  const removeMember = async (m) => {
    const leaving = m.id === me.user.id;
    if (!window.confirm(leaving ? 'Leave this workspace? You will lose access to its workflows.' : `Remove ${m.name} from this workspace?`)) return;
    setMsg(null);
    try {
      await api(`/workspace/members/${m.id}`, { method: 'DELETE' });
      if (leaving) { window.location.assign('/'); return; }
      setMsg({ kind: 'ok', text: 'Member removed' });
      load();
    } catch (err) { setMsg({ kind: 'error', text: err.message }); }
  };

  const invite = async (e) => {
    e.preventDefault();
    setMsg(null);
    try { await api('/workspace/invite', { method: 'POST', body: { email } }); setEmail(''); setMsg({ kind: 'ok', text: 'Member added' }); load(); } catch (err) { setMsg({ kind: 'error', text: err.message }); }
  };

  if (!usage) return <div className="page"><Loading rows={5} /></div>;
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

      <h3>Members</h3>
      <div className="card stack">
        <ul className="plain">{members.map((m) => (
          <li key={m.id} className="row between">
            <span><b>{m.name}</b> <span className="muted">{m.email} · {m.role}</span></span>
            {m.role !== 'owner' && (isOwner || m.id === me.user.id) && (
              <button className="link danger" onClick={() => removeMember(m)}>{m.id === me.user.id ? 'Leave' : 'Remove'}</button>
            )}
          </li>
        ))}</ul>
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
