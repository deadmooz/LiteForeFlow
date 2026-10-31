import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Modal } from './common.jsx';
import { SchedulePicker, TimezoneSelect } from './SchedulePicker.jsx';
import { LiveSelect, FieldsEditor, optionList } from './LiveFields.jsx';

export const OPERATORS = ['equals', 'notEquals', 'contains', 'notContains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty', 'regex', 'isTrue', 'isFalse'];
const NO_RIGHT = new Set(['isEmpty', 'isNotEmpty', 'isTrue', 'isFalse']);

/** Merges stored parameters with the node type's defaults, so the form always shows effective values. */
export const effectiveParams = (typeDef, params = {}) => {
  const out = { ...params };
  for (const p of typeDef.properties ?? []) if (out[p.name] === undefined && p.default !== undefined) out[p.name] = p.default;
  return out;
};

const visible = (prop, values) => {
  if (!prop.showIf) return true;
  return Object.entries(prop.showIf).every(([k, v]) => (Array.isArray(v) ? v.includes(values[k]) : values[k] === v));
};

export function CredentialModal({ typeId, onClose, onSaved, existing }) {
  const [types, setTypes] = useState([]);
  const [type, setType] = useState(typeId ?? existing?.type ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [data, setData] = useState(existing?.data ?? {});
  const [secretsSet] = useState(existing?.secretsSet ?? []);
  const [error, setError] = useState('');
  const [test, setTest] = useState(null); // { busy } | { ok, warn, message }

  useEffect(() => { api('/credential-types').then(setTypes); }, []);
  const def = types.find((t) => t.id === type);
  const options = Array.isArray(typeId) ? types.filter((t) => typeId.includes(t.id)) : types;

  const runTest = async () => {
    setTest({ busy: true });
    try { setTest(await api('/credentials/test', { method: 'POST', body: { id: existing?.id, type, data } })); } catch (err) { setTest({ ok: false, message: err.message }); }
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const res = existing
        ? await api(`/credentials/${existing.id}`, { method: 'PUT', body: { name, data } })
        : await api('/credentials', { method: 'POST', body: { name: name || def.name, type, data } });
      onSaved(res);
    } catch (err) { setError(err.message); }
  };

  return (
    <Modal title={existing ? 'Edit credential' : 'New credential'} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        {!existing && (
          <label>Type
            <select value={type} onChange={(e) => { setType(e.target.value); setData({}); }} required>
              <option value="">Select…</option>
              {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
        )}
        {def?.setup?.length > 0 && (
          <div className="setup-steps">
            <b>How to get this</b>
            <ol>{def.setup.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </div>
        )}
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={def?.name ?? 'My credential'} /></label>
        {def?.fields.map((f) => (
          <label key={f.name}>{f.label}{f.required && ' *'}
            {f.type === 'text' ? (
              <textarea rows={6} className="mono" value={data[f.name] ?? ''} onChange={(e) => setData({ ...data, [f.name]: e.target.value })} />
            ) : f.type === 'boolean' ? (
              <input type="checkbox" checked={!!data[f.name]} onChange={(e) => setData({ ...data, [f.name]: e.target.checked })} />
            ) : (
              <input
                type={f.type === 'password' ? 'password' : 'text'} autoComplete="off" value={data[f.name] ?? ''}
                placeholder={secretsSet.includes(f.name) ? '•••••••• (unchanged)' : f.placeholder}
                onChange={(e) => setData({ ...data, [f.name]: e.target.value })}
              />
            )}
          </label>
        ))}
        <p className="muted small">Secrets are encrypted at rest and never shown again after saving.</p>
        {def && (
          <div className="row gap wrap">
            <button type="button" onClick={runTest} disabled={test?.busy}>{test?.busy ? 'Testing…' : 'Test connection'}</button>
            {test && !test.busy && <span className={`test-result ${test.ok ? (test.warn || test.untested ? 'warn' : 'ok') : 'bad'}`} role="status">{test.ok ? (test.warn || test.untested ? '⚠ ' : '✓ ') : '✕ '}{test.message}</span>}
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row gap end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!def}>Save</button>
        </div>
      </form>
    </Modal>
  );
}

function CredentialSelect({ prop, value, onChange, values, credentials, reloadCredentials }) {
  const [creating, setCreating] = useState(false);
  const types = prop.credentialTypeBy
    ? [prop.credentialTypeBy.map[values[prop.credentialTypeBy.param]]]
    : [].concat(prop.credentialType);
  const matching = credentials.filter((c) => types.includes(c.type));
  return (
    <div className="row gap">
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">{prop.required ? 'Select credential…' : 'None'}</option>
        {matching.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <button type="button" onClick={() => setCreating(true)}>＋ New</button>
      {creating && (
        <CredentialModal
          typeId={types.length === 1 ? types[0] : types}
          onClose={() => setCreating(false)}
          onSaved={async (c) => { await reloadCredentials(); onChange(c.id); setCreating(false); }}
        />
      )}
    </div>
  );
}

function KeyValue({ value, onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const update = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack tight">
      {rows.map((r, i) => (
        <div className="row gap" key={i}>
          <input placeholder="field" value={r.name ?? ''} onChange={(e) => update(i, { name: e.target.value })} />
          <input placeholder="value or {{ expression }}" value={r.value ?? ''} onChange={(e) => update(i, { value: e.target.value })} />
          <button type="button" className="icon" aria-label="Remove" onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { name: '', value: '' }])}>＋ Add field</button>
    </div>
  );
}

function Conditions({ value, onChange }) {
  const rows = Array.isArray(value) ? value : [];
  const update = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack tight">
      {rows.map((r, i) => (
        <div className="row gap" key={i}>
          <input placeholder="{{ $json.field }}" value={r.left ?? ''} onChange={(e) => update(i, { left: e.target.value })} />
          <select value={r.op ?? 'equals'} onChange={(e) => update(i, { op: e.target.value })}>
            {OPERATORS.map((o) => <option key={o}>{o}</option>)}
          </select>
          {!NO_RIGHT.has(r.op) && <input placeholder="value" value={r.right ?? ''} onChange={(e) => update(i, { right: e.target.value })} />}
          <button type="button" className="icon" aria-label="Remove" onClick={() => onChange(rows.filter((_, idx) => idx !== i))}>✕</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rows, { left: '', op: 'equals', right: '' }])}>＋ Add condition</button>
    </div>
  );
}

export default function ParamForm({ typeDef, params, onChange, credentials, reloadCredentials }) {
  const values = effectiveParams(typeDef, params);
  const set = (name, v) => onChange({ ...params, [name]: v });
  const props = typeDef.properties.filter((p) => visible(p, values));
  if (!props.length) return <p className="muted">This node has no settings.</p>;
  const everyday = props.filter((p) => !p.advanced);
  const advanced = props.filter((p) => p.advanced);

  const renderProp = (p) => {
        const v = values[p.name];
        // a list filled from the live service (only when its condition holds, e.g. the Ollama model list)
        const live = p.dynamic && (!p.dynamicIf || Object.entries(p.dynamicIf).every(([k, want]) => values[k] === want));
        let input;
        switch (p.type) {
          case 'number':
            input = <input type="number" value={v ?? ''} onChange={(e) => set(p.name, e.target.value === '' ? '' : Number(e.target.value))} />;
            break;
          case 'boolean':
            input = <input type="checkbox" checked={!!v} onChange={(e) => set(p.name, e.target.checked)} />;
            break;
          case 'options':
            input = live
              ? <LiveSelect typeDef={typeDef} prop={p} values={values} value={v} onChange={(nv) => set(p.name, nv)} />
              : <select value={v ?? ''} onChange={(e) => set(p.name, e.target.value)}>{optionList(p.options).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
            break;
          case 'text':
            input = <textarea rows={4} value={v ?? ''} onChange={(e) => set(p.name, e.target.value)} />;
            break;
          case 'json':
            input = <textarea rows={4} className="mono" spellCheck={false} value={typeof v === 'string' ? v : JSON.stringify(v ?? '', null, 2)} onChange={(e) => set(p.name, e.target.value)} />;
            break;
          case 'code':
            input = <textarea rows={10} className="mono" spellCheck={false} value={v ?? ''} onChange={(e) => set(p.name, e.target.value)} />;
            break;
          case 'keyvalue':
            input = <KeyValue value={v} onChange={(nv) => set(p.name, nv)} />;
            break;
          case 'conditions':
            input = <Conditions value={v} onChange={(nv) => set(p.name, nv)} />;
            break;
          case 'schedule':
            input = <SchedulePicker value={v} onChange={(nv) => set(p.name, nv)} />;
            break;
          case 'timezone':
            input = <TimezoneSelect value={v} onChange={(nv) => set(p.name, nv)} />;
            break;
          case 'credential':
            input = <CredentialSelect prop={p} value={v} values={values} onChange={(nv) => set(p.name, nv)} credentials={credentials} reloadCredentials={reloadCredentials} />;
            break;
          case 'fields':
            input = <FieldsEditor typeDef={typeDef} prop={p} values={values} value={v} onChange={(nv) => set(p.name, nv)} />;
            break;
          default:
            input = live
              ? <LiveSelect typeDef={typeDef} prop={p} values={values} value={v} onChange={(nv) => set(p.name, nv)} />
              : <input value={v ?? ''} placeholder={p.placeholder} onChange={(e) => set(p.name, e.target.value)} />;
        }
        // several controls in one field: not wrapped in a <label>
        if (['schedule', 'timezone', 'fields'].includes(p.type) || live) {
          return (
            <div key={p.name} className="field">
              {p.type === 'fields' || live ? <span className="field-label">{p.label}{p.required && <b className="req"> *</b>}</span> : null}
              {input}
              {p.help && <span className="muted small">{p.help}</span>}
            </div>
          );
        }
        return (
          <label key={p.name} className={p.type === 'boolean' ? 'inline' : ''}>
            <span>{p.label}{p.required && <b className="req"> *</b>}</span>
            {input}
            {p.help && <span className="muted small">{p.help}</span>}
          </label>
        );
  };

  return (
    <div className="stack">
      {everyday.map(renderProp)}
      {advanced.length > 0 && (
        <details className="advanced">
          <summary>Advanced</summary>
          <div className="stack">{advanced.map(renderProp)}</div>
        </details>
      )}
    </div>
  );
}
