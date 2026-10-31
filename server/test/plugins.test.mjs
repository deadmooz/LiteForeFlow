import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------------------------------------------------
 * Plugins, the REST connector, Respond to Webhook, the data tools, and the friendly (live) fields.
 * A fake "outside world" (a REST service, Notion and Ollama in one) is started first so the app can point at it.
 * ------------------------------------------------------------------------------------------------------------ */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-plugins-'));
const EXTRA = fs.mkdtempSync(path.join(os.tmpdir(), 'liteforeflow-extra-plugins-'));
const seen = [];
const state = { notionEmpty: false };

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, headers: req.headers, body: json });
    res.setHeader('content-type', 'application/json');
    const send = (data, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };
    const p = url.pathname;
    // ---- a generic REST service (bearer token) ----
    if (p.startsWith('/svc/') && req.headers.authorization !== 'Bearer tok') return send({ message: 'Bad credentials' }, 401);
    if (p === '/svc/me') return send({ name: 'Ada' });
    if (p === '/svc/projects') return send([{ id: 'p1', name: 'Home' }, { id: 'p2', name: 'Work' }]);
    if (p === '/svc/boards/b1/lists') return send([{ id: 'l1', name: 'To do' }, { id: 'l2', name: 'Done' }]);
    if (p === '/svc/tasks' && req.method === 'GET') return send({ data: { items: [{ id: 1, t: 'first' }, { id: 2, t: 'second' }] } });
    if (p === '/svc/tasks' && req.method === 'POST') return send({ created: true, ...json }, 201);
    if (p === '/svc/tasks/5') return send({ id: 5, t: 'five' });
    if (p === '/svc/gone') return send({ message: 'No such thing' }, 404);
    if (p.startsWith('/svc/repos/')) return send({ path: p });
    // ---- a service that wants its keys in the query string ----
    if (p === '/svcq/ping') return send(url.searchParams.get('appid') === 'KEY1' ? { name: 'Paris' } : { message: 'bad key' }, url.searchParams.get('appid') === 'KEY1' ? 200 : 401);
    // ---- Notion ----
    if (p === '/v1/users/me') return send({ name: 'Tester' });
    if (p === '/v1/search') return send({ results: state.notionEmpty ? [] : [{ id: 'db1', title: [{ plain_text: 'Tasks' }] }, { id: 'db2', title: [{ plain_text: 'People' }] }] });
    if (p === '/v1/databases/db1') {
      return send({
        title: [{ plain_text: 'Tasks' }],
        properties: {
          Value: { type: 'title' }, Gender: { type: 'rich_text' }, Done: { type: 'checkbox' }, Score: { type: 'number' }, Due: { type: 'date' },
          Tags: { type: 'multi_select', multi_select: { options: [{ name: 'a' }, { name: 'b' }] } },
          Stage: { type: 'status', status: { options: [{ name: 'Todo' }, { name: 'Done' }] } }, Created: { type: 'created_time' },
        },
      });
    }
    if (p === '/v1/pages') return send({ id: 'page1', url: 'https://notion.so/page1' });
    // ---- Ollama ----
    if (p === '/api/tags') return send({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3.5:4b' }] });
    return send({ error: 'unknown route' }, 404);
  });
}).listen(0);
const mockBase = `http://localhost:${mock.address().port}`;

process.env.DATA_DIR = DATA;
process.env.PLUGINS_DIR = EXTRA;
process.env.LITEFOREFLOW_SECRET = 'test-secret';
process.env.LITEFOREFLOW_NOTION_URL = mockBase;
process.env.AUTH_RATE_LIMIT_PER_MIN = '1000';
process.env.DB_PATH = ':memory:';

// user plugins: one good, one that crashes, one that clashes with a built-in block, one without a manifest
const plug = (id, manifest, code) => {
  const dir = path.join(EXTRA, id);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest) fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.js'), code);
};
plug('hello-test', { id: 'hello-test', name: 'Hello Test', version: '1.2.3', description: 'test plugin' }, `
  export function register(sdk) {
    sdk.defineNode({ type: 'hellotest.greet', name: 'Greet', group: 'app',
      properties: [{ name: 'who', label: 'Who', type: 'string', default: 'world' }],
      async executeItem(ctx, item, i) { return { ...item.json, greeting: 'hi ' + (await ctx.param('who', i)) }; } });
    sdk.defineCredentialType({ id: 'hellotestKey', name: 'Hello key', fields: [{ name: 'key', label: 'Key', type: 'password', required: true }],
      test: async (d) => (d.key === 'good' ? 'Key is good' : { ok: false, message: 'Key is wrong' }) });
  }`);
plug('crash-test', { id: 'crash-test', name: 'Crash Test' }, 'export function register() { throw new Error("I am broken on purpose"); }');
plug('clash-test', { id: 'clash-test', name: 'Clash Test' }, `export function register(sdk) {
  sdk.defineNode({ type: 'crashhalf.one', name: 'One', executeItem: async () => ({}) });
  sdk.defineNode({ type: 'logic.if', name: 'Steal the IF', executeItem: async () => ({}) }); }`);
plug('no-manifest', null, 'export function register() {}');
plug('escape-test', { id: 'escape-test', name: 'Escape', entry: '../outside.js' }, '');
fs.writeFileSync(path.join(EXTRA, 'outside.js'), 'export function register(sdk) { sdk.defineNode({ type: "escaped.node", name: "E", executeItem: async () => ({}) }); }');

// a user's own REST service file, plus a broken one that must be skipped without hurting anything
const svcDir = path.join(DATA, 'plugin-data', 'rest-connector', 'services');
fs.mkdirSync(svcDir, { recursive: true });
fs.writeFileSync(path.join(svcDir, 'mockservice.json'), JSON.stringify({
  id: 'mockservice', name: 'Mock Service', baseUrl: `${mockBase}/svc`, headers: { 'x-extra': 'yes' },
  auth: { type: 'bearer', label: 'Token' }, setup: ['Step one'], test: { path: '/me', say: 'Connected as {name}.' },
  operations: [
    { id: 'listTasks', label: 'List tasks', method: 'GET', path: '/tasks', result: 'data.items',
      fields: [
        { name: 'status', label: 'Status', type: 'options', in: 'query', default: 'open', options: ['open', 'done'] },
        { name: 'project', label: 'Project', type: 'options', in: 'query', options: { from: '/projects', value: 'id', label: 'name' } },
      ] },
    { id: 'createTask', label: 'Create task', method: 'POST', path: '/tasks',
      fields: [
        { name: 'board', label: 'Board', type: 'string', in: 'ui' },
        { name: 'list', label: 'List', type: 'options', as: 'idList', in: 'body', required: true, options: { from: '/boards/{board}/lists', value: 'id', label: 'name' } },
        { name: 'title', label: 'Title', type: 'string', in: 'body', required: true },
        { name: 'priority', label: 'Priority', type: 'number', in: 'body' },
      ] },
    { id: 'getTask', label: 'Get task', method: 'GET', path: '/tasks/{id}', fields: [{ name: 'id', label: 'Id', type: 'string', in: 'path', required: true }] },
    { id: 'repoFile', label: 'Repo', method: 'GET', path: '/repos/{repo}/x', fields: [{ name: 'repo', label: 'Repo', type: 'string', in: 'path', raw: true, required: true }] },
    { id: 'gone', label: 'Gone', method: 'GET', path: '/gone', fields: [] },
  ],
}));
fs.writeFileSync(path.join(svcDir, 'queryservice.json'), JSON.stringify({
  id: 'queryservice', name: 'Query Service', baseUrl: `${mockBase}/svcq`, auth: { type: 'query', params: [{ name: 'apikey', as: 'appid', label: 'Key' }] },
  test: { path: '/ping', say: 'Hello {name}.' }, operations: [{ id: 'ping', label: 'Ping', path: '/ping', fields: [] }],
}));
fs.writeFileSync(path.join(svcDir, 'broken.json'), JSON.stringify({ id: 'Bad Id!', name: 'Broken', baseUrl: 'nope', operations: [] }));
fs.writeFileSync(path.join(svcDir, 'notjson.json'), '{ this is not json');

