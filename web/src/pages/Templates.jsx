import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function Templates() {
  const [list, setList] = useState(null);
  const [nodeTypes, setNodeTypes] = useState({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('All');
  const navigate = useNavigate();

  useEffect(() => {
    api('/templates').then(setList).catch((e) => setError(e.message));
    api('/node-types').then((t) => setNodeTypes(Object.fromEntries(t.map((x) => [x.type, x]))));
  }, []);

  const use = async (id) => {
    setBusy(id);
    try {
      const wf = await api(`/templates/${id}/use`, { method: 'POST' });
      navigate(`/workflows/${wf.id}`);
    } catch (e) { setError(e.message); setBusy(''); }
  };

  const categories = ['All', ...new Set((list ?? []).map((t) => t.category))];
  const shown = (list ?? []).filter((t) => filter === 'All' || t.category === filter);

  return (
    <div className="page">
      <div className="page-head"><h1>Templates</h1></div>
      <div className="row gap wrap">
        {categories.map((c) => (
          <button key={c} className={`chip ${filter === c ? 'active' : ''}`} onClick={() => setFilter(c)}>{c}</button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {!list ? <p className="muted">Loading…</p> : (
        <div className="grid">
          {shown.map((t) => (
            <div className="card template" key={t.id}>
              <div className="muted small">{t.category}</div>
              <h3>{t.name}</h3>
              <p className="muted">{t.description}</p>
              <div className="row gap wrap icons">
                {t.nodeTypes.map((nt) => <span key={nt} title={nodeTypes[nt]?.name}>{nodeTypes[nt]?.icon}</span>)}
              </div>
              <button className="primary" disabled={!!busy} onClick={() => use(t.id)}>{busy === t.id ? 'Creating…' : 'Use template'}</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
