import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { Modal } from '../components/common.jsx';

const TRIGGER_LABEL = { 'trigger.webhook': 'Webhook', 'trigger.cron': 'Schedule', 'trigger.rss': 'RSS', 'trigger.manual': 'Manual', 'trigger.error': 'Error' };

export default function Workflows() {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();

  const load = () => api('/workflows').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    const wf = await api('/workflows', {
      method: 'POST',
      body: {
        name: 'Untitled workflow',
        definition: { nodes: [{ id: 'start', type: 'trigger.manual', name: 'Manual Trigger', parameters: {}, position: { x: 80, y: 160 } }], connections: [] },
      },
    });
    navigate(`/workflows/${wf.id}`);
  };

  const act = async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Workflows</h1>
        <div className="row gap">
          <button onClick={() => setImporting(true)}>Import from n8n</button>
          <Link to="/templates"><button>Browse templates</button></Link>
          <button className="primary" onClick={create}>＋ New workflow</button>
        </div>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? (
        <div className="card empty">
          <h3>No workflows yet</h3>
          <p className="muted">Start from a template, import an n8n export, or build from scratch.</p>
          <div className="row gap center-x">
            <Link to="/templates"><button className="primary">Browse templates</button></Link>
            <button onClick={create}>Start from scratch</button>
          </div>
        </div>
      ) : (
        <table className="table">
          <thead><tr><th>Name</th><th>Trigger</th><th>Nodes</th><th>Updated</th><th>Active</th><th /></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w.id}>
                <td><Link to={`/workflows/${w.id}`}><b>{w.name}</b></Link></td>
                <td>{[...new Set(w.triggers.map((t) => TRIGGER_LABEL[t] ?? t))].join(', ') || '—'}</td>
                <td>{w.nodeCount}</td>
                <td className="muted">{fmtDate(w.updatedAt)}</td>
                <td>
                  <label className="switch" aria-label={`Toggle ${w.name}`}>
                    <input type="checkbox" checked={w.active} onChange={() => act(() => api(`/workflows/${w.id}/${w.active ? 'deactivate' : 'activate'}`, { method: 'POST' }))} />
                    <span>{w.active ? 'On' : 'Off'}</span>
                  </label>
                </td>
                <td className="actions">
                  <button className="link" onClick={() => act(() => api(`/workflows/${w.id}/duplicate`, { method: 'POST' }))}>Duplicate</button>
                  <button className="link danger" onClick={() => window.confirm(`Delete "${w.name}" and its execution history?`) && act(() => api(`/workflows/${w.id}`, { method: 'DELETE' }))}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {importing && <ImportModal onClose={() => setImporting(false)} onDone={(id) => navigate(`/workflows/${id}`)} />}
    </div>
  );
}

function ImportModal({ onClose, onDone }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const readFile = async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); };
  const submit = async () => {
    setError('');
    try {
      setResult(await api('/import/n8n', { method: 'POST', body: { workflow: JSON.parse(text) } }));
    } catch (e) { setError(e instanceof SyntaxError ? 'That is not valid JSON.' : e.message); }
  };

  return (
    <Modal title="Import an n8n workflow" onClose={onClose} wide>
      {!result ? (
        <div className="stack">
          <p className="muted">In n8n, open a workflow → <b>⋯ → Download</b>, then upload the JSON file or paste it below. Credentials are never exported by n8n, so you will reconnect them here.</p>
          <input type="file" accept=".json,application/json" onChange={readFile} aria-label="n8n workflow file" />
          <textarea rows={10} className="mono" placeholder='{ "nodes": [...], "connections": {...} }' value={text} onChange={(e) => setText(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <div className="row gap end">
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={!text.trim()} onClick={submit}>Import</button>
          </div>
        </div>
      ) : (
        <div className="stack">
          <h3>{result.report.converted} of {result.report.total} nodes converted</h3>
          {result.report.unsupported.length > 0 && (
            <>
              <h4>Not supported yet (replaced with placeholders)</h4>
              <ul>{result.report.unsupported.map((u) => <li key={u.name}><b>{u.name}</b> <span className="muted">({u.type})</span></li>)}</ul>
            </>
          )}
          {result.report.notes.length > 0 && (
            <>
              <h4>Needs your attention</h4>
              <ul>{result.report.notes.map((n, i) => <li key={i}><b>{n.name}:</b> {n.note}</li>)}</ul>
            </>
          )}
          <div className="row gap end"><button className="primary" onClick={() => onDone(result.workflow.id)}>Open workflow</button></div>
        </div>
      )}
    </Modal>
  );
}
