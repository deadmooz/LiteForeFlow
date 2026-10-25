// End-to-end check against a RUNNING compose stack:  node server/test/e2e-compose.mjs [http://localhost:3000]
// Uses only the public HTTP API, so it validates the real containers (api + N workers + Postgres + Redis).
import assert from 'node:assert/strict';

const base = process.argv[2] ?? 'http://localhost:3000';
const run = Math.random().toString(36).slice(2, 8);
let token;

const call = async (method, url, body) => {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000) => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(300); }
};
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
const mk = async (name, nodes, connections) => (await call('POST', '/api/workflows', { name, definition: { nodes, connections } })).data;
const ok = (msg) => console.log(`  ✔ ${msg}`);

console.log(`E2E against ${base}`);
const health = await call('GET', '/api/health');
assert.deepEqual([health.data.db, health.data.queue], ['postgres', 'bullmq']);
ok(`health: db=${health.data.db} queue=${health.data.queue}`);

token = (await call('POST', '/api/auth/signup', { email: `e2e-${run}@example.com`, password: 'password123' })).data.token;
assert.ok(token);
ok('signup');

// 1. Editor run goes through the queue to a worker container.
const wf = await mk('e2e-math', [
  node('t', 'trigger.manual', 'Start'),
  node('c', 'data.code', 'Code', { mode: 'runOnce', code: 'return [{ answer: 6 * 7, sandbox: typeof process }];' }),
], [edge('t', 'c')]);
const r = await call('POST', `/api/workflows/${wf.id}/run`);
assert.equal(r.data.status, 'success');
assert.deepEqual(r.data.results.c.output[0][0].json, { answer: 42, sandbox: 'undefined' });
ok('editor run executed in an isolated-vm sandbox');

// 2. Webhook (respond with last node) and fan-out across both workers.
const hook = await mk('e2e-hook', [
  node('t', 'trigger.webhook', 'Hook', { path: `e2e-${run}`, method: 'POST', respond: 'lastNode' }),
  node('s', 'data.set', 'Set', { fields: [{ name: 'echo', value: '{{ $json.body.n }}' }], keepOthers: false }),
], [edge('t', 's')]);
assert.equal((await call('POST', `/api/workflows/${hook.id}/activate`)).status, 200);
const N = 40;
const replies = await Promise.all(Array.from({ length: N }, (_, i) =>
  fetch(`${base}/webhook/e2e-${run}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n: i }) }).then((x) => x.json())));
assert.deepEqual(replies.map((x) => x.echo).sort((a, b) => a - b), Array.from({ length: N }, (_, i) => i));
const list = (await call('GET', `/api/executions?workflowId=${hook.id}&limit=100`)).data;
const workers = new Set();
for (const e of list) workers.add((await call('GET', `/api/executions/${e.id}`)).data.worker);
assert.equal(list.length, N);
ok(`${N} concurrent webhooks answered correctly; executed by ${workers.size} worker container(s): ${[...workers].join(', ')}`);

// 3. Schedules fire exactly once per tick even though two workers + the API exist.
const tick = await mk('e2e-cron', [
  node('t', 'trigger.cron', 'Every 3s', { cron: '*/3 * * * * *', timezone: 'UTC' }),
  node('s', 'logic.noop', 'Noop'),
], [edge('t', 's')]);
assert.equal((await call('POST', `/api/workflows/${tick.id}/activate`)).status, 200);
await sleep(13000);
await call('POST', `/api/workflows/${tick.id}/deactivate`);
await sleep(2000);
const ticks = (await call('GET', `/api/executions?workflowId=${tick.id}&limit=100`)).data;
const stamps = ticks.map((t) => Math.floor(new Date(t.startedAt).getTime() / 3000));
assert.ok(ticks.length >= 3 && ticks.length <= 6, `expected ~4 ticks in 13s, got ${ticks.length}`);
assert.equal(new Set(stamps).size, stamps.length, 'no tick ran twice');
ok(`cron: ${ticks.length} ticks in 13s, none duplicated`);

// 4. Plan limits and usage metering across processes.
const usage = (await call('GET', '/api/usage')).data;
assert.ok(usage.runsThisMonth >= N + 1 + ticks.length);
ok(`usage metering: ${usage.runsThisMonth} runs counted this month`);

console.log('E2E OK');
