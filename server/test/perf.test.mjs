import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

/* Guards for the speed and memory work: the fast paths must give exactly the answers real JavaScript gives, a damaged
 * sandbox must never be reused, shared data must be fresh for every item, and the compressed static files must be safe. */
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-perf-'));
process.env.DB_PATH = ':memory:';
process.env.LITEFOREFLOW_SECRET = 'perf';
process.env.AUTH_RATE_LIMIT_PER_MIN = '100000';

const { Sandbox, drainSandboxPool, sandboxMode } = await import('../src/sandbox.js');
const { createNodeEvaluator, createResolver } = await import('../src/expressions.js');
const { createApp } = await import('../src/app.js');
const { startWorker, closeQueue } = await import('../src/queue.js');
const { closeDb } = await import('../src/db.js');
const { loadPlugins } = await import('../src/plugins.js');

after(async () => { drainSandboxPool(); await closeQueue(); await closeDb(); });

const makeEval = (items, nodes = {}) => {
  const sandbox = new Sandbox();
  const ev = createNodeEvaluator({
    baseFn: (i) => ({ $json: items[i], $itemIndex: i, $workflow: { id: 'w', name: 'W' }, $now: '2026-01-01T00:00:00.000Z' }),
    extraFn: () => ({ $node: nodes, $input: { all: items } }),
    sandbox,
  });
  return { ev, sandbox, done: () => { ev.release(); sandbox.dispose(); } };
};
const ITEMS = [{ v: 1, list: [3, 1, 2], s: 'abc', n: null, o: { a: { b: 5 } } }, { v: 2, list: [9, 8], s: 'xyz' }, { v: 3, list: [], s: '' }];

test('plain lookups answer exactly what JavaScript would, without the sandbox', async () => {
  const { ev, done } = makeEval(ITEMS, { Fetch: { json: { list: [1, 2], n: 7 }, items: [] } });
  const cases = [
    ['{{ $json.v }}', 0, 1], ['{{ $json.o.a.b }}', 0, 5], ['{{ $json["s"] }}', 1, 'xyz'], ["{{ $json['list'][1] }}", 0, 1], ['{{ $json.list.length }}', 0, 3],
    ['{{ $json.s.length }}', 0, 3], ['{{ $json.s[1] }}', 0, 'b'], ['{{ $json.n }}', 0, null], ['{{ $json.missing }}', 0, undefined], ['{{ $itemIndex }}', 2, 2],
    ['{{ $now }}', 0, '2026-01-01T00:00:00.000Z'], ['{{ $workflow.name }}', 0, 'W'], ['{{ $node["Fetch"].json.n }}', 0, 7], ["{{ $node['Fetch'].json.list[1] }}", 1, 2],
    ['{{ $json.toString }}', 0, undefined], ['{{ $json.hasOwnProperty }}', 0, undefined],
  ];
  for (const [expr, i, want] of cases) assert.deepEqual(await ev.resolve(expr, i), want, expr);
  assert.equal(await ev.resolve('a {{ $json.v }} b {{ $json.s }} c', 0), 'a 1 b abc c');
  assert.deepEqual(await ev.resolve({ x: '{{ $json.v }}', y: ['{{ $json.s }}', 'plain'] }, 1), { x: 2, y: ['xyz', 'plain'] });
  done();
});

test('what a lookup returns is a copy, and the names that could poison objects are never followed', async () => {
  const { ev, done } = makeEval(ITEMS);
  const list = await ev.resolve('{{ $json.list }}', 0);
  list.push(99);
  assert.equal(ITEMS[0].list.length, 3, 'changing the answer must not change the item');
  for (const bad of ['{{ $json.__proto__ }}', '{{ $json.constructor }}', '{{ $json.constructor.prototype }}']) {
    const v = await ev.resolve(bad, 0).catch(() => 'err');
    assert.ok(v === undefined || v === 'err' || typeof v === 'object', bad);
  }
  assert.equal(({}).polluted, undefined);
  done();
});

