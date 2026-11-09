import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position,
  useNodesState, useEdgesState, addEdge, useReactFlow, getSmoothStepPath,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from '../api.js';
import ParamForm, { effectiveParams } from '../components/ParamForm.jsx';
import { NodeResult, StatusBadge } from '../components/common.jsx';
import AlertSettings from '../components/AlertSettings.jsx';
import InsertPicker from '../components/InsertPicker.jsx';
import { createHistory, copyPayload, parseClip, clonePaste, findInsertTarget, planInsert, rewire, edgeMidpoint, nearestConnectTarget, handlePoint } from '../flow.js';

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

const FlowNode = React.memo(function FlowNode({ data, selected }) {
  const { node, def, status } = data;
  const inputs = def.inputs ?? 1;
  const outs = outputCount(node, def);
  const h = Math.max(inputs, outs) > 1 ? 28 + Math.max(inputs, outs) * 18 : 56;
  return (
    <div className={`ff-node ${selected ? 'selected' : ''} ${status ?? ''} ${node.disabled ? 'disabled' : ''}`} style={{ minHeight: h }}>
      {Array.from({ length: inputs }, (_, i) => (
        <Handle key={`in-${i}`} id={`in-${i}`} type="target" position={Position.Left} className={data.near === `in-${i}` ? 'near' : undefined} style={{ top: `${((i + 1) * 100) / (inputs + 1)}%` }} />
      ))}
      <div className="ff-node-icon">{def.icon}</div>
      <div className="ff-node-text">
        <div className="ff-node-name">{node.name}</div>
        <div className="ff-node-type">{def.name}</div>
      </div>
      {Array.from({ length: outs }, (_, i) => (
        <Handle key={`out-${i}`} id={`out-${i}`} type="source" position={Position.Right} className={data.near === `out-${i}` ? 'near' : undefined} style={{ top: `${((i + 1) * 100) / (outs + 1)}%` }}>
          {outputLabel(node, def, i) !== null && <span className="handle-label">{outputLabel(node, def, i)}</span>}
        </Handle>
      ))}
    </div>
  );
});
const nodeTypes = { ff: FlowNode };

/*
 * The line shown while one is dragged out of a handle: dotted, with a stepped route and a blue dot at each end.
 * When a step is close enough to take it, the line snaps to that step's handle instead of following the pointer,
 * and an x in the middle says "Esc cancels". `suggestion` is written by the editor and read here on every draw.
 */
const suggestion = { current: null };
function ConnectionLine({ fromX, fromY, toX, toY, fromPosition, toPosition }) {
  const t = suggestion.current;
  const ex = t ? t.point.x : toX; const ey = t ? t.point.y : toY;
  const [path, mx, my] = getSmoothStepPath({
    sourceX: fromX, sourceY: fromY, sourcePosition: fromPosition, targetX: ex, targetY: ey,
    targetPosition: t ? (t.side === 'in' ? Position.Left : Position.Right) : toPosition, borderRadius: 8,
  });
  return (
    <g className="connect-preview">
      <path d={path} fill="none" className="connect-line" />
      <circle cx={fromX} cy={fromY} r={6} className="connect-dot" />
      <circle cx={ex} cy={ey} r={6} className={t ? 'connect-dot' : 'connect-dot loose'} />
      {t && (
        <g transform={`translate(${mx},${my})`} className="connect-x">
          <circle r={9} />
          <text textAnchor="middle" dominantBaseline="central">×</text>
        </g>
      )}
    </g>
  );
}

