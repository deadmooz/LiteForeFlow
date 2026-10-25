import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const RUN_ID = crypto.randomBytes(4).toString('hex');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-'));
process.env.LITEFOREFLOW_SECRET = 'test-secret';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.AUTH_RATE_LIMIT_PER_MIN = '1000'; // this suite creates many accounts from one IP
// The same suite runs against the default stack (SQLite + in-process queue) or the production stack
// (Postgres + Redis/BullMQ) when TEST_DATABASE_URL / TEST_REDIS_URL are set.
const PG_SCHEMA = `ff_test_${RUN_ID}`;
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.PG_SCHEMA = PG_SCHEMA;
} else {
  process.env.DB_PATH = ':memory:';
}
if (process.env.TEST_REDIS_URL) {
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
  process.env.QUEUE_NAME = `ff-test-${RUN_ID}`;
}

const { createApp } = await import('../src/app.js');
const { startWorker, startEvents, closeQueue, queueMode } = await import('../src/queue.js');
const { closeDb, dialect } = await import('../src/db.js');
const { verifyStripeSignature } = await import('../src/routes/resources.js');
const { convertN8nWorkflow } = await import('../src/importer.js');

let server;
let base;
let mock;
let mockBase;
const seen = [];

before(async () => {
  console.log(`# stack under test: db=${dialect} queue=${queueMode}`);
  await startWorker();
  if (queueMode === 'bullmq') await startEvents();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  // A tiny fake "third party" used by the HTTP, LLM and agent tests.
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      seen.push({ url: req.url, auth: req.headers.authorization, body: json });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/people') return res.end(JSON.stringify([{ name: 'Ada', age: 36 }, { name: 'Linus', age: 17 }]));
      if (req.url === '/flaky') {
        const n = seen.filter((s) => s.url === '/flaky').length;
        if (n < 3) { res.statusCode = 503; return res.end('{"error":"try later"}'); }
        return res.end('{"ok":true}');
      }
      if (req.url === '/always-fails') { res.statusCode = 500; return res.end('{"error":"boom"}'); }
      if (req.url === '/v1/chat/completions') {
        const hasToolResult = json.messages.some((m) => m.role === 'tool');
        if (json.tools && !hasToolResult) {
          return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'calculator', arguments: '{"expression":"17*2450/100"}' } }] } }] }));
        }
        const last = json.messages.at(-1).content;
        return res.end(JSON.stringify({ model: 'mock', usage: { total_tokens: 5 }, choices: [{ message: { role: 'assistant', content: json.tools ? `The answer is ${last}` : '{"urgent": true, "summary": "down"}' } }] }));
      }
      return res.end('{}');
    });
  }).listen(0);
  mockBase = `http://localhost:${mock.address().port}`;
});

