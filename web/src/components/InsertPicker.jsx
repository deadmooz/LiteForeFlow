import { useEffect, useMemo, useRef, useState } from 'react';

/** A small "add a step here" menu: type to filter, arrow keys to move, Enter to pick, Esc to close. */
export default function InsertPicker({ types, x, y, onPick, onClose }) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef(null);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return types.filter((t) => !needle || `${t.name} ${t.description}`.toLowerCase().includes(needle)).slice(0, 40);
  }, [types, q]);

  useEffect(() => {
    box.current?.querySelector('input')?.focus();
    const away = (e) => { if (box.current && !box.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { box.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(list.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && list[at]) { e.preventDefault(); onPick(list[at]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div ref={box} className="insert-picker" style={{ left: x, top: y }} role="dialog" aria-label="Add a step here">
      <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Add a step here…" aria-label="Search steps" />
      <ul role="listbox">
        {list.length === 0 && <li className="muted small empty">Nothing matches “{q}”.</li>}
        {list.map((t, i) => (
          <li key={t.type} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onMouseEnter={() => setAt(i)} onClick={() => onPick(t)}>
            <span aria-hidden="true">{t.icon}</span> <b>{t.name}</b> <small className="muted">{t.description}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
