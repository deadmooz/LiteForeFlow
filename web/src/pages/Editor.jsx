import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge, useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.js';
import ParamForm, { effectiveParams } from '../components/ParamForm.jsx';
import { NodeResult, StatusBadge } from '../components/common.jsx';

const GROUPS = [['trigger', 'Triggers'], ['core', 'Core'], ['logic', 'Logic'], ['data', 'Data'], ['ai', 'AI'], ['app', 'Apps']];
const rid = () => Math.random().toString(36).slice(2, 10);

/* ---------- helpers shared by canvas and panels ---------- */
function parseCases(node) {
  let c = node.parameters?.cases ?? '["a"]';
  try { c = typeof c === 'string' ? JSON.parse(c) : c; } catch { c = []; }
  return Array.isArray(c) ? c : [];
}
const outputCount = (node, def) => (def.dynamicOutputs === 'switch' ? parseCases(node).length + 1 : def.outputs ?? 1);
const outputLabel = (node, def, i) => {
  if (def.outputLabels) return def.outputLabels[i];
  if (def.dynamicOutputs === 'switch') return parseCases(node)[i] ?? 'fallback';
  return null;
};

function FlowNode({ data, selected }) {
  const { node, def, status } = data;
  const inputs = def.inputs ?? 1;
  const outs = outputCount(node, def);
  const h = Math.max(inputs, outs) > 1 ? 28 + Math.max(inputs, outs) * 18 : 56;
  return (
    <div className={`ff-node ${selected ? 'selected' : ''} ${status ?? ''} ${node.disabled ? 'disabled' : ''}`} style={{ minHeight: h }}>
      {Array.from({ length: inputs }, (_, i) => (
        <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left} style={{ top: `${((i + 1) * 100) / (inputs + 1)}%` }} />
      ))}
      <div className="ff-node-icon">{def.icon}</div>
      <div className="ff-node-text">
        <div className="ff-node-name">{node.name}</div>
        <div className="ff-node-type">{def.name}</div>
      </div>
      {Array.from({ length: outs }, (_, i) => (
        <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right} style={{ top: `${((i + 1) * 100) / (outs + 1)}%` }}>
          {outputLabel(node, def, i) !== null && <span className="handle-label">{outputLabel(node, def, i)}</span>}
        </Handle>
      ))}
    </div>
  );
}
const nodeTypes = { ff: FlowNode };

const toRF = (node, def, status) => ({ id: node.id, type: 'ff', position: node.position ?? { x: 0, y: 0 }, data: { node, def, status } });
const toEdge = (c) => ({
  id: `${c.from}-${c.fromOutput ?? 0}-${c.to}-${c.toInput ?? 0}`, source: c.from, target: c.to,
  sourceHandle: `out-${c.fromOutput ?? 0}`, targetHandle: `in-${c.toInput ?? 0}`,
});

export default function Editor() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}

