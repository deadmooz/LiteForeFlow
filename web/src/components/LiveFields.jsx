import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/** Options may be plain strings or { value, label }. */
export const optionList = (options = []) => options.map((o) => (typeof o === 'object' ? o : { value: o, label: o === '' ? '(none)' : String(o) }));

/** A value that changes when any of the parameters a live list depends on changes. */
const depsKey = (values, names) => JSON.stringify(names.map((n) => values[n] ?? null));

/**
 * A dropdown filled from the live service ("which Notion databases can I pick?", "which Ollama models are installed?").
 * Falls back to typing when the list cannot be loaded, so a flaky connection never blocks you.
 */
export function LiveSelect({ typeDef, prop, values, value, onChange }) {
  const [state, setState] = useState({ options: [], loading: false, error: '', loaded: false });
  const [manual, setManual] = useState(false);
  const [tick, setTick] = useState(0);
  const watch = ['credential', 'provider', 'operation', ...(prop.dependsOn ?? [])];
  const key = depsKey(values, watch);
  const latest = useRef(0);

  useEffect(() => {
    const id = latest.current + 1;
    latest.current = id;
    setState((s) => ({ ...s, loading: true, error: '' }));
    api('/node-options', { method: 'POST', body: { type: typeDef.type, property: prop.name, parameters: values } })
      .then((r) => { if (latest.current === id) setState({ options: optionList(r.options), loading: false, error: r.error || '', loaded: true }); })
      .catch((e) => { if (latest.current === id) setState({ options: [], loading: false, error: e.message, loaded: true }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick, typeDef.type, prop.name]);

  const listed = state.options.some((o) => o.value === value);
  if (manual || (state.loaded && !state.options.length)) {
    return (
      <div className="stack tight live-select">
        <input aria-label={prop.label} value={value ?? ''} placeholder={prop.placeholder || 'Type it here'} onChange={(e) => onChange(e.target.value)} />
        <span className="muted small">
          {state.error ? `${state.error} ` : ''}
          <button type="button" className="link-button" onClick={() => { setManual(false); setTick((t) => t + 1); }}>Try the list again</button>
        </span>
      </div>
    );
  }
  return (
    <div className="stack tight live-select">
      <div className="row gap">
        <select aria-label={prop.label} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={state.loading && !state.options.length}>
          <option value="">{state.loading ? 'Loading…' : prop.required ? 'Choose…' : '(none)'}</option>
          {value && !listed && <option value={value}>{value}</option>}
          {state.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button type="button" className="icon" title="Reload the list" aria-label="Reload the list" onClick={() => setTick((t) => t + 1)}>↻</button>
      </div>
      <span className="muted small">
        <button type="button" className="link-button" onClick={() => setManual(true)}>Type it myself instead</button>
      </span>
    </div>
  );
}

/** One input per column of the chosen database (or any service that reports its fields). Stores { name: value }. */
export function FieldsEditor({ typeDef, prop, values, value, onChange }) {
  const [state, setState] = useState({ fields: [], loading: false, error: '' });
  const watch = ['credential', prop.fieldsFor ?? 'credential'];
  const key = depsKey(values, watch);
  const latest = useRef(0);
  const current = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const hasSource = Boolean(values[prop.fieldsFor ?? 'credential']);

  useEffect(() => {
    if (!hasSource) { setState({ fields: [], loading: false, error: '' }); return; }
    const id = latest.current + 1;
    latest.current = id;
    setState((s) => ({ ...s, loading: true, error: '' }));
    api('/node-options', { method: 'POST', body: { type: typeDef.type, property: prop.name, parameters: values, kind: 'fields' } })
      .then((r) => { if (latest.current === id) setState({ fields: r.fields ?? [], loading: false, error: r.error || '' }); })
      .catch((e) => { if (latest.current === id) setState({ fields: [], loading: false, error: e.message }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, typeDef.type, prop.name, hasSource]);

  // Switching to another database must not carry the old database's columns along: drop values that no longer exist.
  useEffect(() => {
    if (state.loading || state.error || !state.fields.length) return;
    const known = new Set(state.fields.map((f) => f.name));
    const stale = Object.keys(current).filter((k) => !known.has(k));
    if (stale.length) onChange(Object.fromEntries(Object.entries(current).filter(([k]) => known.has(k))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.fields, state.loading, state.error]);

  const set = (name, v) => {
    const next = { ...current };
    if (v === '' || v === undefined) delete next[name]; else next[name] = v;
    onChange(next);
  };

  if (!hasSource) return <p className="muted small">Choose the {prop.fieldsFor === 'databaseId' ? 'database' : 'source'} above to see its columns here.</p>;
  if (state.loading && !state.fields.length) return <p className="muted small">Loading columns…</p>;
  if (state.error) return <p className="muted small">{state.error}</p>;
  if (!state.fields.length) return <p className="muted small">This database has no extra columns to fill in. Only the title is used.</p>;

  return (
    <div className="stack tight columns-editor">
      {state.fields.map((f) => (
        <label key={f.name} className={f.type === 'boolean' ? 'inline' : ''}>
          <span>{f.label}</span>
          {f.type === 'boolean' ? (
            <input type="checkbox" checked={current[f.name] === true || current[f.name] === 'true'} onChange={(e) => set(f.name, e.target.checked ? true : '')} />
          ) : f.type === 'options' ? (
            <select value={current[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}>
              <option value="">(leave empty)</option>
              {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input
              value={current[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}
              placeholder={f.type === 'tags' ? 'one, two, three' : f.type === 'date' ? '2026-03-05' : f.type === 'number' ? 'a number, or {{ $json.field }}' : 'text, or {{ $json.field }}'}
            />
          )}
        </label>
      ))}
    </div>
  );
}
