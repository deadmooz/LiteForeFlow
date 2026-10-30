import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const STATUS = {
  ok: { label: 'On', cls: 'success' },
  disabled: { label: 'Off', cls: 'skipped' },
  error: { label: 'Problem', cls: 'error' },
};

export default function Plugins() {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = () => api('/plugins').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const act = async (key, path) => {
    setBusy(key);
    setError('');
    try { setList(await api(path, { method: 'POST' })); } catch (e) { setError(e.message); }
    setBusy('');
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>Plugins</h1>
        <button onClick={() => act('reload', '/plugins/reload')} disabled={busy === 'reload' || list?.[0]?.canManage === false} title={list?.[0]?.canManage === false ? 'Only the owner (the first account) can reload' : 'Look for new or changed plugin folders'}>{busy === 'reload' ? 'Reloading…' : '↻ Reload'}</button>
      </div>
      <p className="muted">
        Plugins add blocks (nodes) and credential types. Some come with LiteForeFlow; you can add your own by dropping a folder into
        <code> data/plugins</code>.
      </p>
      {error && <div className="error">{error}</div>}
      {!list ? <p className="muted">Loading…</p> : (
        <div className="stack">
          {list.map((p) => {
            const st = STATUS[p.status] ?? STATUS.error;
            return (
              <div className="card plugin-card" key={`${p.id}-${p.source}`}>
                <div className="row gap wrap between">
                  <div>
                    <b>{p.name}</b> <span className="muted small">v{p.version || '?'} · {p.source === 'bundled' ? 'comes with LiteForeFlow' : `added by you${p.author ? ` · ${p.author}` : ''}`}</span>
                  </div>
                  <div className="row gap">
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {p.status !== 'error' && (
                      <button onClick={() => act(p.id, `/plugins/${p.id}/${p.status === 'ok' ? 'disable' : 'enable'}`)} disabled={busy === p.id || p.canManage === false} title={p.canManage === false ? 'Only the owner (the first account) can change this' : ''}>
                        {p.status === 'ok' ? 'Turn off' : 'Turn on'}
                      </button>
                    )}
                  </div>
                </div>
                {p.description && <p className="muted">{p.description}</p>}
                {p.status === 'error' && <div className="error">{p.error}</div>}
                {p.nodes.length > 0 && (
                  <div className="row gap wrap">
                    <span className="muted small">Blocks:</span>
                    {p.nodes.map((n) => <span className="chip" key={n.type}>{n.name}</span>)}
                  </div>
                )}
                {p.credentialTypes.length > 0 && (
                  <div className="row gap wrap">
                    <span className="muted small">Credential types:</span>
                    {p.credentialTypes.map((c) => <span className="chip" key={c.id}>{c.name}</span>)}
                  </div>
                )}
              </div>
            );
          })}
          {list.length === 0 && <div className="card empty"><p className="muted">No plugins found.</p></div>}
        </div>
      )}

      <div className="card plugin-howto">
        <h3>Make your own plugin</h3>
        <ol>
          <li>In the LiteForeFlow folder run: <code>npm run plugin:new -- my-plugin</code>. It creates <code>data/plugins/my-plugin</code> with a working example.</li>
          <li>Open <code>data/plugins/my-plugin/index.js</code> and change the example block.</li>
          <li>Press <b>Reload</b> above. Your block appears in the editor palette.</li>
        </ol>
        <p className="muted small">
          Just connecting a web service? You may not need code at all: describe it in one small JSON file (see the REST connector plugin and
          <code> docs/PLUGINS.md</code>). Plugins run with the same rights as LiteForeFlow itself, so only install plugins you trust.
          Only the owner (the first account) can turn plugins on and off.
        </p>
      </div>
    </div>
  );
}
