import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curvePoints, handlePoint, edgeEnds, distanceToCurve, findInsertTarget, planInsert, downstream, rewire, copyPayload, parseClip, clonePaste, createHistory, GAP } from '../src/flow.js';

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
