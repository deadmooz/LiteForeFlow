import { useEffect, useRef, useState } from 'react';

/** Follows `value`, but only after it has stopped changing for `ms` (search boxes: one filter pass per pause, not per keystroke). */
export function useDebounced(value, ms = 200) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** `wide` rows on a desktop screen, `narrow` rows on a phone. Re-evaluated only when the breakpoint flips. */
export function useRowHeight(wide, narrow, query = '(max-width: 720px)') {
  const [small, setSmall] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setSmall(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return small ? narrow : wide;
}

/** Pressing "/" outside a text field jumps to the search box (the same shortcut GitHub and Gmail use). */
export function useSlashFocus() {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return ref;
}

const THEME_KEY = 'ff_theme';
export const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } };
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { theme === 'auto' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
}

/** An on/off setting remembered in this browser (a collapsed sidebar). Works without storage, it just is not remembered then. */
export function useStoredFlag(key, initial = false) {
  const [on, setOn] = useState(() => { try { const v = localStorage.getItem(key); return v === null ? initial : v === '1'; } catch { return initial; } });
  const toggle = () => setOn((cur) => { const next = !cur; try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* not remembered */ } return next; });
  return [on, toggle];
}

/** A number setting (a sidebar width) kept inside [min, max] and remembered in this browser. A bad saved value falls back to `initial`. */
export function useStoredNumber(key, initial, min, max) {
  const clamp = (v) => Math.min(max, Math.max(min, Math.round(v)));
  const [n, setN] = useState(() => { try { const v = Number(localStorage.getItem(key)); return localStorage.getItem(key) !== null && Number.isFinite(v) ? clamp(v) : initial; } catch { return initial; } });
  // `remember` is false while a drag is going on; the value is written once when it ends
  const set = (v, remember = true) => { const c = clamp(v); setN(c); if (remember) { try { localStorage.setItem(key, String(c)); } catch { /* not remembered */ } } };
  return [n, set];
}
