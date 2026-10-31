// Safety checks for the sandbox after the speed work: node server/test/bench/sandbox-safety.mjs
import { Sandbox, drainSandboxPool, sandboxMode } from '../../src/sandbox.js';
import { createNodeEvaluator } from '../../src/expressions.js';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  (${extra})` : ''}`); if (!ok) failed += 1; };
const makeEval = (items, nodes = {}) => {
  const sandbox = new Sandbox();
  const ev = createNodeEvaluator({
    baseFn: (i) => ({ $json: items[i], $itemIndex: i, $workflow: { id: 'w', name: 'W' }, $now: '2026-01-01T00:00:00.000Z' }),
    extraFn: () => ({ $node: nodes, $input: { all: items } }),
    sandbox,
  });
  return { ev, sandbox, done: () => { ev.release(); sandbox.dispose(); } };
};
const items = [{ v: 1, list: [3, 1, 2], s: 'abc' }, { v: 2, list: [9, 8], s: 'xyz' }, { v: 3, list: [], s: '' }];
console.log(`sandbox mode: ${sandboxMode()}`);

// 1. results are what JavaScript gives
{
  const { ev, done } = makeEval(items);
  check('arithmetic', (await ev.resolve('{{ $json.v * 2 + 1 }}', 1)) === 5);
  check('method call', (await ev.resolve('{{ $json.s.toUpperCase() }}', 0)) === 'ABC');
  check('ternary + text around it', (await ev.resolve('n={{ $json.v > 1 ? "big" : "small" }}!', 0)) === 'n=small!');
  check('plain lookup (no sandbox)', (await ev.resolve('{{ $json.list[1] }}', 0)) === 1);
  check('lookup of a missing field is undefined', (await ev.resolve('{{ $json.nope }}', 0)) === undefined);
  check('error text for a lookup through nothing', await ev.resolve('{{ $json.nope.deeper }}', 0).then(() => false, (e) => /Cannot read properties of undefined/.test(e.message)));
  check('whole object comes back as a copy', JSON.stringify(await ev.resolve('{{ $json }}', 2)) === JSON.stringify(items[2]));
  const copy = await ev.resolve('{{ $json.list }}', 0); copy.push(99);
  check('changing a returned lookup does not change the item', items[0].list.length === 3);
  done();
}

// 2. one item cannot see or change another item's data
{
  const { ev, done } = makeEval(items);
  await ev.resolve('{{ $json.v = 100 }}', 0); // an expression that writes to $json
  check('item 1 is untouched by item 0 changing $json', (await ev.resolve('{{ $json.v + 0 }}', 1)) === 2);
  await ev.resolve('{{ $json.list.reverse() }}', 0);
  check('in-place changes to $json do not leak into the next item', JSON.stringify(await ev.resolve('{{ $json.list.join() }}', 1)) === '"9,8"');
  done();
}

// 3. shared data ($node, $input) is fresh for every item even if an expression mutates it
{
  const nodes = { Fetch: { json: { list: [1, 2, 3], n: 7 }, items: [{ list: [1, 2, 3] }] } };
  const { ev, done } = makeEval(items, nodes);
  const first = await ev.resolve('{{ $node["Fetch"].json.list.reverse()[0] }}', 0);
  const second = await ev.resolve('{{ $node["Fetch"].json.list.reverse()[0] }}', 1);
  check('$node data is not changed for the next item (reverse() twice gives the same answer)', first === 3 && second === 3, `${first}, ${second}`);
  check('$node lookup without sandbox', (await ev.resolve('{{ $node["Fetch"].json.n }}', 0)) === 7);
  check('$input.all() works', (await ev.resolve('{{ $input.all().length }}', 0)) === 3);
  check('$input.first() works', (await ev.resolve('{{ $input.first().json.s }}', 2)) === 'abc');
  check('$input.item is the current item', (await ev.resolve('{{ $input.item.json.s }}', 1)) === 'xyz');
  done();
}

// 4. an infinite loop is stopped, the run carries on, and the damaged isolate is not reused
if (sandboxMode() === 'isolated-vm') {
  drainSandboxPool();
  const { ev, sandbox, done } = makeEval(items);
  const t0 = Date.now();
  const r = await ev.resolve('{{ (function () { while (true) {} })() }}', 0).then(() => 'no error', (e) => e.message);
  const ms = Date.now() - t0;
  check('infinite loop is stopped with a clear message', /timed out/.test(r), r);
  check('...within about a second', ms < 2500, `${ms} ms`);
  check('...and the next item still works', (await ev.resolve('{{ $json.v * 10 }}', 1)) === 20);
  done();
  const again = makeEval(items);
  check('a new node run gets a healthy isolate after a timeout', (await again.ev.resolve('{{ $json.v + 1 }}', 0)) === 2);
  again.done();
  void sandbox;

  // 5. a memory bomb is contained
  const bomb = makeEval(items);
  const m = await bomb.ev.resolve('{{ (function () { const a = []; while (true) a.push(new Array(1e6).fill("x".repeat(100))); })() }}', 0).then(() => 'no error', (e) => e.message);
  check('a memory bomb is stopped', /memory|timed out/.test(m), m);
  bomb.done();
  const after = makeEval(items);
  check('and the server keeps working afterwards', (await after.ev.resolve('{{ $json.v * 3 }}', 2)) === 9);
  after.done();

  // 6. host objects are not reachable
  const host = makeEval(items);
  const probes = ['typeof process', 'typeof require', 'typeof globalThis.constructor.constructor', 'typeof Buffer', 'typeof fetch'];
  for (const p of probes) {
    const v = await host.ev.resolve(`{{ ${p} }}`, 0);
    check(`${p} is "undefined" or a plain sandbox function`, v === 'undefined' || (p.includes('constructor') && v === 'function'), String(v));
  }
  const esc = await host.ev.resolve('{{ (function(){ try { return this.constructor.constructor("return process")() } catch (e) { return "blocked" } })() }}', 0).then((x) => x, (e) => e.message);
  check('cannot reach the host process through constructors', esc === 'blocked' || esc === undefined || /not defined|undefined/.test(String(esc)), String(esc).slice(0, 60));
  host.done();
}

// 7. many items with the SAME expression compile once and stay correct
{
  const big = Array.from({ length: 5000 }, (_, i) => ({ v: i }));
  const { ev, done } = makeEval(big);
  let ok = true; const t0 = Date.now();
  for (let i = 0; i < big.length; i += 1) if ((await ev.resolve('{{ $json.v * 2 }}', i)) !== i * 2) { ok = false; break; }
  check('5,000 items, JavaScript expression, all correct', ok, `${Date.now() - t0} ms`);
  done();
}

drainSandboxPool();
console.log(failed ? `\n${failed} FAILED` : '\nall sandbox safety checks pass');
process.exit(failed ? 1 : 0);
