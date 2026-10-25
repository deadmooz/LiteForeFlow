import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, fmtDuration } from '../api.js';
import { Modal, NodeResult, StatusBadge } from '../components/common.jsx';

export default function Executions() {
  const [list, setList] = useState(null);
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState(null);
  const [error, setError] = useState('');

  const load = () => api(`/executions?limit=100${status ? `&status=${status}` : ''}`).then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <h1>Executions</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="queued">Queued</option>
          <option value="running">Running</option>
        </select>
      </div>
      {error && <div className="error">{error}</div>}
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? (
        <div className="card empty"><p className="muted">No executions yet. Run a workflow and it will show up here.</p></div>
      ) : (
        <table className="table">
          <thead><tr><th>Workflow</th><th>Status</th><th>Mode</th><th>Started</th><th>Duration</th><th>Error</th></tr></thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="clickable" onClick={() => setOpenId(e.id)}>
                <td><Link to={`/workflows/${e.workflowId}`} onClick={(ev) => ev.stopPropagation()}>{e.workflowName}</Link></td>
                <td><StatusBadge status={e.status} /></td>
                <td>{e.mode}</td>
                <td className="muted">{fmtDate(e.startedAt)}</td>
                <td>{fmtDuration(e.startedAt, e.finishedAt)}</td>
                <td className="muted ellipsis">{e.error?.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {openId && <ExecutionModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ExecutionModal({ id, onClose }) {
  const [ex, setEx] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { api(`/executions/${id}`).then(setEx); }, [id]);
  return (
    <Modal title="Execution details" onClose={onClose} wide>
      {!ex ? <p className="muted">Loading…</p> : (
        <div className="stack">
          <div className="row gap wrap">
            <b>{ex.workflowName}</b> <StatusBadge status={ex.status} /> <span className="muted">{fmtDate(ex.startedAt)} · {ex.mode}{ex.worker ? ` · worker ${ex.worker}` : ''}</span>
          </div>
          {ex.error && <div className="error">Failed at <b>{ex.error.nodeName ?? 'workflow'}</b>: {ex.error.message}</div>}
          {ex.error?.truncated && <p className="muted small">Some item data was truncated to keep logs small.</p>}
          {Object.entries(ex.results).map(([nodeId, r]) => (
            <div key={nodeId} className="card flat">
              <button className="link row gap" onClick={() => setOpen(open === nodeId ? null : nodeId)} aria-expanded={open === nodeId}>
                <span>{open === nodeId ? '▾' : '▸'}</span> <b>{r.name ?? nodeId}</b> <StatusBadge status={r.status} />
                {r.durationMs !== undefined && <span className="muted small">{r.durationMs} ms</span>}
              </button>
              {open === nodeId && <NodeResult result={r} />}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
