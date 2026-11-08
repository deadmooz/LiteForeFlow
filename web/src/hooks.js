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
