import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, SearchX, ChevronDown, ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, fmtAgo, fmtDate, fmtDuration } from '../api.js';
import { EmptyState, ErrorState, Loading, Modal, NodeResult, StatusBadge } from '../components/common.jsx';
import VirtualList from '../components/VirtualList.jsx';
import { useDebounced, useRowHeight, useSlashFocus } from '../hooks.js';

const PAGE = 100;
const rowKey = (r) => r.id;
const COLS = 'minmax(140px, 1.6fr) 96px 88px 176px 72px minmax(0, 2fr)';
const HEADER = ['Workflow', 'Status', 'Mode', 'Started', 'Duration', 'Error'].map((h) => <span key={h} role="columnheader">{h}</span>);
// Cheap fingerprint: a refresh that brought nothing new must not re-render the list.
const fingerprint = (rows) => rows.map((r) => `${r.id}${r.status}${r.finishedAt ?? ''}`).join('|');

export default function Executions() {
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const q = useDebounced(query, 200).trim().toLowerCase();
  const rowHeight = useRowHeight(48, 76);
  const searchRef = useSlashFocus();
  const latest = useRef([]);
  const turn = useRef(0); // a slow answer for an old filter must never overwrite a newer one
  const busy = useRef(false);

  const page = useCallback((offset) => api(`/executions?limit=${PAGE}&offset=${offset}${status ? `&status=${status}` : ''}`), [status]);

  const reload = useCallback(async ({ quiet = false } = {}) => {
    const mine = ++turn.current;
    if (!quiet) { setRows(null); setError(''); setFresh(false); }
    try {
      const first = await page(0);
      if (mine !== turn.current) return;
      const browsingHistory = latest.current.length > PAGE;
      if (quiet && browsingHistory) { // do not move rows under someone who scrolled down: offer a refresh instead
        if (fingerprint(first) !== fingerprint(latest.current.slice(0, PAGE))) setFresh(true);
        return;
      }
      if (quiet && fingerprint(first) === fingerprint(latest.current)) return;
      latest.current = first;
      setRows(first);
      setMore(first.length === PAGE);
      setError('');
    } catch (e) {
      if (mine === turn.current && !quiet) setError(e.message);
    }
  }, [page]);

  useEffect(() => {
    latest.current = [];
    reload();
    const t = setInterval(() => { if (!document.hidden) reload({ quiet: true }); }, 15000); // hidden tabs do not poll
    return () => { clearInterval(t); turn.current += 1; };
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const mine = turn.current;
    try {
      const next = await page(latest.current.length);
      if (mine !== turn.current) return;
      const seen = new Set(latest.current.map((r) => r.id));
      latest.current = [...latest.current, ...next.filter((r) => !seen.has(r.id))];
      setRows(latest.current);
      setMore(next.length === PAGE);
    } catch (e) { setError(e.message); } finally { busy.current = false; }
  }, [page]);

  const shown = useMemo(() => (!rows ? null : q
    ? rows.filter((r) => `${r.workflowName} ${r.error?.message ?? ''} ${r.id}`.toLowerCase().includes(q))
    : rows), [rows, q]);

  const renderRow = useCallback((e, style, key) => (
    <div key={key} className="vrow clickable" style={style} role="row" tabIndex={0}
      onClick={() => setOpenId(e.id)} onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpenId(e.id); } }}>
      <span role="cell"><Link to={`/workflows/${e.workflowId}`} onClick={(ev) => ev.stopPropagation()}>{e.workflowName}</Link></span>
      <span role="cell"><StatusBadge status={e.status} /></span>
      <span role="cell" className="hide-sm">{e.mode}</span>
      <span role="cell" className="muted" title={fmtDate(e.startedAt)}>{fmtAgo(e.startedAt)}</span>
      <span role="cell">{fmtDuration(e.startedAt, e.finishedAt)}</span>
      <span role="cell" className="muted hide-sm">{e.error?.message}</span>
    </div>
  ), []);

  // Built once per change of its inputs, so the memoised list is not re-rendered while someone types.
  const footer = useMemo(() => (!shown ? null : (
            <>
              <span>{shown.length.toLocaleString()} {q ? 'matching ' : ''}run{shown.length === 1 ? '' : 's'} loaded{more ? ' · scroll for more' : ''}</span>
              <span className="row gap">
                {error && <span className="error inline-msg" role="alert">{error}</span>}
                {fresh && <button className="link" onClick={() => reload()}>New runs available · refresh</button>}
                {more && <button className="link" onClick={loadMore}>Load more</button>}
              </span>
            </>
  )), [shown?.length, q, more, error, fresh, reload, loadMore]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="page-head">
        <h1>Executions</h1>
        <div className="toolbar">
          <div className="search">
            <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search loaded runs  ( / )" aria-label="Search executions" />
          </div>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
          </select>
        </div>
      </div>
      {error && !rows ? <ErrorState message={error} onRetry={() => reload()} />
        : !shown ? <Loading rows={8} />
          : rows.length === 0 ? <EmptyState icon={<Play size={20} strokeWidth={1.75} />} title="No executions yet">Run a workflow and it will show up here.</EmptyState>
            : shown.length === 0 ? <EmptyState icon={<SearchX size={20} strokeWidth={1.75} />} title="No match">Nothing in the {rows.length} loaded runs matches “{query}”. {more && 'Load more runs, or clear the search.'}</EmptyState>
              : (
                <VirtualList
                  rows={shown} rowHeight={rowHeight} columns={COLS} rowKey={rowKey} renderRow={renderRow}
                  onEnd={q ? undefined : loadMore}
                  header={HEADER}
                  footer={footer}
                />
              )}
      {openId && <ExecutionModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function ExecutionModal({ id, onClose }) {
  const [ex, setEx] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => { setError(''); setEx(null); api(`/executions/${id}`).then(setEx).catch((e) => setError(e.message)); }, [id]);
  useEffect(() => { load(); }, [load]);
  return (
    <Modal title="Execution details" onClose={onClose} wide>
      {error ? <ErrorState message={error} onRetry={load} /> : !ex ? <Loading rows={3} /> : (
        <div className="stack">
          <div className="row gap wrap">
            <b>{ex.workflowName}</b> <StatusBadge status={ex.status} /> <span className="muted">{fmtDate(ex.startedAt)} · {ex.mode}{ex.worker ? ` · worker ${ex.worker}` : ''}</span>
          </div>
          {ex.error && <div className="error">Failed at <b>{ex.error.nodeName ?? 'workflow'}</b>: {ex.error.message}</div>}
          {ex.error?.truncated && <p className="muted small">Some item data was truncated to keep logs small.</p>}
          {Object.entries(ex.results ?? {}).map(([nodeId, r]) => (
            <div key={nodeId} className="card flat">
              <button className="link row gap" onClick={() => setOpen(open === nodeId ? null : nodeId)} aria-expanded={open === nodeId}>
                <span>{open === nodeId ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span> <b>{r.name ?? nodeId}</b> <StatusBadge status={r.status} />
                {r.durationMs !== undefined && <span className="muted small">{r.durationMs} ms</span>}
              </button>
              {open === nodeId && <NodeResult result={r} />}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
