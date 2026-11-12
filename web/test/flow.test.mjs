import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nearestConnectTarget, curvePoints, handlePoint, edgeEnds, distanceToCurve, findInsertTarget, planInsert, downstream, rewire, copyPayload, parseClip, clonePaste, createHistory, GAP } from '../src/flow.js';

const box = (x, y, extra = {}) => ({ x, y, w: 190, h: 56, ins: 1, outs: 1, ...extra });
// A --- B on one row, C far below
const boxes = { A: box(0, 0), B: box(500, 0), C: box(0, 600), D: box(500, 600) };
const edges = [
  { id: 'A-out-0-B-in-0', source: 'A', sourceHandle: 'out-0', target: 'B', targetHandle: 'in-0' },
  { id: 'C-out-0-D-in-0', source: 'C', sourceHandle: 'out-0', target: 'D', targetHandle: 'in-0' },
];

test('the curve starts at the output and ends at the input', () => {
  const s = { x: 190, y: 28 }; const t = { x: 500, y: 28 };
  const pts = curvePoints(s, t);
  assert.deepEqual(pts[0], s);
  assert.ok(Math.abs(pts.at(-1).x - t.x) < 1e-9 && Math.abs(pts.at(-1).y - t.y) < 1e-9);
  assert.ok(distanceToCurve({ x: 345, y: 28 }, pts) < 1, 'a straight edge passes through its middle');
});

test('handles are spread evenly when a step has several outputs', () => {
  const two = box(0, 0, { outs: 2, h: 64 });
  assert.equal(handlePoint(two, 'out', 0).y, 64 / 3);
  assert.equal(handlePoint(two, 'out', 1).y, (64 * 2) / 3);
  assert.equal(handlePoint(two, 'in', 0).x, 0);
});

test('the nearest line within 40 pixels wins, and far away means no target', () => {
  const near = findInsertTarget({ point: { x: 345, y: 20 }, edges, boxes });
  assert.equal(near, 'A-out-0-B-in-0');
  assert.equal(findInsertTarget({ point: { x: 345, y: 200 }, edges, boxes }), null);
  assert.equal(findInsertTarget({ point: { x: 345, y: 620 }, edges, boxes }), 'C-out-0-D-in-0');
});

test('zoom changes what "near" means: the same canvas distance is further away on screen when zoomed in', () => {
  const p = { x: 345, y: 28 + 30 }; // 30 canvas pixels off the line
  assert.equal(findInsertTarget({ point: p, edges, boxes, zoom: 1 }), 'A-out-0-B-in-0');
  assert.equal(findInsertTarget({ point: p, edges, boxes, zoom: 2 }), null, '60 screen pixels away');
  assert.equal(findInsertTarget({ point: p, edges, boxes, zoom: 0.5 }), 'A-out-0-B-in-0');
});

test('hysteresis: a chosen line is kept out to 60 pixels, but a new one needs 40', () => {
  const p = { x: 345, y: 28 + 50 };
  assert.equal(findInsertTarget({ point: p, edges, boxes }), null, 'not chosen from 50 away');
  assert.equal(findInsertTarget({ point: p, edges, boxes, current: 'A-out-0-B-in-0' }), 'A-out-0-B-in-0', 'but kept once chosen');
  assert.equal(findInsertTarget({ point: { x: 345, y: 28 + 70 }, edges, boxes, current: 'A-out-0-B-in-0' }), null, 'released beyond 60');
});

test('a step never snaps onto its own lines', () => {
  assert.equal(findInsertTarget({ point: { x: 345, y: 28 }, edges, boxes, skip: new Set(['B']) }), null);
});

test('room is made only when the gap is too small, and only the steps after it move', () => {
  const size = { w: 190, h: 56 };
  const wide = planInsert({ edge: edges[0], boxes, size, edges });
  assert.equal(wide.dx, 0); assert.deepEqual(wide.shifted, []);
  assert.deepEqual(wide.position, { x: 190 + GAP, y: 0 });

  const tight = { A: box(0, 0), B: box(260, 0) };
  const chain = [{ id: 'e1', source: 'A', sourceHandle: 'out-0', target: 'B', targetHandle: 'in-0' }, { id: 'e2', source: 'B', sourceHandle: 'out-0', target: 'Z', targetHandle: 'in-0' }];
  const plan = planInsert({ edge: chain[0], boxes: tight, size, edges: chain });
  assert.equal(plan.dx, size.w + 2 * GAP - (260 - 190));
  assert.deepEqual(plan.shifted.sort(), ['B', 'Z']);
});