// initialWidth/Height let the lines of a brand-new step draw at once instead of waiting for the first measurement.
const toRF = (node, def, status) => ({ id: node.id, type: 'ff', position: node.position ?? { x: 0, y: 0 }, initialWidth: 190, initialHeight: 56, data: { node, def, status } });
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
  const [drawer, setDrawer] = useState(null); // 'palette' | 'panel' | null — only used on narrow screens
  const [loaded, setLoaded] = useState(false);
  const [candidate, setCandidate] = useState(null); // id of the line a step would be inserted into while it is dragged
  const [plus, setPlus] = useState(null); // { edgeId, x, y }: the + button on a hovered line
  const [picker, setPicker] = useState(null); // { edgeId, x, y }: the "add a step here" menu
  const [, bump] = useState(0); // re-render when the undo history changes
  const history = useRef(createHistory()).current;
  const nodesRef = useRef([]); const edgesRef = useRef([]);
  const dragRef = useRef(null); const paletteType = useRef(null); const candidateRef = useRef(null);
  const clipRef = useRef(null); const pasteCount = useRef(0); const plusTimer = useRef(0); const overPlus = useRef(false);
  const connectRef = useRef(null); const nearRef = useRef(null);
  const [near, setNear] = useState(null); // { id, handle, side }: the step a dragged line would join if released now

  const typeMap = useMemo(() => Object.fromEntries(types.map((t) => [t.type, t])), [types]);
  nodesRef.current = nodes; edgesRef.current = edges;

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
      setLoaded(true);
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

  useEffect(() => { if (message?.kind === 'ok') { const t = setTimeout(() => setMessage(null), message.undo ? 6000 : 2500); return () => clearTimeout(t); } return undefined; }, [message]);

  const markDirty = () => setDirty(true);

  /* ---- undo and redo: snapshots of the serialised workflow, taken once things have been still for a moment ---- */
  const serializeRef = useRef(serialize); serializeRef.current = serialize;
  useEffect(() => {
    if (!loaded) return undefined;
    const snap = JSON.stringify(serialize());
    if (!history.ready) { history.reset(snap); bump((n) => n + 1); return undefined; }
    const t = setTimeout(() => { if (history.commit(snap)) bump((n) => n + 1); }, 350);
    return () => clearTimeout(t);
  }, [loaded, nodes, edges, serialize, history]);

  const restore = (snap) => {
    const def = JSON.parse(snap);
    // A step that still exists keeps its object (and with it its measured size), so its lines do not disappear while the canvas measures it again.
    const current = new Map(nodesRef.current.map((n) => [n.id, n]));
    setNodes(def.nodes.filter((n) => typeMap[n.type]).map((n) => {
      const old = current.get(n.id);
      const status = results[n.id]?.status;
      return old ? { ...old, position: n.position, selected: false, data: { ...old.data, node: n, def: typeMap[n.type], status } } : toRF(n, typeMap[n.type], status);
    }));
    setEdges(def.connections.map(toEdge));
    setSelectedId((cur) => (def.nodes.some((n) => n.id === cur) ? cur : null));
    setDirty(true); bump((n) => n + 1);
  };
  const undo = () => { history.commit(JSON.stringify(serializeRef.current())); const snap = history.undo(); if (snap) restore(snap); };
  const redo = () => { const snap = history.redo(); if (snap) restore(snap); };

  const uniqueName = (base) => {
    const names = new Set(nodes.map((n) => n.data.node.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i += 1;
    return `${base} ${i}`;
  };

  const makeNode = (def, position) => {
    const parameters = {};
    for (const p of def.properties) if (p.default !== undefined) parameters[p.name] = structuredClone(p.default);
    if (def.type === 'trigger.webhook') parameters.path = `hook-${rid()}`;
    return { id: rid(), type: def.type, name: uniqueName(def.name), parameters, position };
  };

  const addNode = (def, position, connectFrom) => {
    const node = makeNode(def, position);
    setNodes((ns) => [...ns, toRF(node, def)]);
    if (connectFrom && (def.inputs ?? 1) > 0) {
      setEdges((es) => addEdge({
        id: `${connectFrom}-out-0-${node.id}-in-0`, source: connectFrom, target: node.id, sourceHandle: 'out-0', targetHandle: 'in-0',
      }, es));
    }
    setSelectedId(node.id);
    setTab('params');
    setDrawer('panel');
    markDirty();
  };

  /* ---- insert a step onto a line: the line is split in two, the steps after it move over to make room ---- */
  const boxesOf = (list) => Object.fromEntries(list.map((n) => [n.id, {
    x: n.position.x, y: n.position.y, w: n.measured?.width ?? 190, h: n.measured?.height ?? 56,
    ins: n.data.def.inputs ?? 1, outs: outputCount(n.data.node, n.data.def),
  }]));
  const canInsert = (def) => !!def && (def.inputs ?? 1) > 0 && (def.outputs ?? 1) > 0 && !def.isTrigger;
  const setTarget = (id) => { if (candidateRef.current === id) return; candidateRef.current = id; setCandidate(id); };
  const findTarget = (point, skip) => findInsertTarget({ point, edges: edgesRef.current, boxes: boxesOf(nodesRef.current), skip, zoom: rf.getZoom(), current: candidateRef.current });

  const insertOnEdge = (edgeId, existingId, def) => {
    const es = edgesRef.current; const ns = nodesRef.current;
    const edge = es.find((e) => e.id === edgeId);
    if (!edge) return;
    const created = def ? makeNode(def, { x: 0, y: 0 }) : null;
    const id = created?.id ?? existingId;
    const here = ns.find((n) => n.id === id);
    // A step that was just created has not been measured yet; its width follows its name (the card is 170 to 230 wide).
    const size = here?.measured ? { w: here.measured.width, h: here.measured.height } : { w: Math.max(170, Math.min(230, 100 + (created?.name.length ?? 8) * 7)), h: 56 };
    const plan = planInsert({ edge, boxes: boxesOf(ns), size, edges: es });
    if (!plan) return;
    const moved = new Set(plan.shifted);
    setNodes((cur) => [...(created ? [...cur, toRF(created, def)] : cur)].map((n) => {
      if (n.id === id) return { ...n, position: plan.position, className: 'ff-settle' };
      if (moved.has(n.id)) return { ...n, position: { x: n.position.x + plan.dx, y: n.position.y }, className: 'ff-settle' };
      return n;
    }));
    setEdges((cur) => rewire(cur, edge, id));
    setTimeout(() => setNodes((cur) => cur.map((n) => (n.className === 'ff-settle' ? { ...n, className: undefined } : n))), 350);
    const nameOf = (nid) => ns.find((n) => n.id === nid)?.data.node.name ?? 'step';
    if (created) { setSelectedId(id); setTab('params'); setDrawer('panel'); }
    setMessage({ kind: 'ok', text: `Inserted between ${nameOf(edge.source)} and ${nameOf(edge.target)}`, undo: true });
    markDirty();
  };
  const cancelInsert = () => {
    if (dragRef.current) dragRef.current.cancelled = true;
    if (connectRef.current) connectRef.current.cancelled = true;
    setTarget(null); setNearTarget(null);
  };

  /* ---- copy, cut, paste, duplicate, select all ---- */
  const chosenSteps = () => {
    const picked = nodesRef.current.filter((n) => n.selected);
    return picked.length ? picked : nodesRef.current.filter((n) => n.id === selectedId);
  };
  const toPayload = () => {
    const picked = chosenSteps();
    if (!picked.length) return null;
    return copyPayload(picked.map((n) => ({ ...n.data.node, position: n.position })), serializeRef.current().connections);
  };
  const copySteps = () => {
    const payload = toPayload();
    if (!payload) return null;
    clipRef.current = payload; pasteCount.current = 0;
    try { navigator.clipboard?.writeText(JSON.stringify(payload)).catch(() => {}); } catch { /* the in-page copy still works */ }
    return payload;
  };
  const pasteSteps = (payload, step = 40) => {
    const usable = { ...payload, nodes: payload.nodes.filter((n) => typeMap[n.type]) };
    if (!usable.nodes.length) return;
    pasteCount.current += 1;
    const off = step * pasteCount.current;
    const made = clonePaste(usable, nodesRef.current.map((n) => n.data.node.name), { dx: off, dy: off, newId: rid });
    setNodes((cur) => [...cur.map((n) => ({ ...n, selected: false })), ...made.nodes.map((n) => ({ ...toRF(n, typeMap[n.type]), selected: true }))]);
    setEdges((cur) => [...cur, ...made.connections.map(toEdge)]);
    setSelectedId(made.nodes.length === 1 ? made.nodes[0].id : null);
    setMessage({ kind: 'ok', text: made.nodes.length === 1 ? 'Pasted 1 step' : `Pasted ${made.nodes.length} steps`, undo: true });
    markDirty();
  };
  const duplicateSteps = () => { const payload = toPayload(); if (payload) { pasteCount.current = 0; pasteSteps(payload); } };
  const cutSteps = () => {
    const payload = copySteps();
    if (!payload) return;
    const ids = new Set(payload.nodes.map((n) => n.id));
    setNodes((cur) => cur.filter((n) => !ids.has(n.id)));
    setEdges((cur) => cur.filter((e) => !ids.has(e.source) && !ids.has(e.target)));
    setSelectedId(null); markDirty();
  };
  const selectAll = () => setNodes((cur) => cur.map((n) => ({ ...n, selected: true })));

  const keys = useRef({});
  keys.current = { undo, redo, copySteps, cutSteps, pasteSteps, duplicateSteps, selectAll, cancelInsert };
  useEffect(() => {
    const editing = (t) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onKey = (e) => {
      const k = keys.current; const key = e.key.toLowerCase(); const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { k.cancelInsert(); setPicker(null); setPlus(null); return; }
      if (editing(e.target)) return; // inside a text box, these keys belong to the text
      if (mod && key === 'z' && !e.shiftKey) { e.preventDefault(); k.undo(); }
      else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); k.redo(); }
      else if (mod && key === 'c' && !String(window.getSelection?.() ?? '')) { if (k.copySteps()) e.preventDefault(); }
      else if (mod && key === 'x') { e.preventDefault(); k.cutSteps(); }
      else if (mod && key === 'd') { e.preventDefault(); k.duplicateSteps(); }
      else if (mod && key === 'a') { e.preventDefault(); k.selectAll(); }
      else if (e.key === 'Enter') {
        const edge = edgesRef.current.find((x) => x.selected);
        if (edge) { e.preventDefault(); openPickerAt(edge.id); }
      }
    };
    const onPaste = (e) => {
      if (editing(e.target)) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      const payload = parseClip(text) ?? (!text.trim() ? clipRef.current : null);
      if (payload) { e.preventDefault(); keys.current.pasteSteps(payload); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('paste', onPaste); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---- the + on a hovered line, and the menu it opens ---- */
  const lineAnchor = (edgeId) => {
    const edge = edgesRef.current.find((e) => e.id === edgeId);
    const mid = edge && edgeMidpoint(edge, boxesOf(nodesRef.current));
    if (!mid || !wrapper.current) return null;
    const sp = rf.flowToScreenPosition(mid); const r = wrapper.current.getBoundingClientRect();
    return { x: Math.round(sp.x - r.left), y: Math.round(sp.y - r.top) };
  };
  const showPlus = (edgeId) => {
    clearTimeout(plusTimer.current);
    if (dragRef.current || picker) return;
    const at = lineAnchor(edgeId);
    if (at) setPlus({ edgeId, ...at });
  };
  // The + stays while the pointer is on it or pressing it, even if the hide timer from leaving the line fires meanwhile.
  const hidePlusSoon = () => { clearTimeout(plusTimer.current); plusTimer.current = setTimeout(() => { if (!overPlus.current) setPlus(null); }, 220); };
  const openPickerAt = (edgeId) => {
    const at = lineAnchor(edgeId);
    if (!at) return;
    const w = wrapper.current?.clientWidth ?? 600;
    overPlus.current = false; setPlus(null); setPicker({ edgeId, x: Math.max(150, Math.min(w - 150, at.x)), y: at.y });
  };

  /* ---- dragging a step that has no lines yet over a line (the step is already on screen, so only the line needs to react) ---- */
  const nodeOf = (id) => nodesRef.current.find((n) => n.id === id);
  const onNodeDragStart = (_, node) => {
    const touched = edgesRef.current.some((e) => e.source === node.id || e.target === node.id);
    dragRef.current = { id: node.id, free: !touched, eligible: canInsert(nodeOf(node.id)?.data.def), cancelled: false };
    setPlus(null);
  };
  const onNodeDrag = (e, node) => {
    const d = dragRef.current;
    if (!d || d.id !== node.id) return;
    if (!d.free || !d.eligible || d.cancelled || e.altKey) { setTarget(null); return; } // Alt turns snapping off for this drag
    const w = node.measured?.width ?? 190; const h = node.measured?.height ?? 56;
    setTarget(findTarget({ x: node.position.x + w / 2, y: node.position.y + h / 2 }, new Set([node.id])));
  };
  const onNodeDragStop = (e, node) => {
    const d = dragRef.current; dragRef.current = null;
    const target = candidateRef.current; setTarget(null);
    if (d && target && d.free && d.eligible && !d.cancelled && !e.altKey) insertOnEdge(target, node.id);
  };

  /* ---- dragging a line out of a handle: the nearest step that can take it lights up, and releasing there connects ---- */
  const setNearTarget = (t) => {
    const k = t ? `${t.id}:${t.handle}` : null;
    if ((nearRef.current?.k ?? null) === k) return;
    const n = t && nodesRef.current.find((x) => x.id === t.id);
    const box = n && boxesOf([n])[t.id];
    nearRef.current = t ? { ...t, k, point: box ? handlePoint(box, t.side, t.index) : null } : null;
    suggestion.current = nearRef.current?.point ? nearRef.current : null;
    setNear(nearRef.current);
  };
  const canTake = (id, side) => {
    const n = nodesRef.current.find((x) => x.id === id);
    return !!n && (side === 'in' ? (n.data.def.inputs ?? 1) > 0 : outputCount(n.data.node, n.data.def) > 0);
  };
  const connectMove = (e) => {
    const c = connectRef.current;
    if (!c || c.cancelled || c.frame) return;
    const pt = e.touches?.[0] ?? e;
    c.frame = requestAnimationFrame(() => {
      c.frame = 0;
      if (connectRef.current !== c || c.cancelled) return;
      setNearTarget(nearestConnectTarget({
        point: rf.screenToFlowPosition({ x: pt.clientX, y: pt.clientY }), boxes: boxesOf(nodesRef.current), edges: edgesRef.current,
        from: c, eligible: canTake, zoom: rf.getZoom(), current: nearRef.current?.id ?? null,
      }));
    });
  };
  const onConnectStart = (_, { nodeId, handleId, handleType }) => {
    connectRef.current = { nodeId, type: handleType, index: Number(String(handleId ?? '').split('-')[1] ?? 0) || 0, cancelled: false, frame: 0 };
    window.addEventListener('mousemove', connectMove); window.addEventListener('touchmove', connectMove, { passive: true });
    setPlus(null);
  };
  const onConnectEnd = (_, state) => {
    const c = connectRef.current; connectRef.current = null;
    window.removeEventListener('mousemove', connectMove); window.removeEventListener('touchmove', connectMove);
    if (c?.frame) cancelAnimationFrame(c.frame);
    const t = nearRef.current; setNearTarget(null);
    if (!c || c.cancelled || !t || state?.isValid) return; // a line that landed on a handle was already connected by the canvas
    const out = c.type === 'source' ? { id: c.nodeId, handle: `out-${c.index}` } : { id: t.id, handle: t.handle };
    const into = c.type === 'source' ? { id: t.id, handle: t.handle } : { id: c.nodeId, handle: `in-${c.index}` };
    setEdges((es) => addEdge({ id: `${out.id}-${out.handle}-${into.id}-${into.handle}`, source: out.id, sourceHandle: out.handle, target: into.id, targetHandle: into.handle }, es));
    const nameOf = (id) => nodesRef.current.find((n) => n.id === id)?.data.node.name ?? 'step';
    setMessage({ kind: 'ok', text: `Connected ${nameOf(out.id)} to ${nameOf(into.id)}`, undo: true });
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
    // Continue from the selected node. With nothing selected, continue from the last node if it is still a dead end (so the first block
    // clicked after the trigger joins it instead of landing next to it unconnected); otherwise place it on its own.
    const open = anchor && !edges.some((e) => e.source === anchor.id) && (anchor.data.def?.outputs ?? 1) > 0;
    addNode(def, pos, selectedId && anchor?.id === selectedId ? selectedId : open ? anchor.id : undefined);
  };

  const onDrop = (e) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/ff-node');
    const target = candidateRef.current; setTarget(null); paletteType.current = null;
    if (!type || !typeMap[type]) return;
    if (target && !e.altKey && canInsert(typeMap[type])) { insertOnEdge(target, null, typeMap[type]); return; }
    const p = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addNode(typeMap[type], { x: Math.round(p.x - 90), y: Math.round(p.y - 28) });
  };
  const onDragOver = (e) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    const def = typeMap[paletteType.current];
    if (!canInsert(def) || e.altKey) { setTarget(null); return; }
    setTarget(findTarget(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), new Set()));
  };

  const onConnect = useCallback((params) => {
    if (connectRef.current?.cancelled) return; // Esc was pressed while dragging the line
    setEdges((eds) => addEdge({ ...params, id: `${params.source}-${params.sourceHandle}-${params.target}-${params.targetHandle}` }, eds));
    const nm = (id) => nodesRef.current.find((n) => n.id === id)?.data.node.name ?? 'step';
    setMessage({ kind: 'ok', text: `Connected ${nm(params.source)} to ${nm(params.target)}`, undo: true });
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

  const displayNodes = useMemo(() => (near ? nodes.map((n) => (n.id === near.id ? { ...n, className: `${n.className ?? ''} connect-near`.trim(), data: { ...n.data, near: near.handle } } : n)) : nodes), [nodes, near]);
  const displayEdges = useMemo(() => (candidate ? edges.map((e) => (e.id === candidate ? { ...e, className: 'insert-target' } : e)) : edges), [edges, candidate]);
  const hint = candidate ? (() => {
    const edge = edges.find((e) => e.id === candidate); const at = edge && lineAnchor(candidate);
    const nm = (id) => nodes.find((n) => n.id === id)?.data.node.name ?? 'step';
    return edge && at ? { ...at, text: `Drop to insert between ${nm(edge.source)} and ${nm(edge.target)}` } : null;
  })() : null;
  const nearHint = near ? (() => {
    const n = nodes.find((x) => x.id === near.id);
    if (!n || !wrapper.current) return null;
    const sp = rf.flowToScreenPosition({ x: n.position.x + (n.measured?.width ?? 190) / 2, y: n.position.y });
    const r = wrapper.current.getBoundingClientRect();
    return { x: Math.round(sp.x - r.left), y: Math.round(sp.y - r.top), text: `Release to connect to ${n.data.node.name}` };
  })() : null;
  const picked = nodes.filter((n) => n.selected).length;
  const insertable = types.filter(canInsert);

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
        <button className="icon" onClick={undo} disabled={!history.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button className="icon" onClick={redo} disabled={!history.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
        {dirty && <span className="muted small">Unsaved changes</span>}
        <button className="mobile-only" onClick={() => setDrawer((d) => (d === 'palette' ? null : 'palette'))}>＋ Nodes</button>
        <button className="mobile-only" onClick={() => setDrawer((d) => (d === 'panel' ? null : 'panel'))}>Settings</button>
        <div className="spacer" />
        {message && <span className={message.kind === 'error' ? 'error inline-msg' : 'ok inline-msg'} role="status">{message.text}{message.undo && <> · <button className="link" onClick={() => { undo(); setMessage(null); }}>Undo</button></>}</span>}
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
        <aside className={`palette ${drawer === 'palette' ? 'open' : ''}`}>
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
                    onDragStart={(e) => { paletteType.current = t.type; e.dataTransfer.setData('application/ff-node', t.type); }}
                    onDragEnd={() => { paletteType.current = null; setTarget(null); }}
                    onClick={() => addAtCenter(t)}
                  >
                    <span>{t.icon}</span> {t.name}
                  </button>
                ))}
              </div>
            );
          })}
        </aside>

        <div className="canvas" ref={wrapper} onDrop={onDrop} onDragOver={onDragOver} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setTarget(null); }}>
          <ReactFlow
            nodes={displayNodes} edges={displayEdges} nodeTypes={nodeTypes}
            onConnectStart={onConnectStart} onConnectEnd={onConnectEnd} connectionRadius={60}
            connectionLineComponent={ConnectionLine}
            onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop}
            onEdgeMouseEnter={(_, edge) => showPlus(edge.id)} onEdgeMouseLeave={hidePlusSoon} onMoveStart={() => setPlus(null)}
            onNodesChange={(c) => { onNodesChange(c); if (c.some((x) => x.type === 'position' && x.dragging === false)) markDirty(); if (c.some((x) => x.type === 'remove')) markDirty(); }}
            onEdgesChange={(c) => { onEdgesChange(c); if (c.some((x) => x.type === 'remove')) markDirty(); }}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedId(n.id); setDrawer('panel'); }}
            onPaneClick={() => { setSelectedId(null); setDrawer(null); setPicker(null); }}
            deleteKeyCode={['Backspace', 'Delete']}
            fitView proOptions={{ hideAttribution: true }}
          >
            <Background id="grid-minor" variant={BackgroundVariant.Lines} gap={24} lineWidth={1} color="var(--grid-minor)" />
            <Background id="grid-major" variant={BackgroundVariant.Lines} gap={120} lineWidth={1} color="var(--grid-major)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable maskColor="rgba(120, 130, 160, 0.18)" nodeColor="#7b7bff" nodeStrokeWidth={0} />
          </ReactFlow>
          {nearHint && <div className="insert-chip" style={{ left: nearHint.x, top: nearHint.y }} role="status">{nearHint.text} <kbd>Esc</kbd> to cancel</div>}
          {hint && <div className="insert-chip" style={{ left: hint.x, top: hint.y }} role="status">{hint.text} <kbd>Esc</kbd> to cancel</div>}
          {plus && !picker && (
            <button className="insert-plus" style={{ left: plus.x, top: plus.y }} aria-label="Add a step here" title="Add a step here"
              onMouseEnter={() => { overPlus.current = true; clearTimeout(plusTimer.current); }} onMouseDown={() => { overPlus.current = true; clearTimeout(plusTimer.current); }}
              onMouseLeave={() => { overPlus.current = false; hidePlusSoon(); }} onClick={() => openPickerAt(plus.edgeId)}>+</button>
          )}
          {picker && (
            <InsertPicker types={insertable} x={picker.x} y={picker.y} onClose={() => setPicker(null)}
              onPick={(def) => { const id = picker.edgeId; setPicker(null); insertOnEdge(id, null, def); }} />
          )}
          {picked > 1 && <div className="select-hint" role="status">{picked} steps selected · <kbd>Ctrl</kbd>+<kbd>C</kbd> copy · <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicate · <kbd>Delete</kbd> remove</div>}
          {nodes.length === 0 && <div className="canvas-empty">Add a trigger from the left to get started →</div>}
          {lastRun && (
            <div className="run-summary">
              <StatusBadge status={lastRun.status} /> Last run: {Object.values(lastRun.results).filter((r) => r.status === 'success').length} nodes succeeded
              {lastRun.error && <> · <button className="link" onClick={() => { setSelectedId(lastRun.error.nodeId); setTab('output'); }}>show error</button></>}
            </div>
          )}
        </div>

        <aside className={`panel ${drawer === 'panel' ? 'open' : ''}`}>
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
              <AlertSettings
                workflowId={id} alerts={meta.settings.alerts} credentials={credentials} reloadCredentials={reloadCredentials}
                onChange={(alerts) => { setMeta({ ...meta, settings: { ...meta.settings, alerts } }); markDirty(); }}
              />
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
              <p className="muted small">Click a node to configure it. Drag from a node's right handle to another node's left handle to connect them. Press Delete to remove a selected node or connection. Hold Shift and drag to select several steps; Ctrl+C, Ctrl+V and Ctrl+D copy, paste and duplicate them, and Ctrl+Z undoes. Drop a step on a line to insert it there, or hover a line and click +.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
