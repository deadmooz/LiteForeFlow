import React, { useEffect } from 'react';

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export const StatusBadge = ({ status }) => <span className={`badge ${status}`}>{status}</span>;

export function Json({ value, max = 4000 }) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text === undefined) text = '';
  const truncated = text.length > max;
  return <pre className="json">{truncated ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text}</pre>;
}

/** Shows a node's recorded run data (used by the editor and the executions page). */
export function NodeResult({ result }) {
  if (!result) return <p className="muted">No data yet. Run the workflow or test this step.</p>;
  const items = (arr) => (arr ?? []).map((a) => a.map((i) => i.json));
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
      {result.input && (<><h4>Input ({result.input[0]?.length ?? 0} items)</h4><Json value={items(result.input)[0]} /></>)}
      {result.output && (
        <>
          {result.output.map((o, idx) => (
            <div key={idx}>
              <h4>Output{result.output.length > 1 ? ` ${idx + 1}` : ''} ({o.length} items)</h4>
              <Json value={o.map((i) => i.json)} />
            </div>
          ))}
        </>
      )}
    </div>
  );
}
