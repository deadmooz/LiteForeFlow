// End-to-end check of the Lite features against a RUNNING Docker stack (API + several workers):
//   docker compose up -d --build --scale worker=2
//   node server/test/e2e-docker-features.mjs [http://localhost:3000]
// Everything goes through the public HTTP API plus the ./plugins-user folder that the containers share.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:3000';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pluginDir = path.join(root, 'plugins-user', 'e2e-hello');
const run = Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let token;

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data, headers: res.headers };
};
const until = async (fn, ms = 30000, what = 'condition') => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(400); }
};
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
const hook = (p) => node('t', 'trigger.webhook', 'Hook', { path: p, method: 'POST', respond: 'lastNode' });
const fire = (p, n = 1) => Promise.all(Array.from({ length: n }, () => fetch(`${base}/webhook/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"hi"}' })));
const ok = (msg) => console.log(`  ✔ ${msg}`);
async function activate(name, nodes, connections) {
  const wf = (await call('POST', '/api/workflows', { name, definition: { nodes, connections } })).data;
  const a = await call('POST', `/api/workflows/${wf.id}/activate`, {});
  assert.equal(a.status, 200, JSON.stringify(a.data));
  return wf;
}

console.log(`Docker feature e2e against ${base}`);
const health = (await call('GET', '/api/health')).data;
assert.deepEqual([health.db, health.queue, health.sandbox], ['postgres', 'bullmq', 'isolated-vm']);
ok(`stack: db=${health.db} queue=${health.queue} sandbox=${health.sandbox}`);

const page = await fetch(base);
assert.match(await page.text(), /<div id="root">/);
assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
ok('editor is served with the security headers');

token = (await call('POST', '/api/auth/signup', { email: `e2e-${run}@example.com`, password: 'password123' })).data.token;
assert.ok(token);
ok('first account created (becomes the owner who may manage plugins)');

// 1) a bundled plugin node runs on every worker
const sortHook = `sort-${run}`;
await activate('sort', [hook(sortHook), node('g', 'data.code', 'Gen', { mode: 'runOnce', code: 'return [{n:3},{n:1},{n:2}];' }),
  node('s', 'tools.sort', 'Sort', { field: 'n', direction: 'asc', kind: 'number' })], [edge('t', 'g'), edge('g', 's')]);
const rs = await fire(sortHook, 30);
assert.ok(rs.every((r) => r.status === 200), `statuses ${[...new Set(rs.map((r) => r.status))]}`);
assert.deepEqual((await rs[0].json()).map((x) => x.n), [1, 2, 3]);
const execs = (await call('GET', '/api/executions?limit=100')).data;
const workers = new Set();
for (const e of execs) workers.add((await call('GET', `/api/executions/${e.id}`)).data.worker);
assert.ok(workers.size >= 2, `only ${workers.size} worker(s) ran the plugin node: ${[...workers]}`);
ok(`bundled plugin "Sort" ran 30 times on ${workers.size} different worker containers`);

// 2) switching a plugin off/on on the API reaches ALL workers
assert.equal((await call('POST', '/api/plugins/data-tools/disable')).status, 200);
await until(async () => (await fire(sortHook, 24)).every((r) => r.status === 500), 30000, 'every worker to stop the disabled plugin');
ok('plugin switched off on the Plugins page: all workers stopped using it');
assert.equal((await call('POST', '/api/plugins/data-tools/enable')).status, 200);
await until(async () => (await fire(sortHook, 24)).every((r) => r.status === 200), 30000, 'every worker to use the re-enabled plugin');
ok('plugin switched back on: all workers use it again');

// 3) a plugin folder added on the host (./plugins-user) is picked up by API and every worker
fs.rmSync(pluginDir, { recursive: true, force: true });
fs.mkdirSync(pluginDir, { recursive: true });
fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'e2e-hello', name: 'E2E Hello', version: '1.0.0', description: 'docker e2e' }));
fs.writeFileSync(path.join(pluginDir, 'index.js'), `export function register(sdk) {
  sdk.defineNode({ type: 'e2ehello.shout', name: 'Shout', group: 'data', icon: '📣', properties: [],
    async executeItem(ctx, item) { return { shout: String(item.json.body?.text ?? '').toUpperCase() }; } });
}\n`);
try {
  await until(async () => (await call('GET', '/api/node-types')).data.some((n) => n.type === 'e2ehello.shout'), 30000, 'the API to see the new plugin');
  const helloHook = `hello-${run}`;
  await activate('hello', [hook(helloHook), node('h', 'e2ehello.shout', 'Shout')], [edge('t', 'h')]);
  await until(async () => { const r = await fire(helloHook, 24); return r.every((x) => x.status === 200); }, 30000, 'every worker to load the new plugin');
  assert.deepEqual(await (await fire(helloHook, 1))[0].json(), { shout: 'HI' });
  ok('a plugin folder dropped into ./plugins-user is live on the API and all workers within seconds');
} finally {
  fs.rmSync(pluginDir, { recursive: true, force: true });
}

// 4) schedules (the Schedule picker saves a cron expression) fire exactly once per tick across API + workers
const tick = await activate('tick', [node('t', 'trigger.cron', 'Every 3s', { cron: '*/3 * * * * *', timezone: 'UTC' }), node('s', 'logic.noop', 'Noop')], [edge('t', 's')]);
await sleep(11500);
await call('POST', `/api/workflows/${tick.id}/deactivate`);
await sleep(1500);
const ticks = (await call('GET', `/api/executions?workflowId=${tick.id}&limit=100`)).data;
const slots = ticks.map((t) => Math.floor(new Date(t.startedAt).getTime() / 3000));
assert.ok(ticks.length >= 3 && ticks.length <= 5, `${ticks.length} ticks in 11.5 s`);
assert.equal(new Set(slots).size, slots.length, 'a tick ran twice');
ok(`schedule: ${ticks.length} ticks in 11.5 s, none duplicated`);

console.log('DOCKER FEATURES OK');
