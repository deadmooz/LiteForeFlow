import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { CredentialModal } from '../components/ParamForm.jsx';

export default function Credentials() {
  const [list, setList] = useState(null);
  const [types, setTypes] = useState([]);
  const [modal, setModal] = useState(null); // null | { existing? }
  const [error, setError] = useState('');

  const load = () => api('/credentials').then(setList).catch((e) => setError(e.message));
  useEffect(() => { load(); api('/credential-types').then(setTypes); }, []);
  const typeName = (id) => types.find((t) => t.id === id)?.name ?? id;

  const edit = async (c) => setModal({ existing: await api(`/credentials/${c.id}`) });

  return (
    <div className="page">
      <div className="page-head">
        <h1>Credentials</h1>
        <button className="primary" onClick={() => setModal({})}>＋ New credential</button>
      </div>
      <p className="muted">Encrypted at rest (AES-256-GCM). Secret values are never sent back to the browser.</p>
      {error && <div className="error">{error}</div>}
      {!list ? <p className="muted">Loading…</p> : list.length === 0 ? (
        <div className="card empty"><p className="muted">No credentials yet. Add one here or directly from a node.</p></div>
      ) : (
        <table className="table">
          <thead><tr><th>Name</th><th>Type</th><th>Created</th><th /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id}>
                <td data-label="Name"><b>{c.name}</b></td><td data-label="Type">{typeName(c.type)}</td><td className="muted" data-label="Created">{fmtDate(c.createdAt)}</td>
                <td className="actions">
                  <button className="link" onClick={() => edit(c)}>Edit</button>
                  <button className="link danger" onClick={async () => { if (window.confirm(`Delete credential "${c.name}"? Workflows using it will fail until you pick another.`)) { await api(`/credentials/${c.id}`, { method: 'DELETE' }); load(); } }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {modal && <CredentialModal existing={modal.existing} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
