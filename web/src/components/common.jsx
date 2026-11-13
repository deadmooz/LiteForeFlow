import React, { useEffect, useMemo, useRef } from 'react';
import { X, Inbox, TriangleAlert } from 'lucide-react';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Windows that are open at the same moment (one counts as many) keep the page behind from scrolling.
let openModals = 0;

/** head replaces the plain title, footer sits under the scrolling body, className picks a size (see .modal.node). */
export function Modal({ title, onClose, children, wide, head, footer, className = '' }) {
  const box = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    // Keyboard users: move focus into the dialog, keep Tab inside it, and give focus back when it closes.
    const before = document.activeElement;
    const first = box.current?.querySelector('[data-autofocus], .modal-body input, .modal-body select, .modal-body textarea') ?? box.current?.querySelector('.modal-body button, .modal-body a[href]');
    (first ?? box.current)?.focus();
    openModals += 1; document.body.style.overflow = 'hidden';
    const onKey = (e) => {
      if (e.key === 'Escape') { close.current(); return; }
      if (e.key !== 'Tab' || !box.current) return;
      const items = [...box.current.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) { e.preventDefault(); return; }
      const [head, tail] = [items[0], items[items.length - 1]];
      if (!box.current.contains(document.activeElement)) { e.preventDefault(); head.focus(); }
      else if (e.shiftKey && document.activeElement === head) { e.preventDefault(); tail.focus(); }
      else if (!e.shiftKey && document.activeElement === tail) { e.preventDefault(); head.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); openModals -= 1; if (!openModals) document.body.style.overflow = ''; if (before?.isConnected) before.focus?.(); };
  }, []);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} tabIndex={-1} className={`modal ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          {head ?? <h2>{title}</h2>}
          <button className="icon" onClick={onClose} aria-label="Close"><X size={16} strokeWidth={1.75} aria-hidden="true" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

const STATUS_WORDS = { success: 'Succeeded', error: 'Failed', queued: 'Waiting', running: 'Running', skipped: 'Skipped' };
export const StatusBadge = ({ status }) => <span className={`badge ${status}`}>{STATUS_WORDS[status] ?? status}</span>;

/*
 * Shows JSON without ever serialising more than `max` characters. A run can hold hundreds of thousands of items;
 * stringifying all of them just to cut the text afterwards would freeze the page, so a list is walked item by item
 * and the walk stops as soon as enough text exists. `items` is a list of { json } wrappers (mapped lazily).
 */
function previewText(value, items, max) {
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}\n… (${value.length - max} more characters)` : value;
  const list = items ?? (Array.isArray(value) ? value : null);
  if (!list) { const t = JSON.stringify(value, null, 2) ?? ''; return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t; }
  const parts = [];
  let size = 2;
  let shown = 0;
  for (; shown < list.length && size < max; shown += 1) {
    const part = JSON.stringify(items ? list[shown].json : list[shown], null, 2) ?? 'null';
    parts.push(part.split('\n').map((l) => `  ${l}`).join('\n'));
    size += part.length + 2;
  }
  let text = parts.length ? `[\n${parts.join(',\n')}\n]` : '[]';
  if (text.length > max) text = `${text.slice(0, max)}\n… (output shortened)`;
  return shown < list.length ? `${text}\n… ${list.length - shown} more item${list.length - shown === 1 ? '' : 's'} not shown` : text;
}

export const Json = React.memo(function Json({ value, items, max = 4000 }) {
  const text = useMemo(() => previewText(value, items, max), [value, items, max]);
  return <pre className="json">{text}</pre>;
});

/** Placeholder that keeps the layout from jumping while data loads (CSS animation only, no JS timers). */
export function Loading({ rows = 5, cards = false }) {
  return (
    <div className={cards ? 'grid' : 'skel-rows'} role="status" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className={`skel ${cards ? 'skel-card' : 'skel-row'}`} />)}
    </div>
  );
}

export function EmptyState({ icon = <Inbox size={20} strokeWidth={1.75} />, title, children }) {
  return (
    <div className="card state">
      <div className="state-icon" aria-hidden="true">{icon}</div>
      {title && <h3 style={{ margin: 0 }}>{title}</h3>}
      <p className="muted">{children}</p>
    </div>
  );
}

/** A failed load always offers a way back: the message, and a button that tries again. */
export function ErrorState({ message, onRetry }) {
  return (
    <div className="card state bad" role="alert">
      <div className="state-icon" aria-hidden="true"><TriangleAlert size={20} strokeWidth={1.75} /></div>
      <h3 style={{ margin: 0 }}>That did not work</h3>
      <p className="muted">{message}</p>
      {onRetry && <button className="primary" onClick={onRetry}>Try again</button>}
    </div>
  );
}

/** Shows a node's recorded run data (used by the editor and the executions page). */
export function NodeResult({ result }) {
  if (!result) return <p className="muted">No data yet. Run the workflow or test this step.</p>;
  return (
    <div className="stack">
      <div className="row gap">
        <StatusBadge status={result.status} />
        {result.durationMs !== undefined && <span className="muted small">{result.durationMs} ms</span>}
        {result.tries > 1 && <span className="muted small">{result.tries} attempts</span>}
        {result.note && <span className="muted small">{result.note}</span>}
      </div>
      {result.error && <div className="error">{result.error}</div>}
      {result.logs?.length > 0 && (<><h4>Logs</h4><Json value={result.logs.join('\n')} /></>)}
      {result.input && (<><h4>Input ({result.input[0]?.length ?? 0} items)</h4><Json items={result.input[0] ?? []} /></>)}
      {result.output && (
        <>
          {result.output.map((o, idx) => (
            <div key={idx}>
              <h4>Output{result.output.length > 1 ? ` ${idx + 1}` : ''} ({o.length} items)</h4>
              <Json items={o} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
