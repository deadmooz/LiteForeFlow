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

export const handleIndex = (id) => Number(String(id ?? '').split('-')[1] ?? 0) || 0;
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
    if (d > keep) continue; // keep is always the wider of the two
    const spot = pick(id);
    if (!spot) continue; // this step cannot take the line (already joined the same way): look at the next one
    if (id === current && d <= keep) stay = spot;
    if (d <= near && (!best || d < best.d)) best = { spot, d };
  }
  return stay ?? best?.spot ?? null;
}

/* ------------------------------------ tidy up ------------------------------------ */
/**
 * Lays a messy canvas out neatly: every step goes in a column by how far it is from the start, left to right; steps in a column
 * are ordered to keep lines from crossing and sit near the steps that feed them; separate flows are stacked one under the other.
 * nodes: [{ id, x, y, w, h }]   edges: [{ from, to, fromOutput }]   Returns Map id -> { x, y } (the top-left stays where it was).
 */
export function tidyLayout({ nodes, edges, gapX = 90, gapY = 36, gapFlows = 90 }) {
  const result = new Map();
  if (!nodes.length) return result;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const out = new Map(nodes.map((n) => [n.id, []]));
  const inn = new Map(nodes.map((n) => [n.id, []]));
  const readingOrder = (a, b) => a.y - b.y || a.x - b.x;

  // separate flows = connected groups (ignoring direction)
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (id) => { let r = id; while (parent.get(r) !== r) r = parent.get(r); parent.set(id, r); return r; };
  for (const e of links) parent.set(find(e.from), find(e.to));
  const groups = new Map();
  for (const n of [...nodes].sort(readingOrder)) { const r = find(n.id); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(n); }
  const flows = [...groups.values()].sort((a, b) => Math.min(...a.map((n) => n.y)) - Math.min(...b.map((n) => n.y)));

  // drop the lines that would close a loop (a depth-first walk in reading order), so every flow has a clear direction
  const forward = [];
  const state = new Map();
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of links) adj.get(e.from).push(e);
  const walk = (id) => {
    state.set(id, 1);
    for (const e of adj.get(id).sort((a, b) => readingOrder(byId.get(a.to), byId.get(b.to)))) {
      if (state.get(e.to) === 1) continue; // back to a step still being walked: a loop
      forward.push(e);
      if (!state.has(e.to)) walk(e.to);
    }
    state.set(id, 2);
  };
  for (const n of [...nodes].sort(readingOrder)) if (!state.has(n.id)) walk(n.id);
  for (const e of forward) { out.get(e.from).push(e); inn.get(e.to).push(e); }

  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  let top = minY;
  for (const members of flows) {
    // column = longest path from a step that nothing feeds
    const layer = new Map();
    const colOf = (id) => {
      if (layer.has(id)) return layer.get(id);
      layer.set(id, 0); // guards the walk; the lines left are loop-free
      const c = Math.max(0, ...inn.get(id).map((e) => colOf(e.from) + 1));
      layer.set(id, c);
      return c;
    };
    members.forEach((n) => colOf(n.id));
    const cols = [];
    members.forEach((n) => { (cols[layer.get(n.id)] ??= []).push(n); });
    cols.forEach((c) => c.sort(readingOrder));

    // order inside a column: a few sweeps that put each step near the average position of its neighbours
    const rank = new Map();
    const reindex = () => cols.forEach((c) => c.forEach((n, i) => rank.set(n.id, i)));
    reindex();
    const sweep = (list, neighbours, outputFirst) => {
      const key = (n) => {
        const ls = neighbours(n);
        if (!ls.length) return rank.get(n.id);
        return ls.reduce((sum, e) => sum + rank.get(outputFirst ? e.to : e.from) + (e.fromOutput ?? 0) * 0.01, 0) / ls.length;
      };
      const keys = new Map(list.map((n) => [n.id, key(n)]));
      list.sort((a, b) => keys.get(a.id) - keys.get(b.id) || rank.get(a.id) - rank.get(b.id));
    };
    for (let pass = 0; pass < 4; pass += 1) {
      for (let c = 1; c < cols.length; c += 1) { sweep(cols[c], (n) => inn.get(n.id), false); cols[c].forEach((n, i) => rank.set(n.id, i)); }
      for (let c = cols.length - 2; c >= 0; c -= 1) { sweep(cols[c], (n) => out.get(n.id), true); cols[c].forEach((n, i) => rank.set(n.id, i)); }
    }

    // vertical position: near the middle of the steps that feed it, never overlapping the one above
    const xOf = [];
    let x = minX;
    cols.forEach((c, i) => { xOf[i] = x; x += Math.max(...c.map((n) => n.w)) + gapX; });
    const centre = new Map();
    const placed = new Map();
    cols.forEach((c, ci) => {
      let floor = -Infinity;
      c.forEach((n) => {
        const feeders = inn.get(n.id);
        const want = feeders.length ? feeders.reduce((s, e) => s + centre.get(e.from), 0) / feeders.length - n.h / 2 : (floor === -Infinity ? 0 : floor);
        const y = Math.max(want, floor);
        placed.set(n.id, { x: xOf[ci], y });
        centre.set(n.id, y + n.h / 2);
        floor = y + n.h + gapY;
      });
    });
    const flowTop = Math.min(...members.map((n) => placed.get(n.id).y));
    const flowBottom = Math.max(...members.map((n) => placed.get(n.id).y + n.h));
    for (const n of members) { const p = placed.get(n.id); result.set(n.id, { x: Math.round(p.x), y: Math.round(p.y - flowTop + top) }); }
    top += flowBottom - flowTop + gapFlows;
  }
  return result;
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

// One size for every step, so the lines and handles sit exactly where the geometry in flow.js expects them: 200 wide, 52 tall
// (taller only when a step has several handles, 18 px each).
export const NODE_W = 200;
export const nodeHeight = (inputs, outs) => { const n = Math.max(inputs, outs); return n > 1 ? Math.max(52, 20 + 18 * n) : 52; };

// The second line of a step: what it points at (address, channel, ...) when it has one, else what kind of step it is.
const SUB_KEYS = ['url', 'path', 'channel', 'to', 'expression'];
export function subtitle(node, def) {
  const p = node.parameters ?? {};
  const k = SUB_KEYS.find((x) => typeof p[x] === 'string' && p[x].trim());
  return k ? `${k === 'url' && p.method ? `${p.method} ` : ''}${p[k].trim()}` : def.name;
}