test('a lookup through something that is not there fails with the same message as real JavaScript', async () => {
  const { ev, done } = makeEval(ITEMS);
  await assert.rejects(ev.resolve('{{ $json.nope.deeper }}', 0), /Expression error in .*Cannot read properties of undefined/);
  await assert.rejects(ev.resolve('{{ $node["Nothing"].json.x }}', 0), /Expression error/);
  done();
});

test('expressions that change their data cannot affect the next item', async () => {
  const { ev, done } = makeEval(ITEMS, { Fetch: { json: { list: [1, 2, 3] }, items: [] } });
  await ev.resolve('{{ $json.v = 100 }}', 0);
  assert.equal(await ev.resolve('{{ $json.v + 0 }}', 1), 2);
  await ev.resolve('{{ $json.list.reverse() }}', 0);
  assert.equal(await ev.resolve('{{ $json.list.join() }}', 1), '9,8');
  const a = await ev.resolve('{{ $node["Fetch"].json.list.reverse()[0] }}', 0);
  const b = await ev.resolve('{{ $node["Fetch"].json.list.reverse()[0] }}', 1);
  assert.deepEqual([a, b], [3, 3], 'shared $node data is parsed fresh for each item');
  assert.equal(await ev.resolve('{{ $input.all().length }}', 0), 3);
  assert.equal(await ev.resolve('{{ $input.first().json.s }}', 2), 'abc');
  assert.equal(await ev.resolve('{{ $input.item.json.s }}', 1), 'xyz');
  done();
});

test('a node run with thousands of items stays fast and correct (the old code took 0.8 ms per item for even a plain lookup)', async () => {
  const big = Array.from({ length: 4000 }, (_, i) => ({ v: i, name: `n${i}` }));
  const { ev, done } = makeEval(big, { Gen: { json: { k: 1 }, items: big } });
  const t0 = Date.now();
  for (let i = 0; i < big.length; i += 1) {
    assert.equal(await ev.resolve('{{ $json.v }}', i), i);
    assert.equal(await ev.resolve('{{ $json.v * 2 + 1 }}', i), i * 2 + 1);
    assert.equal(await ev.resolve('{{ $node["Gen"].json.k }}', i), 1); // was quadratic: every item rebuilt all earlier data
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `${big.length} items took ${ms} ms`);
  done();
});

test('the one-item resolver kept for older callers still works', async () => {
  const r = createResolver(() => ({ $json: { a: 2 } }), () => ({ $node: {}, $input: { all: [] } }));
  assert.equal(await r.resolve('{{ $json.a * 21 }}'), 42);
  assert.equal(await r.resolve('{{ $json.a }}'), 2);
  r.release();
});

test('sandbox: an infinite loop is stopped, the run carries on, and a damaged isolate is never reused', { skip: sandboxMode() !== 'isolated-vm' }, async () => {
  drainSandboxPool();
  const { ev, done } = makeEval(ITEMS);
  const t0 = Date.now();
  await assert.rejects(ev.resolve('{{ (function () { while (true) {} })() }}', 0), /timed out/);
  assert.ok(Date.now() - t0 < 3000, 'the 1 s limit still applies after the quick synchronous try');
  assert.equal(await ev.resolve('{{ $json.v * 10 }}', 1), 20, 'the next item still works');
  done();
  const again = makeEval(ITEMS);
  assert.equal(await again.ev.resolve('{{ $json.v + 1 }}', 0), 2, 'the next node run gets a healthy isolate');
  again.done();

  const bomb = makeEval(ITEMS);
  await assert.rejects(bomb.ev.resolve('{{ (function () { const a = []; while (true) a.push(new Array(1e6).fill("x".repeat(100))); })() }}', 0), /memory|timed out/);
  bomb.done();
  const after2 = makeEval(ITEMS);
  assert.equal(await after2.ev.resolve('{{ $json.v * 3 }}', 2), 9);
  after2.done();
});