after(async () => {
  server.close();
  mock.close();
  await closeQueue();
  await closeDb();
  if (process.env.TEST_DATABASE_URL) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${PG_SCHEMA} CASCADE`);
    await c.end();
  }
});

async function api(method, url, { token, body, headers } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data };
}

let counter = 0;
async function newUser() {
  counter += 1;
  const r = await api('POST', '/api/auth/signup', { body: { email: `user${counter}@example.com`, password: 'password123', name: `User ${counter}` } });
  assert.equal(r.status, 201);
  return r.data.token;
}

const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to, fromOutput = 0, toInput = 0) => ({ from, to, fromOutput, toInput });

async function createWf(token, name, nodes, connections, settings) {
  const r = await api('POST', '/api/workflows', { token, body: { name, definition: { nodes, connections }, settings } });
  assert.equal(r.status, 201);
  return r.data;
}

test('auth: signup, login, bad password, protected routes', async () => {
  const token = await newUser();
  const dupAgain = await api('POST', '/api/auth/signup', { body: { email: `user${counter}@example.com`, password: 'password123' } });
  assert.equal(dupAgain.status, 409);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: `user${counter}@example.com`, password: 'wrong-password' } })).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { body: { email: `user${counter}@example.com`, password: 'password123' } })).status, 200);
  assert.equal((await api('GET', '/api/workflows')).status, 401);
  assert.equal((await api('GET', '/api/me', { token })).status, 200);
  assert.equal((await api('POST', '/api/auth/signup', { body: { email: 'x@y.com', password: 'short' } })).status, 400);
});

test('engine: set → code → IF routes items, expressions keep types and reach other nodes', async () => {
  const token = await newUser();
  const wf = await createWf(token, 'logic', [
    node('t', 'trigger.manual', 'Start'),
    node('h', 'http.request', 'People', { url: `${mockBase}/people` }),
    node('s', 'data.splitOut', 'Split', { field: 'data' }),
    node('c', 'data.set', 'Flag', { fields: [{ name: 'adult', value: '{{ $json.age >= 18 }}' }, { name: 'label', value: '{{ $json.name }} ({{ $json.age }})' }, { name: 'from', value: '{{ $node["People"].json.statusCode }}' }], keepOthers: true }),
    node('i', 'logic.if', 'Adult?', { conditions: [{ left: '{{ $json.adult }}', op: 'isTrue', right: '' }], combine: 'all' }),
    node('yes', 'data.code', 'Yes', { mode: 'runOnce', code: 'return [{ count: items.length, names: items.map(i => i.name) }];' }),
    node('no', 'data.set', 'No', { fields: [{ name: 'minor', value: 'true' }], keepOthers: true }),
  ], [edge('t', 'h'), edge('h', 's'), edge('s', 'c'), edge('c', 'i'), edge('i', 'yes', 0), edge('i', 'no', 1)]);

  const r = await api('POST', `/api/workflows/${wf.id}/run`, { token });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'success');
  const res = r.data.results;
  assert.deepEqual(res.yes.output[0][0].json, { count: 1, names: ['Ada'] });
  assert.equal(res.no.output[0][0].json.label, 'Linus (17)');
  assert.equal(res.no.output[0][0].json.adult, false); // boolean preserved, not "false"
  assert.equal(res.no.output[0][0].json.from, 200); // number preserved, $node access works

  const list = await api('GET', `/api/executions?workflowId=${wf.id}`, { token });
  assert.equal(list.data.length, 1);
  const detail = await api('GET', `/api/executions/${list.data[0].id}`, { token });
  assert.equal(detail.data.results.c.status, 'success');
});

test('expressions: sandbox cannot reach host process', async () => {
  const token = await newUser();
  const wf = await createWf(token, 'escape', [
    node('t', 'trigger.manual', 'Start'),
    node('s', 'data.set', 'Evil', { fields: [{ name: 'x', value: "{{ $json.constructor.constructor('return process')() }}" }] }),
  ], [edge('t', 's')]);
  const r = await api('POST', `/api/workflows/${wf.id}/run`, { token });
  assert.equal(r.data.status, 'error');
  assert.match(r.data.error.message, /Expression error/);

  const wf2 = await createWf(token, 'escape2', [
    node('t', 'trigger.manual', 'Start'),
    node('c', 'data.code', 'Evil', { mode: 'runOnce', code: 'return [{ p: typeof process, r: typeof require, f: (() => { try { return this.constructor.constructor("return process")(); } catch (e) { return "blocked"; } })() }];' }),
  ], [edge('t', 'c')]);
  const r2 = await api('POST', `/api/workflows/${wf2.id}/run`, { token });
  const out = r2.data.results.c.output[0][0].json;
  assert.equal(out.p, 'undefined');
  assert.equal(out.r, 'undefined');
  assert.equal(out.f, 'blocked');

  const wf3 = await createWf(token, 'loop', [node('t', 'trigger.manual', 'Start'), node('c', 'data.code', 'Spin', { code: 'while(true){}' })], [edge('t', 'c')]);
  const r3 = await api('POST', `/api/workflows/${wf3.id}/run`, { token });
  assert.equal(r3.data.status, 'error');
});

test('engine: cycles are rejected, merge combines branches', async () => {
  const token = await newUser();
  const cyc = await createWf(token, 'cycle', [
    node('t', 'trigger.manual', 'Start'), node('a', 'logic.noop', 'A'), node('b', 'logic.noop', 'B'),
  ], [edge('t', 'a'), edge('a', 'b'), edge('b', 'a')]);
  const r = await api('POST', `/api/workflows/${cyc.id}/run`, { token });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /loop/);

  const m = await createWf(token, 'merge', [
    node('t', 'trigger.manual', 'Start'),
    node('a', 'data.set', 'A', { fields: [{ name: 'a', value: '{{ 1 }}' }], keepOthers: false }),
    node('b', 'data.set', 'B', { fields: [{ name: 'b', value: '{{ 2 }}' }], keepOthers: false }),
    node('m', 'logic.merge', 'Merge', { mode: 'combineByPosition' }),
  ], [edge('t', 'a'), edge('t', 'b'), edge('a', 'm', 0, 0), edge('b', 'm', 0, 1)]);
  const r2 = await api('POST', `/api/workflows/${m.id}/run`, { token });
  assert.deepEqual(r2.data.results.m.output[0][0].json, { a: 1, b: 2 });
});

test('webhook: activate, call, respond with last node, secret, conflicts, deactivate', async () => {
  const token = await newUser();
  const nodes = [
    node('t', 'trigger.webhook', 'Hook', { path: 'echo-test', method: 'POST', respond: 'lastNode', secret: 's3cret' }),
    node('s', 'data.set', 'Shout', { fields: [{ name: 'shout', value: '{{ $json.body.msg.toUpperCase() }}' }], keepOthers: false }),
  ];
  const wf = await createWf(token, 'echo', nodes, [edge('t', 's')]);
  assert.equal((await api('POST', '/webhook/echo-test', { body: { msg: 'hi' } })).status, 404); // inactive

  assert.equal((await api('POST', `/api/workflows/${wf.id}/activate`, { token })).data.active, true);
  assert.equal((await api('POST', '/webhook/echo-test', { body: { msg: 'hi' } })).status, 401); // missing secret
  const ok = await api('POST', '/webhook/echo-test', { body: { msg: 'hi' }, headers: { 'x-webhook-secret': 's3cret' } });
  assert.deepEqual(ok.data, { shout: 'HI' });

  const other = await createWf(token, 'clash', nodes, [edge('t', 's')]);
  const clash = await api('POST', `/api/workflows/${other.id}/activate`, { token });
  assert.equal(clash.status, 400);
  assert.match(clash.data.error, /already used/);

  await api('POST', `/api/workflows/${wf.id}/deactivate`, { token });
  assert.equal((await api('POST', '/webhook/echo-test', { body: { msg: 'hi' }, headers: { 'x-webhook-secret': 's3cret' } })).status, 404);
});

test('webhook: immediate mode returns an execution id and the run is recorded', async () => {
  const token = await newUser();
  const wf = await createWf(token, 'async', [
    node('t', 'trigger.webhook', 'Hook', { path: 'async-test', method: 'ANY' }),
    node('s', 'logic.noop', 'Noop'),
  ], [edge('t', 's')]);
  await api('POST', `/api/workflows/${wf.id}/activate`, { token });
  const r = await api('GET', '/webhook/async-test?x=1');
  assert.equal(r.status, 200);
  assert.ok(r.data.executionId);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ex = await api('GET', `/api/executions/${r.data.executionId}`, { token });
  assert.equal(ex.data.status, 'success');
  assert.equal(ex.data.results.t.output[0][0].json.query.x, '1');
});

test('credentials: encrypted at rest, secrets never returned, used by HTTP node', async () => {
  const token = await newUser();
  const created = await api('POST', '/api/credentials', { token, body: { name: 'My API', type: 'httpBearer', data: { token: 'super-secret-token' } } });
  assert.equal(created.status, 201);
  const got = await api('GET', `/api/credentials/${created.data.id}`, { token });
  assert.deepEqual(got.data.data, {});
  assert.deepEqual(got.data.secretsSet, ['token']);
  assert.ok(!JSON.stringify((await api('GET', '/api/credentials', { token })).data).includes('super-secret'));
  assert.equal((await api('POST', '/api/credentials', { token, body: { name: 'bad', type: 'httpBearer', data: {} } })).status, 400);

  const wf = await createWf(token, 'auth', [
    node('t', 'trigger.manual', 'Start'),
    node('h', 'http.request', 'Call', { url: `${mockBase}/people`, credential: created.data.id }),
  ], [edge('t', 'h')]);
  await api('POST', `/api/workflows/${wf.id}/run`, { token });
  assert.equal(seen.filter((s) => s.url === '/people').at(-1).auth, 'Bearer super-secret-token');

  const other = await newUser();
  const stolen = await createWf(other, 'steal', [node('t', 'trigger.manual', 'Start'), node('h', 'http.request', 'Call', { url: `${mockBase}/people`, credential: created.data.id })], [edge('t', 'h')]);
  const r = await api('POST', `/api/workflows/${stolen.id}/run`, { token: other });
  assert.equal(r.data.status, 'error'); // another workspace cannot use the credential
  assert.equal((await api('GET', `/api/credentials/${created.data.id}`, { token: other })).status, 404);
});

test('retries, continue-on-fail and error workflow', async () => {
  const token = await newUser();
  const flaky = await createWf(token, 'flaky', [
    node('t', 'trigger.manual', 'Start'),
    { ...node('h', 'http.request', 'Flaky', { url: `${mockBase}/flaky` }), retryOnFail: true, maxTries: 3, waitBetweenTries: 10 },
  ], [edge('t', 'h')]);
  const r = await api('POST', `/api/workflows/${flaky.id}/run`, { token });
  assert.equal(r.data.status, 'success');
  assert.equal(r.data.results.h.tries, 3);

  const cont = await createWf(token, 'cont', [
    node('t', 'trigger.manual', 'Start'),
    { ...node('h', 'http.request', 'Fails', { url: `${mockBase}/always-fails` }), continueOnFail: true },
    node('n', 'logic.noop', 'After'),
  ], [edge('t', 'h'), edge('h', 'n')]);
  const r2 = await api('POST', `/api/workflows/${cont.id}/run`, { token });
  assert.equal(r2.data.status, 'success');
  assert.match(r2.data.results.n.output[0][0].json.error, /HTTP 500/);

  const handler = await createWf(token, 'handler', [node('e', 'trigger.error', 'On error'), node('s', 'data.set', 'Mark', { fields: [{ name: 'seen', value: '{{ $json.error.message }}' }] })], [edge('e', 's')]);
  const broken = await createWf(token, 'broken', [
    node('t', 'trigger.manual', 'Start'),
    node('x', 'logic.stopAndError', 'Boom', { message: 'kaput' }),
  ], [edge('t', 'x')], { errorWorkflowId: handler.id });
  const r3 = await api('POST', `/api/workflows/${broken.id}/run`, { token });
  assert.equal(r3.data.status, 'error');
  assert.equal(r3.data.error.nodeName, 'Boom');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const hist = await api('GET', `/api/executions?workflowId=${handler.id}`, { token });
  assert.equal(hist.data.length, 1);
  const d = await api('GET', `/api/executions/${hist.data[0].id}`, { token });
  assert.equal(d.data.results.s.output[0][0].json.seen, 'kaput');
});

test('single-node test uses previous execution input', async () => {
  const token = await newUser();
  const wf = await createWf(token, 'nodetest', [
    node('t', 'trigger.manual', 'Start'),
    node('s', 'data.set', 'Make', { fields: [{ name: 'n', value: '{{ 41 }}' }], keepOthers: false }),
    node('c', 'data.set', 'Plus', { fields: [{ name: 'n', value: '{{ $json.n + 1 }}' }], keepOthers: false }),
  ], [edge('t', 's'), edge('s', 'c')]);
  await api('POST', `/api/workflows/${wf.id}/run`, { token });
  const r = await api('POST', `/api/workflows/${wf.id}/nodes/c/test`, { token, body: {} });
  assert.equal(r.data.result.output[0][0].json.n, 42);
});

test('AI: LLM node (JSON parse) and agent tool loop against an OpenAI-compatible API', async () => {
  const token = await newUser();
  const cred = await api('POST', '/api/credentials', { token, body: { name: 'LLM', type: 'openaiApi', data: { apiKey: 'k', baseUrl: `${mockBase}/v1` } } });
  const wf = await createWf(token, 'ai', [
    node('t', 'trigger.manual', 'Start'),
    node('l', 'ai.llm', 'Classify', { provider: 'openai', credential: cred.data.id, prompt: 'help', parseJson: true }),
    node('a', 'ai.agent', 'Agent', { provider: 'openai', credential: cred.data.id, prompt: 'What is 17% of 2450?', tools: '["calculator"]' }),
  ], [edge('t', 'l'), edge('l', 'a')]);
  const r = await api('POST', `/api/workflows/${wf.id}/run`, { token });
  assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
  assert.deepEqual(r.data.results.l.output[0][0].json.parsed, { urgent: true, summary: 'down' });
  const agent = r.data.results.a.output[0][0].json;
  assert.equal(agent.steps[0].tool, 'calculator');
  assert.equal(agent.steps[0].output, '416.5');
  assert.match(agent.text, /416\.5/);
});

test('plans: free tier limits active workflows and monthly runs', async () => {
  const token = await newUser();
  const mk = (i) => createWf(token, `w${i}`, [node('t', 'trigger.webhook', 'Hook', { path: `limit-${counter}-${i}`, method: 'POST' })], []);
  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push((await mk(i)).id);
  for (let i = 0; i < 5; i += 1) assert.equal((await api('POST', `/api/workflows/${ids[i]}/activate`, { token })).status, 200);
  const over = await api('POST', `/api/workflows/${ids[5]}/activate`, { token });
  assert.equal(over.status, 402);

  const up = await api('POST', '/api/billing/dev-plan', { token, body: { plan: 'pro' } });
  assert.equal(up.data.plan.id, 'pro');
  assert.equal((await api('POST', `/api/workflows/${ids[5]}/activate`, { token })).status, 200);
  const usage = await api('GET', '/api/usage', { token });
  assert.equal(usage.data.activeWorkflows, 6);
});

test('templates and n8n import', async () => {
  const token = await newUser();
  const list = await api('GET', '/api/templates', { token });
  assert.ok(list.data.length >= 15);
  const nodeTypes = new Set((await api('GET', '/api/node-types', { token })).data.map((n) => n.type));
  for (const t of list.data) {
    const used = await api('POST', `/api/templates/${t.id}/use`, { token });
    assert.equal(used.status, 201);
    for (const n of used.data.definition.nodes) assert.ok(nodeTypes.has(n.type), `${t.id} uses unknown type ${n.type}`);
    for (const c of used.data.definition.connections) {
      const ids = used.data.definition.nodes.map((n) => n.id);
      assert.ok(ids.includes(c.from) && ids.includes(c.to), `${t.id} has a dangling connection`);
    }
  }

  const n8n = {
    name: 'Imported',
    nodes: [
      { name: 'Manual', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
      { name: 'Fetch', type: 'n8n-nodes-base.httpRequest', position: [200, 0], parameters: { url: `=${mockBase}/people`, method: 'GET' } },
      { name: 'Weird', type: 'n8n-nodes-base.quickbooks', position: [400, 0], parameters: {} },
      { name: 'Note', type: 'n8n-nodes-base.stickyNote', position: [0, 200], parameters: {} },
    ],
    connections: { Manual: { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] }, Fetch: { main: [[{ node: 'Weird', type: 'main', index: 0 }]] } },
  };
  const imp = await api('POST', '/api/import/n8n', { token, body: { workflow: n8n } });
  assert.equal(imp.status, 201);
  assert.equal(imp.data.report.total, 3);
  assert.equal(imp.data.report.converted, 2);
  assert.equal(imp.data.report.unsupported[0].type, 'quickbooks');
  const run = await api('POST', `/api/workflows/${imp.data.workflow.id}/run`, { token });
  assert.equal(run.data.status, 'success');
  assert.equal((await api('POST', '/api/import/n8n', { token, body: { workflow: { nope: 1 } } })).status, 400);

  const conv = convertN8nWorkflow({
    nodes: [{ name: 'S', type: 'n8n-nodes-base.set', position: [0, 0], parameters: { assignments: { assignments: [{ name: 'x', value: "={{ $('Other').item.json.y }}" }] } } }],
    connections: {},
  });
  assert.equal(conv.definition.nodes[0].parameters.fields[0].value, '{{ $node["Other"].json.y }}');
});

test('workspace isolation and stripe signature', async () => {
  const a = await newUser();
  const b = await newUser();
  const wf = await createWf(a, 'private', [node('t', 'trigger.manual', 'Start')], []);
  assert.equal((await api('GET', `/api/workflows/${wf.id}`, { token: b })).status, 404);
  assert.equal((await api('PUT', `/api/workflows/${wf.id}`, { token: b, body: { name: 'hacked' } })).status, 404);
  assert.equal((await api('DELETE', `/api/workflows/${wf.id}`, { token: b })).status, 404);

  const body = '{"type":"checkout.session.completed"}';
  const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
  assert.equal(verifyStripeSignature(body, `t=${t},v1=${sig}`, 'whsec_test'), true);
  assert.equal(verifyStripeSignature(body + ' ', `t=${t},v1=${sig}`, 'whsec_test'), false);
  assert.equal(verifyStripeSignature(body, `t=${t - 4000},v1=${sig}`, 'whsec_test'), false);
  const bad = await fetch(`${base}/api/billing/webhook`, { method: 'POST', body, headers: { 'stripe-signature': 't=1,v1=00' } });
  assert.equal(bad.status, 400);
});

test('sandbox: memory bombs and host APIs are contained, large item counts stay fast', async () => {
  const token = await newUser();

  const bomb = await createWf(token, 'bomb', [
    node('t', 'trigger.manual', 'Start'),
    node('c', 'data.code', 'Bomb', { mode: 'runOnce', code: 'const a = []; while (true) { a.push(new Array(1e6).fill(7)); }' }),
  ], [edge('t', 'c')]);
  const r1 = await api('POST', `/api/workflows/${bomb.id}/run`, { token });
  assert.equal(r1.data.status, 'error');
  assert.match(r1.data.error.message, /memory|timed out/i);

  const probe = await createWf(token, 'probe', [
    node('t', 'trigger.manual', 'Start'),
    node('c', 'data.code', 'Probe', {
      mode: 'runOnce',
      code: 'return [{ t: [typeof fetch, typeof setTimeout, typeof Buffer, typeof process, typeof require, typeof module, typeof globalThis.global].join(",") }];',
    }),
  ], [edge('t', 'c')]);
  const r2 = await api('POST', `/api/workflows/${probe.id}/run`, { token });
  assert.equal(r2.data.results.c.output[0][0].json.t, 'undefined,undefined,undefined,undefined,undefined,undefined,undefined');

  // The server is still healthy after both attacks, and 1500 items x 2 expressions finish quickly.
  const many = await createWf(token, 'many', [
    node('t', 'trigger.manual', 'Start'),
    node('g', 'data.code', 'Gen', { mode: 'runOnce', code: 'return Array.from({ length: 1500 }, (_, i) => ({ i }));' }),
    node('s', 'data.set', 'Calc', { fields: [{ name: 'sq', value: '{{ $json.i * $json.i }}' }, { name: 'label', value: 'n{{ $json.i }}' }], keepOthers: false }),
  ], [edge('t', 'g'), edge('g', 's')]);
  const t0 = Date.now();
  const r3 = await api('POST', `/api/workflows/${many.id}/run`, { token });
  const elapsed = Date.now() - t0;
  assert.equal(r3.data.status, 'success', JSON.stringify(r3.data.error));
  assert.equal(r3.data.results.s.output[0].length, 100); // stored log is capped at 100 items per output
  assert.deepEqual(r3.data.results.s.output[0][7].json, { sq: 49, label: 'n7' });
  assert.ok(elapsed < 15000, `1500 items took ${elapsed}ms`);
  console.log(`# 1500 items x 2 expressions in ${elapsed}ms`);
});

