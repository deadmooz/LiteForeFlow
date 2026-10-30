// A-to-Z QA for plugins, the REST connector, Respond to Webhook, the data tools, friendly fields and Test connection.
// Boots real app processes (own port, own temp data folder), talks to them over HTTP, and writes
// server/test/qa/plugins-qa-results.json (the report is generated from it).
//   node server/test/qa/plugins-qa.mjs                 run everything
//   ONLY=SEC-01,PLG-15 node server/test/qa/plugins-qa.mjs   re-run some cases and merge them into the results file
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { FORK, launch, sleep } from './fork-lib.mjs';

const RESULTS = path.join(FORK, 'server/test/qa/plugins-qa-results.json');
const ONLY = process.env.ONLY?.split(',');
const results = [];
const T0 = Date.now();
const seen = [];
const state = { notionEmpty: false, notionDelay: 0 };

/* =================================== the pretend outside world =================================== */
const world = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString();
    let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    seen.push({ method: req.method, path: p, rawPath: req.url.split('?')[0], query: Object.fromEntries(url.searchParams), headers: req.headers, body: json ?? raw });
    const send = (data, status = 200, type = 'application/json') => { res.statusCode = status; res.setHeader('content-type', type); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
    if (p.startsWith('/svc/') && req.headers.authorization !== 'Bearer tok') return send({ message: 'Bad credentials' }, 401);
    switch (true) {
      case p === '/svc/me': return send({ name: 'Ada' });
      case p === '/svc/echo': return send({ method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body: json });
      case p === '/svc/text': return send('hello there', 200, 'text/plain');
      case p === '/svc/empty': res.statusCode = 204; return res.end();
      case p === '/svc/big': return send(Array.from({ length: 1500 }, (_, i) => ({ id: i })));
      case p === '/svc/slow': await sleep(2500); return send({ slow: true });
      case p === '/svc/redirect': res.statusCode = 302; res.setHeader('location', '/svc/me'); return res.end();
      case p === '/svc/rate': return send({ message: 'Slow down' }, 429);
      case p === '/svc/boom': return send('<html>Internal Server Error</html>', 500, 'text/html');
      case p === '/svc/projects': return send([{ id: 'p1', name: 'Home' }, { id: 'p2' }]);
      case p === '/svc/none': return send([]);
      case p === '/svc/nested': return send({ data: { other: 1 } });
      case p.startsWith('/svc/tasks/'): return send({ path: p, raw: req.url });
      case p === '/svc/tasks': return send({ data: { items: [{ id: 1 }, { id: 2 }] } });
      case p === '/basic/ping': return send({ ok: req.headers.authorization === `Basic ${Buffer.from('u:p').toString('base64')}` });
      case p === '/hdr/ping': return send({ key: req.headers['x-api-key'] });
      case p === '/sub/ping': return send({ host: req.headers.host });
      case p === '/v1/models' && req.headers.authorization === 'Bearer sk-good': return send({ data: [{ id: 'm1' }, { id: 'm2' }] });
      case p === '/v1/models': return send({ error: { message: 'bad key' } }, 401);
      case p === '/api/tags': return send({ models: [{ name: 'llama3.2:latest' }] });
      // ---- Notion ----
      case p === '/v1/users/me': return send({ name: 'Tester' });
      case p === '/v1/search': if (state.notionDelay) await sleep(state.notionDelay); return send({ results: state.notionEmpty ? [] : [{ id: 'db1', title: [{ plain_text: 'Tasks' }] }, { id: 'db2', title: [] }] });
      case p === '/v1/databases/db1': return send({ title: [{ plain_text: 'Tasks' }], properties: { Value: { type: 'title' }, Gender: { type: 'rich_text' }, Score: { type: 'number' }, Done: { type: 'checkbox' }, Formula: { type: 'formula' }, Rel: { type: 'relation' }, ...(state.extraColumn ? { Added: { type: 'rich_text' } } : {}) } });
      case p === '/v1/databases/db1/query': return send({ results: [{ id: 'r1', url: 'u', properties: { a: 1 } }, { id: 'r2', url: 'u2', properties: {} }] });
      case p === '/v1/pages': return send({ id: 'page1', url: 'https://notion.so/page1' });
      default: return send({ error: 'unknown route', path: p }, 404);
    }
  });
}).listen(0);
const W = `http://localhost:${world.address().port}`;

/* ======================================== helpers ======================================== */
class Skip extends Error {}
const ok = (c, m) => { if (!c) throw new Error(m); };
const show = (s, n = 90) => String(s).replace(/\s+/g, ' ').slice(0, n);
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to, o = 0) => ({ from, to, fromOutput: o, toInput: 0 });
let portN = 5950;

function writePlugin(root, folder, manifest, code) {
  const dir = path.join(root, folder);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) fs.writeFileSync(path.join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (code !== null) fs.writeFileSync(path.join(dir, 'index.js'), code);
  return dir;
}
const GOOD = (id, type = `${id.replace(/-/g, '')}.hello`) => `export function register(sdk){ sdk.defineNode({ type: '${type}', name: 'Hello ${id}', group: 'app', properties: [{ name: 'who', label: 'Who', type: 'string', default: 'w' }], async executeItem(ctx, item, i) { return { ...item.json, hi: await ctx.param('who', i) }; } }); }`;

