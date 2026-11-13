import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SearchX, Plus } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtAgo, fmtDate } from '../api.js';
import { EmptyState, ErrorState, Loading, Modal } from '../components/common.jsx';
import { useDebounced, useSlashFocus } from '../hooks.js';

const TRIGGER_LABEL = { 'trigger.webhook': 'Webhook', 'trigger.cron': 'Schedule', 'trigger.rss': 'RSS', 'trigger.manual': 'Manual', 'trigger.error': 'Error' };

/** One table row. Memoised: switching one workflow on does not re-render the others. */
const WorkflowRow = React.memo(function WorkflowRow({ w, act }) {
  return (
    <tr key={w.id}>
      <td data-label="Name"><Link to={`/workflows/${w.id}`}><b>{w.name}</b></Link></td>
      <td data-label="Trigger">{[...new Set(w.triggers.map((t) => TRIGGER_LABEL[t] ?? t))].join(', ') || '—'}</td>
      <td data-label="Nodes">{w.nodeCount}</td>
      <td className="muted" data-label="Updated" title={fmtDate(w.updatedAt)}>{fmtAgo(w.updatedAt)}</td>
      <td data-label="Active">
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
  );
});

export default function Workflows() {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [query, setQuery] = useState('');
  const q = useDebounced(query, 200).trim().toLowerCase();
  const searchRef = useSlashFocus();
  const navigate = useNavigate();

  const load = () => api('/workflows').then((fresh) => {
    setList((prev) => {
      if (!prev) return fresh;
      const old = new Map(prev.map((w) => [w.id, w]));
      return fresh.map((w) => (JSON.stringify(old.get(w.id)) === JSON.stringify(w) ? old.get(w.id) : w)); // unchanged rows keep their identity, so they skip rendering
    });
    setError('');
  }).catch((e) => setError(e.message));
  const shown = useMemo(() => (q && list ? list.filter((w) => w.name.toLowerCase().includes(q)) : list), [list, q]);
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

  const act = useCallback(async (fn) => { try { await fn(); await load(); } catch (e) { setError(e.message); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <div className="hello">
          <h1>Workflows</h1>
        </div>
        <div className="toolbar">
          {list?.length > 4 && (
            <div className="search">
              <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workflows  ( / )" aria-label="Search workflows" />
            </div>
          )}
          <button onClick={() => setImporting(true)}>Import from n8n</button>
          <Link to="/templates"><button>Browse templates</button></Link>
          <button className="primary" onClick={create}><Plus size={14} aria-hidden="true" /> New workflow</button>
        </div>
      </div>
      {error && list && <div className="error" role="alert">{error}</div>}
      {!list ? (error ? <ErrorState message={error} onRetry={() => { setError(''); load(); }} /> : <Loading rows={6} />) : shown.length === 0 && list.length > 0 ? (
        <EmptyState icon={<SearchX size={20} strokeWidth={1.75} />} title="No match">No workflow is called “{query}”.</EmptyState>
      ) : list.length === 0 ? (
        <div className="card empty">
          <h3>No workflows yet</h3>
          <p className="muted">Start from a template, import an n8n workflow, or create a blank one.</p>
          <div className="row gap center-x">
            <Link to="/templates"><button className="primary">Browse templates</button></Link>
            <button onClick={create}>Start from scratch</button>
          </div>
        </div>
      ) : (
        <table className="table">
          <thead><tr><th>Name</th><th>Trigger</th><th>Nodes</th><th>Updated</th><th>Active</th><th /></tr></thead>
          <tbody>
            {shown.map((w) => <WorkflowRow key={w.id} w={w} act={act} />)}
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