test('a loop back to the left side never moves the left side', () => {
  const loop = [
    { id: 'ab', source: 'A', sourceHandle: 'out-0', target: 'B', targetHandle: 'in-0' },
    { id: 'ba', source: 'B', sourceHandle: 'out-0', target: 'A', targetHandle: 'in-0' },
  ];
  assert.deepEqual(downstream('B', loop, new Set(['A'])), ['B']);
});

test('rewiring keeps which output the line came from (an IF branch stays on its branch)', () => {
  const branch = { id: 'x', source: 'IF', sourceHandle: 'out-1', target: 'B', targetHandle: 'in-0' };
  const out = rewire([branch, { id: 'other', source: 'Q', sourceHandle: 'out-0', target: 'R', targetHandle: 'in-0' }], branch, 'N');
  assert.equal(out.length, 3);
  assert.ok(!out.some((e) => e.id === 'x'));
  assert.ok(out.some((e) => e.source === 'IF' && e.sourceHandle === 'out-1' && e.target === 'N' && e.targetHandle === 'in-0'));
  assert.ok(out.some((e) => e.source === 'N' && e.sourceHandle === 'out-0' && e.target === 'B' && e.targetHandle === 'in-0'));
});

test('copy keeps only the connections between the copied steps; paste gives new ids and names', () => {
  const nodes = [
    { id: 'a', type: 'trigger.webhook', name: 'Hook', parameters: { path: 'orders' }, position: { x: 10, y: 20 } },
    { id: 'b', type: 'data.set', name: 'Edit Fields', parameters: {}, position: { x: 300, y: 20 } },
    { id: 'c', type: 'app.slack', name: 'Slack', parameters: {}, position: { x: 600, y: 20 } },
  ];
  const conns = [{ from: 'a', to: 'b', fromOutput: 0, toInput: 0 }, { from: 'b', to: 'c', fromOutput: 0, toInput: 0 }];
  const payload = copyPayload(nodes.slice(0, 2), conns);
  assert.equal(payload.connections.length, 1, 'the line to the step that was not copied is dropped');
  const roundTrip = parseClip(JSON.stringify(payload));
  assert.ok(roundTrip);
  let n = 0;
  const pasted = clonePaste(roundTrip, ['Hook', 'Edit Fields', 'Slack'], { dx: 40, dy: 40, newId: () => `id${++n}` });
  assert.deepEqual(pasted.nodes.map((x) => x.name), ['Hook 2', 'Edit Fields 2']);
  assert.ok(pasted.nodes.every((x) => !['a', 'b', 'c'].includes(x.id)));
  assert.deepEqual(pasted.nodes[0].position, { x: 50, y: 60 });
  assert.notEqual(pasted.nodes[0].parameters.path, 'orders', 'a webhook path must be unique');
  assert.deepEqual(pasted.connections, [{ from: pasted.nodes[0].id, to: pasted.nodes[1].id, fromOutput: 0, toInput: 0 }]);
  const again = clonePaste(roundTrip, ['Hook', 'Hook 2', 'Edit Fields'], { newId: () => `x${++n}` });
  assert.equal(again.nodes[0].name, 'Hook 3');
});

test('only our own clipboard text pastes as steps', () => {
  assert.equal(parseClip('hello'), null);
  assert.equal(parseClip(JSON.stringify({ nodes: [] })), null);
  assert.equal(parseClip(JSON.stringify({ 'liteforeflow-steps': 1, nodes: [], connections: [] })), null, 'an empty copy is nothing');
});

test('undo and redo walk the history, and a new change clears what could be redone', () => {
  const h = createHistory(3);
  assert.equal(h.ready, false);
  h.reset('s0');
  assert.equal(h.canUndo, false);
  assert.equal(h.commit('s0'), false, 'no change, no entry');
  h.commit('s1'); h.commit('s2');
  assert.equal(h.undo(), 's1'); assert.equal(h.undo(), 's0'); assert.equal(h.undo(), null);
  assert.equal(h.redo(), 's1');
  h.commit('s9');
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), 's1');
});

