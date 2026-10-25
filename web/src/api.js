const TOKEN_KEY = 'ff_token';
const WS_KEY = 'ff_workspace';

export const auth = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ } },
  get workspace() { try { return localStorage.getItem(WS_KEY); } catch { return null; } },
  set workspace(v) { try { v ? localStorage.setItem(WS_KEY, v) : localStorage.removeItem(WS_KEY); } catch { /* ignore */ } },
};

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(auth.token ? { authorization: `Bearer ${auth.token}` } : {}),
      ...(auth.workspace ? { 'x-workspace-id': auth.workspace } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && auth.token) onUnauthorized();
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtDuration = (a, b) => (a && b ? `${((new Date(b) - new Date(a)) / 1000).toFixed(1)}s` : '—');