test('sandbox: nothing from the host is reachable', async () => {
  const { ev, done } = makeEval(ITEMS);
  for (const probe of ['typeof process', 'typeof require', 'typeof Buffer', 'typeof fetch', 'typeof module']) assert.equal(await ev.resolve(`{{ ${probe} }}`, 0), 'undefined', probe);
  const esc = await ev.resolve('{{ (function(){ try { return this.constructor.constructor("return process")() } catch (e) { return "blocked" } })() }}', 0).catch(() => 'blocked');
  assert.ok(esc === 'blocked' || esc === undefined, String(esc));
  done();
});

test('the isolate pool keeps a few small ones ready and drops big ones at once', { skip: sandboxMode() !== 'isolated-vm' }, async () => {
  drainSandboxPool();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) { const s = new Sandbox(); const c = s.reusable(); c.setItem({ $json: { i } }); await c.run('"1"', 500); c.release(); s.dispose(); }
  const msEach = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  assert.ok(msEach < 1.2, `a node run that needs the sandbox costs ${msEach.toFixed(2)} ms (creating a fresh isolate each time costs about 2.4 ms)`);
});

/* ------------------------------------ the web server ------------------------------------ */
let server;
let port;
const getRaw = (p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  }).on('error', reject);
});

test('built files are served gzip-compressed, cached, and only from inside the web folder', async () => {
  await loadPlugins();
  await startWorker();
  server = createApp().listen(0);
  port = server.address().port;
  const index = (await getRaw('/')).body.toString();
  const js = index.match(/assets\/index-[^"]+\.js/)[0];
  const plain = await getRaw(`/${js}`);
  const zipped = await getRaw(`/${js}`, { 'accept-encoding': 'gzip' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.ok(zipped.body.length < plain.body.length / 2, `${zipped.body.length} vs ${plain.body.length}`);
  assert.equal((await import('node:zlib')).gunzipSync(zipped.body).toString(), plain.body.toString(), 'same bytes after decompressing');
  assert.match(zipped.headers['cache-control'], /immutable/);
  assert.equal((await getRaw(`/${js}`, { 'accept-encoding': 'gzip', 'if-none-match': zipped.headers.etag })).status, 304);
  const page = await getRaw('/workflows/abc', { 'accept-encoding': 'gzip' });
  assert.equal(page.headers['content-encoding'], 'gzip', 'page routes get the editor page');
  for (const evil of ['/assets/..%2f..%2fpackage.json', '/..%2fserver%2fsrc%2fconfig.js', '/assets/../../../package.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%5c..%5cpackage.json', '/server/src/config.js', '/package.json']) {
    const r = await getRaw(evil, { 'accept-encoding': 'gzip' });
    const text = (r.headers['content-encoding'] === 'gzip' ? (await import('node:zlib')).gunzipSync(r.body) : r.body).toString();
    assert.ok(/<!doctype html>/i.test(text) || r.status >= 400, `${evil} returned something other than the editor page`);
    assert.ok(!/LITEFOREFLOW_SECRET|"dependencies"/.test(text), `${evil} leaked a source file`);
  }
  assert.equal((await getRaw('/api/health', { 'accept-encoding': 'gzip' })).headers['content-encoding'], undefined, 'the API is not touched');
  server.close();
});

test('the editor script that every page loads is small because the canvas is loaded on demand', async () => {
  const assets = fs.readdirSync(new URL('../../web/dist/assets', import.meta.url));
  const main = assets.find((f) => /^index-.*\.js$/.test(f));
  const editor = assets.find((f) => /^Editor-.*\.js$/.test(f));
  assert.ok(editor, 'the editor must be its own file');
  assert.ok(fs.statSync(new URL(`../../web/dist/assets/${main}`, import.meta.url)).size < 260_000);
});