function EditorInner() {
  const { id } = useParams();
  const navigate = useNavigate();
  const rf = useReactFlow();
  const wrapper = useRef(null);

  const [meta, setMeta] = useState(null); // { name, active, settings }
  const [types, setTypes] = useState([]);
  const [credentials, setCredentials] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState('params');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null); // { kind, text }
  const [results, setResults] = useState({}); // nodeId -> result from last run
  const [lastRun, setLastRun] = useState(null);
  const [search, setSearch] = useState('');

  const typeMap = useMemo(() => Object.fromEntries(types.map((t) => [t.type, t])), [types]);

  const reloadCredentials = useCallback(() => api('/credentials').then(setCredentials), []);

  useEffect(() => {
    Promise.all([api('/node-types'), api(`/workflows/${id}`), api('/credentials'), api('/workflows')]).then(([t, wf, c, all]) => {
      setTypes(t);
      setCredentials(c);
      setWorkflows(all.filter((w) => w.id !== id));
      setMeta({ name: wf.name, active: wf.active, settings: wf.settings ?? {} });
      const map = Object.fromEntries(t.map((x) => [x.type, x]));
      setNodes(wf.definition.nodes.filter((n) => map[n.type]).map((n) => toRF(n, map[n.type])));
      setEdges(wf.definition.connections.map(toEdge));
    }).catch((e) => { setMessage({ kind: 'error', text: e.message }); });
  }, [id, setNodes, setEdges]);

  // Reflect run status on the canvas.
  useEffect(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, status: results[n.id]?.status } })));
  }, [results, setNodes]);

  const serialize = useCallback(() => ({
    nodes: nodes.map((n) => ({ ...n.data.node, position: n.position })),
    connections: edges.map((e) => ({
      from: e.source, to: e.target,
      fromOutput: Number(e.sourceHandle?.split('-')[1] ?? 0), toInput: Number(e.targetHandle?.split('-')[1] ?? 0),
    })),
  }), [nodes, edges]);

  const save = useCallback(async () => {
    setBusy('save');
    try {
      const wf = await api(`/workflows/${id}`, { method: 'PUT', body: { name: meta.name, definition: serialize(), settings: meta.settings } });
      setMeta((m) => ({ ...m, active: wf.active }));
      setDirty(false);
      setMessage(wf.warning ? { kind: 'error', text: wf.warning } : { kind: 'ok', text: 'Saved' });
      return true;
    } catch (e) {
      setMessage({ kind: 'error', text: e.message });
      return false;
    } finally { setBusy(''); }
  }, [id, meta, serialize]);

  useEffect(() => {
    const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => { if (message?.kind === 'ok') { const t = setTimeout(() => setMessage(null), 2500); return () => clearTimeout(t); } return undefined; }, [message]);

  const markDirty = () => setDirty(true);

  const uniqueName = (base) => {
    const names = new Set(nodes.map((n) => n.data.node.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i += 1;
    return `${base} ${i}`;
  };

  const addNode = (def, position, connectFrom) => {
    const parameters = {};
    for (const p of def.properties) if (p.default !== undefined) parameters[p.name] = structuredClone(p.default);
    if (def.type === 'trigger.webhook') parameters.path = `hook-${rid()}`;
    const node = { id: rid(), type: def.type, name: uniqueName(def.name), parameters, position };
    setNodes((ns) => [...ns, toRF(node, def)]);
    if (connectFrom && (def.inputs ?? 1) > 0) {
      setEdges((es) => addEdge({
        id: `${connectFrom}-out-0-${node.id}-in-0`, source: connectFrom, target: node.id, sourceHandle: 'out-0', targetHandle: 'in-0',
      }, es));
    }
    setSelectedId(node.id);
    setTab('params');
    markDirty();
  };

  /** Clicking a palette item places the node to the right of the selection (or the last node) without overlapping. */
  const addAtCenter = (def) => {
    const anchor = nodes.find((n) => n.id === selectedId) ?? nodes[nodes.length - 1];
    let pos;
    if (anchor) {
      pos = { x: anchor.position.x + 260, y: anchor.position.y };
      while (nodes.some((n) => Math.abs(n.position.x - pos.x) < 200 && Math.abs(n.position.y - pos.y) < 70)) pos.y += 90;
    } else {
      const box = wrapper.current.getBoundingClientRect();
      const p = rf.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      pos = { x: Math.round(p.x - 90), y: Math.round(p.y - 28) };
    }
    // Auto-connect only when the user has explicitly selected a node to continue from.
    addNode(def, pos, selectedId && anchor?.id === selectedId ? selectedId : undefined);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/ff-node');
    if (!type || !typeMap[type]) return;
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(typeMap[type], { x: Math.round(p.x - 90), y: Math.round(p.y - 28) });
  };

  const onConnect = useCallback((params) => {
    setEdges((eds) => addEdge({ ...params, id: `${params.source}-${params.sourceHandle}-${params.target}-${params.targetHandle}` }, eds));
    setDirty(true);
  }, [setEdges]);

  const selected = nodes.find((n) => n.id === selectedId);
  const updateNode = (patch) => {
    setNodes((ns) => ns.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, node: { ...n.data.node, ...patch } } } : n)));
    markDirty();
  };
  const rename = (name) => {
    const clash = nodes.some((n) => n.id !== selectedId && n.data.node.name === name);
    updateNode({ name });
    if (clash) setMessage({ kind: 'error', text: 'Node names must be unique — expressions refer to nodes by name.' });
  };

  const run = async () => {
    setBusy('run');
    setMessage(null);
    try {
      const r = await api(`/workflows/${id}/run`, { method: 'POST', body: { definition: serialize() } });
      setResults(r.results);
      setLastRun(r);
      setMessage(r.status === 'success' ? { kind: 'ok', text: 'Run finished' } : { kind: 'error', text: `Failed at "${r.error?.nodeName ?? 'workflow'}": ${r.error?.message}` });
    } catch (e) {
      setMessage({ kind: 'error', text: e.message });
    } finally { setBusy(''); }
  };

  const testStep = async () => {
    setBusy('test');
    try {
      const r = await api(`/workflows/${id}/nodes/${selectedId}/test`, { method: 'POST', body: { definition: serialize() } });
      setResults((prev) => ({ ...prev, [selectedId]: r.result ?? { status: 'error', error: r.error?.message } }));
      setTab('output');
    } catch (e) { setMessage({ kind: 'error', text: e.message }); } finally { setBusy(''); }
  };

  const toggleActive = async () => {
    if (!(await save())) return;
    try {
      const wf = await api(`/workflows/${id}/${meta.active ? 'deactivate' : 'activate'}`, { method: 'POST' });
      setMeta((m) => ({ ...m, active: wf.active }));
      setMessage({ kind: 'ok', text: wf.active ? 'Workflow activated' : 'Workflow deactivated' });
    } catch (e) { setMessage({ kind: 'error', text: e.message }); }
  };

  const deleteSelected = () => {
    setNodes((ns) => ns.filter((n) => n.id !== selectedId));
    setEdges((es) => es.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
    markDirty();
  };

  const webhookUrls = meta?.active
    ? nodes.filter((n) => n.data.node.type === 'trigger.webhook').map((n) => ({ name: n.data.node.name, url: `${window.location.origin}/webhook/${effectiveParams(n.data.def, n.data.node.parameters).path}`, method: effectiveParams(n.data.def, n.data.node.parameters).method }))
    : [];

  if (!meta) return <div className="center muted">{message ? <span className="error">{message.text}</span> : 'Loading…'}</div>;

  const filtered = types.filter((t) => `${t.name} ${t.description}`.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="editor">
      <header className="editor-bar">
        <button className="link" onClick={() => navigate('/')}>← Workflows</button>
        <input
          className="title-input" value={meta.name} aria-label="Workflow name"
          onChange={(e) => { setMeta({ ...meta, name: e.target.value }); markDirty(); }}
        />
        {dirty && <span className="muted small">Unsaved changes</span>}
        <div className="spacer" />
        {message && <span className={message.kind === 'error' ? 'error inline-msg' : 'ok inline-msg'} role="status">{message.text}</span>}
        <button onClick={save} disabled={!!busy || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button className="primary" onClick={run} disabled={!!busy}>{busy === 'run' ? 'Running…' : '▶ Run'}</button>
        <label className="switch" title="Active workflows respond to webhooks and schedules">
          <input type="checkbox" checked={meta.active} onChange={toggleActive} disabled={!!busy} />
          <span>{meta.active ? 'Active' : 'Inactive'}</span>
        </label>
      </header>

      {webhookUrls.length > 0 && (
        <div className="webhook-bar">
          {webhookUrls.map((w) => (
            <span key={w.name}><b>{w.name}</b> <code>{w.method} {w.url}</code></span>
          ))}
        </div>
      )}

      <div className="editor-body">
        <aside className="palette">
          <input placeholder="Search nodes…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search nodes" />
          {GROUPS.map(([g, label]) => {
            const items = filtered.filter((t) => t.group === g);
            if (!items.length) return null;
            return (
              <div key={g}>
                <h4>{label}</h4>
                {items.map((t) => (
                  <button
                    key={t.type} className="palette-item" draggable title={t.description}
                    onDragStart={(e) => e.dataTransfer.setData('application/ff-node', t.type)}
                    onClick={() => addAtCenter(t)}
                  >
                    <span>{t.icon}</span> {t.name}
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        <div className="canvas" ref={wrapper} onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === 'position' && x.dragging === false)) markDirty(); if (c.some((x) => x.type === 'remove')) markDirty(); }}
            onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === 'remove')) markDirty(); }}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedId(n.id); }}
            onPaneClick={() => setSelectedId(null)}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(120, 130, 160, 0.18)" nodeColor="#7b7bff" nodeStrokeWidth={0} />
          </ReactFlow>
          {nodes.length === 0 && <div className="canvas-empty">Add a trigger from the left to get started →</div>}
          {lastRun && (
            <div className="run-summary">
              <StatusBadge status={lastRun.status} /> Last run: {Object.values(lastRun.results).filter((r) => r.status === 'success').length} nodes succeeded
              {lastRun.error && <> · <button className="link" onClick={() => { setSelectedId(lastRun.error.nodeId); setTab('output'); }}>show error</button></>}
            </div>
          )}
        </div>

        <aside className="panel">
          {selected ? (
            <>
              <div className="panel-head">
                <span className="panel-icon">{selected.data.def.icon}</span>
                <input value={selected.data.node.name} onChange={(e) => rename(e.target.value)} aria-label="Node name" />
                <button className="icon" title="Delete node" onClick={deleteSelected} aria-label="Delete node">🗑</button>
              </div>
              <p className="muted small">{selected.data.def.description}</p>
              <div className="tabs" role="tablist">
                {[['params', 'Parameters'], ['output', 'Data'], ['settings', 'Settings']].map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
                ))}
              </div>
              {tab === 'params' && (
                <>
                  <ParamForm
                    typeDef={selected.data.def} params={selected.data.node.parameters}
                    onChange={(parameters) => updateNode({ parameters })}
                    credentials={credentials} reloadCredentials={reloadCredentials}
                  />
                  {!selected.data.def.isTrigger && (
                    <button className="test-btn" onClick={testStep} disabled={!!busy}>{busy === 'test' ? 'Testing…' : '▶ Test this step'}</button>
                  )}
                  <p className="muted small">Use <code>{'{{ $json.field }}'}</code> for the current item or <code>{'{{ $node["Name"].json.field }}'}</code> for another node. Test step re-uses the input from your last run.</p>
                </>
              )}
              {tab === 'output' && <NodeResult result={results[selectedId]} />}
              {tab === 'settings' && (
                <div className="stack">
                  <label className="inline"><input type="checkbox" checked={!!selected.data.node.disabled} onChange={(e) => updateNode({ disabled: e.target.checked })} /> Disabled (pass data through)</label>
                  <label className="inline"><input type="checkbox" checked={!!selected.data.node.continueOnFail} onChange={(e) => updateNode({ continueOnFail: e.target.checked })} /> Continue on failure</label>
                  <label className="inline"><input type="checkbox" checked={!!selected.data.node.retryOnFail} onChange={(e) => updateNode({ retryOnFail: e.target.checked })} /> Retry on failure</label>
                  {selected.data.node.retryOnFail && (
                    <div className="row gap">
                      <label>Max tries<input type="number" min={1} max={5} value={selected.data.node.maxTries ?? 3} onChange={(e) => updateNode({ maxTries: Number(e.target.value) })} /></label>
                      <label>Wait (ms)<input type="number" min={0} step={100} value={selected.data.node.waitBetweenTries ?? 1000} onChange={(e) => updateNode({ waitBetweenTries: Number(e.target.value) })} /></label>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="stack">
              <h3>Workflow settings</h3>
              <label>Error workflow
                <select
                  value={meta.settings.errorWorkflowId ?? ''}
                  onChange={(e) => { setMeta({ ...meta, settings: { ...meta.settings, errorWorkflowId: e.target.value || undefined } }); markDirty(); }}
                >
                  <option value="">None</option>
                  {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                <span className="muted small">Runs when this workflow fails. It needs an Error Trigger node.</span>
              </label>
              <label>Timeout (seconds)
                <input
                  type="number" min={1} value={meta.settings.timeoutSec ?? 300}
                  onChange={(e) => { setMeta({ ...meta, settings: { ...meta.settings, timeoutSec: Number(e.target.value) } }); markDirty(); }}
                />
              </label>
              <label className="inline">
                <input
                  type="checkbox" checked={meta.settings.saveSuccessData ?? true}
                  onChange={(e) => { setMeta({ ...meta, settings: { ...meta.settings, saveSuccessData: e.target.checked } }); markDirty(); }}
                />
                Keep node data of successful runs
              </label>
              <span className="muted small">Turn off for high-volume workflows to save storage. Failed runs and editor runs always keep full data.</span>
              <p className="muted small">Workflow ID: <code>{id}</code></p>
              {lastRun && (
                <>
                  <h4>Last run</h4>
                  <ul className="run-list">
                    {nodes.map((n) => results[n.id] && (
                      <li key={n.id}>
                        <button className="link" onClick={() => { setSelectedId(n.id); setTab('output'); }}>{n.data.node.name}</button>
                        <StatusBadge status={results[n.id].status} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="muted small">Click a node to configure it. Drag from a node's right handle to another node's left handle to connect them. Press Delete to remove a selected node or connection.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
