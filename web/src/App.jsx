import React, { createContext, useContext, useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, auth, firstName, initials, setUnauthorizedHandler } from './api.js';
import { ErrorState, Loading } from './components/common.jsx';
import { applyTheme, getTheme, useStoredFlag } from './hooks.js';
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

/** A crash inside one page shows a message and a retry, not a blank screen; moving to another page resets it. */
class Boundary extends React.Component {
  state = { err: null };
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (!this.state.err) return this.props.children;
    return <div className="page"><ErrorState message={`This page hit an unexpected problem: ${this.state.err.message}`} onRetry={() => this.setState({ err: null })} /></div>;
  }
}

const THEMES = ['auto', 'light', 'dark'];
function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme);
  const pick = (t) => { applyTheme(t); setTheme(t); };
  return (
    <div className="theme-seg" role="group" aria-label="Theme">
      {THEMES.map((t) => <button key={t} aria-pressed={theme === t} onClick={() => pick(t)}>{t[0].toUpperCase() + t.slice(1)}</button>)}
    </div>
  );
}

function Shell() {
  const { me, logout } = useSession();
  const { pathname } = useLocation();
  const switchWorkspace = (id) => { auth.workspace = id; window.location.assign('/'); };
  const [navHidden, toggleNav] = useStoredFlag('ff_hide_nav');
  const editing = pathname.startsWith('/workflows/') && pathname.length > '/workflows/'.length; // building or editing an automation: the canvas gets the whole window (the editor has its own back button)
  return (
    <div className="shell">
      {!editing && navHidden && (
        <div className="sidebar-rail"><button className="icon" onClick={toggleNav} aria-label="Show the menu" title="Show the menu">☰</button></div>
      )}
      {!editing && !navHidden && <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">⚡ LiteForeFlow</div>
          <button className="icon" onClick={toggleNav} aria-label="Hide the menu" title="Hide the menu">«</button>
        </div>
        <nav>
          <NavLink to="/" end>Workflows</NavLink>
          <NavLink to="/templates">Templates</NavLink>
          <NavLink to="/executions">Executions</NavLink>
          <NavLink to="/credentials">Credentials</NavLink>
          <NavLink to="/plugins">Plugins</NavLink>
          <NavLink to="/settings" title="Usage and plan">Plan</NavLink>
        </nav>
        <div className="sidebar-foot">
          {me.workspaces.length > 1 && (
            <select value={me.currentWorkspaceId} onChange={(e) => switchWorkspace(e.target.value)} aria-label="Workspace">
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          )}
          <div className="who">
            <span className="avatar" aria-hidden="true">{initials(me.user)}</span>
            <div><b>{me.user.name || firstName(me.user)}</b><small title={me.user.email}>{me.user.email}</small></div>
          </div>
          <ThemeToggle />
          <button className="link" onClick={logout}>Sign out</button>
        </div>
      </aside>}
      <main className="content">
        <Boundary key={pathname}>
        <Suspense fallback={<div className="page"><Loading rows={6} /></div>}>
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
        </Boundary>
      </main>
    </div>
  );
}
