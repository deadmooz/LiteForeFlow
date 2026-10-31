import React, { createContext, useContext, useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api, auth, setUnauthorizedHandler } from './api.js';
import Login from './pages/Login.jsx';
import Workflows from './pages/Workflows.jsx';
// The editor (with its canvas library) is the heavy part: it is only fetched when a workflow is opened.
const Editor = lazy(() => import('./pages/Editor.jsx'));
import Templates from './pages/Templates.jsx';
import Executions from './pages/Executions.jsx';
import Credentials from './pages/Credentials.jsx';
import Settings from './pages/Settings.jsx';
import Plugins from './pages/Plugins.jsx';

const Session = createContext(null);
export const useSession = () => useContext(Session);

export default function App() {
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(!!auth.token);
  const navigate = useNavigate();

  const logout = useCallback(() => {
    auth.token = null;
    auth.workspace = null;
    setMe(null);
    navigate('/login');
  }, [navigate]);

  const refresh = useCallback(async () => {
    const data = await api('/me');
    auth.workspace = data.currentWorkspaceId;
    setMe(data);
    return data;
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!auth.token) return;
    refresh().catch(() => logout()).finally(() => setLoading(false));
  }, [logout, refresh]);

  const onAuthed = (data) => {
    auth.token = data.token;
    auth.workspace = data.workspaces[0]?.id;
    refresh().then(() => navigate('/'));
  };

  if (loading) return <div className="center muted">Loading…</div>;

  return (
    <Session.Provider value={{ me, refresh, logout }}>
      <Routes>
        <Route path="/login" element={me ? <Navigate to="/" /> : <Login onAuthed={onAuthed} />} />
        <Route path="/*" element={me ? <Shell /> : <Navigate to="/login" />} />
      </Routes>
    </Session.Provider>
  );
}

function Shell() {
  const { me, logout } = useSession();
  const switchWorkspace = (id) => { auth.workspace = id; window.location.assign('/'); };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">⚡ LiteForeFlow</div>
        <nav>
          <NavLink to="/" end>Workflows</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/executions">Executions</NavLink>
          <NavLink to="/credentials">Credentials</NavLink>
          <NavLink to="/plugins">Plugins</NavLink>
          <NavLink to="/settings">Usage &amp; plan</NavLink>
        </nav>
        <div className="sidebar-foot">
          {me.workspaces.length > 1 && (
            <select value={me.currentWorkspaceId} onChange={(e) => switchWorkspace(e.target.value)} aria-label="Workspace">
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <div className="muted small">{me.user.email}</div>
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        <Suspense fallback={<div className="center muted">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Workflows />} />
          <Route path="/workflows/:id" element={<Editor />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/executions" element={<Executions />} />
          <Route path="/credentials" element={<Credentials />} />
          <Route path="/plugins" element={<Plugins />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
        </Suspense>
      </main>
    </div>
  );
}