test('footprint: logs are compressed, success data can be dropped, static data is only written when changed', async () => {
  const { get } = await import('../src/db.js');
  const { pack, unpack } = await import('../src/packing.js');
  const token = await newUser();

  const sample = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ['a', 'b', 'c'] })));
  assert.ok(pack(sample).length < sample.length / 4, 'repetitive JSON compresses well');
  assert.equal(unpack(pack(sample)), sample);
  assert.equal(pack('{"small":1}'), '{"small":1}'); // tiny payloads stay plain text

  const mk = (name, path, settings) => createWf(token, name, [
    node('t', 'trigger.webhook', 'Hook', { path, method: 'POST', respond: 'lastNode' }),
    node('g', 'data.code', 'Gen', { mode: 'runOnce', code: 'return Array.from({ length: 150 }, (_, i) => ({ i, text: "row " + i }));' }),
  ], [edge('t', 'g')], settings);

  const keep = await mk('keeps', `fp-keep-${counter}`);
  const drop = await mk('drops', `fp-drop-${counter}`, { saveSuccessData: false });
  for (const wf of [keep, drop]) await api('POST', `/api/workflows/${wf.id}/activate`, { token });
  await fetch(`${base}/webhook/fp-keep-${counter}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await fetch(`${base}/webhook/fp-drop-${counter}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

  const row = async (wf) => (await get('SELECT status, data FROM executions WHERE workflow_id = ?', wf.id));
  const kept = await row(keep);
  const dropped = await row(drop);
  assert.equal(kept.status, 'success');
  assert.ok(kept.data.startsWith('gz:'), 'stored run data is compressed');
  const list = (await api('GET', `/api/executions?workflowId=${keep.id}`, { token })).data;
  const detail = (await api('GET', `/api/executions/${list[0].id}`, { token })).data;
  assert.equal(detail.results.g.output[0].length, 100); // readable through the API, capped at 100 items
  assert.equal(dropped.status, 'success');
  assert.equal(dropped.data, null, 'successful runs keep only the one-line record');

  // A failing run always keeps its data so it can be debugged, even with saveSuccessData off.
  const bad = await createWf(token, 'bad', [
    node('t', 'trigger.webhook', 'Hook', { path: `fp-bad-${counter}`, method: 'POST' }),
    node('x', 'logic.stopAndError', 'Boom', { message: 'nope' }),
  ], [edge('t', 'x')], { saveSuccessData: false });
  await api('POST', `/api/workflows/${bad.id}/activate`, { token });
  await fetch(`${base}/webhook/fp-bad-${counter}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await new Promise((r) => setTimeout(r, 400));
  const failed = await get('SELECT status, data FROM executions WHERE workflow_id = ?', bad.id);
  assert.equal(failed.status, 'error');
  assert.ok(failed.data, 'failed runs keep their data');
});