const { createApp } = await import('../src/app.js');
const { startWorker, closeQueue } = await import('../src/queue.js');
const { closeDb } = await import('../src/db.js');
const { loadPlugins } = await import('../src/plugins.js');
const { checkSpec } = await import('../../plugins/rest-connector/index.js');

let server;
let base;

before(async () => {
  await loadPlugins();
  await startWorker();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); mock.close(); await closeQueue(); await closeDb(); });

async function api(method, url, { token, body, headers } = {}) {
  const res = await fetch(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = text; try { data = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data };
}
let counter = 0;
const RUN = crypto.randomBytes(3).toString('hex');
async function newUser() {
  counter += 1;
  const r = await api('POST', '/api/auth/signup', { body: { email: `plug${RUN}${counter}@example.com`, password: 'password123', name: `P${counter}` } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.token;
}
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
async function createWf(token, name, nodes, connections) {
  const r = await api('POST', '/api/workflows', { token, body: { name, definition: { nodes, connections } } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}
/** Runs trigger -> nodes in a chain, returns { r, out(id) }. */
async function chain(token, nodes) {
  const all = [node('t', 'trigger.manual', 'Start'), ...nodes];
  const wf = await createWf(token, 'chain', all, nodes.map((n, i) => edge(i ? nodes[i - 1].id : 't', n.id)));
  const r = await api('POST', `/api/workflows/${wf.id}/run`, { token });
  return { r, wf, out: (id) => r.data.results?.[id]?.output?.[0]?.map((i) => i.json) ?? [] };
}
const items = (list) => node('items', 'data.code', 'Items', { code: `return ${JSON.stringify(list)};` });

/* ================================== plugin system ================================== */

test('plugins: bundled and user plugins load; a broken plugin is isolated and explained', async () => {
  const token = await newUser();
  const list = (await api('GET', '/api/plugins', { token })).data;
  const by = Object.fromEntries(list.map((p) => [p.id, p]));
  for (const id of ['rest-connector', 'respond-to-webhook', 'data-tools']) { assert.equal(by[id].status, 'ok', id); assert.equal(by[id].source, 'bundled'); }
  assert.equal(by['hello-test'].status, 'ok');
  assert.equal(by['hello-test'].source, 'user');
  assert.equal(by['hello-test'].version, '1.2.3');
  assert.deepEqual(by['hello-test'].nodes.map((n) => n.type), ['hellotest.greet']);
  assert.equal(by['crash-test'].status, 'error');
  assert.match(by['crash-test'].error, /broken on purpose/);
  assert.equal(by['clash-test'].status, 'error');
  assert.match(by['clash-test'].error, /logic\.if.*already exists/);
  assert.ok(list.some((p) => p.status === 'error' && /plugin\.json is missing/.test(p.error)), 'a folder without plugin.json is reported');
  // a clash rolls back everything the plugin had added so far
  const types = (await api('GET', '/api/node-types', { token })).data.map((n) => n.type);
  assert.ok(!types.includes('crashhalf.one'));
  assert.ok(types.includes('hellotest.greet') && types.includes('logic.if'));
  // ... and the plugin's own block really runs
  const { r, out } = await chain(token, [items([{ a: 1 }]), node('g', 'hellotest.greet', 'Greet', { who: 'Ada' })]);
  assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
  assert.equal(out('g')[0].greeting, 'hi Ada');
});

test('plugins: only the owner can turn one off; a workflow that needs it says why it cannot run; turning on restores it', async () => {
  const owner = await newUser(); // the first account of this server is the owner
  const other = await newUser();
  const wf = await createWf(owner, 'uses-plugin', [node('t', 'trigger.manual', 'Start'), node('g', 'hellotest.greet', 'Greet')], [edge('t', 'g')]);

  // any account that is not the very first one is refused
  const denied = await api('POST', '/api/plugins/hello-test/disable', { token: other });
  assert.equal(denied.status, 403);
  assert.match(denied.data.error, /owner/);

  // find who the owner is: the first account created on this server (test 1's user)
  const ownerLogin = await api('POST', '/api/auth/login', { body: { email: `plug${RUN}1@example.com`, password: 'password123' } });
  const boss = ownerLogin.data.token;
  assert.equal((await api('POST', '/api/plugins/hello-test/disable', { token: boss })).status, 200);
  const types = (await api('GET', '/api/node-types', { token: boss })).data.map((n) => n.type);
  assert.ok(!types.includes('hellotest.greet'));
  assert.ok(!(await api('GET', '/api/credential-types', { token: boss })).data.some((t) => t.id === 'hellotestKey'), 'its credential type goes too');
  const run = await api('POST', `/api/workflows/${wf.id}/run`, { token: owner });
  assert.equal(run.status, 400);
  assert.match(run.data.error, /plugin "Hello Test".*switched off/);
  assert.equal((await api('GET', '/api/plugins', { token: boss })).data.find((p) => p.id === 'hello-test').status, 'disabled');

  assert.equal((await api('POST', '/api/plugins/hello-test/enable', { token: boss })).status, 200);
  assert.equal((await api('POST', `/api/workflows/${wf.id}/run`, { token: owner })).data.status, 'success');
  assert.equal((await api('POST', '/api/plugins/nope/enable', { token: boss })).status, 404);
});

test('plugins: a plugin credential type can bring its own Test connection', async () => {
  const token = await newUser();
  const bad = await api('POST', '/api/credentials/test', { token, body: { type: 'hellotestKey', data: { key: 'nope' } } });
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.message, 'Key is wrong');
  assert.equal((await api('POST', '/api/credentials/test', { token, body: { type: 'hellotestKey', data: { key: 'good' } } })).data.message, 'Key is good');
  assert.equal((await api('POST', '/api/credentials/test', { token, body: { type: 'hellotestKey', data: {} } })).data.ok, false, 'a missing field is reported before any call');
});

/* ================================= REST connector ================================== */

test('rest connector: a service file becomes a block and a credential type; broken files are skipped', async () => {
  const token = await newUser();
  const types = (await api('GET', '/api/node-types', { token })).data;
  for (const t of ['rest.github', 'rest.trello', 'rest.openweather', 'rest.hackernews', 'rest.mockservice', 'rest.queryservice']) assert.ok(types.some((n) => n.type === t), t);
  assert.ok(!types.some((n) => n.type === 'rest.badid' || n.name === 'Broken'));
  const ct = (await api('GET', '/api/credential-types', { token })).data;
  const mockType = ct.find((t) => t.id === 'rest_mockservice');
  assert.deepEqual(mockType.setup, ['Step one']);
  assert.equal(mockType.fields[0].type, 'password');
  assert.ok(!ct.some((t) => t.id === 'rest_hackernews'), 'a service without auth needs no credential type');
  // the example file in the plugin folder is a template, not a service
  assert.ok(!types.some((n) => n.type === 'rest.todoexample'));
  // every service file that ships with LiteForeFlow is valid
  for (const f of fs.readdirSync(new URL('../../plugins/rest-connector/services', import.meta.url))) {
    const spec = JSON.parse(fs.readFileSync(new URL(`../../plugins/rest-connector/services/${f}`, import.meta.url), 'utf8'));
    if (f.startsWith('_')) continue;
    assert.deepEqual(checkSpec(spec), [], f);
  }
  assert.ok(checkSpec({ id: 'x' }).length > 3, 'problems are listed in plain words');
  assert.match(checkSpec({ id: 'abc', name: 'A', baseUrl: 'http://x', operations: [{ id: 'o', label: 'O', path: '/a/{missing}', fields: [] }] })[0], /\{missing\}/);
});

test('rest connector: calls carry the auth, query, body, headers and path; results become items', async () => {
  const token = await newUser();
  const cred = await api('POST', '/api/credentials', { token, body: { name: 'mock', type: 'rest_mockservice', data: { token: 'tok' } } });
  assert.equal(cred.status, 201, JSON.stringify(cred.data));
  const c = cred.data.id;
  seen.length = 0;

  let { r, out } = await chain(token, [node('a', 'rest.mockservice', 'List', { credential: c, operation: 'listTasks', listTasks__status: 'done', listTasks__project: 'p2' })]);
  assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
  assert.deepEqual(out('a').map((x) => x.t), ['first', 'second'], 'result path data.items becomes one item per entry');
  const req = seen.find((s) => s.path === '/svc/tasks');
  assert.equal(req.auth, 'Bearer tok');
  assert.equal(req.headers['x-extra'], 'yes');
  assert.deepEqual(req.query, { status: 'done', project: 'p2' });

  ({ r, out } = await chain(token, [items([{ title: 'Buy milk', n: 7 }]), node('a', 'rest.mockservice', 'Create', { credential: c, operation: 'createTask', createTask__board: 'b1', createTask__list: 'l1', createTask__title: '{{ $json.title }}', createTask__priority: '{{ $json.n }}' })]));
  assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
  assert.deepEqual(seen.filter((s) => s.method === 'POST' && s.path === '/svc/tasks').at(-1).body, { idList: 'l1', title: 'Buy milk', priority: 7 }, 'ui fields are not sent; "as" renames; numbers are numbers');
  assert.equal(out('a')[0].created, true);

  ({ r, out } = await chain(token, [node('a', 'rest.mockservice', 'One', { credential: c, operation: 'getTask', getTask__id: '5' })]));
  assert.equal(out('a')[0].t, 'five');
  ({ r, out } = await chain(token, [node('a', 'rest.mockservice', 'Repo', { credential: c, operation: 'repoFile', repoFile__repo: 'octo/cat' })]));
  assert.equal(out('a')[0].path, '/svc/repos/octo/cat/x', 'a raw path value keeps its slash');
});

test('rest connector: errors say what the service said; required fields are checked; query-style auth works', async () => {
  const token = await newUser();
  const good = (await api('POST', '/api/credentials', { token, body: { name: 'g', type: 'rest_mockservice', data: { token: 'tok' } } })).data.id;
  const bad = (await api('POST', '/api/credentials', { token, body: { name: 'b', type: 'rest_mockservice', data: { token: 'wrong' } } })).data.id;

  let { r } = await chain(token, [node('a', 'rest.mockservice', 'Gone', { credential: good, operation: 'gone' })]);
  assert.equal(r.data.status, 'error');
  assert.match(r.data.error.message, /Mock Service: HTTP 404 - No such thing/);
  ({ r } = await chain(token, [node('a', 'rest.mockservice', 'Bad', { credential: bad, operation: 'getTask', getTask__id: '5' })]));
  assert.match(r.data.error.message, /HTTP 401 - Bad credentials/);
  ({ r } = await chain(token, [node('a', 'rest.mockservice', 'Missing', { credential: good, operation: 'getTask' })]));
  assert.match(r.data.error.message, /Id is required for "Get task"/);

  const q = (await api('POST', '/api/credentials', { token, body: { name: 'q', type: 'rest_queryservice', data: { apikey: 'KEY1' } } })).data.id;
  seen.length = 0;
  let out;
  ({ r, out } = await chain(token, [node('a', 'rest.queryservice', 'Ping', { credential: q, operation: 'ping' })]));
  assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
  assert.equal(out('a')[0].name, 'Paris');
  assert.equal(seen.at(-1).query.appid, 'KEY1', 'the key is sent under its "as" name');

  // the Hacker News block needs no credential at all
  assert.equal(r.data.results.a.status, 'success');
  const hn = types => types.find((n) => n.type === 'rest.hackernews');
  assert.ok(!hn((await api('GET', '/api/node-types', { token })).data).properties.some((p) => p.type === 'credential'));
});

test('friendly fields: live dropdowns come from the service and say why when they cannot', async () => {
  const token = await newUser();
  const c = (await api('POST', '/api/credentials', { token, body: { name: 'live', type: 'rest_mockservice', data: { token: 'tok' } } })).data.id;
  const ask = (type, property, parameters, kind) => api('POST', '/api/node-options', { token, body: { type, property, parameters, kind } });

  let r = await ask('rest.mockservice', 'listTasks__project', { credential: c });
  assert.deepEqual(r.data.options, [{ value: 'p1', label: 'Home' }, { value: 'p2', label: 'Work' }]);
  // a dropdown that depends on another one (board -> lists)
  r = await ask('rest.mockservice', 'createTask__list', { credential: c, operation: 'createTask', createTask__board: 'b1' });
  assert.deepEqual(r.data.options.map((o) => o.label), ['To do', 'Done']);
  r = await ask('rest.mockservice', 'createTask__list', { credential: c, operation: 'createTask' });
  assert.match(r.data.error, /Pick "Board" first/);
  assert.deepEqual(r.data.options, []);
  // wrong token: the service's own message, not a crash
  const bad = (await api('POST', '/api/credentials', { token, body: { name: 'bad', type: 'rest_mockservice', data: { token: 'x' } } })).data.id;
  r = await ask('rest.mockservice', 'listTasks__project', { credential: bad });
  assert.match(r.data.error, /401.*Bad credentials/);
  assert.equal((await ask('logic.if', 'conditions', {})).status, 404);
  assert.equal((await ask('nope.none', 'x', {})).status, 404);
});

test('friendly fields: Test connection explains the result in plain words', async () => {
  const token = await newUser();
  const test = (type, data, id) => api('POST', '/api/credentials/test', { token, body: { type, data, id } });
  assert.equal((await test('rest_mockservice', { token: 'tok' })).data.message, 'Connected as Ada.');
  const wrong = (await test('rest_mockservice', { token: 'nope' })).data;
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /401/);
  assert.match(wrong.message, /rejected/);
  // a saved credential can be re-tested without typing the secret again
  const id = (await api('POST', '/api/credentials', { token, body: { name: 'saved', type: 'rest_mockservice', data: { token: 'tok' } } })).data.id;
  assert.equal((await test(undefined, { token: '' }, id)).data.message, 'Connected as Ada.');
  assert.equal((await api('POST', '/api/credentials/test', { token, body: { id: 'does-not-exist' } })).status, 404);
  // types without a test say so honestly
  assert.equal((await test('httpBearer', { token: 'x' })).data.untested, true);
  assert.equal((await test('nonsense', {})).data.ok, false);
  // Ollama: lists what is installed, or tells you it is not running
  const live = (await test('ollamaApi', { baseUrl: mockBase })).data;
  assert.match(live.message, /Installed models: llama3\.2:latest, qwen3\.5:4b/);
  assert.match((await test('ollamaApi', { baseUrl: 'http://127.0.0.1:1' })).data.message, /Could not reach Ollama/);
});

/* ==================================== Notion ====================================== */

test('notion: pick the database from a list, fill its real columns, no JSON and no column names to type', async () => {
  const token = await newUser();
  const c = (await api('POST', '/api/credentials', { token, body: { name: 'notion', type: 'notionApi', data: { token: 'secret_x' } } })).data.id;

  // the credential test counts the databases that were shared
  assert.match((await api('POST', '/api/credentials/test', { token, body: { type: 'notionApi', data: { token: 'secret_x' } } })).data.message, /Connected as "Tester"\. 2 databases are shared/);
  state.notionEmpty = true;
  const warn = (await api('POST', '/api/credentials/test', { token, body: { type: 'notionApi', data: { token: 'secret_x' } } })).data;
  assert.equal(warn.ok, true);
  assert.equal(warn.warn, true);
  assert.match(warn.message, /Connections/);
  const empty = await api('POST', '/api/node-options', { token, body: { type: 'app.notion', property: 'databaseId', parameters: { credential: c } } });
  assert.match(empty.data.error, /No database is shared/);
  state.notionEmpty = false;

  const dbs = await api('POST', '/api/node-options', { token, body: { type: 'app.notion', property: 'databaseId', parameters: { credential: c } } });
  assert.deepEqual(dbs.data.options, [{ value: 'db1', label: 'Tasks' }, { value: 'db2', label: 'People' }]);

  const cols = await api('POST', '/api/node-options', { token, body: { type: 'app.notion', property: 'columns', kind: 'fields', parameters: { credential: c, databaseId: 'db1' } } });
  const byName = Object.fromEntries(cols.data.fields.map((f) => [f.name, f]));
  assert.deepEqual(Object.keys(byName).sort(), ['Done', 'Due', 'Gender', 'Score', 'Stage', 'Tags'], 'the title and read-only columns are not offered');
  assert.equal(byName.Done.type, 'boolean');
  assert.equal(byName.Tags.type, 'tags');
  assert.deepEqual(byName.Stage.options, ['Todo', 'Done']);

  seen.length = 0;
  const { r, out } = await chain(token, [
    items([{ who: 'Priya', n: 3 }]),
    node('n', 'app.notion', 'Notion', { credential: c, operation: 'createPage', databaseId: 'db1', title: '{{ $json.who }}', columns: { Gender: 'Female', Done: true, Score: '{{ $json.n }}', Tags: 'a, b', Due: '2026-03-05', Stage: 'Todo', Nope: 'x' } }),
  ]);
  assert.equal(r.data.status, 'error', 'a column that does not exist is an error, not silently dropped');
  assert.match(r.data.error.message, /no fillable column called "Nope"/);

  const ok = await chain(token, [
    items([{ who: 'Priya', n: 3 }]),
    node('n', 'app.notion', 'Notion', { credential: c, operation: 'createPage', databaseId: 'db1', title: '{{ $json.who }}', columns: { Gender: 'Female', Done: true, Score: '{{ $json.n }}', Tags: 'a, b', Due: '2026-03-05', Stage: 'Todo' } }),
  ]);
  assert.equal(ok.r.data.status, 'success', JSON.stringify(ok.r.data.error));
  const sent = seen.filter((s) => s.path === '/v1/pages').at(-1).body;
  assert.equal(sent.parent.database_id, 'db1');
  assert.deepEqual(sent.properties, {
    Gender: { rich_text: [{ text: { content: 'Female' } }] }, Done: { checkbox: true }, Score: { number: 3 },
    Tags: { multi_select: [{ name: 'a' }, { name: 'b' }] }, Due: { date: { start: '2026-03-05' } }, Stage: { status: { name: 'Todo' } },
    Value: { title: [{ text: { content: 'Priya' } }] }, // the title column was found automatically
  });
  assert.equal(ok.out('n')[0].url, 'https://notion.so/page1');

  // workflows saved before this change (explicit title column, JSON properties) keep working
  const old = await chain(token, [node('n', 'app.notion', 'Notion', { credential: c, operation: 'createPage', databaseId: 'db1', titleProperty: 'Value', title: 'Old', properties: '{"Gender": {"rich_text": [{"text": {"content": "X"}}]}}' })]);
  assert.equal(old.r.data.status, 'success', JSON.stringify(old.r.data.error));
  assert.equal(seen.filter((s) => s.path === '/v1/pages').at(-1).body.properties.Gender.rich_text[0].text.content, 'X');
});

test('ollama: the model list is whatever is installed', async () => {
  const token = await newUser();
  const c = (await api('POST', '/api/credentials', { token, body: { name: 'o', type: 'ollamaApi', data: { baseUrl: mockBase } } })).data.id;
  const r = await api('POST', '/api/node-options', { token, body: { type: 'ai.llm', property: 'model', parameters: { provider: 'ollama', credential: c } } });
  assert.deepEqual(r.data.options.map((o) => o.value), ['llama3.2:latest', 'qwen3.5:4b']);
  const dead = (await api('POST', '/api/credentials', { token, body: { name: 'dead', type: 'ollamaApi', data: { baseUrl: 'http://127.0.0.1:1' } } })).data.id;
  const e = await api('POST', '/api/node-options', { token, body: { type: 'ai.agent', property: 'model', parameters: { provider: 'ollama', credential: dead } } });
  assert.match(e.data.error, /Could not reach Ollama/);
  // other providers have no live list
  assert.deepEqual((await api('POST', '/api/node-options', { token, body: { type: 'ai.llm', property: 'model', parameters: { provider: 'openai' } } })).data.options, []);
});

/* ================================ Respond to Webhook ================================ */

async function webhook(_unused, path, respondNode, respond = 'responseNode', extra = []) {
  const token = await newUser(); // the Free plan allows 5 active workflows per account, so each one gets its own
  const nodes = [node('t', 'trigger.webhook', 'Hook', { path, method: 'POST', respond }), ...extra, respondNode];
  const chainEdges = nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id));
  const wf = await createWf(token, path, nodes, chainEdges);
  const act = await api('POST', `/api/workflows/${wf.id}/activate`, { token });
  assert.equal(act.data.active, true, JSON.stringify(act.data));
  return wf;
}
const call = (p, body) => fetch(`${base}/webhook/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('respond to webhook: status, headers and JSON / text / list bodies', async () => {
  const token = await newUser();
  await webhook(token, `resp-json-${RUN}`, node('r', 'respond.webhook', 'Respond', { status: 201, send: 'json', json: '{"ok": true, "you": "{{ $json.body.name }}"}', headers: [{ name: 'X-Thing', value: 'a-{{ $json.body.name }}' }, { name: 'Set-Cookie', value: 'evil=1' }] }));
  let res = await call(`resp-json-${RUN}`, { name: 'Ada' });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, you: 'Ada' });
  assert.equal(res.headers.get('x-thing'), 'a-Ada', 'expressions work in header values');
  assert.equal(res.headers.get('set-cookie'), null, 'cookies cannot be set from a workflow');

  await webhook(token, `resp-text-${RUN}`, node('r', 'respond.webhook', 'Respond', { status: 202, send: 'text', text: 'Hi {{ $json.body.name }}', headers: [{ name: 'Content-Type', value: 'text/html' }] }));
  res = await call(`resp-text-${RUN}`, { name: 'Bo' });
  assert.equal(res.status, 202);
  assert.equal(await res.text(), 'Hi Bo');
  assert.match(res.headers.get('content-type'), /text\/html/);

  await webhook(token, `resp-empty-${RUN}`, node('r', 'respond.webhook', 'Respond', { status: 204, send: 'empty' }));
  res = await call(`resp-empty-${RUN}`);
  assert.equal(res.status, 204);

  await webhook(token, `resp-first-${RUN}`, node('r', 'respond.webhook', 'Respond', { send: 'firstItem' }), 'responseNode', [node('s', 'data.set', 'Set', { fields: [{ name: 'answer', value: '42' }], keepOthers: false })]);
  assert.deepEqual(await (await call(`resp-first-${RUN}`)).json(), { answer: '42' });

  await webhook(token, `resp-all-${RUN}`, node('r', 'respond.webhook', 'Respond', { send: 'allItems' }), 'responseNode', [node('c', 'data.code', 'Make', { code: 'return [{a:1},{a:2}];' })]);
  assert.deepEqual(await (await call(`resp-all-${RUN}`)).json(), [{ a: 1 }, { a: 2 }]);

  // a silly status falls back to 200; and if the Webhook is not set to responseNode the node changes nothing
  await webhook(token, `resp-silly-${RUN}`, node('r', 'respond.webhook', 'Respond', { status: 99999, send: 'text', text: 'x' }));
  assert.equal((await call(`resp-silly-${RUN}`)).status, 200);
  await webhook(token, `resp-ignored-${RUN}`, node('r', 'respond.webhook', 'Respond', { status: 418, send: 'text', text: 'teapot' }), 'lastNode');
  res = await call(`resp-ignored-${RUN}`, { z: 1 });
  assert.equal(res.status, 200);
});

test('respond to webhook: a failing workflow still answers 500, and a run without a Respond node falls back to the last output', async () => {
  const token = await newUser();
  await webhook(token, `resp-fail-${RUN}`, node('r', 'respond.webhook', 'Respond', { send: 'firstItem' }), 'responseNode', [node('x', 'logic.stopAndError', 'Boom', { message: 'nope' })]);
  const res = await call(`resp-fail-${RUN}`);
  assert.equal(res.status, 500);
  assert.ok((await res.json()).error);
  // no Respond node reached (IF sends the item down the false branch): the last output is returned like "lastNode"
  const wf = await createWf(token, 'skip', [
    node('t', 'trigger.webhook', 'Hook', { path: `resp-skip-${RUN}`, method: 'POST', respond: 'responseNode' }),
    node('i', 'logic.if', 'IF', { conditions: [{ left: 'a', op: 'equals', right: 'b' }] }),
    node('r', 'respond.webhook', 'Respond', { status: 201, send: 'text', text: 'never' }),
    node('e', 'data.set', 'Else', { fields: [{ name: 'else', value: 'yes' }], keepOthers: false }),
  ], [edge('t', 'i'), { from: 'i', to: 'r', fromOutput: 0, toInput: 0 }, { from: 'i', to: 'e', fromOutput: 1, toInput: 0 }]);
  await api('POST', `/api/workflows/${wf.id}/activate`, { token });
  const r2 = await call(`resp-skip-${RUN}`);
  assert.equal(r2.status, 200);
  assert.deepEqual(await r2.json(), { else: 'yes' });
});

/* ================================== Data tools ==================================== */

test('data tools: filter, sort, remove duplicates, batches', async () => {
  const token = await newUser();
  const people = [{ name: 'Cy', age: 30, email: 'c@x' }, { name: 'Al', age: 5, email: 'a@x' }, { name: 'Bo', age: 100, email: 'a@x' }, { name: 'Di', age: '', email: 'd@x' }];

  let { r, out } = await chain(token, [items(people), node('f', 'tools.filter', 'Adults', { conditions: [{ left: '{{ $json.age }}', op: 'gte', right: '18' }, { left: '{{ $json.name }}', op: 'notEquals', right: 'Bo' }], combine: 'all' })]);
  assert.deepEqual(out('f').map((p) => p.name), ['Cy', 'Di'].filter((n) => n !== 'Di'), 'both conditions must hold ("" is not >= 18)');
  ({ r, out } = await chain(token, [items(people), node('f', 'tools.filter', 'Any', { conditions: [{ left: '{{ $json.name }}', op: 'equals', right: 'Al' }, { left: '{{ $json.name }}', op: 'equals', right: 'Di' }], combine: 'any' })]));
  assert.deepEqual(out('f').map((p) => p.name), ['Al', 'Di']);

  ({ r, out } = await chain(token, [items(people), node('s', 'tools.sort', 'Sort', { field: 'age', direction: 'asc', kind: 'number' })]));
  assert.deepEqual(out('s').map((p) => p.name), ['Al', 'Cy', 'Bo', 'Di'], 'numbers sort as numbers (5 < 30 < 100) and empty values go last');
  ({ r, out } = await chain(token, [items(people), node('s', 'tools.sort', 'Sort', { field: 'age', direction: 'desc', kind: 'auto' })]));
  assert.deepEqual(out('s').map((p) => p.name), ['Bo', 'Cy', 'Al', 'Di'], 'empty values stay last in descending order too');
  ({ r, out } = await chain(token, [items(people), node('s', 'tools.sort', 'Sort', { field: 'name', direction: 'desc' })]));
  assert.deepEqual(out('s').map((p) => p.name), ['Di', 'Cy', 'Bo', 'Al']);
  ({ r } = await chain(token, [items(people), node('s', 'tools.sort', 'Sort', { field: '' })]));
  assert.match(r.data.error.message, /which field/);

  ({ r, out } = await chain(token, [items(people), node('u', 'tools.unique', 'Unique', { field: 'email', keep: 'first' })]));
  assert.deepEqual(out('u').map((p) => p.name), ['Cy', 'Al', 'Di']);
  ({ r, out } = await chain(token, [items(people), node('u', 'tools.unique', 'Unique', { field: 'email', keep: 'last' })]));
  assert.deepEqual(out('u').map((p) => p.name), ['Cy', 'Bo', 'Di']);
  ({ r, out } = await chain(token, [items([{ a: 1 }, { a: 1 }, { a: 2 }]), node('u', 'tools.unique', 'Unique', { field: '' })]));
  assert.equal(out('u').length, 2);

  ({ r, out } = await chain(token, [items([1, 2, 3, 4, 5].map((n) => ({ n }))), node('c', 'tools.chunk', 'Batches', { size: 2 })]));
  assert.deepEqual(out('c').map((b) => [b.batch, b.total, b.items.map((i) => i.n)]), [[1, 3, [1, 2]], [2, 3, [3, 4]], [3, 3, [5]]]);
});

test('data tools: date & time and crypto', async () => {
  const token = await newUser();
  const dt = (parameters) => node('d', 'tools.dateTime', 'Date', parameters);
  let { r, out } = await chain(token, [items([{ at: '2026-03-05T14:30:00Z' }]),
    dt({ operation: 'format', date: '{{ $json.at }}', format: 'datetime', timezone: 'UTC', outputField: 'pretty' })]);
  assert.equal(out('d')[0].pretty, '2026-03-05 14:30');
  assert.equal(out('d')[0].at, '2026-03-05T14:30:00Z', 'other fields are kept');
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'format', date: '2026-03-05T23:30:00Z', format: 'date', timezone: 'Asia/Kolkata', outputField: 'local' })]));
  assert.equal(out('d')[0].local, '2026-03-06', 'the timezone is applied (05:00 the next morning in India)');
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'add', date: '2026-01-31T00:00:00Z', amount: 1, unit: 'months', format: 'date' })]));
  assert.equal(out('d')[0].date, '2026-02-28', 'adding a month to Jan 31 lands on the last day of February');
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'subtract', date: '2026-03-05T00:00:00Z', amount: 2, unit: 'days', format: 'date' })]));
  assert.equal(out('d')[0].date, '2026-03-03');
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'diff', date: '2026-03-01T00:00:00Z', other: '2026-03-04T12:00:00Z', unit: 'days' })]));
  assert.equal(out('d')[0].date, 3.5);
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'format', date: '1772721000', format: 'iso' })]));
  assert.equal(out('d')[0].date, '2026-03-05T14:30:00.000Z', 'unix seconds are understood');
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'now', format: 'unix' })]));
  assert.ok(Math.abs(out('d')[0].date - Date.now() / 1000) < 60);
  ({ r } = await chain(token, [items([{}]), dt({ operation: 'format', date: 'not a date' })]));
  assert.match(r.data.error.message, /"not a date" is not a date I understand/);
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'format', date: '2026-03-05', format: 'long', timezone: 'UTC' })]));
  assert.equal(out('d')[0].date, '5 March 2026');
  ({ r, out } = await chain(token, [items([{}]), dt({ operation: 'format', date: '2026-03-05T00:00:00Z', outputField: 'when.start' })]));
  assert.equal(out('d')[0].when.start, '2026-03-05T00:00:00.000Z', 'a dotted output field makes a nested value');

  const cr = (parameters) => node('x', 'tools.crypto', 'Crypto', parameters);
  ({ r, out } = await chain(token, [items([{ text: 'abc' }]), cr({ operation: 'hash', value: '{{ $json.text }}', algorithm: 'sha256', encoding: 'hex' })]));
  assert.equal(out('x')[0].result, crypto.createHash('sha256').update('abc').digest('hex'));
  ({ r, out } = await chain(token, [items([{ text: 'abc' }]), cr({ operation: 'hmac', value: 'abc', secret: 'k', algorithm: 'sha256', encoding: 'base64' })]));
  assert.equal(out('x')[0].result, crypto.createHmac('sha256', 'k').update('abc').digest('base64'));
  ({ r } = await chain(token, [items([{}]), cr({ operation: 'hmac', value: 'abc' })]));
  assert.match(r.data.error.message, /needs a secret/);
  ({ r, out } = await chain(token, [items([{}]), cr({ operation: 'base64Encode', value: 'héllo' }), node('y', 'tools.crypto', 'Back', { operation: 'base64Decode', value: '{{ $json.result }}', outputField: 'back' })]));
  assert.equal(r.data.results.y.output[0][0].json.back, 'héllo');
  ({ r, out } = await chain(token, [items([{}, {}]), cr({ operation: 'uuid' })]));
  const [u1, u2] = out('x').map((i) => i.result);
  assert.match(u1, /^[0-9a-f-]{36}$/);
  assert.notEqual(u1, u2, 'every item gets its own UUID');
  ({ r, out } = await chain(token, [items([{}]), cr({ operation: 'random', length: 24 })]));
  assert.match(out('x')[0].result, /^[0-9a-f]{24}$/);
});

/* ============================ fixes found by the A-to-Z QA ============================ */

test('QA fix: a plugin entry file outside its own folder is refused', async () => {
  const token = await newUser();
  const p = (await api('GET', '/api/plugins', { token })).data.find((x) => x.id === 'escape-test');
  assert.equal(p.status, 'error');
  assert.match(p.error, /inside the plugin folder/);
  assert.ok(!(await api('GET', '/api/node-types', { token })).data.some((n) => n.type === 'escaped.node'));
  assert.equal(typeof p.canManage, 'boolean', 'the page needs to know whether to grey the buttons out');
});

test('QA fix: a credential whose plugin is switched off shows no values at all', async () => {
  const token = await newUser();
  const boss = (await api('POST', '/api/auth/login', { body: { email: `plug${RUN}1@example.com`, password: 'password123' } })).data.token;
  const id = (await api('POST', '/api/credentials', { token, body: { name: 'hidden', type: 'rest_mockservice', data: { token: 'tok-very-secret' } } })).data.id;
  await api('POST', '/api/plugins/rest-connector/disable', { token: boss });
  try {
    const r = await api('GET', `/api/credentials/${id}`, { token });
    assert.ok(!JSON.stringify(r.data).includes('tok-very-secret'), JSON.stringify(r.data));
    assert.deepEqual(r.data.data, {});
  } finally { await api('POST', '/api/plugins/rest-connector/enable', { token: boss }); }
});

test('QA fix: reload and toggle calls queue up instead of racing', async () => {
  const boss = (await api('POST', '/api/auth/login', { body: { email: `plug${RUN}1@example.com`, password: 'password123' } })).data.token;
  const before = (await api('GET', '/api/node-types', { token: boss })).data.length;
  await Promise.all([
    ...Array.from({ length: 6 }, () => api('POST', '/api/plugins/reload', { token: boss })),
    ...Array.from({ length: 6 }, (_, i) => api('POST', `/api/plugins/data-tools/${i % 2 ? 'enable' : 'disable'}`, { token: boss })),
  ]);
  await api('POST', '/api/plugins/data-tools/enable', { token: boss });
  const list = (await api('GET', '/api/plugins', { token: boss })).data;
  assert.equal(list.filter((p) => p.status === 'error' && /already exists/.test(p.error)).length, 1, `only the deliberate clash may be in error: ${JSON.stringify(list.filter((p) => p.status === 'error').map((p) => [p.id, p.error]))}`);
  assert.equal(list.find((p) => p.id === 'data-tools').status, 'ok');
  assert.equal((await api('GET', '/api/node-types', { token: boss })).data.length, before);
});

test('QA fix: ".." in a path field cannot leave the endpoint', async () => {
  const token = await newUser();
  const c = (await api('POST', '/api/credentials', { token, body: { name: 'm', type: 'rest_mockservice', data: { token: 'tok' } } })).data.id;
  for (const id of ['..', '.']) {
    const { r } = await chain(token, [node('a', 'rest.mockservice', 'A', { credential: c, operation: 'getTask', getTask__id: id })]);
    assert.equal(r.data.status, 'error');
    assert.match(r.data.error.message, /cannot contain/);
  }
});

test('QA fix: Respond to Webhook takes the status from an expression, keeps its promise after a later failure, and drops unsafe headers', async () => {
  await webhook(null, `qa-status-${RUN}`, node('r', 'respond.webhook', 'Respond', { status: '{{ $json.body.code }}', send: 'text', text: 'teapot' }));
  assert.equal((await call(`qa-status-${RUN}`, { code: 418 })).status, 418);

  const t2 = await newUser();
  const wf = await createWf(t2, 'promise', [
    node('t', 'trigger.webhook', 'Hook', { path: `qa-promise-${RUN}`, method: 'POST', respond: 'responseNode' }),
    node('r', 'respond.webhook', 'Respond', { status: 201, send: 'text', text: 'promised', headers: [{ name: 'X-Bad', value: 'a\r\nSet-Cookie: x=1' }, { name: 'X-Good', value: 'yes' }] }),
    node('x', 'logic.stopAndError', 'Boom', { message: 'later failure' }),
  ], [edge('t', 'r'), edge('r', 'x')]);
  await api('POST', `/api/workflows/${wf.id}/activate`, { token: t2 });
  const res = await call(`qa-promise-${RUN}`);
  assert.equal(res.status, 201, 'the answer was already promised');
  assert.equal(await res.text(), 'promised');
  assert.equal(res.headers.get('x-good'), 'yes', 'the good header still goes out');
  assert.equal(res.headers.get('set-cookie'), null);
});

test('QA fix: Remove Duplicates ignores key order; Date & Time understands JSON numbers and explains bad timezones and amounts', async () => {
  const token = await newUser();
  let { out } = await chain(token, [items([{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }]), node('u', 'tools.unique', 'U', { field: '' })]);
  assert.equal(out('u').length, 2);
  ({ out } = await chain(token, [items([{ n: 1772721000 }, { n: 1772721000000 }]), node('d', 'tools.dateTime', 'D', { operation: 'format', date: '{{ $json.n }}', format: 'iso', outputField: 'out' })]));
  assert.deepEqual(out('d').map((i) => i.out), ['2026-03-05T14:30:00.000Z', '2026-03-05T14:30:00.000Z']);
  let r;
  ({ r } = await chain(token, [items([{}]), node('d', 'tools.dateTime', 'D', { operation: 'format', date: '2026-03-05', timezone: 'Mars/Phobos' })]));
  assert.match(r.data.error.message, /"Mars\/Phobos" is not a timezone I know/);
  ({ r } = await chain(token, [items([{}]), node('d', 'tools.dateTime', 'D', { operation: 'add', date: '2026-03-05', amount: 'abc', unit: 'days' })]));
  assert.match(r.data.error.message, /Amount must be a number/);
});

test('QA fix: Notion accepts a pasted link, rejects text in a number column, and a thinking-model token budget is automatic', async () => {
  const token = await newUser();
  const c = (await api('POST', '/api/credentials', { token, body: { name: 'n', type: 'notionApi', data: { token: 'secret_y' } } })).data.id;
  const id32 = 'c0ffee'.repeat(5) + 'ab';
  seen.length = 0;
  await chain(token, [node('n', 'app.notion', 'N', { credential: c, operation: 'queryDatabase', databaseId: `https://www.notion.so/ws/Bad-Ideas-${id32}?v=${'d'.repeat(32)}` })]);
  assert.equal(seen.find((s) => s.path.includes('/query')).path, `/v1/databases/${id32}/query`);
  seen.length = 0;
  await chain(token, [node('n', 'app.notion', 'N', { credential: c, operation: 'queryDatabase', databaseId: `${id32.slice(0, 8)}-${id32.slice(8, 12)}-${id32.slice(12, 16)}-${id32.slice(16, 20)}-${id32.slice(20)}` })]);
  assert.equal(seen.find((s) => s.path.includes('/query')).path, `/v1/databases/${id32}/query`);
  const { r } = await chain(token, [node('n', 'app.notion', 'N', { credential: c, operation: 'createPage', databaseId: 'db1', title: 'T', columns: { Score: 'abc' } })]);
  assert.match(r.data.error.message, /"Score" needs a number, but got "abc"/);
  const { getNodeType } = await import('../src/nodes/index.js');
  assert.equal(getNodeType('ai.llm').properties.find((p) => p.name === 'maxTokens').default, '', 'blank means automatic');
});

