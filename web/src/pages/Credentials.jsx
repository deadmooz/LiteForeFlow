import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, fmtDate } from '../api.js';
import { CredentialModal } from '../components/ParamForm.jsx';
import { Loading } from '../components/common.jsx';

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
        <button className="primary" onClick={() => setModal({})}><Plus size={14} aria-hidden="true" /> New credential</button>
      </div>
      <p className="muted">Encrypted at rest (AES-256-GCM). Secret values are never sent back to the browser.</p>
      {error && <div className="error">{error}</div>}
      {!list ? <Loading rows={5} /> : list.length === 0 ? (
        <div className="card empty"><p className="muted">No credentials yet. Add one here or directly from a node.</p></div>
      ) : (
        <table className="table" role="table" aria-label="Credentials">
          <thead role="rowgroup"><tr role="row"><th role="columnheader">Name</th><th role="columnheader">Type</th><th role="columnheader">Created</th><th role="columnheader"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody role="rowgroup">
            {list.map((c) => (
              <tr key={c.id} role="row">
                <td role="cell" data-label="Name"><b>{c.name}</b></td><td role="cell" data-label="Type">{typeName(c.type)}</td><td role="cell" className="muted" data-label="Created">{fmtDate(c.createdAt)}</td>
                <td role="cell" className="actions">
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