test('the history is capped, so a long session cannot grow without limit', () => {
  const h = createHistory(3);
  h.reset('s0');
  for (let i = 1; i <= 10; i += 1) h.commit(`s${i}`);
  let steps = 0;
  while (h.undo() !== null) steps += 1;
  assert.equal(steps, 3);
});

test('edgeEnds is null when a step is unknown', () => {
  assert.equal(edgeEnds({ source: 'A', target: 'nope', sourceHandle: 'out-0', targetHandle: 'in-0' }, boxes), null);
});

const cb = { A: box(0, 0, { ins: 0 }), M: box(300, -100, { ins: 2 }), S: box(300, 200), Z: box(900, 0) };
const ok = (id, side) => (side === 'in' ? cb[id].ins > 0 : cb[id].outs > 0);

test('a line dragged out of an output suggests the nearest step that takes an input, and the handle closest to the pointer', () => {
  const from = { nodeId: 'A', type: 'source', index: 0 };
  const near = nearestConnectTarget({ point: { x: 290, y: -90 }, boxes: cb, edges: [], from, eligible: ok });
  assert.equal(near.id, 'M');
  assert.equal(near.handle, 'in-0', 'the upper of the two inputs is closer to a pointer above the middle');
  const low = nearestConnectTarget({ point: { x: 290, y: -50 }, boxes: cb, edges: [], from, eligible: ok });
  assert.equal(low.handle, 'in-1');
});

test('a step far away is not suggested, and neither is the step the line comes from', () => {
  const from = { nodeId: 'A', type: 'source', index: 0 };
  assert.equal(nearestConnectTarget({ point: { x: 600, y: 600 }, boxes: cb, edges: [], from, eligible: ok }), null);
  assert.equal(nearestConnectTarget({ point: { x: 10, y: 10 }, boxes: { A: cb.A }, edges: [], from, eligible: ok }), null);
});

test('a trigger takes no input, so it is never offered for a line from an output', () => {
  const boxesT = { A: box(0, 0), T: box(300, 0, { ins: 0 }) };
  const from = { nodeId: 'A', type: 'source', index: 0 };
  const eligible = (id, side) => (side === 'in' ? boxesT[id].ins > 0 : boxesT[id].outs > 0);
  assert.equal(nearestConnectTarget({ point: { x: 310, y: 10 }, boxes: boxesT, edges: [], from, eligible }), null);
});

test('dragging backwards from an input looks for steps that have an output', () => {
  const from = { nodeId: 'S', type: 'target', index: 0 };
  const near = nearestConnectTarget({ point: { x: 150, y: 110 }, boxes: cb, edges: [], from, eligible: ok });
  assert.equal(near.id, 'A'); assert.equal(near.side, 'out'); assert.equal(near.handle, 'out-0');
});

test('an input that is already joined is not offered again for the same line, and a free one is preferred', () => {
  const from = { nodeId: 'A', type: 'source', index: 0 };
  const joined = [{ source: 'A', sourceHandle: 'out-0', target: 'M', targetHandle: 'in-0' }];
  const next = nearestConnectTarget({ point: { x: 290, y: -90 }, boxes: cb, edges: joined, from, eligible: ok });
  assert.equal(next.id, 'M'); assert.equal(next.handle, 'in-1', 'the other input is offered');
  const both = [...joined, { source: 'A', sourceHandle: 'out-0', target: 'M', targetHandle: 'in-1' }];
  assert.equal(nearestConnectTarget({ point: { x: 290, y: -90 }, boxes: { A: cb.A, M: cb.M }, edges: both, from, eligible: ok }), null, 'both inputs already joined to A');
});

test('hysteresis: a chosen step stays chosen a little further out, a new one needs to be close', () => {
  const from = { nodeId: 'A', type: 'source', index: 0 };
  const p = { x: 300 - 135, y: -72 };
  assert.equal(nearestConnectTarget({ point: p, boxes: cb, edges: [], from, eligible: ok }), null);
  assert.equal(nearestConnectTarget({ point: p, boxes: cb, edges: [], from, eligible: ok, current: 'M' })?.id, 'M');
});