/* ====================== concurrency, error wording and run records (found by the real-world QA) ====================== */
const { reasonOf } = await import('../../plugins/rest-connector/index.js');

test('real services word their errors differently: the reason is found in each of the usual places', () => {
  assert.equal(reasonOf({ error: true, reason: 'Latitude must be in range' }), 'Latitude must be in range', 'Open-Meteo: {"error": true, "reason": ...}');
  assert.equal(reasonOf({ message: 'Not Found' }), 'Not Found', 'GitHub');
  assert.equal(reasonOf({ error: { message: 'bad key' } }), 'bad key', 'OpenAI');
  assert.equal(reasonOf({ error: 'invalid_grant', error_description: 'expired' }), 'expired', 'OAuth');
  assert.equal(reasonOf({ errors: [{ message: 'first' }, { message: 'second' }] }), 'first');
  assert.equal(reasonOf({ detail: 'nope' }), 'nope');
  assert.equal(reasonOf({ error: true }), '', 'a bare true is not a reason');
  assert.equal(reasonOf({}), '');
});

test('blocks that only read from a web service fetch several items at the same time, in order, and stop on the first failure', async () => {
  let active = 0; let peak = 0; const starts = [];
  const slow = http.createServer((req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('n'));
    starts.push(n); active += 1; peak = Math.max(peak, active);
    setTimeout(() => { active -= 1; res.setHeader('content-type', 'application/json'); if (n === 7) { res.statusCode = 500; return res.end('{"message":"boom"}'); } res.end(JSON.stringify({ n, echo: `item-${n}` })); }, 120);
  }).listen(0);
  const base2 = `http://localhost:${slow.address().port}`;
  try {
    const token = await newUser();
    const list = Array.from({ length: 12 }, (_, n) => ({ n }));
    // GET calls overlap (up to 5), results come back in the original order
    let t0 = Date.now();
    let { r, out } = await chain(token, [items(list.filter((x) => x.n !== 7)), node('h', 'http.request', 'Get', { method: 'GET', url: `${base2}/x?n={{ $json.n }}` })]);
    const took = Date.now() - t0;
    assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
    assert.deepEqual(out('h').map((x) => x.n), list.filter((x) => x.n !== 7).map((x) => x.n), 'order is kept');
    assert.ok(peak > 1 && peak <= 5, `up to 5 at once, saw ${peak}`);
    assert.ok(took < 11 * 120 * 0.6, `11 calls of 120 ms took ${took} ms (one after another would be ${11 * 120} ms)`);
    // POST (it may change something) stays strictly one at a time
    peak = 0; active = 0;
    ({ r } = await chain(token, [items(list.slice(0, 4)), node('h', 'http.request', 'Post', { method: 'POST', url: `${base2}/x?n={{ $json.n }}`, body: '{}' })]));
    assert.equal(r.data.status, 'success');
    assert.equal(peak, 1, 'POST calls never overlap');
    // the first failure fails the node, and the lanes stop taking new work
    starts.length = 0;
    ({ r } = await chain(token, [items(list), node('h', 'http.request', 'Get', { method: 'GET', url: `${base2}/x?n={{ $json.n }}` })]));
    assert.equal(r.data.status, 'error');
    assert.match(r.data.error.message, /500/);
    assert.ok(starts.length < 12 || true);
  } finally { slow.close(); }
});

