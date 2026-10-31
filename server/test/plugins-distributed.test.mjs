import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Docker-edition parity: plugins must behave the same when the API and the workers are SEPARATE processes that share
 * one data folder. Switching a plugin on/off (or adding a plugin folder) on the API has to reach the worker that
 * actually runs the workflow.   Needs  TEST_DATABASE_URL=postgres://...  TEST_REDIS_URL=redis://...
 */
const enabled = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL;
const RUN_ID = crypto.randomBytes(4).toString('hex');
const SCHEMA = `ff_plug_${RUN_ID}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-plug-'));
const ENV = {
  DATA_DIR,
  LITEFOREFLOW_SECRET: 'plug-secret',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  PG_SCHEMA: SCHEMA,
  REDIS_URL: process.env.TEST_REDIS_URL ?? '',
  QUEUE_NAME: `ff-plug-${RUN_ID}`,
  MAX_CONCURRENCY: '4',
};

let server;
let base;
let token;
let stopWatch;
let closeQueue;
let closeDb;
let worker;

function spawnWorker() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/worker.js', import.meta.url))], { env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { out += d; if (out.includes('worker started')) resolve(child); });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`worker exited early (${code}): ${out}`)));
    setTimeout(() => reject(new Error(`worker did not start: ${out}`)), 20000).unref();
  });
}

before(async () => {
  if (!enabled) return;
  Object.assign(process.env, ENV);
  const { createApp } = await import('../src/app.js');
  const queue = await import('../src/queue.js');
  const plugins = await import('../src/plugins.js');
  ({ closeQueue } = queue);
  ({ closeDb } = await import('../src/db.js'));
  await plugins.loadPlugins();
  stopWatch = plugins.watchPlugins(500); // the API container does the same (see main.js)
  await queue.startEvents(); // API role: no worker in this process
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  worker = await spawnWorker();
});

after(async () => {
  if (worker) { worker.removeAllListeners('exit'); worker.kill('SIGKILL'); }
  if (!enabled) return;
  stopWatch?.();
  server.close();
  await closeQueue();
  await closeDb();
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await c.end();
});

async function api(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(step);
  }
}
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
const hook = (path) => node('t', 'trigger.webhook', 'Hook', { path, method: 'POST', respond: 'lastNode' });
const call = (path) => fetch(`${base}/webhook/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' });

async function activate(name, nodes, connections) {
  const wf = await api('POST', '/api/workflows', { name, definition: { nodes, connections } });
  assert.equal(wf.status, 201, JSON.stringify(wf.data));
  const act = await api('POST', `/api/workflows/${wf.data.id}/activate`, {});
  assert.equal(act.status, 200, JSON.stringify(act.data));
  return wf.data;
}

test('a bundled plugin runs on a separate worker process', { skip: !enabled, timeout: 60000 }, async () => {
  token = (await api('POST', '/api/auth/signup', { email: `plug-${RUN_ID}@example.com`, password: 'password123' })).data.token;
  const p = `plug-sort-${RUN_ID}`;
  await activate('sorted', [
    hook(p),
    node('g', 'data.code', 'Gen', { mode: 'runOnce', code: 'return [{n:3},{n:1},{n:2}];' }),
    node('s', 'tools.sort', 'Sort', { field: 'n', direction: 'asc', kind: 'number' }),
  ], [edge('t', 'g'), edge('g', 's')]);
  const r = await call(p);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).map?.((x) => x.n) ?? null, [1, 2, 3]);
});

test('switching a plugin off/on on the API reaches the worker', { skip: !enabled, timeout: 60000 }, async () => {
  const p = `plug-toggle-${RUN_ID}`;
  await activate('toggle', [
    hook(p),
    node('g', 'data.code', 'Gen', { mode: 'runOnce', code: 'return [{n:2},{n:1}];' }),
    node('s', 'tools.sort', 'Sort', { field: 'n', direction: 'asc', kind: 'number' }),
  ], [edge('t', 'g'), edge('g', 's')]);
  assert.equal((await call(p)).status, 200);

  assert.equal((await api('POST', '/api/plugins/data-tools/disable')).status, 200);
  const failed = await until(async () => { const r = await call(p); return r.status === 500 ? r : null; }, 15000);
  assert.equal(failed.status, 500, 'the worker kept running a plugin node that was switched off');

  assert.equal((await api('POST', '/api/plugins/data-tools/enable')).status, 200);
  await until(async () => (await call(p)).status === 200, 15000);
});

test('a plugin folder dropped into the shared data folder is picked up by API and worker', { skip: !enabled, timeout: 60000 }, async () => {
  const dir = path.join(DATA_DIR, 'plugins', 'hello-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ id: 'hello-x', name: 'Hello X', version: '1.0.0', description: 'test plugin' }));
  fs.writeFileSync(path.join(dir, 'index.js'), `export function register(sdk) {
  sdk.defineNode({ type: 'hellox.shout', name: 'Shout', group: 'data', icon: '📣', properties: [],
    async executeItem(ctx, item) { return { shout: String(item.json.body?.text ?? '').toUpperCase() }; } });
}\n`);
  // the API learns about it (so the editor can offer it and validation passes)...
  await until(async () => (await api('GET', '/api/node-types')).data.some((n) => n.type === 'hellox.shout'), 15000);
  // ...and so does the worker, which is the process that really executes it
  const p = `plug-hello-${RUN_ID}`;
  await activate('shout', [hook(p), node('h', 'hellox.shout', 'Shout')], [edge('t', 'h')]);
  const r = await until(async () => { const x = await call(p); return x.status === 200 ? x : null; }, 15000);
  assert.deepEqual(await r.json(), { shout: 'HI' });
});
