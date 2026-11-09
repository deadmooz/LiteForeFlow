/*
 * Pure helpers for the workflow canvas (no React): where a step would snap onto a line, how much room it needs,
 * how copy and paste remap ids, and the undo history. Kept apart from the editor so they can be tested without a browser.
 * A "box" is { x, y, w, h, ins, outs } in canvas coordinates; handles sit at the middle of the left and right edges,
 * evenly spaced when a step has several.
 */
export const GAP = 60; // empty space kept on both sides of an inserted step

const controlOffset = (d, curvature = 0.25) => (d >= 0 ? 0.5 * d : curvature * 25 * Math.sqrt(-d)); // the same rule React Flow uses

/** Points along the curve React Flow draws from a right-hand output `s` to a left-hand input `t`. */
export function curvePoints(s, t, steps = 24) {
  const o = controlOffset(t.x - s.x);
  const c1 = { x: s.x + o, y: s.y }; const c2 = { x: t.x - o, y: t.y };
  const pts = [];
  for (let i = 0; i <= steps; i += 1) {
    const u = i / steps; const v = 1 - u;
    pts.push({
      x: v * v * v * s.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * t.x,
      y: v * v * v * s.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * t.y,
    });
  }
  return pts;
}

const handleIndex = (id) => Number(String(id ?? '').split('-')[1] ?? 0) || 0;
export const handlePoint = (box, side, index) => {
  const count = Math.max(1, side === 'out' ? box.outs : box.ins);
  return { x: side === 'out' ? box.x + box.w : box.x, y: box.y + (box.h * (index + 1)) / (count + 1) };
};

/** Where an edge starts and ends, or null when one of its steps is unknown. */
export function edgeEnds(edge, boxes) {
  const a = boxes[edge.source]; const b = boxes[edge.target];
  if (!a || !b) return null;
  return { s: handlePoint(a, 'out', handleIndex(edge.sourceHandle)), t: handlePoint(b, 'in', handleIndex(edge.targetHandle)) };
}

const distToSegment = (p, a, b) => {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
};
export function distanceToCurve(p, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i += 1) best = Math.min(best, distToSegment(p, pts[i - 1], pts[i]));
  return best;
}

/** The point halfway along an edge (where the + button and the hint sit). */
export function edgeMidpoint(edge, boxes) {
  const ends = edgeEnds(edge, boxes);
  if (!ends) return null;
  const pts = curvePoints(ends.s, ends.t, 24);
  return pts[12];
}

/**
 * Which line, if any, a dragged step would be inserted into. Only the nearest line within `near` screen pixels counts;
 * once a line is chosen it stays chosen until the step is `keep` pixels away, so the preview never flickers between two lines.
 * Lines that touch a step in `skip` (the dragged step itself) are ignored.
 */
export function findInsertTarget({ point, edges, boxes, skip = new Set(), zoom = 1, current = null, near = 40, keep = 60 }) {
  const reach = keep / zoom;
  let best = null;
  let stay = null;
  for (const e of edges) {
    if (skip.has(e.source) || skip.has(e.target)) continue;
    const ends = edgeEnds(e, boxes);
    if (!ends) continue;
    // cheap rejection before sampling the curve
    if (point.x < Math.min(ends.s.x, ends.t.x) - reach || point.x > Math.max(ends.s.x, ends.t.x) + reach) continue;
    if (point.y < Math.min(ends.s.y, ends.t.y) - reach - 80 || point.y > Math.max(ends.s.y, ends.t.y) + reach + 80) continue;
    const d = distanceToCurve(point, curvePoints(ends.s, ends.t)) * zoom;
    if (e.id === current && d <= keep) stay = e.id;
    if (d <= near && (!best || d < best.d)) best = { id: e.id, d };
  }
  return stay ?? best?.id ?? null;
}

/** Steps reachable from `startId`, not crossing the ids in `stop` (so a loop back to the left never moves the left side). */
export function downstream(startId, edges, stop = new Set()) {
  const seen = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || stop.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.source === id) queue.push(e.target);
  }
  return [...seen];
}

/** Where the new step goes and how far the steps after it must move right to leave room (dx = 0 when there is already room). */
export function planInsert({ edge, boxes, size, edges }) {
  const ends = edgeEnds(edge, boxes);
  if (!ends) return null;
  const needed = size.w + 2 * GAP;
  const dx = Math.max(0, Math.round(needed - (ends.t.x - ends.s.x)));
  return {
    position: { x: Math.round(ends.s.x + GAP), y: Math.round((ends.s.y + ends.t.y) / 2 - size.h / 2) },
    dx,
    shifted: dx > 0 ? downstream(edge.target, edges, new Set([edge.source])) : [],
  };
}

const edgeId = (source, sh, target, th) => `${source}-${sh}-${target}-${th}`;
/** Replaces `edge` with two: source to the new step, and the new step to the old target. The old output and input numbers are kept. */
export function rewire(edges, edge, nodeId) {
  return [
    ...edges.filter((e) => e.id !== edge.id),
    { id: edgeId(edge.source, edge.sourceHandle, nodeId, 'in-0'), source: edge.source, sourceHandle: edge.sourceHandle, target: nodeId, targetHandle: 'in-0' },
    { id: edgeId(nodeId, 'out-0', edge.target, edge.targetHandle), source: nodeId, sourceHandle: 'out-0', target: edge.target, targetHandle: edge.targetHandle },
  ];
}