test('when the nearest step cannot take the line, the next nearest one that can is offered', () => {
  const bx = { A: box(0, 0, { ins: 0 }), B: box(300, 0), C: box(300, 120) };
  const from = { nodeId: 'A', type: 'source', index: 0 };
  const eligible = (id, side) => (side === 'in' ? bx[id].ins > 0 : bx[id].outs > 0);
  const joined = [{ source: 'A', sourceHandle: 'out-0', target: 'B', targetHandle: 'in-0' }];
  const near = nearestConnectTarget({ point: { x: 250, y: 60 }, boxes: bx, edges: joined, from, eligible });
  assert.equal(near?.id, 'C', 'B is closer but already joined to A, so C is offered');
});

/* ---------------------------------- tidy up ---------------------------------- */
import { tidyLayout } from '../src/flow.js';
const tn = (id, x, y, w = 190, h = 56) => ({ id, x, y, w, h });
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('tidy: a chain becomes one even row, left to right, and keeps its top-left corner', () => {
  const nodes = [tn('a', 400, 300), tn('b', 10, 900), tn('c', 800, 50)];
  const pos = tidyLayout({ nodes, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }] });
  assert.ok(pos.get('a').x < pos.get('b').x && pos.get('b').x < pos.get('c').x);
  assert.equal(pos.get('a').y, pos.get('b').y); assert.equal(pos.get('b').y, pos.get('c').y);
  assert.equal(pos.get('b').x - pos.get('a').x, 190 + 90);
  assert.equal(Math.min(...[...pos.values()].map((p) => p.x)), 10); // the leftmost x stayed
  assert.equal(Math.min(...[...pos.values()].map((p) => p.y)), 50); // and so did the topmost y
});

test('tidy: a branch puts output 0 above output 1 and both after their parent', () => {
  const nodes = [tn('if', 0, 0), tn('yes', 0, 500), tn('no', 0, 100)]; // deliberately upside down
  const pos = tidyLayout({ nodes, edges: [{ from: 'if', to: 'yes', fromOutput: 0 }, { from: 'if', to: 'no', fromOutput: 1 }] });
  assert.ok(pos.get('yes').y < pos.get('no').y, 'output 0 is above output 1');
  assert.ok(pos.get('yes').x > pos.get('if').x && pos.get('no').x > pos.get('if').x);
});

test('tidy: a merge sits after both of its inputs', () => {
  const nodes = [tn('a', 0, 0), tn('b', 0, 100), tn('m', 0, 50), tn('z', 0, 200)];
  const pos = tidyLayout({ nodes, edges: [{ from: 'a', to: 'm' }, { from: 'b', to: 'm' }, { from: 'm', to: 'z' }] });
  assert.ok(pos.get('m').x > pos.get('a').x && pos.get('m').x > pos.get('b').x && pos.get('z').x > pos.get('m').x);
});

test('tidy: separate flows are stacked and nothing overlaps, even in a big tangle', () => {
  const nodes = []; const edges = [];
  for (let i = 0; i < 40; i += 1) nodes.push(tn(`n${i}`, (i * 37) % 300, (i * 53) % 200, 150 + (i % 4) * 30, 56 + (i % 3) * 20));
  for (let i = 0; i < 40; i += 1) { if (i % 7 !== 6) edges.push({ from: `n${i}`, to: `n${i + 1}` }); if (i % 5 === 0 && i + 3 < 40) edges.push({ from: `n${i}`, to: `n${i + 3}`, fromOutput: 1 }); }
  const pos = tidyLayout({ nodes, edges });
  assert.equal(pos.size, 40);
  const boxes = nodes.map((n) => ({ ...n, ...pos.get(n.id) }));
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) assert.ok(!overlap(boxes[i], boxes[j]), `${boxes[i].id} overlaps ${boxes[j].id}`);
});

test('tidy: a loop or a line to nowhere cannot hang or crash it, and a lone step stays put', () => {
  const pos = tidyLayout({ nodes: [tn('a', 5, 7), tn('b', 300, 7)], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }, { from: 'a', to: 'ghost' }, { from: 'a', to: 'a' }] });
  assert.ok(pos.get('a').x < pos.get('b').x);
  assert.deepEqual(tidyLayout({ nodes: [tn('only', 123, 45)], edges: [] }).get('only'), { x: 123, y: 45 });
  assert.equal(tidyLayout({ nodes: [], edges: [] }).size, 0);
});
