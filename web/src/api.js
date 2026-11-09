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
const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;
/** "5 minutes ago", "yesterday", "Mar 3": how people say it. The exact time stays available as a tooltip (fmtDate). */
export function fmtAgo(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t) || !rtf) return fmtDate(iso);
  const s = Math.round((t - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'just now';
  if (abs < 2700) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 79200) return rtf.format(Math.round(s / 3600), 'hour');
  if (abs < 6 * 86400) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(abs > 300 * 86400 ? { year: 'numeric' } : {}) });
}
export const greeting = (d = new Date()) => { const h = d.getHours(); return h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; };
export const firstName = (user) => String(user?.name || user?.email || '').trim().split(/[\s@.]/)[0] || 'there';
export const initials = (user) => { const n = String(user?.name || user?.email || '?').trim().split(/\s+/); return ((n[0]?.[0] ?? '?') + (n.length > 1 ? n[n.length - 1][0] : '')).toUpperCase(); };
export const fmtDuration = (a, b) => (a && b ? `${((new Date(b) - new Date(a)) / 1000).toFixed(1)}s` : '—');