/* ------------------------------ dragging a line out of a handle ------------------------------ */
const boxDistance = (p, b) => Math.hypot(Math.max(b.x - p.x, 0, p.x - (b.x + b.w)), Math.max(b.y - p.y, 0, p.y - (b.y + b.h)));

/**
 * While a line is dragged out of a handle, which step would it join if released now, and at which of that step's handles?
 * `from` is { nodeId, type: 'source' | 'target', index }. A line dragged from an output looks for steps that take an input,
 * and the other way round. Only steps within `near` screen pixels count (a chosen one is kept out to `keep`), and the handle
 * is the free one closest to the pointer (a handle already joined to the same step is never offered twice).
 * `eligible(id, side)` says whether a step has that kind of handle at all (a trigger takes no input).
 */
export function nearestConnectTarget({ point, boxes, edges, from, eligible, zoom = 1, current = null, near = 120, keep = 150 }) {
  const side = from.type === 'source' ? 'in' : 'out';
  const pick = (id) => {
    const b = boxes[id];
    const count = side === 'in' ? b.ins : b.outs;
    const taken = (i) => edges.some((e) => (side === 'in'
      ? e.source === from.nodeId && e.target === id && e.sourceHandle === `out-${from.index}` && e.targetHandle === `in-${i}`
      : e.source === id && e.target === from.nodeId && e.sourceHandle === `out-${i}` && e.targetHandle === `in-${from.index}`));
    const used = (i) => edges.some((e) => (side === 'in' ? e.target === id && e.targetHandle === `in-${i}` : e.source === id && e.sourceHandle === `out-${i}`));
    const options = Array.from({ length: count }, (_, i) => i).filter((i) => !taken(i));
    if (!options.length) return null;
    const free = options.filter((i) => !used(i));
    const pool = free.length ? free : options;
    const y = (i) => b.y + (b.h * (i + 1)) / (count + 1);
    const index = pool.reduce((best, i) => (Math.abs(y(i) - point.y) < Math.abs(y(best) - point.y) ? i : best), pool[0]);
    return { id, side, index, handle: `${side}-${index}` };
  };
  let best = null;
  let stay = null;
  for (const id of Object.keys(boxes)) {
    if (id === from.nodeId || !eligible(id, side)) continue;
    const d = boxDistance(point, boxes[id]) * zoom;
    if (d > Math.max(near, keep)) continue;
    const spot = pick(id);
    if (!spot) continue; // this step cannot take the line (already joined the same way): look at the next one
    if (id === current && d <= keep) stay = spot;
    if (d <= near && (!best || d < best.d)) best = { spot, d };
  }
  return stay ?? best?.spot ?? null;
}

/* ------------------------------------ copy and paste ------------------------------------ */
export const CLIP_MARK = 'liteforeflow-steps';

/** What goes on the clipboard: the chosen steps and only the connections between them. */
export function copyPayload(nodes, connections) {
  const ids = new Set(nodes.map((n) => n.id));
  return { [CLIP_MARK]: 1, nodes: nodes.map((n) => structuredClone(n)), connections: connections.filter((c) => ids.has(c.from) && ids.has(c.to)).map((c) => ({ ...c })) };
}
export function parseClip(text) {
  try {
    const p = JSON.parse(text);
    return p && p[CLIP_MARK] === 1 && Array.isArray(p.nodes) && p.nodes.length && Array.isArray(p.connections) ? p : null;
  } catch { return null; }
}

const baseName = (name) => String(name).replace(/ \d+$/, '');
/** Fresh ids, unique names (expressions refer to steps by name), moved by (dx, dy), and new webhook paths (they must be unique). */
export function clonePaste(payload, takenNames, { dx = 40, dy = 40, newId }) {
  const taken = new Set(takenNames);
  const idMap = new Map();
  const nodes = payload.nodes.map((n) => {
    const id = newId();
    idMap.set(n.id, id);
    let name = n.name;
    if (taken.has(name)) { const b = baseName(name); let i = 2; while (taken.has(`${b} ${i}`)) i += 1; name = `${b} ${i}`; }
    taken.add(name);
    const copy = { ...structuredClone(n), id, name, position: { x: Math.round((n.position?.x ?? 0) + dx), y: Math.round((n.position?.y ?? 0) + dy) } };
    if (copy.type === 'trigger.webhook' && copy.parameters) copy.parameters = { ...copy.parameters, path: `hook-${newId()}` };
    return copy;
  });
  const connections = payload.connections.filter((c) => idMap.has(c.from) && idMap.has(c.to)).map((c) => ({ ...c, from: idMap.get(c.from), to: idMap.get(c.to) }));
  return { nodes, connections, idMap };
}

/* ------------------------------------- undo history ------------------------------------- */
/** Snapshots are strings (the serialised workflow), so "did anything change" is a plain comparison. */
export function createHistory(limit = 100) {
  let past = []; let future = []; let present = null;
  return {
    reset(snapshot) { past = []; future = []; present = snapshot; },
    commit(snapshot) {
      if (snapshot === present) return false;
      if (present !== null) past.push(present);
      if (past.length > limit) past.shift();
      future = [];
      present = snapshot;
      return true;
    },
    undo() { if (!past.length) return null; future.push(present); present = past.pop(); return present; },
    redo() { if (!future.length) return null; past.push(present); present = future.pop(); return present; },
    get canUndo() { return past.length > 0; },
    get canRedo() { return future.length > 0; },
    get ready() { return present !== null; },
  };
}
