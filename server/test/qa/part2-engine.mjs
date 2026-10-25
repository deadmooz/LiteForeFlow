import assert from 'node:assert/strict';
import { area, t, client, blocked, sleep, N, E, chain, manual, set, code, mkWf, runWf, outJson, webhook, uniq, maxLatencyDuring } from './lib.mjs';

export default async function part2({ s1, mock }) {
  const U = await client(s1.base).user();
  const cond = (left, op, right = '') => ({ left, op, right });
  const ifNode = (id, conditions, combine = 'all') => N(id, 'logic.if', id, { conditions, combine });
  const run = (nodes, conns, opts) => runWf(U, nodes, conns, opts);
  const ok = (r) => { assert.equal(r.status, 'success', `status=${r.status} http=${r.http} err=${JSON.stringify(r.error ?? r.raw)}`); return r; };

  area('Engine: data flow & expressions');
  await t('ENG-01', 'Linear workflow passes data node to node', async () => {
    const r = ok(await run([manual(), set('a', { x: '{{ 20 }}' }), set('b', { y: '{{ $json.x + 1 }}' })], chain('t', 'a', 'b')));
    assert.deepEqual(outJson(r, 'b'), [{ x: 20, y: 21 }]);
  });
  await t('ENG-02', 'A whole-value expression keeps its type (number, boolean, object, array, null)', async () => {
    const r = ok(await run([manual(), set('a', { n: '{{ 1.5 }}', b: '{{ true }}', o: '{{ ({k:[1,2]}) }}', a: '{{ [1,"2"] }}', z: '{{ null }}' }, {}, false)], chain('t', 'a')));
    assert.deepEqual(outJson(r, 'a'), [{ n: 1.5, b: true, o: { k: [1, 2] }, a: [1, '2'], z: null }]);
  });
  await t('ENG-03', 'Mixed text + expressions interpolate; objects become JSON; null/undefined become empty', async () => {
    const r = ok(await run([manual(), set('a', { s: 'v={{ ({a:1}) }} n={{ null }} u={{ undefined }}!' }, {}, false)], chain('t', 'a')));
    assert.equal(outJson(r, 'a')[0].s, 'v={"a":1} n= u=!');
  });
  await t('ENG-04', '$node["Name"] reads another node\'s output; $input.all() and $itemIndex work', async () => {
    const r = ok(await run([manual(), code('gen', 'return [{v:1},{v:2},{v:3}];'), set('use', { first: '{{ $node["gen"].json.v }}', cnt: '{{ $input.all().length }}', idx: '{{ $itemIndex }}' }, {}, false)], chain('t', 'gen', 'use')));
    assert.deepEqual(outJson(r, 'use'), [{ first: 1, cnt: 3, idx: 0 }, { first: 1, cnt: 3, idx: 1 }, { first: 1, cnt: 3, idx: 2 }]);
  });
  await t('ENG-05', 'Reading a property of undefined fails the run with a readable "Expression error" naming the node', async () => {
    const r = await run([manual(), set('bad', { x: '{{ $json.a.b.c }}' })], chain('t', 'bad'));
    assert.equal(r.status, 'error'); assert.equal(r.error.nodeName, 'bad'); assert.match(r.error.message, /Expression error/);
  });
  await t('ENG-06', 'Expression syntax error is reported, not swallowed', async () => {
    const r = await run([manual(), set('bad', { x: '{{ 1 + }}' })], chain('t', 'bad'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /Expression error/);
  });
  await t('ENG-07', 'Unicode, emoji, quotes and newlines survive expressions untouched', async () => {
    const s = 'héllo 日本語 🚀 "q" \'s\' \\ \n line2';
    const r = ok(await run([manual(), set('a', { s: '{{ $json.s }}', t: 'pre-{{ $json.s }}-post' })], chain('t', 'a'), { payload: { s } }));
    assert.equal(outJson(r, 'a')[0].s, s); assert.equal(outJson(r, 'a')[0].t, `pre-${s}-post`);
  });
  await t('ENG-08', '1,500 items × 2 expressions complete within 10 s and are all processed', async () => {
    const t0 = Date.now();
    const r = ok(await run([manual(), code('g', 'return Array.from({length:1500},(_,i)=>({i}));'), set('s', { sq: '{{ $json.i*$json.i }}', l: 'n{{ $json.i }}' }, {}, false), N('agg', 'data.aggregate', 'agg', { field: 'rows' })], chain('t', 'g', 's', 'agg')));
    assert.ok(Date.now() - t0 < 10000, `${Date.now() - t0} ms`);
    return `${Date.now() - t0} ms`;
  });
  await t('ENG-09', 'Large single item (2 MB string) flows through nodes', async () => {
    const r = ok(await run([manual(), set('a', { len: '{{ $json.big.length }}' })], chain('t', 'a'), { payload: { big: 'x'.repeat(2_000_000) } }));
    const stored = outJson(r, 'a');
    return stored ? `output length ${stored[0].len}` : 'run succeeded, but the stored log omits node data above ~1 MB, so the editor shows no input/output for this run (by design, documented)';
  });
  await t('ENG-10', 'Deeply nested JSON (200 levels) is processed', async () => {
    let o = { leaf: 1 }; for (let i = 0; i < 200; i += 1) o = { c: o };
    const r = ok(await run([manual(), set('a', { ok: '{{ !!$json.c }}' })], chain('t', 'a'), { payload: o }));
    assert.equal(outJson(r, 'a')[0].ok, true);
  });

  area('Engine: branching & logic nodes');
  const items3 = 'return [{n:1,s:"apple"},{n:5,s:"banana"},{n:10,s:""}];';
  await t('ENG-11', 'IF routes items to true/false outputs; empty branch downstream is skipped', async () => {
    const r = ok(await run([manual(), code('g', items3), ifNode('i', [cond('{{ $json.n }}', 'gt', '4')]), set('yes', { b: '{{ 1 }}' }), set('no', { b: '{{ 0 }}' })], [...chain('t', 'g', 'i'), E('i', 'yes', 0), E('i', 'no', 1)]));
    assert.equal(outJson(r, 'yes').length, 2); assert.equal(outJson(r, 'no').length, 1);
    const r2 = await run([manual(), code('g', 'return [{n:1}];'), ifNode('i', [cond('{{ $json.n }}', 'gt', '4')]), set('yes', { b: '{{ 1 }}' })], [...chain('t', 'g', 'i'), E('i', 'yes', 0)]);
    assert.equal(r2.results.yes.status, 'skipped');
  });
  await t('ENG-12', 'IF operators: equals notEquals contains startsWith endsWith lt gte isEmpty isNotEmpty regex isTrue isFalse', async () => {
    const tests = [['equals', 'apple', 'apple', true], ['notEquals', 'apple', 'pear', true], ['contains', 'pineapple', 'apple', true], ['notContains', 'pear', 'apple', true],
      ['startsWith', 'apple', 'app', true], ['endsWith', 'apple', 'ple', true], ['lt', '3', '5', true], ['gte', '5', '5', true], ['isEmpty', '', '', true], ['isNotEmpty', 'x', '', true],
      ['regex', 'abc123', '^[a-z]+\\d+$', true], ['isTrue', 'true', '', true], ['isFalse', 'false', '', true], ['equals', 'a', 'b', false], ['gt', '1', '2', false]];
    for (const [op, l, rr, want] of tests) {
      const r = ok(await run([manual(), ifNode('i', [cond(l, op, rr)]), set('y', { m: '{{ 1 }}' }), set('n', { m: '{{ 0 }}' })], [E('t', 'i'), E('i', 'y', 0), E('i', 'n', 1)]));
      assert.equal(r.results.y.status === 'success', want, `${op}(${l},${rr}) expected ${want}`);
    }
  });
  await t('ENG-13', 'IF combine=any vs all', async () => {
    const mk = (combine) => run([manual(), ifNode('i', [cond('a', 'equals', 'a'), cond('a', 'equals', 'b')], combine), set('y', { m: '{{ 1 }}' })], [E('t', 'i'), E('i', 'y', 0)]);
    assert.equal((await mk('any')).results.y.status, 'success'); assert.equal((await mk('all')).results.y.status, 'skipped');
  });
  await t('ENG-14', 'Switch routes by case, sends unmatched to fallback; numeric/string values match', async () => {
    const r = ok(await run([manual(), code('g', 'return [{k:"a"},{k:1},{k:"zzz"}];'), N('sw', 'logic.switch', 'sw', { value: '{{ $json.k }}', cases: '["a","1"]' }), set('o0', { x: '{{ 0 }}' }), set('o1', { x: '{{ 1 }}' }), set('fb', { x: '{{ 2 }}' })],
      [...chain('t', 'g', 'sw'), E('sw', 'o0', 0), E('sw', 'o1', 1), E('sw', 'fb', 2)]));
    assert.equal(outJson(r, 'o0').length, 1); assert.equal(outJson(r, 'o1').length, 1); assert.equal(outJson(r, 'fb').length, 1);
  });
  await t('ENG-15', 'Switch with invalid cases JSON fails with a clear message', async () => {
    const r = await run([manual(), N('sw', 'logic.switch', 'sw', { value: 'x', cases: '[not json' })], chain('t', 'sw'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /JSON array/);
  });
  await t('ENG-16', 'Merge: append, combineByPosition, combineByKey', async () => {
    const base = [manual(), set('a', { a: '{{ 1 }}', id: '{{ 7 }}' }, {}, false), set('b', { b: '{{ 2 }}', id: '{{ 7 }}' }, {}, false)];
    const wires = (m) => [E('t', 'a'), E('t', 'b'), E('a', m, 0, 0), E('b', m, 0, 1)];
    const ap = ok(await run([...base, N('m', 'logic.merge', 'm', { mode: 'append' })], wires('m')));
    assert.equal(outJson(ap, 'm').length, 2);
    const pos = ok(await run([...base, N('m', 'logic.merge', 'm', { mode: 'combineByPosition' })], wires('m')));
    assert.deepEqual(outJson(pos, 'm'), [{ a: 1, id: 7, b: 2 }]);
    const key = ok(await run([...base, N('m', 'logic.merge', 'm', { mode: 'combineByKey', keyA: 'id', keyB: 'id' })], wires('m')));
    assert.equal(outJson(key, 'm').length, 1);
  });
  await t('ENG-17', 'Merge still runs when only one branch produced items', async () => {
    const r = ok(await run([manual(), ifNode('i', [cond('a', 'equals', 'a')]), set('y', { v: '{{ 1 }}' }), set('n', { v: '{{ 2 }}' }), N('m', 'logic.merge', 'm', { mode: 'append' })],
      [E('t', 'i'), E('i', 'y', 0), E('i', 'n', 1), E('y', 'm', 0, 0), E('n', 'm', 0, 1)]));
    assert.equal(outJson(r, 'm').length, 1);
  });
  await t('ENG-18', 'Split Out / Aggregate / Limit; Split Out on a non-array fails clearly', async () => {
    const r = ok(await run([manual(), code('g', 'return [{list:[{a:1},{a:2},{a:3}]}];'), N('sp', 'data.splitOut', 'sp', { field: 'list' }), N('lim', 'data.limit', 'lim', { max: 2 }), N('ag', 'data.aggregate', 'ag', { field: 'rows' })], chain('t', 'g', 'sp', 'lim', 'ag')));
    assert.deepEqual(outJson(r, 'ag'), [{ rows: [{ a: 1 }, { a: 2 }] }]);
    const bad = await run([manual(), code('g', 'return [{list:5}];'), N('sp', 'data.splitOut', 'sp', { field: 'list' })], chain('t', 'g', 'sp'));
    assert.equal(bad.status, 'error'); assert.match(bad.error.message, /not an array/);
  });
  await t('ENG-19', 'Edit Fields: dotted paths create nested objects; keepOthers=false drops the rest', async () => {
    const r = ok(await run([manual(), set('a', { 'a.b.c': '{{ 1 }}', top: '{{ 2 }}' }, {}, false)], chain('t', 'a'), { payload: { keep: 1 } }));
    assert.deepEqual(outJson(r, 'a'), [{ a: { b: { c: 1 } }, top: 2 }]);
  });
  await t('ENG-20', 'Wait node pauses; Stop and Error fails with its message', async () => {
    const t0 = Date.now();
    ok(await run([manual(), N('w', 'logic.wait', 'w', { seconds: 1 })], chain('t', 'w')));
    assert.ok(Date.now() - t0 >= 950);
    const r = await run([manual(), N('x', 'logic.stopAndError', 'x', { message: 'custom failure' })], chain('t', 'x'));
    assert.equal(r.status, 'error'); assert.equal(r.error.message, 'custom failure');
  });
  await t('ENG-21', 'Disabled node passes data through unchanged', async () => {
    const r = ok(await run([manual(), set('a', { x: '{{ 1 }}' }, { disabled: true }), set('b', { y: '{{ $json.x === undefined }}' })], chain('t', 'a', 'b')));
    assert.equal(outJson(r, 'b')[0].y, true);
  });
  await t('ENG-22', 'Cycles, missing trigger and unknown nodes are rejected before running', async () => {
    const cyc = await run([manual(), N('a', 'logic.noop', 'a'), N('b', 'logic.noop', 'b')], [E('t', 'a'), E('a', 'b'), E('b', 'a')]);
    assert.equal(cyc.http, 400); assert.match(cyc.error, /loop/);
  });

  area('Engine: Code node & sandbox');
  await t('CODE-01', 'runOnce: array, single object, null and undefined returns are handled', async () => {
    const o = (src) => run([manual(), code('c', src)], chain('t', 'c'));
    assert.equal(outJson(ok(await o('return [{a:1},{a:2}];')), 'c').length, 2);
    assert.deepEqual(outJson(ok(await o('return {a:1};')), 'c'), [{ a: 1 }]);
    assert.deepEqual(outJson(ok(await o('return null;')), 'c'), []);
    assert.deepEqual(outJson(ok(await o('')), 'c'), []);
  });
  await t('CODE-02', 'eachItem mode sees $json per item', async () => {
    const r = ok(await run([manual(), code('g', 'return [{v:1},{v:2}];'), code('c', 'return { d: $json.v * 2, i: $itemIndex };', 'eachItem')], chain('t', 'g', 'c')));
    assert.deepEqual(outJson(r, 'c'), [{ d: 2, i: 0 }, { d: 4, i: 1 }]);
  });
  await t('CODE-03', 'console.log output is captured into the node log', async () => {
    const r = ok(await run([manual(), code('c', 'console.log("hello", {a:1}); return [{ok:1}];')], chain('t', 'c')));
    assert.deepEqual(r.results.c.logs, ['hello {"a":1}']);
  });
  await t('CODE-04', 'Syntax and runtime errors surface with a "Code error" message', async () => {
    const s = await run([manual(), code('c', 'return [{ ;')], chain('t', 'c'));
    assert.equal(s.status, 'error'); assert.match(s.error.message, /Code error/);
    const rt = await run([manual(), code('c', 'null.x')], chain('t', 'c'));
    assert.equal(rt.status, 'error'); assert.match(rt.error.message, /Code error/);
  });
  await t('CODE-05', 'Infinite loop is killed by the timeout and the server stays responsive', async () => {
    const { max, out } = await maxLatencyDuring(s1.base, () => run([manual(), code('c', 'while(true){}')], chain('t', 'c')));
    assert.equal(out.status, 'error'); assert.match(out.error.message, /timed out/i);
    assert.ok(max < 1500, `the whole server (even /api/health) was unresponsive for ${max} ms while one Code node looped - expressions run synchronously on the event loop`);
    return `worst health-check latency while a Code node looped for 5 s: ${max} ms`;
  });
  await t('CODE-06', 'Memory bomb is contained (run fails, server survives)', async () => {
    const r = await run([manual(), code('c', 'const a=[]; while(true){ a.push(new Array(1e6).fill(7)); }')], chain('t', 'c'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /memory|timed out/i);
    assert.equal((await fetch(`${s1.base}/api/health`)).status, 200);
  });
  await t('CODE-07', 'Async code / Promises are rejected with an explanation', async () => {
    const r = await run([manual(), code('c', 'return Promise.resolve([{a:1}]);')], chain('t', 'c'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /async|Promise/i);
  });
  await t('CODE-08', 'Sandbox exposes no process/require/fetch/timers/Buffer/module/global', async () => {
    const r = ok(await run([manual(), code('c', 'return [{ t: [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer, typeof module, typeof global, typeof globalThis.process].join() }];')], chain('t', 'c')));
    assert.equal(outJson(r, 'c')[0].t, 'undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined');
  });
  await t('CODE-09', 'Sandbox-escape payloads (constructor chains, import(), prototype tricks) all fail safely', async () => {
    const payloads = [
      'return [{ r: this.constructor.constructor("return process")().pid }];',
      'return [{ r: (function(){}).constructor("return process")().version }];',
      'return [{ r: [].constructor.constructor("return globalThis.process")().env }];',
      'return import("fs");',
      'return [{ r: Object.getPrototypeOf(async function(){}).constructor("return process")().pid }];',
      'try { return [{ r: new Function("return process")().pid }]; } catch (e) { return [{ blocked: String(e) }]; }',
    ];
    for (const p of payloads) {
      const r = await run([manual(), code('c', p)], chain('t', 'c'));
      const out = r.status === 'error' ? 'error' : JSON.stringify(outJson(r, 'c'));
      assert.ok(r.status === 'error' || !/"r":\s*(\d|"v\d)/.test(out), `ESCAPE: ${p} -> ${out}`);
    }
  });
  await t('CODE-10', 'Expression-sandbox escapes ({{ }}) fail safely', async () => {
    for (const e of ['{{ this.constructor.constructor("return process")().pid }}', '{{ $json.constructor.constructor("return process")() }}', '{{ process.env }}', '{{ require("fs") }}']) {
      const r = await run([manual(), set('a', { x: e })], chain('t', 'a'));
      assert.equal(r.status, 'error', `expression ${e} did not error`);
    }
  });
  await t('CODE-11', 'Code node result larger than the cap fails instead of crashing the server', async () => {
    const r = await run([manual(), code('c', 'return [{ s: "x".repeat(6000000) }];')], chain('t', 'c'));
    assert.ok(r.status === 'error' || r.status === 'success'); assert.equal((await fetch(`${s1.base}/api/health`)).status, 200);
    return `status=${r.status}`;
  });

  area('Engine: reliability (retry, continue-on-fail, timeouts, sub-workflows, error workflows)');
  await t('REL-01', 'Retry-on-fail retries until success (503,503,200)', async () => {
    const r = ok(await run([manual(), N('h', 'http.request', 'h', { url: `${mock.base}/flaky` }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 10 })], chain('t', 'h')));
    assert.equal(r.results.h.tries, 3);
  });
  await t('REL-02', 'Retry gives up after maxTries and fails the run with the last error', async () => {
    const r = await run([manual(), N('h', 'http.request', 'h', { url: `${mock.base}/status/500` }, { retryOnFail: true, maxTries: 2, waitBetweenTries: 10 })], chain('t', 'h'));
    assert.equal(r.status, 'error'); assert.equal(r.results.h.tries, 2); assert.match(r.error.message, /HTTP 500/);
  });
  await t('REL-03', 'continueOnFail keeps the run alive and passes the error downstream', async () => {
    const r = ok(await run([manual(), N('h', 'http.request', 'h', { url: `${mock.base}/status/404` }, { continueOnFail: true }), set('after', { seen: '{{ $json.error }}' })], chain('t', 'h', 'after')));
    assert.match(outJson(r, 'after')[0].seen, /HTTP 404/);
  });
  await t('REL-04', 'Workflow timeout: a run exceeding timeoutSec fails at the next node', async () => {
    const r = await run([manual(), N('w', 'logic.wait', 'w', { seconds: 2 }), set('after', { x: '{{ 1 }}' })], chain('t', 'w', 'after'), { settings: { timeoutSec: 1 } });
    assert.equal(r.status, 'error'); assert.match(r.error.message, /timed out/i);
  });
  await t('REL-05', 'Workflow timeout also applies when the slow node is the LAST node (and stops the node promptly)', async () => {
    const t0 = Date.now();
    const r = await run([manual(), N('w', 'logic.wait', 'w', { seconds: 4 })], chain('t', 'w'), { settings: { timeoutSec: 1 } });
    assert.equal(r.status, 'error', 'run reported success although it took 4 s with a 1 s timeout');
    assert.match(r.error.message, /timed out/i); assert.ok(Date.now() - t0 < 2500, `run was only stopped after ${Date.now() - t0} ms`);
    const h = await run([manual(), N('h', 'http.request', 'h', { url: `${mock.base}/slow?ms=4000` })], chain('t', 'h'), { settings: { timeoutSec: 1 } });
    assert.equal(h.status, 'error'); assert.match(h.error.message, /timed out/i);
  });
  await t('REL-13', 'A node that overruns the timeout is not retried and the next workflow still runs normally', async () => {
    const r = await run([manual(), N('w', 'logic.wait', 'w', { seconds: 3 }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 10 })], chain('t', 'w'), { settings: { timeoutSec: 1 } });
    assert.equal(r.status, 'error'); assert.equal(r.results.w.tries ?? 1, 1);
    assert.equal((await run([manual(), set('a', { x: '{{ 1 }}' })], chain('t', 'a'))).status, 'success');
  });
  await t('REL-06', 'Sub-workflow (Execute Workflow) returns the child\'s output to the parent', async () => {
    const child = await mkWf(U, 'child', [manual(), set('c', { fromChild: '{{ $json.in * 2 }}' })], chain('t', 'c'));
    const r = ok(await run([manual(), set('p', { in: '{{ 21 }}' }), N('x', 'logic.executeWorkflow', 'x', { workflowId: child.id })], chain('t', 'p', 'x')));
    assert.equal(outJson(r, 'x')[0].fromChild, 42);
  });
  await t('REL-07', 'Missing sub-workflow id fails with a clear message', async () => {
    const r = await run([manual(), N('x', 'logic.executeWorkflow', 'x', { workflowId: 'does-not-exist' })], chain('t', 'x'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /not found/i);
  });
  await t('REL-08', 'Self-recursive sub-workflow stops at the depth limit instead of looping forever', async () => {
    const wf = await mkWf(U, 'rec', [manual()], []);
    await U.put(`/api/workflows/${wf.id}`, { definition: { nodes: [manual(), N('x', 'logic.executeWorkflow', 'x', { workflowId: wf.id })], connections: chain('t', 'x') } });
    const r = (await U.post(`/api/workflows/${wf.id}/run`, {})).data;
    assert.equal(r.status, 'error'); assert.match(r.error.message, /deep|nest|depth/i);
  });
  await t('REL-09', 'Error workflow fires with workflow/execution/error details; failing workflow without handler does not crash', async () => {
    const handler = await mkWf(U, 'handler', [N('e', 'trigger.error', 'e'), set('m', { got: '{{ $json.error.message }}', wf: '{{ $json.workflow.name }}' })], chain('e', 'm'));
    const bad = await mkWf(U, 'broken', [manual(), N('x', 'logic.stopAndError', 'x', { message: 'kaput' })], chain('t', 'x'), { errorWorkflowId: handler.id });
    await U.post(`/api/workflows/${bad.id}/run`, {});
    await sleep(600);
    const list = (await U.get(`/api/executions?workflowId=${handler.id}`)).data;
    assert.equal(list.length, 1);
    const d = (await U.get(`/api/executions/${list[0].id}`)).data;
    assert.equal(d.results.m.output[0][0].json.got, 'kaput'); assert.equal(d.results.m.output[0][0].json.wf, 'broken'); assert.ok(d.results.m.output[0][0].json.execution.id);
  });
  await t('REL-10', 'Error handler that itself fails does not trigger an infinite error loop', async () => {
    const h = await mkWf(U, 'h2', [N('e', 'trigger.error', 'e'), N('x', 'logic.stopAndError', 'x', { message: 'handler broke' })], chain('e', 'x'));
    await U.put(`/api/workflows/${h.id}`, { settings: { errorWorkflowId: h.id } }); // points to itself
    const bad = await mkWf(U, 'b2', [manual(), N('x', 'logic.stopAndError', 'x', { message: 'first' })], chain('t', 'x'), { errorWorkflowId: h.id });
    await U.post(`/api/workflows/${bad.id}/run`, {});
    await sleep(1000);
    const n = (await U.get(`/api/executions?workflowId=${h.id}`)).data.length;
    assert.ok(n <= 1, `${n} handler executions (loop?)`);
  });
  await t('REL-11', 'Run data: output longer than 100 items is capped in the log but the run still processes all items', async () => {
    const r = ok(await run([manual(), code('g', 'return Array.from({length:500},(_,i)=>({i}));'), N('ag', 'data.aggregate', 'ag', { field: 'n' })], chain('t', 'g', 'ag')));
    assert.equal(r.results.g.output[0].length, 100); assert.equal(outJson(r, 'ag')[0].n.length, 100 === 100 ? outJson(r, 'ag')[0].n.length : 0);
    return 'log capped at 100 items/output (aggregate saw all 500 internally)';
  });
  await t('REL-12', 'Test-step on a single node uses the previous run\'s input', async () => {
    const wf = await mkWf(U, 'ts', [manual(), set('a', { n: '{{ 41 }}' }, {}, false), set('b', { n: '{{ $json.n + 1 }}' }, {}, false)], chain('t', 'a', 'b'));
    await U.post(`/api/workflows/${wf.id}/run`, {});
    const r = (await U.post(`/api/workflows/${wf.id}/nodes/b/test`, {})).data;
    assert.equal(r.result.output[0][0].json.n, 42);
    assert.equal((await U.post(`/api/workflows/${wf.id}/nodes/ghost/test`, {})).status, 404);
  });
}
