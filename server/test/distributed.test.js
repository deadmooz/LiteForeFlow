import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/*
 * Proves the production topology: the API process only enqueues, separate worker PROCESSES execute.
 * Needs real infrastructure:  TEST_DATABASE_URL=postgres://...  TEST_REDIS_URL=redis://...
 */
const enabled = process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL;
const RUN_ID = crypto.randomBytes(4).toString('hex');
const SCHEMA = `ff_dist_${RUN_ID}`;
const ENV = {
  DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-dist-')),
  LITEFOREFLOW_SECRET: 'dist-secret',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  PG_SCHEMA: SCHEMA,
  REDIS_URL: process.env.TEST_REDIS_URL ?? '',
  QUEUE_NAME: `ff-dist-${RUN_ID}`,
  WORKER_LOCK_MS: '3000',
  WORKER_STALLED_INTERVAL_MS: '1000',
  MAX_CONCURRENCY: '4',
};

let server;
let base;
let closeQueue;
let closeDb;
let token;
const children = [];

function spawnWorker() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/worker.js', import.meta.url))], { env: { ...process.env, ...ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
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
  ({ closeQueue } = queue);
  ({ closeDb } = await import('../src/db.js'));
  await queue.startEvents(); // API role: deliberately NO worker in this process
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  for (const c of children) { c.removeAllListeners('exit'); c.kill('SIGKILL'); }
  if (!enabled) return;
  server.close();
  await closeQueue();
  await closeDb();
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await c.end();
});

async function api(method, url, { body } = {}) {
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
const postJson = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 200) {
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
async function mkWorkflow(name, nodes, connections) {
  const r = await api('POST', '/api/workflows', { body: { name, definition: { nodes, connections } } });
  assert.equal(r.status, 201);
  return r.data;
}
const execution = async (id) => (await api('GET', `/api/executions/${id}`)).data;

test('API only enqueues; executions run in a separate worker process', { skip: !enabled, timeout: 90000 }, async () => {
  token = (await api('POST', '/api/auth/signup', { body: { email: `dist-${RUN_ID}@example.com`, password: 'password123' } })).data.token;

  const hook = await mkWorkflow('echo', [
    node('t', 'trigger.webhook', 'Hook', { path: `dist-${RUN_ID}`, method: 'POST', respond: 'immediately' }),
    node('s', 'data.set', 'Set', { fields: [{ name: 'doubled', value: '{{ $json.body.n * 2 }}' }], keepOthers: false }),
  ], [edge('t', 's')]);
  assert.equal((await api('POST', `/api/workflows/${hook.id}/activate`)).status, 200);

  // With no worker running, an accepted event just waits durably in the queue.
  const queued = await (await postJson(`/webhook/dist-${RUN_ID}`, { n: 21 })).json();
  await sleep(1500);
  assert.equal((await execution(queued.executionId)).status, 'queued', 'nothing may execute until a worker exists');

  // A worker process comes up and drains the backlog.
  const workerA = await spawnWorker();
  const ex = await until(async () => { const e = await execution(queued.executionId); return e.status === 'success' ? e : null; });
  assert.equal(ex.results.s.output[0][0].json.doubled, 42);
  assert.ok(ex.worker.endsWith(`:${workerA.pid}`), `ran on worker pid ${workerA.pid}, got ${ex.worker}`);
  assert.notEqual(ex.worker.split(':').pop(), String(process.pid));

  // Synchronous paths cross the process boundary too: editor run, respond-with-last-node webhook, step test.
  const run = await api('POST', `/api/workflows/${hook.id}/run`);
  assert.equal(run.data.status, 'success');
  const sync = await mkWorkflow('sync', [
    node('t', 'trigger.webhook', 'Hook', { path: `dist-sync-${RUN_ID}`, method: 'POST', respond: 'lastNode' }),
    node('c', 'data.code', 'Code', { mode: 'runOnce', code: 'return [{ sum: items[0].body.a + items[0].body.b }];' }),
  ], [edge('t', 'c')]);
  await api('POST', `/api/workflows/${sync.id}/activate`);
  assert.deepEqual(await (await postJson(`/webhook/dist-sync-${RUN_ID}`, { a: 2, b: 40 })).json(), { sum: 42 });
  const t = await api('POST', `/api/workflows/${sync.id}/nodes/c/test`, { body: { input: [{ body: { a: 1, b: 1 } }] } });
  assert.equal(t.data.result.output[0][0].json.sum, 2);
});

test('cron schedules are durable BullMQ jobs fired on workers', { skip: !enabled, timeout: 60000 }, async () => {
  const wf = await mkWorkflow('ticker', [
    node('t', 'trigger.cron', 'Every 2s', { cron: '*/2 * * * * *', timezone: 'UTC' }),
    node('s', 'data.set', 'Stamp', { fields: [{ name: 'seen', value: '{{ $json.timestamp }}' }], keepOthers: false }),
  ], [edge('t', 's')]);
  assert.equal((await api('POST', `/api/workflows/${wf.id}/activate`)).status, 200);
  const runs = await until(async () => {
    const l = (await api('GET', `/api/executions?workflowId=${wf.id}`)).data;
    return l.filter((e) => e.status === 'success').length >= 2 ? l : null;
  }, 25000);
  assert.ok(runs.every((e) => e.mode === 'trigger'));

  await api('POST', `/api/workflows/${wf.id}/deactivate`);
  await sleep(2500); // let anything already in flight finish
  const count = async () => (await api('GET', `/api/executions?workflowId=${wf.id}`)).data.length;
  const before = await count();
  await sleep(4500);
  assert.equal(await count(), before, 'deactivating removes the schedule from Redis');
});

test('a crashed worker never silently loses or re-runs an execution', { skip: !enabled, timeout: 90000 }, async () => {
  const slow = await mkWorkflow('slow', [
    node('t', 'trigger.webhook', 'Hook', { path: `dist-slow-${RUN_ID}`, method: 'POST', respond: 'immediately' }),
    node('w', 'logic.wait', 'Wait', { seconds: 120 }),
  ], [edge('t', 'w')]);
  await api('POST', `/api/workflows/${slow.id}/activate`);
  const { executionId } = await (await postJson(`/webhook/dist-slow-${RUN_ID}`, {})).json();

  await until(async () => (await execution(executionId)).status === 'running');
  const victim = children.find((c) => c.exitCode === null && !c.killed);
  victim.removeAllListeners('exit');
  victim.kill('SIGKILL'); // simulates an OOM-kill or node failure mid-run
  await sleep(300);

  await spawnWorker(); // a replacement worker notices the stalled job
  const ex = await until(async () => { const e = await execution(executionId); return e.status === 'error' ? e : null; }, 40000);
  assert.match(ex.error.message, /Worker failed|stalled/i);
  assert.equal((await api('GET', `/api/executions?workflowId=${slow.id}`)).data.length, 1, 'the run was not re-executed after the crash');
});