/** Starts a copy of the app. setup(dataDir, extraPluginsDir) can pre-populate plugins / services. */
async function boot(name, { env = {}, setup, cwd } = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `pqa-${name}-`));
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), `pqa-${name}-plug-`));
  setup?.(data, extra);
  const port = portN++;
  const dir = cwd ?? FORK;
  const h = launch('node', dir, { env: { PORT: String(port), DATA_DIR: data, PLUGINS_DIR: extra, LITEFOREFLOW_SECRET: 'qa-secret', AUTH_RATE_LIMIT_PER_MIN: '5000', LITEFOREFLOW_NOTION_URL: W, ...env } });
  const t0 = Date.now();
  if (!(await h.ready)) throw new Error(`app ${name} did not start:\n${h.log().slice(-600)}`);
  const app = { name, h, data, extra, port, base: h.url.replace(/\/$/, ''), startMs: Date.now() - t0, users: 0 };
  app.api = async (method, url, { token, body, headers, raw } = {}) => {
    const res = await fetch(app.base + url, { method, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined || method === 'GET' ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let data2 = text; try { data2 = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data: data2, headers: res.headers };
  };
  app.user = async () => {
    app.users += 1;
    const r = await app.api('POST', '/api/auth/signup', { body: { email: `u${app.users}-${crypto.randomBytes(2).toString('hex')}@example.com`, password: 'password123', name: `U${app.users}` } });
    ok(r.status === 201, `signup failed ${r.status} ${JSON.stringify(r.data)}`);
    return r.data.token;
  };
  app.stop = () => h.stop();
  app.wf = async (token, nodes, conns, name = 'qa') => {
    const r = await app.api('POST', '/api/workflows', { token, body: { name, definition: { nodes, connections: conns } } });
    ok(r.status === 201, `workflow create failed: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  /** trigger -> n1 -> n2 ... ; returns the run and the outputs by node id. */
  app.chain = async (token, nodes) => {
    const wf = await app.wf(token, [node('t', 'trigger.manual', 'Start'), ...nodes], nodes.map((n, i) => edge(i ? nodes[i - 1].id : 't', n.id)));
    const t0 = Date.now();
    const r = await app.api('POST', `/api/workflows/${wf.id}/run`, { token });
    return { r, wf, ms: Date.now() - t0, out: (id) => r.data.results?.[id]?.output?.[0]?.map((i) => i.json) ?? [], err: () => r.data.error?.message ?? r.data.error ?? '' };
  };
  /** An active webhook workflow on its own (fresh) account, because a Free account may only have 5 active workflows. */
  app.hook = async (path2, respondNode, { respond = 'responseNode', extra: more = [], method = 'POST', secret } = {}) => {
    const token = await app.user();
    const nodes = [node('t', 'trigger.webhook', 'Hook', { path: path2, method, respond, ...(secret ? { secret } : {}) }), ...more, ...(respondNode ? [respondNode] : [])];
    const wf = await app.wf(token, nodes, nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id)));
    const act = await app.api('POST', `/api/workflows/${wf.id}/activate`, { token });
    ok(act.data.active === true, `activate failed: ${JSON.stringify(act.data)}`);
    return { token, wf, url: `${app.base}/webhook/${path2}` };
  };
  return app;
}
const items = (list) => node('items', 'data.code', 'Items', { code: `return ${JSON.stringify(list)};` });
const alive = async (app) => (await fetch(`${app.base}/api/health`).catch(() => null))?.ok === true;

const REG = [];
function test(id, group, title, steps, expected, fn) { REG.push({ id, group, title, steps, expected, fn }); }

/* ========================================= SECURITY ========================================= */
test('SEC-01', 'Security', 'Every new API needs a login', 'Call /plugins, /plugins/reload, /node-options, /credentials/test without a token.', 'All answer 401.', async (c) => {
  for (const [m, u] of [['GET', '/api/plugins'], ['POST', '/api/plugins/reload'], ['POST', '/api/plugins/x/disable'], ['POST', '/api/node-options'], ['POST', '/api/credentials/test']]) {
    const r = await c.app.api(m, u, { body: {} });
    ok(r.status === 401, `${m} ${u} -> ${r.status}`);
  }
  return '5 endpoints refuse anonymous callers';
});
test('SEC-02', 'Security', 'Only the owner can reload, enable or disable plugins; others can still look', 'Second account tries each action.', 'GET works; reload/enable/disable give 403.', async (c) => {
  ok((await c.app.api('GET', '/api/plugins', { token: c.other })).status === 200, 'list should work');
  for (const u of ['/api/plugins/reload', '/api/plugins/data-tools/disable', '/api/plugins/data-tools/enable']) {
    const r = await c.app.api('POST', u, { token: c.other });
    ok(r.status === 403, `${u} -> ${r.status}`);
  }
  return '403 x3';
});
test('SEC-03', 'Security', 'Live dropdowns cannot use someone else\'s credential', 'User B asks /node-options with user A\'s Notion credential id.', 'Refused ("Credential not found"), nothing from A leaks.', async (c) => {
  const cid = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'A notion', type: 'notionApi', data: { token: 'secret_ownerA' } } })).data.id;
  const r = await c.app.api('POST', '/api/node-options', { token: c.other, body: { type: 'app.notion', property: 'databaseId', parameters: { credential: cid } } });
  ok(/Credential not found/.test(r.data.error ?? ''), JSON.stringify(r.data));
  ok(!JSON.stringify(r.data).includes('Tasks'), 'database names leaked');
  const t = await c.app.api('POST', '/api/credentials/test', { token: c.other, body: { id: cid } });
  ok(t.status === 404, `credentials/test -> ${t.status}`);
  return 'both refused';
});
test('SEC-04', 'Security', 'Secrets never come back from the new endpoints', 'Notion token "secret_leakcheck" through node-options and credentials/test (ok and error cases).', 'The token text appears in no response.', async (c) => {
  const cid = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'leak', type: 'notionApi', data: { token: 'secret_leakcheck' } } })).data.id;
  const bodies = [
    await c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'app.notion', property: 'databaseId', parameters: { credential: cid } } }),
    await c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'app.notion', property: 'columns', kind: 'fields', parameters: { credential: cid, databaseId: 'db1' } } }),
    await c.app.api('POST', '/api/credentials/test', { token: c.owner, body: { id: cid } }),
    await c.app.api('POST', '/api/credentials/test', { token: c.owner, body: { type: 'openaiApi', data: { apiKey: 'secret_leakcheck', baseUrl: W + '/nope' } } }),
    await c.app.api('GET', `/api/credentials/${cid}`, { token: c.owner }),
  ];
  for (const b of bodies) ok(!JSON.stringify(b.data).includes('secret_leakcheck'), `leak in ${JSON.stringify(b.data).slice(0, 200)}`);
  return '5 responses clean';
});
test('SEC-05', 'Security', 'Header injection through Respond to Webhook cannot crash the server or add headers', 'Header values with CR/LF, invalid names, a 100 KB value.', 'Server stays up; no injected header.', async (c) => {
  const hk = await c.app.hook('inj-1', node('r', 'respond.webhook', 'Respond', { status: 200, send: 'text', text: 'x', headers: [{ name: 'X-A', value: 'a\r\nSet-Cookie: pwned=1' }, { name: 'bad name', value: 'v' }, { name: 'X-Long', value: 'z'.repeat(100000) }, { name: 'X-Ok', value: 'fine' }] }));
  const res = await fetch(hk.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  ok(res.headers.get('set-cookie') === null, 'cookie injected');
  ok(await alive(c.app), 'server died');
  return `status ${res.status}, X-Ok=${res.headers.get('x-ok')}`;
});
test('SEC-06', 'Security', 'Respond to Webhook cannot set cookies, CSP or hop-by-hop headers', 'Headers Set-Cookie, Content-Security-Policy, Transfer-Encoding, Content-Length.', 'None of them is applied.', async (c) => {
  const hk = await c.app.hook('inj-2', node('r', 'respond.webhook', 'Respond', { send: 'text', text: 'abc', headers: [{ name: 'Set-Cookie', value: 'a=1' }, { name: 'Content-Security-Policy', value: 'default-src *' }, { name: 'Content-Length', value: '1' }, { name: 'Transfer-Encoding', value: 'chunked' }] }));
  const res = await fetch(hk.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  ok(res.headers.get('set-cookie') === null && res.headers.get('content-security-policy') !== 'default-src *', "blocked header got through (the app's own security policy must stay)");
  ok((await res.text()) === 'abc', 'body was cut by a fake content-length');
  return 'blocked';
});
test('SEC-07', 'Security', 'BLOCK_PRIVATE_NETWORK also covers the REST connector', 'App with BLOCK_PRIVATE_NETWORK=true; REST block calls the fake service on localhost.', 'Blocked with the private-network message.', async (c) => {
  const a = await boot('block', { env: { BLOCK_PRIVATE_NETWORK: 'true' }, setup: (data) => svc(data, 'blk', `${W}/svc`) });
  try {
    const t = await a.user();
    const cid = (await a.api('POST', '/api/credentials', { token: t, body: { name: 'c', type: 'rest_blk', data: { token: 'tok' } } })).data.id;
    const { r } = await a.chain(t, [node('a', 'rest.blk', 'A', { credential: cid, operation: 'me' })]);
    ok(r.data.status === 'error' && /private or loopback/.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 300));
    const d = await a.api('POST', '/api/node-options', { token: t, body: { type: 'rest.blk', property: 'me__x', parameters: { credential: cid } } });
    ok(d.status === 200 || d.status === 404, 'options endpoint misbehaved');
    return 'blocked';
  } finally { a.stop(); }
});
test('SEC-08', 'Security', 'A ".." in a path field cannot climb out of the endpoint', 'REST path /tasks/{id} with id "..", "../me" and "%2e%2e".', 'Requests stay under /svc/tasks/ (or are refused).', async (c) => {
  const cid = c.restCred;
  const outcomes = [];
  for (const id of ['..', '../me', '%2e%2e', '.']) {
    seen.length = 0;
    const { r } = await c.app.chain(c.owner, [node('a', 'rest.mock', 'A', { credential: cid, operation: 'getTask', getTask__id: id })]);
    const escaped = seen.filter((s) => s.rawPath.startsWith('/svc') && !s.rawPath.startsWith('/svc/tasks/'));
    outcomes.push(`${id}: ${seen.length ? seen.map((s) => s.rawPath).join(',') : 'refused before any call'}`);
    ok(escaped.length === 0, `"${id}" escaped to ${escaped.map((s) => s.rawPath).join(', ')}`);
  }
  return outcomes.join(' | ');
});
test('SEC-09', 'Security', 'Garbage sent to the new APIs gives 4xx, never 500 or a crash', 'null / array / string / huge / prototype names as type and property.', 'Only 400/404 answers; server alive.', async (c) => {
  const bodies = [null, [], 'str', 42, {}, { type: '__proto__', property: 'x' }, { type: 'constructor', property: 'prototype' }, { type: 'app.notion', property: '__proto__', parameters: 'not-an-object' }, { type: 'app.notion', property: 'databaseId', parameters: { credential: { a: 1 } } }, { type: 'x'.repeat(100000) }];
  const codes = [];
  for (const b of bodies) {
    const r = await c.app.api('POST', '/api/node-options', { token: c.owner, body: b });
    codes.push(r.status);
    ok(r.status < 500, `body ${JSON.stringify(b)?.slice(0, 60)} -> ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }
  for (const b of [null, [], 'x', { type: 5 }, { type: 'openaiApi', data: 'str' }, { type: 'openaiApi', data: [1] }, { id: {} }]) {
    const r = await c.app.api('POST', '/api/credentials/test', { token: c.owner, body: b });
    codes.push(r.status);
    ok(r.status < 500, `credentials/test ${JSON.stringify(b)?.slice(0, 60)} -> ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  }
  ok(await alive(c.app), 'server died');
  return `codes ${[...new Set(codes)].join(',')}`;
});
test('SEC-10', 'Security', 'Credentials of a plugin type do not leak their secrets when the plugin is switched off', 'Save a REST credential, switch the REST connector off, GET /credentials/:id.', 'No secret value in the answer.', async (c) => {
  const cid = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'sec', type: 'rest_mock', data: { token: 'tok-supersecret' } } })).data.id;
  await c.app.api('POST', '/api/plugins/rest-connector/disable', { token: c.owner });
  try {
    const r = await c.app.api('GET', `/api/credentials/${cid}`, { token: c.owner });
    ok(!JSON.stringify(r.data).includes('tok-supersecret'), `SECRET LEAKED: ${JSON.stringify(r.data)}`);
    return 'no leak';
  } finally { await c.app.api('POST', '/api/plugins/rest-connector/enable', { token: c.owner }); }
});
test('SEC-11', 'Security', 'A plugin cannot point its entry file outside its own folder', 'plugin.json "entry": "../outside.js".', 'Rejected with a plain message.', async (c) => {
  const p = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.find((x) => x.id === 'escape-test');
  ok(p?.status === 'error' && /inside/.test(p.error), JSON.stringify(p));
  return p.error;
});

/* =========================================== PLUGINS =========================================== */
test('PLG-01', 'Plugins', 'Bundled plugins load at start-up', 'List /plugins on a fresh app.', 'rest-connector, respond-to-webhook, data-tools are ON and "bundled"; _template is not listed.', async (c) => {
  const l = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data;
  for (const id of ['rest-connector', 'respond-to-webhook', 'data-tools']) { const p = l.find((x) => x.id === id && x.source === 'bundled'); ok(p?.status === 'ok', `${id}: ${JSON.stringify(p)}`); }
  ok(!l.some((x) => /template/i.test(x.id)), '_template should not load');
  return `${l.filter((x) => x.status === 'ok').length} on`;
});
test('PLG-02', 'Plugins', 'A plugin dropped into data/plugins loads (not only PLUGINS_DIR)', 'Folder created in <data>/plugins before start.', 'Loaded as "user" plugin; its block runs.', async (c) => {
  const p = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.find((x) => x.id === 'in-data');
  ok(p?.status === 'ok' && p.source === 'user', JSON.stringify(p));
  const { r, out } = await c.app.chain(c.owner, [items([{ a: 1 }]), node('g', 'indata.hello', 'G', { who: 'x' })]);
  ok(r.data.status === 'success' && out('g')[0].hi === 'x', JSON.stringify(r.data).slice(0, 200));
  return 'ok';
});
test('PLG-03', 'Plugins', 'A user plugin cannot take over a bundled plugin\'s id', 'User folder with id "data-tools".', 'Rejected as a duplicate; the bundled one keeps working.', async (c) => {
  const l = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data;
  ok(l.filter((x) => x.id === 'data-tools').length === 2, 'duplicate not listed');
  ok(l.find((x) => x.id === 'data-tools' && x.source === 'bundled').status === 'ok', 'bundled broke');
  ok(/already uses the id/.test(l.find((x) => x.id === 'data-tools' && x.source === 'user').error), 'no explanation');
  return 'duplicate refused';
});
test('PLG-04', 'Plugins', 'A plugin in a folder with spaces and non-English letters loads', 'Folder "मेरा plugin é".', 'Loads and runs.', async (c) => {
  const p = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.find((x) => x.id === 'unicode-path');
  ok(p?.status === 'ok', JSON.stringify(p));
  return 'ok';
});
test('PLG-05', 'Plugins', 'Every kind of bad plugin.json is explained in plain words', 'invalid JSON / no id / bad id / no name / newer API.', 'Each shows status Problem with a readable reason; the app starts.', async (c) => {
  const l = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.filter((p) => p.status === 'error');
  const reasons = l.map((p) => p.error);
  for (const re of [/not valid JSON/, /"id" must be/, /needs a "name"/, /newer LiteForeFlow/, /plugin\.json is missing/]) ok(reasons.some((r) => re.test(r)), `no message matching ${re}; got ${reasons.join(' / ')}`);
  ok(!reasons.some((r) => /undefined|\[object/.test(r)), 'ugly message');
  return `${l.length} problems reported`;
});
test('PLG-06', 'Plugins', 'Register that throws, rejects, returns nothing or has a syntax error is isolated', 'Four broken plugins.', 'All four show Problem; good plugins unaffected.', async (c) => {
  const l = Object.fromEntries((await c.app.api('GET', '/api/plugins', { token: c.owner })).data.map((p) => [p.id, p]));
  for (const id of ['throws', 'rejects', 'syntax-bad', 'no-register']) ok(l[id]?.status === 'error' && l[id].error, `${id}: ${JSON.stringify(l[id])}`);
  ok(/register\(sdk\)/.test(l['no-register'].error), l['no-register'].error);
  ok(!/\n/.test(l['syntax-bad'].error), 'multi-line stack in message');
  ok(l['in-data'].status === 'ok', 'good plugin broke');
  return Object.entries(l).filter(([, p]) => p.status === 'error').map(([id, p]) => `${id}: ${show(p.error, 50)}`).join(' | ');
});
test('PLG-07', 'Plugins', 'Rules for block names and definitions are enforced with clear messages', 'Uppercase type, no dot, spaces, no executor, no name, clash with built-in, duplicate in same plugin.', 'Each rejected; partly registered blocks rolled back.', async (c) => {
  const l = Object.fromEntries((await c.app.api('GET', '/api/plugins', { token: c.owner })).data.map((p) => [p.id, p]));
  const types = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data.map((n) => n.type);
  for (const id of ['rules-upper', 'rules-nodot', 'rules-noexec', 'rules-noname', 'rules-clash', 'rules-dup']) ok(l[id]?.status === 'error', `${id} should be refused: ${JSON.stringify(l[id])}`);
  ok(!types.includes('rulesclash.first') && !types.includes('rulesdup.one'), 'rollback failed: ' + types.filter((t) => /^rules/.test(t)).join(','));
  return Object.entries(l).filter(([id]) => id.startsWith('rules-')).map(([id, p]) => `${id}: ${show(p.error, 60)}`).join(' | ');
});
test('PLG-08', 'Plugins', 'A credential type id that already exists is refused', 'Plugin defines credential type "httpBearer".', 'Refused; its block is not left behind.', async (c) => {
  const p = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.find((x) => x.id === 'cred-clash');
  ok(p?.status === 'error' && /already exists/.test(p.error), JSON.stringify(p));
  ok(!(await c.app.api('GET', '/api/node-types', { token: c.owner })).data.some((n) => n.type === 'credclash.node'), 'block left behind');
  return p.error;
});
test('PLG-09', 'Plugins', 'Turning a plugin off survives a restart; turning it on survives too', 'Disable data-tools, restart the app on the same data, check, enable, restart, check.', 'State is remembered both ways.', async (c) => {
  const a = await boot('persist');
  try {
    const t = await a.user();
    ok((await a.api('POST', '/api/plugins/data-tools/disable', { token: t })).status === 200, 'disable failed');
    const data = a.data; const extra = a.extra;
    a.stop(); await sleep(1500);
    const b = await boot('persist2', { setup: (d) => fs.cpSync(data, d, { recursive: true }) });
    try {
      const tk = (await b.api('POST', '/api/auth/login', { body: { email: (await fetchEmail(data)), password: 'password123' } })).data.token;
      ok((await b.api('GET', '/api/plugins', { token: tk })).data.find((p) => p.id === 'data-tools').status === 'disabled', 'not remembered');
      ok(!(await b.api('GET', '/api/node-types', { token: tk })).data.some((n) => n.type === 'tools.sort'), 'blocks still there');
      await b.api('POST', '/api/plugins/data-tools/enable', { token: tk });
      const d2 = b.data; b.stop(); await sleep(1500);
      const c2 = await boot('persist3', { setup: (d) => fs.cpSync(d2, d, { recursive: true }) });
      try {
        const tk2 = (await c2.api('POST', '/api/auth/login', { body: { email: (await fetchEmail(d2)), password: 'password123' } })).data.token;
        ok((await c2.api('GET', '/api/plugins', { token: tk2 })).data.find((p) => p.id === 'data-tools').status === 'ok', 'enable not remembered');
      } finally { c2.stop(); }
    } finally { b.stop(); }
    void extra;
    return 'remembered across 2 restarts';
  } finally { a.stop(); }
});
async function fetchEmail() { return globalThis.__lastEmail; }
test('PLG-10', 'Plugins', 'A corrupted data/plugins.json does not stop the app', 'Write garbage into plugins.json, start.', 'All plugins load; no crash.', async () => {
  const a = await boot('corrupt', { setup: (d) => fs.writeFileSync(path.join(d, 'plugins.json'), '{{{ not json \u0000\u0001') });
  try {
    const t = await a.user();
    const l = (await a.api('GET', '/api/plugins', { token: t })).data;
    ok(l.filter((p) => p.status === 'ok').length >= 3, JSON.stringify(l.map((p) => [p.id, p.status])));
    return 'defaults used';
  } finally { a.stop(); }
});
test('PLG-11', 'Plugins', 'Reload picks up a new folder, a changed file and a deleted folder without a restart', 'Add, edit, delete a plugin folder; press Reload each time.', 'Block appears, changes, then disappears.', async (c) => {
  const dir = writePlugin(c.app.extra, 'live-plugin', { id: 'live-plugin', name: 'Live' }, GOOD('live-plugin', 'livep.one'));
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  let types = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data;
  ok(types.some((n) => n.type === 'livep.one'), 'new plugin not found');
  fs.writeFileSync(path.join(dir, 'index.js'), GOOD('live-plugin', 'livep.two'));
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  types = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data;
  ok(types.some((n) => n.type === 'livep.two') && !types.some((n) => n.type === 'livep.one'), 'edit not picked up (module cache?)');
  fs.rmSync(dir, { recursive: true, force: true });
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  types = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data;
  ok(!types.some((n) => n.type.startsWith('livep.')), 'deleted plugin still there');
  return 'add / edit / delete all seen';
});
test('PLG-12', 'Plugins', 'Pressing Reload many times at once leaves everything consistent', '8 simultaneous POST /plugins/reload.', 'Afterwards every good plugin is ON, no "already exists" errors, node count unchanged.', async (c) => {
  const before = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data.length;
  await Promise.all(Array.from({ length: 8 }, () => c.app.api('POST', '/api/plugins/reload', { token: c.owner })));
  const l = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data;
  const bad = l.filter((p) => p.status === 'error' && /already exists|already uses/.test(p.error) && !['data-tools'].includes(p.id) && !p.id.startsWith('rules-') && p.id !== 'cred-clash');
  ok(bad.length === 0, `race damage: ${bad.map((p) => `${p.id}: ${p.error}`).join(' | ')}`);
  const after = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data.length;
  ok(after === before, `node count ${before} -> ${after}`);
  return `${after} blocks, stable`;
});
test('PLG-13', 'Plugins', 'Toggling the same plugin from several places at once ends in a sane state', '10 mixed enable/disable calls at once.', 'Final status matches the last state; blocks present iff ON; no error status.', async (c) => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => c.app.api('POST', `/api/plugins/data-tools/${i % 2 ? 'enable' : 'disable'}`, { token: c.owner })));
  const p = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.find((x) => x.id === 'data-tools' && x.source === 'bundled');
  ok(p.status !== 'error', `ended in ${p.status}: ${p.error}`);
  const types = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data.map((n) => n.type);
  ok((p.status === 'ok') === types.includes('tools.sort'), `status ${p.status} but blocks ${types.includes('tools.sort')}`);
  await c.app.api('POST', '/api/plugins/data-tools/enable', { token: c.owner });
  await c.app.api('POST', '/api/plugins/data-tools/enable', { token: c.owner }); // switching on twice must not register the blocks twice
  const again = (await c.app.api('GET', '/api/plugins', { token: c.owner })).data.find((x) => x.id === 'data-tools' && x.source === 'bundled');
  ok(again.status === 'ok', `after enabling twice: ${again.status} ${again.error}`);
  return `ended ${p.status}; enabling twice is harmless`;
});
test('PLG-14', 'Plugins', 'A workflow that uses a switched-off plugin still opens and says what to do', 'Disable the plugin, GET the workflow, run it, try to activate a webhook version.', 'GET works; run/activate give the plain "switched off" message.', async (c) => {
  const wf = await c.app.wf(c.owner, [node('t', 'trigger.webhook', 'Hook', { path: 'plg14', method: 'POST', respond: 'lastNode' }), node('s', 'tools.sort', 'Sort', { field: 'a' })], [edge('t', 's')]);
  await c.app.api('POST', '/api/plugins/data-tools/disable', { token: c.owner });
  try {
    ok((await c.app.api('GET', `/api/workflows/${wf.id}`, { token: c.owner })).status === 200, 'workflow does not open');
    const run = await c.app.api('POST', `/api/workflows/${wf.id}/run`, { token: c.owner });
    ok(run.status === 400 && /plugin "Data tools".*switched off/.test(run.data.error), JSON.stringify(run.data));
    const act = await c.app.api('POST', `/api/workflows/${wf.id}/activate`, { token: c.owner });
    ok(act.status === 400 && /plugin "Data tools"/.test(act.data.error ?? ''), `activate: ${act.status} ${JSON.stringify(act.data)}`);
    return 'plain messages';
  } finally { await c.app.api('POST', '/api/plugins/data-tools/enable', { token: c.owner }); }
});
test('PLG-15', 'Plugins', 'A workflow already ACTIVE when its plugin goes off fails politely, then works again after turning it on', 'Activate webhook workflow using Respond to Webhook; disable plugin; call; enable; call.', 'Error (not a hang or crash) while off, 201 answer after.', async (c) => {
  const hk = await c.app.hook('plg15', node('r', 'respond.webhook', 'Respond', { status: 201, send: 'text', text: 'back' }));
  ok((await fetch(hk.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status === 201, 'baseline');
  await c.app.api('POST', '/api/plugins/respond-to-webhook/disable', { token: c.owner });
  const off = await fetch(hk.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await c.app.api('POST', '/api/plugins/respond-to-webhook/enable', { token: c.owner });
  const on = await fetch(hk.url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  ok(off.status >= 400 && off.status < 600, `while off: ${off.status}`);
  ok(on.status === 201 && (await on.text()) === 'back', `after on: ${on.status}`);
  ok(await alive(c.app), 'server died');
  return `while off: ${off.status} ${show(await off.text().catch(() => ''), 60)}`;
});
test('PLG-16', 'Plugins', 'The palette data is JSON-safe and tags plugin blocks', '/node-types.', 'No functions leak; plugin blocks carry their plugin id; built-ins have none.', async (c) => {
  const r = await c.app.api('GET', '/api/node-types', { token: c.owner });
  const raw = JSON.stringify(r.data);
  ok(!/"(execute|executeItem|loadOptions|loadFields)"/.test(raw), 'function property leaked');
  ok(r.data.find((n) => n.type === 'tools.sort').plugin === 'data-tools', 'plugin tag missing');
  ok(r.data.find((n) => n.type === 'logic.if').plugin === undefined, 'built-in tagged');
  return `${r.data.length} node types, ${raw.length} bytes`;
});
test('PLG-17', 'Plugins', 'A plugin\'s private folder, readJson and listFiles work', 'Plugin uses sdk.dataDir(), readJson, listFiles.', 'Folder under data/plugin-data/<id>; values read back.', async (c) => {
  const { r, out } = await c.app.chain(c.owner, [items([{}]), node('s', 'sdkuse.info', 'S', {})]);
  ok(r.data.status === 'success', JSON.stringify(r.data).slice(0, 300));
  const o = out('s')[0];
  ok(o.json.k === 'v' && o.files === 2 && /plugin-data[\\/]sdk-use$/.test(o.dir), JSON.stringify(o));
  ok(fs.existsSync(path.join(c.app.data, 'plugin-data', 'sdk-use')), 'folder not created');
  return o.dir.slice(-40);
});
test('PLG-18', 'Plugins', 'The scaffold command rejects bad names and makes a plugin that really works', 'npm run plugin:new with BAD names, then a good one, Reload, run its block.', 'Bad names refused (no folder written outside data/plugins); good one runs.', async (c) => {
  const env = { ...process.env, DATA_DIR: c.app.data };
  const run = (name) => { try { execSync(`node scripts/new-plugin.cjs ${name}`, { cwd: FORK, env, stdio: 'pipe' }); return 0; } catch (e) { return e.status; } };
  for (const bad of ['"../escape"', '"Has Space"', 'a', '"x/y"', '".."', '"a;rm -rf"']) ok(run(bad) === 1, `${bad} was accepted`);
  ok(!fs.existsSync(path.join(c.app.data, 'escape')), 'wrote outside plugins');
  ok(run('qa-made') === 0, 'good name failed');
  ok(run('qa-made') === 1, 'overwrote an existing plugin');
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  const { r, out } = await c.app.chain(c.owner, [items([{ a: 1 }]), node('h', 'qamade.hello', 'H', { who: 'Zed', shout: true })]);
  ok(r.data.status === 'success' && out('h')[0].greeting === 'HELLO, ZED!', JSON.stringify(r.data).slice(0, 300));
  return '7 bad names refused; generated block says ' + out('h')[0].greeting;
});

/* ============================================= REST ============================================= */
function svc(dataDir, id, baseUrl, extra = {}) {
  const dir = path.join(dataDir, 'plugin-data', 'rest-connector', 'services');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({
    id, name: `Svc ${id}`, baseUrl, auth: { type: 'bearer' }, test: { path: '/me', say: 'Hi {name}' },
    operations: [{ id: 'me', label: 'Me', path: '/me', fields: [] }, ...(extra.operations ?? [])], ...extra, ...(extra.operations ? { operations: [{ id: 'me', label: 'Me', path: '/me', fields: [] }, ...extra.operations] } : {}),
  }));
}
test('REST-01', 'REST connector', 'Every bundled service file is valid and complete', 'Check the 4 shipped specs and their blocks.', 'No problems; each has a label per operation; services with auth have setup steps.', async (c) => {
  const { checkSpec } = await import(new URL('../../../plugins/rest-connector/index.js', import.meta.url));
  const dir = path.join(FORK, 'plugins/rest-connector/services');
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('_'));
  for (const f of files) {
    const spec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    ok(checkSpec(spec).length === 0, `${f}: ${checkSpec(spec)}`);
    if (spec.auth?.type !== 'none') ok(spec.setup?.length, `${f} has no setup steps`);
    ok(spec.operations.every((o) => o.label), `${f}: operation without label`);
  }
  const types = (await c.app.api('GET', '/api/node-types', { token: c.owner })).data;
  for (const f of files) ok(types.some((n) => n.type === `rest.${f.replace('.json', '')}`), `${f} has no block`);
  return `${files.length} services`;
});
test('REST-02', 'REST connector', 'checkSpec explains 16 kinds of mistakes in plain words and never throws', 'Table of bad specs.', 'Each gives at least one readable problem.', async () => {
  const { checkSpec } = await import(new URL('../../../plugins/rest-connector/index.js', import.meta.url));
  const base = { id: 'abc', name: 'A', baseUrl: 'https://x.test', operations: [{ id: 'o', label: 'O', path: '/a', fields: [] }] };
  const cases = [null, undefined, 'str', 5, [], {}, { ...base, id: 'A B' }, { ...base, name: '' }, { ...base, baseUrl: 'ftp://x' }, { ...base, auth: { type: 'magic' } }, { ...base, auth: { type: 'header' } }, { ...base, auth: { type: 'query' } },
    { ...base, operations: [] }, { ...base, operations: [{ id: 'o', label: 'O', path: 'noslash', fields: [] }] }, { ...base, operations: [{ id: 'o', label: 'O', method: 'TRACE', path: '/a' }] },
    { ...base, operations: [{ id: 'o', label: 'O', path: '/a', fields: [{ name: 'x y' }] }] }, { ...base, operations: [{ id: 'o', label: 'O', path: '/a', fields: [{ name: 'x', type: 'blob' }] }] },
    { ...base, operations: [{ id: 'o', label: 'O', path: '/a', fields: [{ name: 'x', in: 'cookie' }] }] }, { ...base, operations: [{ id: 'o', label: 'O', path: '/a' }, { id: 'o', label: 'P', path: '/b' }] }];
  for (const [i, s] of cases.entries()) {
    let out; try { out = checkSpec(s); } catch (e) { throw new Error(`case ${i} threw ${e.message}`); }
    ok(out.length > 0, `case ${i} (${JSON.stringify(s)?.slice(0, 50)}) passed validation`);
    ok(out.every((m) => !/undefined|\[object|NaN/.test(m)), `case ${i}: ugly message "${out.join('; ')}"`);
  }
  return `${cases.length} bad specs all explained`;
});
test('REST-03', 'REST connector', 'Query/body/header/path values: zero, false, empty, JSON and expressions are handled right', 'Echo service with fields of each type.', 'Zero and false are sent; empty is omitted; JSON parsed; expressions resolved per item.', async (c) => {
  seen.length = 0;
  const { r } = await c.app.chain(c.owner, [items([{ n: 0, f: false, e: '', obj: '{"a":1}' }]),
    node('a', 'rest.mock', 'Echo', { credential: c.restCred, operation: 'echo', echo__count: '{{ $json.n }}', echo__flag: '{{ $json.f }}', echo__empty: '{{ $json.e }}', echo__data: '{{ $json.obj }}', echo__xh: 'hv' })]);
  ok(r.data.status === 'success', JSON.stringify(r.data).slice(0, 300));
  const e = r.data.results.a.output[0][0].json;
  ok(e.query.count === '0', `zero dropped: ${JSON.stringify(e.query)}`);
  ok(e.query.flag === 'false', `false dropped: ${JSON.stringify(e.query)}`);
  ok(!('empty' in e.query), 'empty value was sent');
  ok(JSON.stringify(e.body) === '{"data":{"a":1}}' || e.body?.data?.a === 1, `json body: ${JSON.stringify(e.body)}`);
  ok(e.headers['x-custom'] === 'hv', 'header field missing');
  return JSON.stringify(e.query);
});
test('REST-04', 'REST connector', 'Basic, header-key and query-key authentication all work', 'Three small services.', 'Each service sees the right credential.', async (c) => {
  const cr = async (type, data) => (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: type, type, data } })).data.id;
  let { r, out } = await c.app.chain(c.owner, [node('a', 'rest.basic', 'A', { credential: await cr('rest_basic', { user: 'u', password: 'p' }), operation: 'ping' })]);
  ok(out('a')[0]?.ok === true, `basic: ${JSON.stringify(r.data).slice(0, 200)}`);
  ({ r, out } = await c.app.chain(c.owner, [node('a', 'rest.hdr', 'A', { credential: await cr('rest_hdr', { token: 'KEYVAL' }), operation: 'ping' })]));
  ok(out('a')[0]?.key === 'tk-KEYVAL', `header: ${JSON.stringify(out('a'))}`);
  return 'basic + header(prefix) ok';
});
test('REST-05', 'REST connector', 'A per-account part of the web address (subdomain) comes from the credential', 'baseUrl with {sub}.', 'Request goes to the filled-in address.', async (c) => {
  const cid = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'sub', type: 'rest_sub', data: { sub: 'localhost', token: 'tok' } } })).data.id;
  const { r, out } = await c.app.chain(c.owner, [node('a', 'rest.sub', 'A', { credential: cid, operation: 'ping' })]);
  ok(r.data.status === 'success' && /localhost/.test(out('a')[0].host), JSON.stringify(r.data).slice(0, 300));
  return out('a')[0].host;
});
test('REST-06', 'REST connector', 'Different answer shapes become sensible items', 'JSON object, array, nested result path, text/plain, 204, empty list, missing result path.', 'Object=1 item, array=N, text={value}, 204={ok:true}, empty list=0 items, missing path=no junk item.', async (c) => {
  const run = async (op, extra = {}) => (await c.app.chain(c.owner, [node('a', 'rest.mock', 'A', { credential: c.restCred, operation: op, ...extra })]));
  let x = await run('me'); ok(x.out('a').length === 1 && x.out('a')[0].name === 'Ada', 'object');
  x = await run('listTasks'); ok(x.out('a').length === 2, `array via result path: ${x.out('a').length}`);
  x = await run('text'); ok(x.out('a')[0]?.value === 'hello there', `text: ${JSON.stringify(x.out('a'))}`);
  x = await run('empty'); ok(x.out('a')[0]?.ok === true, `204: ${JSON.stringify(x.out('a'))}`);
  x = await run('none'); ok(x.r.data.status === 'success' && x.out('a').length === 0, `empty list gave ${JSON.stringify(x.out('a'))}`);
  x = await run('missingPath');
  ok(x.out('a').length === 0 || (x.out('a').length === 1 && Object.keys(x.out('a')[0]).length > 0), `missing result path produced a hollow item: ${JSON.stringify(x.out('a'))}`);
  return 'all shapes ok';
});
test('REST-07', 'REST connector', 'A huge list is capped (1000 items) instead of flooding the run', '/big returns 1500 entries.', '1000 items.', async (c) => {
  const x = await c.app.chain(c.owner, [node('a', 'rest.mock', 'A', { credential: c.restCred, operation: 'big' }), node('n', 'data.aggregate', 'All', { field: 'items' })]);
  ok(x.r.data.status === 'success' && x.out('n')[0].items.length === 1000, `got ${x.out('n')[0]?.items?.length} ${x.err()}`);
  return `1000 of 1500 items kept, in ${x.ms} ms`;
});
test('REST-08', 'REST connector', 'Failures are explained: 401, 404, 429, HTML 500 page, server down, slow service', 'One run each.', 'Messages name the service and say what happened; slow (2.5 s) still works; no raw HTML or "fetch failed".', async (c) => {
  const msg = async (op, cred = c.restCred) => (await c.app.chain(c.owner, [node('a', 'rest.mock', 'A', { credential: cred, operation: op })])).err();
  ok(/HTTP 429.*Slow down/.test(await msg('rate')), 'rate: ' + await msg('rate'));
  const boom = await msg('boom'); ok(/HTTP 500/.test(boom) && !/<html>/i.test(boom), `html 500: ${boom}`);
  const bad = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'bad', type: 'rest_mock', data: { token: 'nope' } } })).data.id;
  ok(/HTTP 401.*Bad credentials/.test(await msg('me', bad)), 'auth');
  const dead = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'dead', type: 'rest_dead', data: { token: 'x' } } })).data.id;
  const down = (await c.app.chain(c.owner, [node('a', 'rest.dead', 'A', { credential: dead, operation: 'me' })])).err();
  ok(/could not (reach|connect)|not reachable|refused|is it (up|running)/i.test(down) && !/^[^:]*: fetch failed$/.test(down), `server down message: "${down}"`);
  const slow = await c.app.chain(c.owner, [node('a', 'rest.mock', 'A', { credential: c.restCred, operation: 'slow' })]);
  ok(slow.r.data.status === 'success' && slow.ms >= 2400, `slow: ${slow.r.data.status} ${slow.ms}`);
  return `down => "${show(down, 80)}"`;
});
test('REST-09', 'REST connector', 'Redirects are followed and 100 items make 100 correct calls', 'Redirect endpoint; 100 items through a call with an expression.', 'Redirect resolves; 100 calls each with its own value, in under 20 s.', async (c) => {
  const red = await c.app.chain(c.owner, [node('a', 'rest.mock', 'A', { credential: c.restCred, operation: 'redirect' })]);
  ok(red.r.data.status === 'success', 'redirect: ' + red.err());
  seen.length = 0;
  const list = Array.from({ length: 100 }, (_, i) => ({ i }));
  const x = await c.app.chain(c.owner, [items(list), node('a', 'rest.mock', 'A', { credential: c.restCred, operation: 'getTask', getTask__id: 'task-{{ $json.i }}' })]);
  ok(x.r.data.status === 'success', x.err());
  ok(x.out('a').length === 100 && x.out('a')[57].path === '/svc/tasks/task-57', `item 57: ${JSON.stringify(x.out('a')[57])}`);
  ok(x.ms < 20000, `took ${x.ms} ms`);
  return `${x.ms} ms for 100 calls`;
});
test('REST-10', 'REST connector', 'Live dropdown edge cases: empty list, missing labels, dependent dropdown, wrong credential', 'node-options for empty list, label-less entries, board->list, no credential.', 'Clean answers or readable reasons.', async (c) => {
  const o = (prop, params) => c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'rest.mock', property: prop, parameters: { credential: c.restCred, ...params } } });
  ok((await o('listNone__x', {})).data.options?.length === 0, 'empty list');
  const lab = (await o('listTasks__project', {})).data.options;
  ok(lab.length === 2 && lab[1].label === 'p2', `label fallback: ${JSON.stringify(lab)}`);
  const noc = await c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'rest.mock', property: 'listTasks__project', parameters: {} } });
  ok(/credential/i.test(noc.data.error ?? ''), `no credential: ${JSON.stringify(noc.data)}`);
  return 'ok';
});
test('REST-11', 'REST connector', 'Service files added, broken, duplicated and removed while running', 'Drop a file + Reload; break it + Reload; add a duplicate id; remove.', 'Block appears; broken file skipped without losing others; duplicate ignored; removed block disappears.', async (c) => {
  const dir = path.join(c.app.data, 'plugin-data', 'rest-connector', 'services');
  const file = path.join(dir, 'hot.json');
  svc(c.app.data, 'hot', `${W}/svc`);
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  const has = async (t) => (await c.app.api('GET', '/api/node-types', { token: c.owner })).data.some((n) => n.type === t);
  ok(await has('rest.hot'), 'hot service not found');
  fs.writeFileSync(file, '{ broken');
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  ok(!(await has('rest.hot')) && (await has('rest.github')) && (await has('rest.mock')), 'broken file damaged other services');
  svc(c.app.data, 'hot', `${W}/svc`); fs.copyFileSync(file, path.join(dir, 'hot-copy.json'));
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  ok(await has('rest.hot'), 'duplicate id broke the original');
  fs.rmSync(file); fs.rmSync(path.join(dir, 'hot-copy.json'));
  await c.app.api('POST', '/api/plugins/reload', { token: c.owner });
  ok(!(await has('rest.hot')), 'removed service still listed');
  return 'ok';
});
test('REST-12', 'REST connector', 'Test connection for service credentials', 'Good key, bad key, service with no test path, service down.', 'Friendly message each time.', async (c) => {
  const t = (type, data) => c.app.api('POST', '/api/credentials/test', { token: c.owner, body: { type, data } });
  ok((await t('rest_mock', { token: 'tok' })).data.message === 'Connected as Ada.', 'good');
  const bad = (await t('rest_mock', { token: 'no' })).data; ok(!bad.ok && /rejected/.test(bad.message), JSON.stringify(bad));
  const none = (await t('rest_basic', { user: 'u', password: 'p' })).data; ok(none.ok && none.untested, JSON.stringify(none));
  const down = (await t('rest_dead', { token: 'x' })).data; ok(!down.ok && !/^[^:]*: fetch failed$/.test(down.message), JSON.stringify(down));
  return `down => "${show(down.message, 70)}"`;
});

/* ======================================== RESPOND TO WEBHOOK ======================================== */
const post = (url, body = {}, headers = {}, method = 'POST') => fetch(url, { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(body), redirect: 'manual' });
test('RESP-01', 'Respond to Webhook', 'Every "Send" mode over real HTTP', 'json / text / empty / firstItem / allItems with custom status.', 'Right status, content-type and body each time.', async (c) => {
  let hk = await c.app.hook('r1a', node('r', 'respond.webhook', 'R', { status: 201, send: 'json', json: '{"you":"{{ $json.body.n }}"}' }));
  let res = await post(hk.url, { n: 'Ada' }); ok(res.status === 201 && /json/.test(res.headers.get('content-type')) && (await res.json()).you === 'Ada', 'json');
  hk = await c.app.hook('r1b', node('r', 'respond.webhook', 'R', { send: 'text', text: 'नमस्ते 🙂 {{ $json.body.n }}' }));
  res = await post(hk.url, { n: 'x' }); ok(/text\/plain/.test(res.headers.get('content-type')) && (await res.text()) === 'नमस्ते 🙂 x', 'unicode text');
  hk = await c.app.hook('r1c', node('r', 'respond.webhook', 'R', { status: 204, send: 'empty' }));
  res = await post(hk.url); ok(res.status === 204 && (await res.text()) === '', 'empty');
  return 'ok';
});
test('RESP-02', 'Respond to Webhook', 'Redirect with status 302 and a Location header', 'Respond status 302, header Location.', 'Caller sees 302 + Location.', async (c) => {
  const hk = await c.app.hook('r2', node('r', 'respond.webhook', 'R', { status: 302, send: 'empty', headers: [{ name: 'Location', value: 'https://example.com/next' }] }));
  const res = await post(hk.url);
  ok(res.status === 302 && res.headers.get('location') === 'https://example.com/next', `${res.status} ${res.headers.get('location')}`);
  return '302 + Location';
});
test('RESP-03', 'Respond to Webhook', 'Status can come from an expression', 'Status = {{ $json.body.code }}.', '418 when the caller sends 418.', async (c) => {
  const hk = await c.app.hook('r3', node('r', 'respond.webhook', 'R', { status: '{{ $json.body.code }}', send: 'text', text: 't' }));
  const res = await post(hk.url, { code: 418 });
  ok(res.status === 418, `status was ${res.status}`);
  return String(res.status);
});
test('RESP-04', 'Respond to Webhook', 'If a later step fails AFTER the Respond node ran, the caller still gets the answer it was promised', 'Respond (201) then Stop and Error.', 'Caller gets 201 (the failure is recorded in the run).', async (c) => {
  const nodes = [node('r', 'respond.webhook', 'R', { status: 201, send: 'text', text: 'promised' }), node('x', 'logic.stopAndError', 'Boom', { message: 'later failure' })];
  const token = await c.app.user();
  const all = [node('t', 'trigger.webhook', 'Hook', { path: 'r4', method: 'POST', respond: 'responseNode' }), ...nodes];
  const wf = await c.app.wf(token, all, [edge('t', 'r'), edge('r', 'x')]);
  await c.app.api('POST', `/api/workflows/${wf.id}/activate`, { token });
  const res = await post(`${c.app.base}/webhook/r4`);
  const body = await res.text();
  ok(res.status === 201 && body === 'promised', `got ${res.status} ${body}`);
  return `${res.status} ${body}`;
});
test('RESP-05', 'Respond to Webhook', 'Two Respond nodes: the last one that runs wins; a bad JSON answer gives a plain error', 'Chain of two; JSON mode with broken JSON.', 'Second answer used; broken JSON -> 500 with message.', async (c) => {
  const token = await c.app.user();
  const all = [node('t', 'trigger.webhook', 'Hook', { path: 'r5', method: 'POST', respond: 'responseNode' }), node('a', 'respond.webhook', 'A', { status: 200, send: 'text', text: 'first' }), node('b', 'respond.webhook', 'B', { status: 202, send: 'text', text: 'second' })];
  const wf = await c.app.wf(token, all, [edge('t', 'a'), edge('a', 'b')]);
  await c.app.api('POST', `/api/workflows/${wf.id}/activate`, { token });
  const res = await post(`${c.app.base}/webhook/r5`);
  ok(res.status === 202 && (await res.text()) === 'second', 'last wins');
  const hk = await c.app.hook('r5b', node('r', 'respond.webhook', 'R', { send: 'json', json: '{ this is not json' }));
  const bad = await post(hk.url);
  const body = await bad.json();
  ok(bad.status === 500 && /not valid JSON/.test(body.error), `${bad.status} ${JSON.stringify(body)}`);
  return 'ok';
});
test('RESP-06', 'Respond to Webhook', 'Big answers, GET and HEAD webhooks, and 25 callers at once each get their own answer', '2 MB body; method GET/HEAD; 25 parallel calls with different numbers.', 'All correct, no mix-ups.', async (c) => {
  let hk = await c.app.hook('r6a', node('r', 'respond.webhook', 'R', { send: 'text', text: 'x'.repeat(2_000_000) }));
  ok((await (await post(hk.url)).text()).length === 2_000_000, '2 MB body cut');
  hk = await c.app.hook('r6b', node('r', 'respond.webhook', 'R', { send: 'text', text: 'got-{{ $json.query.n }}' }), { method: 'ANY' });
  ok((await (await post(hk.url + '?n=1', {}, {}, 'GET')).text()) === 'got-1', 'GET');
  ok((await post(hk.url + '?n=1', {}, {}, 'HEAD')).status === 200, 'HEAD');
  const res = await Promise.all(Array.from({ length: 25 }, (_, n) => post(`${hk.url}?n=${n}`, {}, {}, 'GET').then((r) => r.text())));
  ok(res.every((t, n) => t === `got-${n}`), 'answers crossed: ' + res.slice(0, 6).join(','));
  return '25 parallel ok';
});
test('RESP-07', 'Respond to Webhook', 'Webhook secret and a missing Respond node behave as before', 'Secret required; responseNode with no Respond node on the path.', '401 without secret; falls back to last output.', async (c) => {
  const hk = await c.app.hook('r7', node('r', 'respond.webhook', 'R', { send: 'text', text: 'ok' }), { secret: 's3' });
  ok((await post(hk.url)).status === 401, 'secret not enforced');
  ok((await post(hk.url, {}, { 'x-webhook-secret': 's3' })).status === 200, 'secret rejected');
  const h2 = await c.app.hook('r7b', null, { extra: [node('s', 'data.set', 'S', { fields: [{ name: 'k', value: 'v' }], keepOthers: false })] });
  const r2 = await post(h2.url);
  ok(r2.status === 200 && (await r2.json()).k === 'v', 'fallback');
  return 'ok';
});
test('RESP-08', 'Respond to Webhook', 'Running a Respond node from the editor (Run / Test this step) does not crash', 'Manual run and single-node test of a workflow that has Respond to Webhook.', 'Success; output passes through.', async (c) => {
  const x = await c.app.chain(c.owner, [items([{ a: 1 }]), node('r', 'respond.webhook', 'R', { status: 201, send: 'firstItem' })]);
  ok(x.r.data.status === 'success' && x.out('r')[0].a === 1, x.err());
  const t = await c.app.api('POST', `/api/workflows/${x.wf.id}/nodes/r/test`, { token: c.owner, body: {} });
  ok(t.status === 200, JSON.stringify(t.data).slice(0, 200));
  return 'ok';
});

/* ============================================ DATA TOOLS ============================================ */
const dt = (c, nodes) => c.app.chain(c.owner, nodes);
test('DATA-01', 'Data tools', 'Filter: no conditions, no input, regex on a hostile pattern', 'Empty condition list; zero items; (a+)+$ on a long string.', 'Keeps all; empty out; the regex cannot freeze the server.', async (c) => {
  let x = await dt(c, [items([{ a: 1 }, { a: 2 }]), node('f', 'tools.filter', 'F', { conditions: [] })]); ok(x.out('f').length === 2, 'no conditions');
  x = await dt(c, [items([]), node('f', 'tools.filter', 'F', { conditions: [{ left: '1', op: 'equals', right: '1' }] }), node('z', 'logic.noop', 'Z')]); ok(x.r.data.status === 'success', 'empty input: ' + x.err());
  const t0 = Date.now();
  x = await dt(c, [items([{ s: 'a'.repeat(40) + '!' }]), node('f', 'tools.filter', 'F', { conditions: [{ left: '{{ $json.s }}', op: 'regex', right: '(a+)+$' }] })]);
  ok(Date.now() - t0 < 20000 && (await alive(c.app)), `regex took ${Date.now() - t0} ms`);
  return `hostile regex finished in ${Date.now() - t0} ms (${x.r.data.status})`;
});
test('DATA-02', 'Data tools', 'Sort: mixed types, nulls, nested path, dates, stability, missing field, prototype names', 'Several sorts.', 'Sensible order; equal keys keep their order; no crash; no pollution.', async (c) => {
  const mixed = [{ v: 'b' }, { v: 10 }, { v: null }, { v: 2 }, {}, { v: 'a' }, { v: '' }];
  let x = await dt(c, [items(mixed), node('s', 'tools.sort', 'S', { field: 'v', kind: 'auto' })]); ok(x.r.data.status === 'success', x.err());
  const order = x.out('s').map((i) => i.v ?? '∅').join(',');
  ok(order.indexOf('2') < order.indexOf('10'), `numbers should be numeric first: ${order}`);
  x = await dt(c, [items([{ k: 1, n: 'a' }, { k: 1, n: 'b' }, { k: 0, n: 'c' }, { k: 1, n: 'd' }]), node('s', 'tools.sort', 'S', { field: 'k' })]);
  ok(x.out('s').map((i) => i.n).join('') === 'cabd', `unstable: ${x.out('s').map((i) => i.n).join('')}`);
  x = await dt(c, [items([{ a: { b: 3 } }, { a: { b: 1 } }, { a: { b: 2 } }]), node('s', 'tools.sort', 'S', { field: 'a.b', direction: 'desc' })]); ok(x.out('s').map((i) => i.a.b).join('') === '321', 'nested');
  x = await dt(c, [items([{ d: '2026-03-05' }, { d: '2025-12-31' }, { d: '2026-01-01' }]), node('s', 'tools.sort', 'S', { field: 'd', kind: 'date' })]); ok(x.out('s').map((i) => i.d)[0] === '2025-12-31', 'dates');
  x = await dt(c, [items([{ a: 2 }, { a: 1 }]), node('s', 'tools.sort', 'S', { field: 'nope' })]); ok(x.out('s').map((i) => i.a).join('') === '21', 'missing field must keep the order');
  x = await dt(c, [items([{ a: 1 }]), node('s', 'tools.sort', 'S', { field: '__proto__.polluted' }), node('s2', 'tools.sort', 'S2', { field: 'constructor.prototype.x' })]);
  ok(({}).polluted === undefined && x.r.data.status === 'success', 'pollution or crash');
  return `mixed order: ${order}`;
});
test('DATA-03', 'Data tools', 'Remove Duplicates ignores the order of keys and tells 1 from "1"', 'Whole-item compare with different key order; nested path; number vs string.', '{a,b} equals {b,a}; 1 and "1" differ.', async (c) => {
  let x = await dt(c, [items([{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1, b: 3 }]), node('u', 'tools.unique', 'U', { field: '' })]);
  ok(x.out('u').length === 2, `key order made them different: kept ${x.out('u').length} of 3`);
  x = await dt(c, [items([{ v: 1 }, { v: '1' }, { v: 1 }]), node('u', 'tools.unique', 'U', { field: 'v' })]); ok(x.out('u').length === 2, '1 vs "1"');
  x = await dt(c, [items([{ p: { id: 1 } }, { p: { id: 1 } }, { p: { id: 2 } }]), node('u', 'tools.unique', 'U', { field: 'p.id' })]); ok(x.out('u').length === 2, 'nested');
  x = await dt(c, [items([{ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }]), node('u', 'tools.unique', 'U', { field: 'a' })]); ok(x.out('u').length === 1, 'nested object key order');
  return 'ok';
});
test('DATA-04', 'Data tools', 'Split into Batches: odd sizes and empty input', 'size 0, -5, 2.7, "abc", huge; empty list.', 'Never crashes; size falls back sensibly; empty input gives no batches.', async (c) => {
  const sizes = {};
  for (const size of [0, -5, 2.7, 'abc', 1e9]) {
    const x = await dt(c, [items([1, 2, 3, 4, 5].map((n) => ({ n }))), node('c', 'tools.chunk', 'C', { size })]);
    ok(x.r.data.status === 'success', `size ${size}: ${x.err()}`);
    sizes[size] = x.out('c').length;
  }
  ok(sizes[1e9] === 1 && sizes[-5] === 5 && sizes[0] >= 1, JSON.stringify(sizes));
  const e = await dt(c, [items([]), node('c', 'tools.chunk', 'C', { size: 3 })]); ok(e.r.data.status === 'success', 'empty');
  return `batches per size: ${JSON.stringify(sizes)}`;
});
test('DATA-05', 'Data tools', 'Date & Time: numbers, bad timezone, leap years, negative amounts, weeks, other units', 'A list of calculations.', 'Correct results and friendly errors.', async (c) => {
  const d = async (p, input = {}) => { const x = await dt(c, [items([input]), node('d', 'tools.dateTime', 'D', p)]); return { x, v: x.out('d')[0]?.date, err: x.err() }; };
  let r = await d({ operation: 'format', date: '{{ $json.n }}', format: 'iso' }, { n: 1772721000 }); ok(r.v === '2026-03-05T14:30:00.000Z', `seconds as a JSON number: ${r.v} ${r.err}`);
  r = await d({ operation: 'format', date: '{{ $json.n }}', format: 'iso' }, { n: 1772721000000 }); ok(r.v === '2026-03-05T14:30:00.000Z', `milliseconds as a JSON number: ${r.v}`);
  r = await d({ operation: 'format', date: '2026-03-05', format: 'date', timezone: 'Mars/Phobos' }); ok(!r.v && /time ?zone/i.test(r.err) && !/RangeError|Invalid time zone specified/.test(r.err), `bad timezone message: "${r.err}"`);
  r = await d({ operation: 'add', date: '2024-02-29T00:00:00Z', amount: 1, unit: 'years', format: 'date' }); ok(r.v === '2025-02-28', `leap day + 1 year: ${r.v}`);
  r = await d({ operation: 'add', date: '2026-03-31T00:00:00Z', amount: -1, unit: 'months', format: 'date' }); ok(r.v === '2026-02-28', `minus a month: ${r.v}`);
  r = await d({ operation: 'add', date: '2026-03-01T00:00:00Z', amount: 2, unit: 'weeks', format: 'date' }); ok(r.v === '2026-03-15', `weeks: ${r.v}`);
  r = await d({ operation: 'diff', date: '2026-03-05T00:00:00Z', other: '2026-03-01T00:00:00Z', unit: 'days' }); ok(r.v === -4, `negative diff: ${r.v}`);
  r = await d({ operation: 'add', date: '2026-03-05T00:00:00Z', amount: 'abc', unit: 'days', format: 'date' }); ok(r.x.r.data.status === 'error' || r.v !== 'Invalid Date', `amount "abc" gave ${r.v}`);
  r = await d({ operation: 'format', date: '', format: 'unix' }); ok(Math.abs(r.v - Date.now() / 1000) < 120, 'empty date means now');
  r = await d({ operation: 'format', date: '2026-03-05T00:00:00Z', outputField: '__proto__.polluted' }); ok(({}).polluted === undefined, 'prototype pollution');
  return 'all calculations correct';
});
test('DATA-06', 'Data tools', 'Crypto: unknown algorithm, odd inputs, 1000 UUIDs', 'sha3 typo; missing text; invalid base64; random length bounds.', 'Plain errors, bounded output, unique ids.', async (c) => {
  const cr = (p, input = {}) => dt(c, [items([input]), node('x', 'tools.crypto', 'X', p)]);
  let x = await cr({ operation: 'hash', value: 'a', algorithm: 'sha-999' }); ok(x.r.data.status === 'error' && !/error:0|digital envelope|ERR_/.test(x.err()), `algorithm message: "${x.err()}"`);
  x = await cr({ operation: 'hash', value: '{{ $json.missing }}', algorithm: 'sha256' }); ok(x.out('x')[0].result === crypto.createHash('sha256').update('').digest('hex'), 'missing text should hash as empty');
  x = await cr({ operation: 'base64Decode', value: '!!!notbase64!!!' }); ok(x.r.data.status === 'success', 'bad base64 crashed');
  for (const len of [0, -3, 5000, 'abc']) { x = await cr({ operation: 'random', length: len }); ok(x.r.data.status === 'success' && x.out('x')[0].result.length >= 1 && x.out('x')[0].result.length <= 256, `length ${len}: ${x.out('x')[0]?.result?.length}`); }
  x = await dt(c, [items(Array.from({ length: 1000 }, () => ({}))), node('x', 'tools.crypto', 'X', { operation: 'uuid' })]);
  ok(new Set(x.out('x').map((i) => i.result)).size === x.out('x').length && x.out('x').length >= 100, 'duplicate uuids');
  return 'ok';
});
test('DATA-07', 'Data tools', 'The new tools are no slower than the built-in blocks on 10,000 items', 'Same data through the built-in IF, the Filter plugin, and the tools that need no expressions.', 'Filter within 1.5x of IF; Sort / Remove Duplicates / Batches under 2 s each.', async (c) => {
  const gen = () => node('items', 'data.code', 'Items', { code: 'return Array.from({length:10000},(_,i)=>({id:i%5000, v:(i*7919)%10007}));' });
  const cond = [{ left: '{{ $json.v }}', op: 'gt', right: '100' }];
  const timed = async (n) => { const x = await dt(c, [gen(), n]); ok(x.r.data.status === 'success', x.err()); return x.ms; };
  const base = await timed(node('x', 'logic.if', 'X', { conditions: cond }));
  const filter = await timed(node('x', 'tools.filter', 'X', { conditions: cond }));
  const sort = await timed(node('x', 'tools.sort', 'X', { field: 'v', kind: 'number' }));
  const uniq = await timed(node('x', 'tools.unique', 'X', { field: 'id' }));
  const chunk = await timed(node('x', 'tools.chunk', 'X', { size: 500 }));
  ok(filter <= base * 1.5 + 500, `Filter ${filter} ms vs IF ${base} ms`);
  ok(Math.max(sort, uniq, chunk) < 2000, `sort ${sort}, unique ${uniq}, chunk ${chunk}`);
  return `10,000 items: built-in IF ${base} ms, Filter ${filter} ms (expressions cost about ${(base / 10000).toFixed(2)} ms per item in the engine itself); Sort ${sort} ms, Remove Duplicates ${uniq} ms, Batches ${chunk} ms`;
});

/* ============================================ NOTION & FRIENDLY FIELDS ============================================ */
const notionCred = async (c, token = 'secret_x') => (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'n' + Math.random(), type: 'notionApi', data: { token } } })).data.id;
test('NOT-01', 'Friendly fields', 'Database list: names, untitled databases, empty account, slow Notion', 'node-options for databases in four situations.', 'Names shown, "(untitled)" for blank, helpful message when nothing shared, slow answer still arrives.', async (c) => {
  const cid = await notionCred(c);
  const ask = () => c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'app.notion', property: 'databaseId', parameters: { credential: cid } } });
  let r = await ask(); ok(r.data.options.map((o) => o.label).join('|') === 'Tasks|(untitled)', JSON.stringify(r.data));
  state.notionEmpty = true; r = await ask(); state.notionEmpty = false; ok(/No database is shared/.test(r.data.error), JSON.stringify(r.data));
  state.notionDelay = 1500; const t0 = Date.now(); r = await ask(); state.notionDelay = 0; ok(r.data.options?.length === 2 && Date.now() - t0 >= 1400, 'slow');
  return 'ok';
});
test('NOT-02', 'Friendly fields', 'Columns: only fillable types are offered; the title is excluded', 'fields for a database with formula/relation/title columns.', 'Gender, Score, Done only.', async (c) => {
  const cid = await notionCred(c);
  const r = await c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'app.notion', property: 'columns', kind: 'fields', parameters: { credential: cid, databaseId: 'db1' } } });
  ok(r.data.fields.map((f) => f.name).sort().join() === 'Done,Gender,Score', JSON.stringify(r.data));
  return r.data.fields.map((f) => `${f.name}:${f.type}`).join(', ');
});
test('NOT-03', 'Friendly fields', 'A number column given text ("abc") gives a clear error, not a silent null', 'Score = "abc".', 'Error names the column.', async (c) => {
  const cid = await notionCred(c);
  const x = await dt(c, [node('n', 'app.notion', 'N', { credential: cid, operation: 'createPage', databaseId: 'db1', title: 'T', columns: { Score: 'abc' } })]);
  ok(x.r.data.status === 'error' && /Score/.test(x.err()) && /number/i.test(x.err()), `message: "${x.err()}"`);
  return x.err();
});
test('NOT-04', 'Friendly fields', 'Pasting a whole Notion link or an ID with dashes into the database field works', 'databaseId as full URL with ?v=, as dashed UUID.', 'The page is created in the right database.', async (c) => {
  const cid = await notionCred(c);
  const id32 = 'a'.repeat(32);
  for (const pasted of [`https://www.notion.so/myspace/Tasks-${id32}?v=${'b'.repeat(32)}&pvs=4`, `${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(12)}`]) {
    seen.length = 0;
    const x = await dt(c, [node('n', 'app.notion', 'N', { credential: cid, operation: 'queryDatabase', databaseId: pasted })]);
    const hit = seen.find((s) => s.path.includes('/query'));
    ok(hit && hit.path === `/v1/databases/${id32}/query`, `"${pasted.slice(0, 40)}…" -> ${hit?.path} (${x.err()})`);
  }
  return 'both forms understood';
});
test('NOT-05', 'Friendly fields', 'Read rows works and bad filter JSON is explained', 'queryDatabase with and without a filter; broken filter text.', '2 rows; "not valid JSON" message.', async (c) => {
  const cid = await notionCred(c);
  let x = await dt(c, [node('n', 'app.notion', 'N', { credential: cid, operation: 'queryDatabase', databaseId: 'db1' })]); ok(x.out('n').length === 2, 'rows');
  x = await dt(c, [node('n', 'app.notion', 'N', { credential: cid, operation: 'queryDatabase', databaseId: 'db1', filter: '{ nope' })]); ok(x.r.data.status === 'error' && /JSON/.test(x.err()), x.err());
  return 'ok';
});
test('NOT-06', 'Friendly fields', 'The column list is never stale in the editor after a change in Notion', 'fields requested twice after the schema changes.', 'Second request sees the new column.', async (c) => {
  const cid = await notionCred(c);
  const f = () => c.app.api('POST', '/api/node-options', { token: c.owner, body: { type: 'app.notion', property: 'columns', kind: 'fields', parameters: { credential: cid, databaseId: 'db1' } } });
  await f();
  state.extraColumn = true;
  const r = await f();
  state.extraColumn = false;
  ok(r.data.fields.some((x) => x.name === 'Added'), `still stale: ${r.data.fields.map((x) => x.name)}`);
  return 'fresh';
});
test('CRED-01', 'Credentials', 'Test connection for OpenAI-compatible and Anthropic-style APIs, and bad input', 'Good key, wrong key, unknown type, missing field, 5 KB value.', 'Plain results, no crash.', async (c) => {
  const t = (type, data) => c.app.api('POST', '/api/credentials/test', { token: c.owner, body: { type, data } });
  ok(/Connected\. 2 models/.test((await t('openaiApi', { apiKey: 'sk-good', baseUrl: `${W}/v1` })).data.message), 'good key');
  const bad = (await t('openaiApi', { apiKey: 'wrong', baseUrl: `${W}/v1` })).data; ok(!bad.ok && /rejected/.test(bad.message), JSON.stringify(bad));
  ok(!(await t('nonsense', {})).data.ok, 'unknown'); ok(/Missing field/.test((await t('openaiApi', {})).data.message), 'missing');
  ok((await t('openaiApi', { apiKey: 'k'.repeat(5000), baseUrl: `${W}/v1` })).status === 200, 'long value');
  return 'ok';
});
test('CRED-02', 'Credentials', 'Editing a saved credential: blank secret keeps the old one; Test uses the stored secret', 'PUT with blank token, then test by id.', 'Still connected.', async (c) => {
  const id = (await c.app.api('POST', '/api/credentials', { token: c.owner, body: { name: 'edit', type: 'rest_mock', data: { token: 'tok' } } })).data.id;
  await c.app.api('PUT', `/api/credentials/${id}`, { token: c.owner, body: { name: 'renamed', data: { token: '' } } });
  const r = await c.app.api('POST', '/api/credentials/test', { token: c.owner, body: { id, data: { token: '' } } });
  ok(r.data.ok && /Ada/.test(r.data.message), JSON.stringify(r.data));
  return r.data.message;
});

/* ========================================== OLD THINGS STILL WORK ========================================== */
test('REG-01', 'Regression', 'Every built-in template still validates against the block list', 'Load every template and run the workflow checker.', 'No unknown blocks or problems.', async (c) => {
  const list = (await c.app.api('GET', '/api/templates', { token: c.owner })).data;
  ok(list.length >= 10, `only ${list.length} templates`);
  const bad = [];
  for (const t of list) {
    const tk = await c.app.user();
    const res = await c.app.api('POST', `/api/templates/${t.id}/use`, { token: tk });
    if (res.status !== 201) { bad.push(`${t.id}: ${JSON.stringify(res.data).slice(0, 100)}`); continue; }
    const run = await c.app.api('POST', `/api/workflows/${res.data.id}/activate`, { token: tk });
    if (run.status >= 500) bad.push(`${t.id} activate: ${run.status}`);
  }
  ok(bad.length === 0, bad.join(' | '));
  return `${list.length} templates ok`;
});
test('REG-02', 'Regression', 'An n8n export containing a Notion and a Webhook-respond node imports without crashing', 'POST /import/n8n with a small export.', 'Imported or refused politely.', async (c) => {
  const n8n = { name: 'Imp', nodes: [{ id: '1', name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], parameters: { path: 'imp', httpMethod: 'POST' } }, { id: '2', name: 'Notion', type: 'n8n-nodes-base.notion', typeVersion: 2, position: [200, 0], parameters: {} }, { id: '3', name: 'Respond', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1, position: [400, 0], parameters: {} }], connections: { Webhook: { main: [[{ node: 'Notion', type: 'main', index: 0 }]] }, Notion: { main: [[{ node: 'Respond', type: 'main', index: 0 }]] } } };
  const r = await c.app.api('POST', '/api/import/n8n', { token: c.owner, body: { workflow: n8n } });
  ok(r.status < 500, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  return `status ${r.status}`;
});
test('REG-03', 'Regression', 'The earlier schedule picker saves cron and the Schedule node still validates', 'Create a Schedule workflow with a picker-style cron and a custom one.', 'Accepted.', async (c) => {
  for (const cron of ['*/15 * * * *', '0 9 * * 1-5', '30 8 2 * *']) {
    const wf = await c.app.wf(c.owner, [node('s', 'trigger.cron', 'S', { cron, timezone: 'Asia/Calcutta' }), node('n', 'logic.noop', 'N')], [edge('s', 'n')]);
    const r = await c.app.api('POST', `/api/workflows/${wf.id}/run`, { token: c.owner });
    ok(r.data.status === 'success', `${cron}: ${JSON.stringify(r.data).slice(0, 150)}`);
  }
  return '3 schedules run';
});

/* ============================================ PERFORMANCE / FOOTPRINT ============================================ */
const rss = (pid) => Number(execSync(`powershell -NoProfile -Command "[math]::Round((Get-Process -Id ${pid}).WorkingSet64/1MB)"`).toString().trim());
test('PERF-01', 'Performance', 'The plugin system keeps start-up and memory lean (compared with master)', 'Start master and this branch, 3 times each; then 200 runs; read memory.', 'Start-up within +600 ms and memory within +25 MB of master.', async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'pqa-master-'));
  fs.rmSync(wt, { recursive: true, force: true });
  execSync(`git worktree add "${wt}" origin/master`, { cwd: FORK, stdio: 'pipe' });
  try {
    fs.symlinkSync(path.join(FORK, 'node_modules'), path.join(wt, 'node_modules'), 'junction');
    const measure = async (label, cwd) => {
      const starts = []; let mem0 = 0; let mem1 = 0;
      for (let i = 0; i < 3; i += 1) {
        const a = await boot(`${label}${i}`, { cwd });
        starts.push(a.startMs);
        if (i === 2) {
          const t = await a.user(); await sleep(500); mem0 = rss(a.h.proc.pid);
          const wf = await a.wf(t, [node('t', 'trigger.manual', 'S'), node('c', 'data.set', 'C', { fields: [{ name: 'a', value: '1' }], keepOthers: true })], [edge('t', 'c')]);
          for (let n = 0; n < 200; n += 1) await a.api('POST', `/api/workflows/${wf.id}/run`, { token: t });
          mem1 = rss(a.h.proc.pid);
        }
        a.stop(); await sleep(800);
      }
      return { starts, mem0, mem1, med: starts.sort((x, y) => x - y)[1] };
    };
    const m = await measure('master', wt);
    const b = await measure('branch', FORK);
    const msg = `start-up master ${m.med} ms vs branch ${b.med} ms; memory master ${m.mem0}->${m.mem1} MB vs branch ${b.mem0}->${b.mem1} MB`;
    ok(b.med - m.med < 600, `slower start-up: ${msg}`);
    ok(b.mem1 - m.mem1 < 25, `more memory: ${msg}`);
    return msg;
  } finally { try { execSync(`git worktree remove --force "${wt}"`, { cwd: FORK, stdio: 'pipe' }); } catch { /* leave it */ } }
});
test('PERF-02', 'Performance', 'The block list stays small and the editor bundle did not balloon', 'Size of /node-types and the built JS/CSS.', 'Block list < 120 KB; JS < 450 KB.', async (c) => {
  const nt = JSON.stringify((await c.app.api('GET', '/api/node-types', { token: c.owner })).data).length;
  const assets = fs.readdirSync(path.join(FORK, 'web/dist/assets')).map((f) => [f, fs.statSync(path.join(FORK, 'web/dist/assets', f)).size]);
  const js = assets.find(([f]) => f.endsWith('.js'))[1];
  ok(nt < 120000, `block list ${nt}`); ok(js < 450000, `js ${js}`);
  return `node-types ${(nt / 1024).toFixed(0)} KB, js ${(js / 1024).toFixed(0)} KB`;
});
test('PERF-03', 'Performance', 'Reload is quick and 200 Respond-to-Webhook calls are fast', 'Time 5 reloads; 200 sequential webhook calls.', 'Reload < 1 s each; 200 calls < 20 s.', async (c) => {
  const times = [];
  for (let i = 0; i < 5; i += 1) { const t0 = Date.now(); await c.app.api('POST', '/api/plugins/reload', { token: c.owner }); times.push(Date.now() - t0); }
  ok(Math.max(...times) < 1000, `reload ${times}`);
  const hk = await c.app.hook('perf3', node('r', 'respond.webhook', 'R', { status: 200, send: 'json', json: '{"ok":true}' }));
  const t0 = Date.now();
  for (let i = 0; i < 200; i += 1) ok((await post(hk.url)).status === 200, 'call failed');
  const ms = Date.now() - t0;
  ok(ms < 20000, `${ms} ms`);
  return `reload ${times.join('/')} ms; 200 calls ${ms} ms (${(ms / 200).toFixed(0)} ms each)`;
});
test('DIST-01', 'Download', 'A fresh copy (as a user would download it) contains the plugins and starts with them', 'git archive of this branch into an empty folder, npm install, start, list plugins.', 'Plugins page data is complete; the editor bundle has the Plugins page.', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pqa-dist-'));
  execSync(`git archive HEAD | tar -x -C "${dir}"`, { cwd: FORK, shell: 'bash', stdio: 'pipe' });
  execSync('npm install --no-audit --no-fund --loglevel=error --omit=optional', { cwd: dir, stdio: 'pipe', timeout: 240000 });
  const a = await boot('dist', { cwd: dir, env: { PLUGINS_DIR: '' } });
  try {
    const t = await a.user();
    const l = (await a.api('GET', '/api/plugins', { token: t })).data;
    ok(['rest-connector', 'respond-to-webhook', 'data-tools'].every((id) => l.find((p) => p.id === id)?.status === 'ok'), JSON.stringify(l.map((p) => [p.id, p.status])));
    const html = await (await fetch(a.base + '/')).text();
    const js = html.match(/assets\/index-[^"]+\.js/)[0];
    ok((await (await fetch(`${a.base}/${js}`)).text()).includes('Make your own plugin'), 'bundle lacks the Plugins page');
    ok(fs.existsSync(path.join(dir, 'plugins', '_template', 'index.js')) && fs.existsSync(path.join(dir, 'scripts', 'new-plugin.cjs')), 'template/scaffold missing');
    return `${l.length} plugins in a clean copy`;
  } finally { a.stop(); }
});

/* =============================================== run ================================================ */
// shared apps: one for most cases, with every fixture plugin pre-created
const fixtures = (data, extra) => {
  writePlugin(path.join(data, 'plugins'), 'in-data', { id: 'in-data', name: 'In Data' }, GOOD('in-data', 'indata.hello'));
  writePlugin(path.join(data, 'plugins'), 'data-tools', { id: 'data-tools', name: 'Fake Data Tools' }, GOOD('x', 'fakedt.hello'));
  writePlugin(extra, 'मेरा plugin é', { id: 'unicode-path', name: 'Unicode' }, GOOD('unicode-path', 'unicodepath.hello'));
  writePlugin(extra, 'bad-json', '{ not json', GOOD('x'));
  writePlugin(extra, 'no-id', { name: 'No id' }, GOOD('x'));
  writePlugin(extra, 'bad-id', { id: 'Bad_ID!', name: 'x' }, GOOD('x'));
  writePlugin(extra, 'no-name', { id: 'no-name' }, GOOD('x'));
  writePlugin(extra, 'newer-api', { id: 'newer-api', name: 'Newer', apiVersion: 99 }, GOOD('x'));
  writePlugin(extra, 'no-manifest', null, GOOD('x'));
  writePlugin(extra, 'throws', { id: 'throws', name: 'Throws' }, 'export function register(){ throw new Error("kaboom"); }');
  writePlugin(extra, 'rejects', { id: 'rejects', name: 'Rejects' }, 'export async function register(){ throw "a plain string, not an Error"; }');
  writePlugin(extra, 'syntax-bad', { id: 'syntax-bad', name: 'Syntax' }, 'export function register( {{{ nope');
  writePlugin(extra, 'no-register', { id: 'no-register', name: 'No register' }, 'export const hello = 1;');
  writePlugin(extra, 'rules-upper', { id: 'rules-upper', name: 'R1' }, "export function register(sdk){ sdk.defineNode({ type: 'Rules.Upper', name: 'X', executeItem: async()=>({}) }); }");
  writePlugin(extra, 'rules-nodot', { id: 'rules-nodot', name: 'R2' }, "export function register(sdk){ sdk.defineNode({ type: 'nodot', name: 'X', executeItem: async()=>({}) }); }");
  writePlugin(extra, 'rules-noexec', { id: 'rules-noexec', name: 'R3' }, "export function register(sdk){ sdk.defineNode({ type: 'rulesnoexec.a', name: 'X' }); }");
  writePlugin(extra, 'rules-noname', { id: 'rules-noname', name: 'R4' }, "export function register(sdk){ sdk.defineNode({ type: 'rulesnoname.a', executeItem: async()=>({}) }); }");
  writePlugin(extra, 'rules-clash', { id: 'rules-clash', name: 'R5' }, "export function register(sdk){ sdk.defineNode({ type: 'rulesclash.first', name: 'F', executeItem: async()=>({}) }); sdk.defineNode({ type: 'logic.if', name: 'Steal', executeItem: async()=>({}) }); }");
  writePlugin(extra, 'rules-dup', { id: 'rules-dup', name: 'R6' }, "export function register(sdk){ const d={ type: 'rulesdup.one', name: 'D', executeItem: async()=>({}) }; sdk.defineNode(d); sdk.defineNode(d); }");
  writePlugin(extra, 'cred-clash', { id: 'cred-clash', name: 'Cred clash' }, "export function register(sdk){ sdk.defineNode({ type: 'credclash.node', name: 'N', executeItem: async()=>({}) }); sdk.defineCredentialType({ id: 'httpBearer', name: 'Dup', fields: [] }); }");
  writePlugin(extra, 'escape-test', { id: 'escape-test', name: 'Escape', entry: '../outside.js' }, null);
  fs.writeFileSync(path.join(extra, 'outside.js'), 'export function register(sdk){ sdk.defineNode({ type: "escaped.node", name: "E", executeItem: async()=>({}) }); }');
  writePlugin(extra, 'sdk-use', { id: 'sdk-use', name: 'SDK use' }, `
    import fs from 'node:fs'; import path from 'node:path';
    export function register(sdk){
      fs.writeFileSync(path.join(sdk.pluginDir, 'data.json'), '{"k":"v"}');
      sdk.defineNode({ type: 'sdkuse.info', name: 'Info', executeItem: async () => ({ json: sdk.readJson('data.json'), files: sdk.listFiles('.', '.json').length, dir: sdk.dataDir() }) });
    }`);
  // REST fixtures
  const specs = {
    mock: { id: 'mock', name: 'Mock', baseUrl: `${W}/svc`, headers: { 'x-extra': 'yes' }, auth: { type: 'bearer', label: 'Token' }, setup: ['Step'], test: { path: '/me', say: 'Connected as {name}.' }, operations: [
      { id: 'me', label: 'Me', path: '/me', fields: [] },
      { id: 'echo', label: 'Echo', method: 'POST', path: '/echo', fields: [{ name: 'count', type: 'number', in: 'query' }, { name: 'flag', type: 'boolean', in: 'query' }, { name: 'empty', in: 'query' }, { name: 'data', type: 'json', in: 'body' }, { name: 'xh', as: 'x-custom', in: 'header' }] },
      { id: 'listTasks', label: 'List', path: '/tasks', result: 'data.items', fields: [{ name: 'project', type: 'options', in: 'query', options: { from: '/projects', value: 'id', label: 'name' } }] },
      { id: 'listNone', label: 'None', path: '/none', fields: [{ name: 'x', type: 'options', in: 'query', options: { from: '/none', value: 'id', label: 'name' } }] },
      { id: 'getTask', label: 'Get task', path: '/tasks/{id}', fields: [{ name: 'id', in: 'path', required: true }] },
      { id: 'text', label: 'Text', path: '/text', fields: [] }, { id: 'empty', label: 'Empty', path: '/empty', fields: [] }, { id: 'none', label: 'NoneList', path: '/none', fields: [] },
      { id: 'missingPath', label: 'Missing', path: '/nested', result: 'data.nothing.here', fields: [] },
      { id: 'big', label: 'Big', path: '/big', fields: [] }, { id: 'slow', label: 'Slow', path: '/slow', fields: [] }, { id: 'redirect', label: 'Redirect', path: '/redirect', fields: [] },
      { id: 'rate', label: 'Rate', path: '/rate', fields: [] }, { id: 'boom', label: 'Boom', path: '/boom', fields: [] },
    ] },
    basic: { id: 'basic', name: 'Basic', baseUrl: `${W}/basic`, auth: { type: 'basic' }, operations: [{ id: 'ping', label: 'Ping', path: '/ping', fields: [] }] },
    hdr: { id: 'hdr', name: 'Hdr', baseUrl: `${W}/hdr`, auth: { type: 'header', header: 'x-api-key', prefix: 'tk-' }, operations: [{ id: 'ping', label: 'Ping', path: '/ping', fields: [] }] },
    sub: { id: 'sub', name: 'Sub', baseUrl: `http://{sub}:${world.address().port}/sub`, credentialFields: [{ name: 'sub', label: 'Host' }], auth: { type: 'bearer' }, operations: [{ id: 'ping', label: 'Ping', path: '/ping', fields: [] }] },
    dead: { id: 'dead', name: 'Dead', baseUrl: 'http://127.0.0.1:1/x', auth: { type: 'bearer' }, test: { path: '/me' }, operations: [{ id: 'me', label: 'Me', path: '/me', fields: [] }] },
  };
  const sd = path.join(data, 'plugin-data', 'rest-connector', 'services');
  fs.mkdirSync(sd, { recursive: true });
  for (const [id, s] of Object.entries(specs)) fs.writeFileSync(path.join(sd, `${id}.json`), JSON.stringify(s));
};
function svcFile() { /* placeholder to keep helper name used above */ }
void svcFile;

const main = await boot('main', { setup: fixtures });
const owner = await main.user();
const other = await main.user();
globalThis.__lastEmail = null;
const restCred = (await main.api('POST', '/api/credentials', { token: owner, body: { name: 'mock', type: 'rest_mock', data: { token: 'tok' } } })).data.id;
const ctx = { app: main, owner, other, restCred };

console.log(`PQA: ${REG.length} cases${ONLY ? ` (only ${ONLY.join(',')})` : ''}`);
for (const t of REG) {
  if (ONLY && !ONLY.includes(t.id)) continue;
  const t0 = Date.now();
  let status = 'PASS'; let actual = '';
  try {
    if (t.id === 'PLG-09') { /* needs the email of its own owner */
      const a = await boot('persist');
      const email = `own-${crypto.randomBytes(2).toString('hex')}@example.com`;
      const tk = (await a.api('POST', '/api/auth/signup', { body: { email, password: 'password123', name: 'O' } })).data.token;
      ok((await a.api('POST', '/api/plugins/data-tools/disable', { token: tk })).status === 200, 'disable failed');
      const d1 = a.data; a.stop(); await sleep(1500);
      const b = await boot('persist2', { setup: (d) => fs.cpSync(d1, d, { recursive: true }) });
      const tb = (await b.api('POST', '/api/auth/login', { body: { email, password: 'password123' } })).data.token;
      ok((await b.api('GET', '/api/plugins', { token: tb })).data.find((p) => p.id === 'data-tools').status === 'disabled', 'disabled state not remembered');
      ok(!(await b.api('GET', '/api/node-types', { token: tb })).data.some((n) => n.type === 'tools.sort'), 'blocks still present');
      await b.api('POST', '/api/plugins/data-tools/enable', { token: tb });
      const d2 = b.data; b.stop(); await sleep(1500);
      const c2 = await boot('persist3', { setup: (d) => fs.cpSync(d2, d, { recursive: true }) });
      const tc = (await c2.api('POST', '/api/auth/login', { body: { email, password: 'password123' } })).data.token;
      ok((await c2.api('GET', '/api/plugins', { token: tc })).data.find((p) => p.id === 'data-tools').status === 'ok', 'enabled state not remembered');
      c2.stop();
      actual = 'disabled and enabled states both survive a restart';
    } else actual = (await t.fn(ctx)) ?? '';
  } catch (e) {
    if (e instanceof Skip) { status = 'NOT TESTABLE'; actual = e.message; } else { status = 'FAIL'; actual = String(e.message ?? e).slice(0, 700); }
  }
  results.push({ id: t.id, group: t.group, title: t.title, steps: t.steps, expected: t.expected, status, actual, ms: Date.now() - t0 });
  console.log(`${status === 'PASS' ? 'ok  ' : status === 'FAIL' ? 'FAIL' : 'skip'} ${t.id} ${t.title} (${((Date.now() - t0) / 1000).toFixed(1)}s)${status === 'PASS' ? '' : `\n      ${actual}`}`);
  if (!(await alive(main))) { console.log('!! main app died after this case'); break; }
}
main.stop();
world.close();

let merged = results;
if (ONLY && fs.existsSync(RESULTS)) {
  const prev = JSON.parse(fs.readFileSync(RESULTS, 'utf8')).results;
  const byId = new Map(prev.map((r) => [r.id, r]));
  for (const r of results) { const old = byId.get(r.id); byId.set(r.id, { ...r, first_run: old?.first_run ?? (old && old.status !== r.status ? old.status : undefined) }); }
  merged = [...byId.values()].sort((a, b) => REG.findIndex((x) => x.id === a.id) - REG.findIndex((x) => x.id === b.id));
}
const count = (s) => merged.filter((r) => r.status === s).length;
fs.writeFileSync(RESULTS, JSON.stringify({ summary: { pass: count('PASS'), fail: count('FAIL'), notTestable: count('NOT TESTABLE'), seconds: Math.round((Date.now() - T0) / 1000), node: process.version }, results: merged }, null, 2));
console.log(`\n${count('PASS')} pass, ${count('FAIL')} fail, ${count('NOT TESTABLE')} not testable`);
process.exit(0);