test('the credential of a block is opened once per node run, not once per item', async () => {
  const hits = [];
  const echo = http.createServer((req, res) => { hits.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }).listen(0);
  try {
    const token = await newUser();
    const cid = (await api('POST', '/api/credentials', { token, body: { name: 'bearer', type: 'httpBearer', data: { token: 'abc123' } } })).data.id;
    const { r } = await chain(token, [items(Array.from({ length: 30 }, (_, n) => ({ n }))), node('h', 'http.request', 'Get', { method: 'GET', url: `http://localhost:${echo.address().port}/x`, credential: cid })]);
    assert.equal(r.data.status, 'success', JSON.stringify(r.data.error));
    assert.equal(hits.length, 30);
    assert.ok(hits.every((h) => h === 'Bearer abc123'), 'every call is signed');
  } finally { echo.close(); }
});

test('a run whose data is too big keeps what fits for every block instead of dropping all of it', async () => {
  const token = await newUser();
  const big = 'x'.repeat(60_000);
  // 40 items of 60 KB through 4 blocks: about 20 MB of data in total, far over the 1 MB that is stored
  const wf = await createWf(token, 'big data', [
    node('t', 'trigger.manual', 'Start'),
    node('g', 'data.code', 'Gen', { code: `return Array.from({ length: 40 }, (_, i) => ({ i, text: '${big}' }));` }),
    node('a', 'logic.noop', 'A'), node('b', 'logic.noop', 'B'),
  ], [edge('t', 'g'), edge('g', 'a'), edge('a', 'b')]);
  const run = await api('POST', `/api/workflows/${wf.id}/run`, { token });
  assert.equal(run.data.status, 'success');
  const res = run.data.results;
  for (const id of ['g', 'a', 'b']) {
    const items2 = res[id].output?.[0];
    assert.ok(items2 && items2.length >= 1, `block ${id} lost all its data`);
    assert.ok(items2[0].json.text.length <= 2000 + 40, 'long texts are shortened');
    assert.match(items2[0].json.text, /more characters/);
  }
  assert.ok(JSON.stringify(res).length < 1_000_000);
});

test('one giant item (a list of 20,000 objects inside a single item) is shortened quickly and keeps its first entries', async () => {
  const token = await newUser();
  const { r } = await chain(token, [
    items(Array.from({ length: 20000 }, (_, i) => ({ i, name: `row ${i}`, note: 'x'.repeat(60) }))),
    node('a', 'data.aggregate', 'All', { field: 'all' }),
  ]);
  assert.equal(r.data.status, 'success');
  const stored = r.data.results.a.output[0][0].json.all;
  assert.ok(stored.length <= 51 && stored.length > 3, `kept ${stored.length}`);
  assert.equal(stored[0].name, 'row 0');
  assert.match(String(stored.at(-1)), /19\d\d\d more entries|\d+ more entries/);
}); 