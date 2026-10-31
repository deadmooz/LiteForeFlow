// REAL-WORLD QA: workflows that call real public services on the internet (Hacker News, GitHub, Open-Meteo, JSONPlaceholder)
// and a real local Ollama model. Nothing is faked. The services were picked from the public-apis list (github.com/public-apis/public-apis)
// and each one's own documentation; none needs an account.
//   node server/test/qa/realworld-qa.mjs            all scenarios   (about 6 minutes; the AI ones are slow on a laptop)
//   ONLY=RW-01,RW-03 node ...                       some of them
// Results: server/test/qa/realworld-qa-results.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { launch, sleep, FORK } from './fork-lib.mjs';

const RESULTS = path.join(FORK, 'server/test/qa/realworld-qa-results.json');
const ONLY = process.env.ONLY?.split(',');
const results = [];
const timings = {};
const T0 = Date.now();

/* ------------------------------ helpers ------------------------------ */
class Skip extends Error {}
const ok = (c, m) => { if (!c) throw new Error(m); };
const show = (s, n = 100) => String(s).replace(/\s+/g, ' ').slice(0, n);
const node = (id, type, name, parameters = {}, extra = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 }, ...extra });
const edge = (from, to, o = 0) => ({ from, to, fromOutput: o, toInput: 0 });
const chainEdges = (nodes) => nodes.slice(1).map((n, i) => edge(nodes[i].id, n.id));

const agent = new https.Agent({ keepAlive: true });
/** A plain HTTPS GET with timing: what the internet alone costs, to compare with LiteForeFlow doing the same work. */
const direct = (url) => new Promise((resolve, reject) => {
  const t0 = process.hrtime.bigint();
  https.get(url, { agent, headers: { 'user-agent': 'LiteForeFlow-QA' } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, ms: Number(process.hrtime.bigint() - t0) / 1e6, body: Buffer.concat(chunks).toString() }));
  }).on('error', reject);
});

const SERVICES = {
  githubpublic: { id: 'githubpublic', name: 'GitHub (public, no token)', icon: '🐙', baseUrl: 'https://api.github.com', headers: { accept: 'application/vnd.github+json' }, auth: { type: 'none' },
    operations: [
      { id: 'releases', label: 'Releases of a repository', path: '/repos/{repo}/releases', fields: [{ name: 'repo', label: 'owner/name', in: 'path', raw: true, required: true }, { name: 'per_page', label: 'How many', in: 'query', default: 5 }] },
      { id: 'repo', label: 'One repository', path: '/repos/{repo}', fields: [{ name: 'repo', label: 'owner/name', in: 'path', raw: true, required: true }] },
    ] },
  openmeteogeo: { id: 'openmeteogeo', name: 'Open-Meteo place search', icon: '📍', baseUrl: 'https://geocoding-api.open-meteo.com/v1', auth: { type: 'none' },
    operations: [{ id: 'search', label: 'Find a place', path: '/search', fields: [{ name: 'name', label: 'Place', in: 'query' }, { name: 'count', label: 'How many', in: 'query', default: 1 }] }] },
  openmeteo: { id: 'openmeteo', name: 'Open-Meteo forecast', icon: '🌦️', baseUrl: 'https://api.open-meteo.com/v1', auth: { type: 'none' },
    operations: [{ id: 'forecast', label: 'Forecast', path: '/forecast', fields: [{ name: 'latitude', label: 'Latitude', in: 'query', required: true }, { name: 'longitude', label: 'Longitude', in: 'query', required: true }, { name: 'current', label: 'Current values', in: 'query', default: 'temperature_2m,wind_speed_10m,weather_code' }] }] },
  jsonplaceholder: { id: 'jsonplaceholder', name: 'JSONPlaceholder', icon: '🧪', baseUrl: 'https://jsonplaceholder.typicode.com', auth: { type: 'none' },
    operations: [
      { id: 'comments', label: 'All comments', path: '/comments', fields: [] },
      { id: 'createPost', label: 'Create a post', method: 'POST', path: '/posts', fields: [{ name: 'title', in: 'body', required: true }, { name: 'body', in: 'body' }, { name: 'userId', in: 'body', type: 'number' }] },
    ] },
  deadhost: { id: 'deadhost', name: 'Dead host', baseUrl: 'https://this-host-does-not-exist-liteforeflow.invalid', auth: { type: 'none' }, operations: [{ id: 'ping', label: 'Ping', path: '/', fields: [] }] },
};

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-data-'));
const sd = path.join(data, 'plugin-data', 'rest-connector', 'services');
fs.mkdirSync(sd, { recursive: true });
for (const [id, spec] of Object.entries(SERVICES)) fs.writeFileSync(path.join(sd, `${id}.json`), JSON.stringify(spec));

const h = launch('node', FORK, { env: { PORT: '5960', DATA_DIR: data, LITEFOREFLOW_SECRET: 'rw', AUTH_RATE_LIMIT_PER_MIN: '100000' } });
if (!(await h.ready)) throw new Error('app did not start\n' + h.log().slice(-500));
const base = h.url.replace(/\/$/, '');
const api = async (method, url, { token, body } = {}) => {
  const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let d = text; try { d = JSON.parse(text); } catch { /* text */ }
  return { status: res.status, data: d };
};
let users = 0;
const newUser = async () => { users += 1; return (await api('POST', '/api/auth/signup', { body: { email: `rw${users}-${Date.now()}@example.com`, password: 'password123', name: `RW${users}` } })).data.token; };
const token = await newUser();
const createWf = async (tk, name, nodes, connections) => {
  const r = await api('POST', '/api/workflows', { token: tk, body: { name, definition: { nodes, connections } } });
  ok(r.status === 201, `create workflow failed: ${JSON.stringify(r.data)}`);
  return r.data;
};
const run = async (tk, name, nodes) => {
  const all = [node('t', 'trigger.manual', 'Start'), ...nodes];
  const wf = await createWf(tk, name, all, chainEdges(all));
  const t0 = Date.now();
  const r = await api('POST', `/api/workflows/${wf.id}/run`, { token: tk });
  const out = (id) => r.data.results?.[id]?.output?.[0]?.map((i) => i.json) ?? [];
  return { r, wf, ms: Date.now() - t0, out, err: () => String(r.data.error?.message ?? r.data.error ?? '') };
};
const rss = async () => Number((await new Promise((res) => import('node:child_process').then(({ exec }) => exec(`powershell -NoProfile -Command "[math]::Round((Get-Process -Id ${h.proc.pid}).WorkingSet64/1MB)"`, (e, so) => res(so))))).trim());

const REG = [];
const test = (id, title, steps, expected, fn) => REG.push({ id, title, steps, expected, fn });

/** The Hacker News pipeline nodes (also reused by the AI scenario). */
const hnNodes = (count = 15) => [
  node('top', 'rest.hackernews', 'Top story ids', { operation: 'topStories' }),
  node('lim', 'data.limit', 'First few', { max: count }),
  node('item', 'rest.hackernews', 'Get each story', { operation: 'item', item__id: '{{ $json.value }}' }),
  node('flt', 'tools.filter', 'Only real stories', { conditions: [{ left: '{{ $json.type }}', op: 'equals', right: 'story' }, { left: '{{ $json.score }}', op: 'gte', right: '1' }], combine: 'all' }),
  node('srt', 'tools.sort', 'Best first', { field: 'score', direction: 'desc', kind: 'number' }),
  node('dt', 'tools.dateTime', 'When', { operation: 'format', date: '{{ $json.time }}', format: 'datetime', timezone: 'UTC', outputField: 'when' }),
  node('set', 'data.set', 'Tidy', { fields: [{ name: 'title', value: '{{ $json.title }}' }, { name: 'score', value: '{{ $json.score }}' }, { name: 'by', value: '{{ $json.by }}' }, { name: 'when', value: '{{ $json.when }}' }, { name: 'url', value: '{{ $json.url }}' }], keepOthers: false }),
  node('agg', 'data.aggregate', 'All stories', { field: 'stories' }),
];

/* ------------------------------ scenarios ------------------------------ */
test('RW-01', 'Hacker News digest: 15 live stories fetched one by one, filtered, sorted, dated and collected', 'Manual run: topStories -> Limit 15 -> item per id -> Filter -> Sort -> Date & Time -> Edit Fields -> Aggregate.',
  'Real titles, scores in descending order, valid dates; LiteForeFlow adds only a few milliseconds per call on top of the internet.', async () => {
    const x = await run(token, 'HN digest', hnNodes(15));
    ok(x.r.data.status === 'success', x.err());
    const stories = x.out('agg')[0]?.stories ?? [];
    ok(stories.length >= 5, `only ${stories.length} stories`);
    ok(stories.every((s) => typeof s.title === 'string' && s.title.length > 3), 'missing titles');
    ok(stories.every((s, i) => i === 0 || stories[i - 1].score >= s.score), `not sorted: ${stories.map((s) => s.score)}`);
    ok(stories.every((s) => /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(s.when)), `bad dates: ${stories.slice(0, 2).map((s) => s.when)}`);
    // the same 16 calls made directly, one after another, to see what the internet alone costs
    const ids = JSON.parse((await direct('https://hacker-news.firebaseio.com/v0/topstories.json')).body).slice(0, 15);
    let net = 0; for (const id of ids) net += (await direct(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).ms;
    timings.hn = { workflowMs: x.ms, internetOnlyMs: Math.round(net), calls: 16, overheadPerCallMs: +((x.ms - net) / 16).toFixed(1) };
    return `${stories.length} stories in ${x.ms} ms (the same calls made directly take ${Math.round(net)} ms; overhead ${timings.hn.overheadPerCallMs} ms per call). Top: "${show(stories[0].title, 60)}" (${stories[0].score} points, ${stories[0].when} UTC)`;
  });

test('RW-02', 'GitHub release watcher: releases of two real repositories, de-duplicated, newest first, age in days', 'Code -> GitHub (public, user-made service file) -> Remove Duplicates -> Sort by date -> Filter -> Date & Time (days ago) -> Edit Fields.',
  'Real release tags, newest first, a sensible age. (GitHub allows 60 unauthenticated calls an hour: a rate-limit answer is reported, not failed.)', async () => {
    const x = await run(token, 'Release watcher', [
      node('repos', 'data.code', 'Repos', { code: 'return [{ repo: "nodejs/node" }, { repo: "denoland/deno" }];' }),
      node('rel', 'rest.githubpublic', 'Releases', { operation: 'releases', releases__repo: '{{ $json.repo }}', releases__per_page: '4' }),
      node('uniq', 'tools.unique', 'No repeats', { field: 'tag_name' }),
      node('srt', 'tools.sort', 'Newest first', { field: 'published_at', direction: 'desc', kind: 'date' }),
      node('age', 'tools.dateTime', 'Days ago', { operation: 'diff', date: '{{ $json.published_at }}', other: '{{ $now }}', unit: 'days', outputField: 'daysAgo' }),
      node('set', 'data.set', 'Tidy', { fields: [{ name: 'tag', value: '{{ $json.tag_name }}' }, { name: 'name', value: '{{ $json.name }}' }, { name: 'daysAgo', value: '{{ $json.daysAgo }}' }, { name: 'prerelease', value: '{{ $json.prerelease }}' }], keepOthers: false }),
    ]);
    if (/403|rate limit/i.test(x.err())) throw new Skip(`GitHub's hourly limit for anonymous callers was reached: ${x.err().slice(0, 120)}`);
    ok(x.r.data.status === 'success', x.err());
    const rows = x.out('set');
    ok(rows.length >= 4, `only ${rows.length} releases`);
    ok(new Set(rows.map((r) => r.tag)).size === rows.length, 'duplicate tags survived');
    ok(rows.every((r) => Number.isFinite(Number(r.daysAgo)) && Number(r.daysAgo) >= 0 && Number(r.daysAgo) < 4000), `bad ages ${rows.map((r) => r.daysAgo)}`);
    ok(rows.every((r, i) => i === 0 || Number(rows[i - 1].daysAgo) <= Number(r.daysAgo) + 0.01), `not newest-first: ${rows.map((r) => r.daysAgo)}`);
    timings.github = { ms: x.ms, calls: 2 };
    return `${rows.length} releases, newest "${rows[0].tag}" (${Number(rows[0].daysAgo).toFixed(1)} days ago) in ${x.ms} ms`;
  });

const WEATHER_PATH = 'rw-weather';
let weatherReady = false;
const buildWeatherApi = async () => {
  if (weatherReady) return;
  const nodes = [
    node('hook', 'trigger.webhook', 'Weather API', { path: WEATHER_PATH, method: 'GET', respond: 'responseNode' }),
    node('geo', 'rest.openmeteogeo', 'Find the city', { operation: 'search', search__name: '{{ $json.query.city }}', search__count: '1' }),
    node('has', 'logic.if', 'Found?', { conditions: [{ left: '{{ $json.results }}', op: 'isNotEmpty' }] }),
    node('split', 'data.splitOut', 'The place', { field: 'results' }),
    node('fc', 'rest.openmeteo', 'Forecast', { operation: 'forecast', forecast__latitude: '{{ $json.latitude }}', forecast__longitude: '{{ $json.longitude }}' }),
    node('msg', 'data.set', 'Answer', { fields: [
      { name: 'city', value: '{{ $node["The place"].json.name }}' }, { name: 'country', value: '{{ $node["The place"].json.country }}' },
      { name: 'temperature', value: '{{ $json.current.temperature_2m }}' }, { name: 'wind_kmh', value: '{{ $json.current.wind_speed_10m }}' },
      { name: 'feels', value: '{{ $json.current.temperature_2m > 30 ? "hot" : $json.current.temperature_2m > 15 ? "mild" : "cold" }}' },
    ], keepOthers: false }),
    node('ok', 'respond.webhook', 'Send answer', { status: 200, send: 'firstItem' }),
    node('no', 'respond.webhook', 'Not found', { status: 404, send: 'json', json: '{"error": "city not found", "asked": "{{ $json.generationtime_ms >= 0 ? \\"unknown city\\" : \\"\\" }}"}' }),
  ];
  const wf = await createWf(token, 'Weather API', nodes, [edge('hook', 'geo'), edge('geo', 'has'), edge('has', 'split', 0), edge('split', 'fc'), edge('fc', 'msg'), edge('msg', 'ok'), edge('has', 'no', 1)]);
  const act = await api('POST', `/api/workflows/${wf.id}/activate`, { token });
  ok(act.data.active === true, `activate failed: ${JSON.stringify(act.data)}`);
  weatherReady = true;
};

test('RW-03', 'A real little web API built with LiteForeFlow: GET /webhook/rw-weather?city=... answers with live weather', 'Webhook -> Open-Meteo place search -> IF found -> forecast -> answer / 404.',
  'Mumbai -> 200 with a real temperature; an unknown city -> 404 JSON; no city -> a clean error, not a crash.', async () => {
    await buildWeatherApi();
    const get = (q) => fetch(`${base}/webhook/${WEATHER_PATH}${q}`);
    let r = await get('?city=Mumbai'); const j = await r.json();
    ok(r.status === 200, `Mumbai -> ${r.status} ${JSON.stringify(j)}`);
    ok(j.city === 'Mumbai' && j.country === 'India' && typeof j.temperature === 'number' && j.temperature > -40 && j.temperature < 60 && ['hot', 'mild', 'cold'].includes(j.feels), JSON.stringify(j));
    r = await get('?city=Zzzqxwvk'); const nf = await r.json();
    ok(r.status === 404 && nf.error === 'city not found', `unknown city -> ${r.status} ${JSON.stringify(nf)}`);
    r = await get(''); const none = await r.text();
    ok(r.status < 600 && r.status >= 200 && !/at .*\.js:\d+/.test(none), `no city -> ${r.status} ${none.slice(0, 150)}`);
    ok((await fetch(`${base}/api/health`)).ok, 'server died');
    return `Mumbai: ${j.temperature}°C, wind ${j.wind_kmh} km/h, "${j.feels}"; unknown city -> 404; empty request -> ${r.status} ${show(none, 70)}`;
  });

test('RW-04', 'The same API under load: 24 requests, 6 at a time, 4 different real cities', '24 GET calls to the weather API with Paris, Tokyo, Nairobi, Lima.',
  'Every answer is right; memory does not grow; LiteForeFlow adds little to the internet\'s own time.', async () => {
    await buildWeatherApi();
    const cities = ['Paris', 'Tokyo', 'Nairobi', 'Lima'];
    const mem0 = await rss(); const lat = [];
    let n = 0; const bad = [];
    const t0 = Date.now();
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (n < 24) {
        const i = n; n += 1; const city = cities[i % 4]; const s = Date.now();
        const r = await fetch(`${base}/webhook/${WEATHER_PATH}?city=${city}`); const j = await r.json(); lat.push(Date.now() - s);
        if (r.status !== 200 || j.city !== city || typeof j.temperature !== 'number') bad.push(`${city}: ${r.status} ${JSON.stringify(j).slice(0, 80)}`);
      }
    }));
    const total = Date.now() - t0; lat.sort((a, b) => a - b);
    const up = await Promise.all([direct('https://geocoding-api.open-meteo.com/v1/search?name=Paris&count=1'), direct('https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m')]);
    const mem1 = await rss();
    timings.weatherApi = { requests: 24, concurrency: 6, totalMs: total, p50: lat[12], p95: lat[22], upstreamPerRequestMs: Math.round(up[0].ms + up[1].ms), memBeforeMb: mem0, memAfterMb: mem1 };
    ok(bad.length === 0, bad.slice(0, 3).join(' | '));
    ok(mem1 - mem0 < 40, `memory grew ${mem1 - mem0} MB`);
    return `24 answers correct in ${total} ms (median ${lat[12]} ms, 95th ${lat[22]} ms; the two upstream calls alone take ~${Math.round(up[0].ms + up[1].ms)} ms); memory ${mem0} -> ${mem1} MB`;
  });

test('RW-05', 'Bulk data: 500 real comments cleaned and batched', 'JSONPlaceholder comments -> Remove Duplicates (email) -> Sort -> Split into Batches (50) -> Aggregate counts.',
  '500 rows in, unique emails out, batches of 50, in well under a second of our own time.', async () => {
    const x = await run(token, 'Bulk comments', [
      node('c', 'rest.jsonplaceholder', 'Comments', { operation: 'comments' }),
      node('u', 'tools.unique', 'One per email', { field: 'email', keep: 'first' }),
      node('s', 'tools.sort', 'By email', { field: 'email', kind: 'text' }),
      node('b', 'tools.chunk', 'Batches', { size: 50 }),
      node('a', 'data.aggregate', 'Batches together', { field: 'batches' }),
    ]);
    ok(x.r.data.status === 'success', x.err());
    const batches = x.out('a')[0].batches;
    const total = batches.reduce((n, b) => n + b.items.length, 0);
    const direct500 = JSON.parse((await direct('https://jsonplaceholder.typicode.com/comments')).body);
    const uniq = new Set(direct500.map((c) => c.email)).size;
    ok(total === uniq, `expected ${uniq} unique emails, got ${total}`);
    ok(batches.every((b, i) => b.items.length === (i < batches.length - 1 ? 50 : total - 50 * (batches.length - 1))), 'batch sizes');
    const emails = batches.flatMap((b) => b.items.map((i) => i.email));
    ok(emails.every((e, i) => i === 0 || emails[i - 1].localeCompare(e, undefined, { numeric: true, sensitivity: 'base' }) <= 0), 'not sorted');
    const post = await run(token, 'Create post', [node('p', 'rest.jsonplaceholder', 'Create', { operation: 'createPost', createPost__title: 'hello from LiteForeFlow', createPost__body: 'real POST', createPost__userId: '7' })]);
    ok(post.r.data.status === 'success' && post.out('p')[0].title === 'hello from LiteForeFlow' && post.out('p')[0].userId === 7 && post.out('p')[0].id, JSON.stringify(post.out('p')));
    timings.bulk = { ms: x.ms, rows: 500 };
    return `500 comments -> ${uniq} unique -> ${batches.length} batches in ${x.ms} ms; POST created id ${post.out('p')[0].id}`;
  });

test('RW-06', 'Real failures are explained: missing repo, dead host, bad parameters, retry and continue-on-fail', 'GitHub 404, a host that does not exist, Open-Meteo 400, HTTP node with retries and with continue-on-fail.',
  'Each error names the service and the reason in plain words; retries are counted; the run can carry on.', async () => {
    const msgs = {};
    let x = await run(token, 'GH 404', [node('a', 'rest.githubpublic', 'Repo', { operation: 'repo', repo__repo: 'liteforeflow-qa/this-repo-does-not-exist-123' })]);
    if (/rate limit/i.test(x.err())) throw new Skip('GitHub rate limit reached');
    ok(/GitHub \(public, no token\): HTTP 404.*Not Found/i.test(x.err()), `404 message: "${x.err()}"`); msgs.github404 = x.err();
    x = await run(token, 'dead host', [node('a', 'rest.deadhost', 'Ping', { operation: 'ping' })]);
    ok(/could not connect to this-host-does-not-exist-liteforeflow\.invalid \(no such address\)/.test(x.err()), `dead host: "${x.err()}"`); msgs.deadHost = x.err();
    x = await run(token, 'bad coords', [node('a', 'rest.openmeteo', 'Forecast', { operation: 'forecast', forecast__latitude: '999', forecast__longitude: '999' })]);
    ok(/HTTP 400/.test(x.err()) && /latitude|Latitude/i.test(x.err()), `bad coordinates: "${x.err()}"`); msgs.badParams = x.err();
    x = await run(token, 'retry', [node('a', 'http.request', 'Dead call', { method: 'GET', url: 'https://this-host-does-not-exist-liteforeflow.invalid/x' }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 100 })]);
    ok(x.r.data.status === 'error' && x.r.data.results.a.tries === 3, `retries: ${x.r.data.results?.a?.tries}`);
    x = await run(token, 'continue', [node('a', 'http.request', 'Dead call', { method: 'GET', url: 'https://this-host-does-not-exist-liteforeflow.invalid/x' }, { continueOnFail: true }), node('b', 'data.set', 'After', { fields: [{ name: 'carriedOn', value: 'yes' }], keepOthers: true })]);
    ok(x.r.data.status === 'success' && x.out('b')[0].carriedOn === 'yes' && x.out('b')[0].error, JSON.stringify(x.out('b')));
    return `GitHub: "${show(msgs.github404, 70)}" | dead host: "${show(msgs.deadHost, 90)}" | bad params: "${show(msgs.badParams, 80)}"`;
  });

test('RW-07', 'Test connection with real services', 'A made-up GitHub token against api.github.com; a real Ollama as an OpenAI-compatible server; Ollama\'s own test.',
  'GitHub says the token was rejected in plain words; Ollama answers with its models.', async () => {
    const t = (type, d) => api('POST', '/api/credentials/test', { token, body: { type, data: d } });
    const gh = (await t('rest_github', { token: 'ghp_thisIsNotARealToken000000000000000000' })).data;
    if (/rate limit/i.test(gh.message ?? '')) throw new Skip('GitHub rate limit reached');
    ok(gh.ok === false && /401/.test(gh.message) && /rejected/.test(gh.message), JSON.stringify(gh));
    const oa = (await t('openaiApi', { apiKey: 'not-needed', baseUrl: 'http://localhost:11434/v1' })).data;
    ok(oa.ok && /Connected\. \d+ models/.test(oa.message), JSON.stringify(oa));
    const ol = (await t('ollamaApi', {})).data;
    ok(ol.ok && /Installed models/.test(ol.message), JSON.stringify(ol));
    return `GitHub: "${show(gh.message, 80)}" | OpenAI-style on Ollama: "${oa.message}" | Ollama: "${show(ol.message, 60)}"`;
  });

test('RW-08', 'Import a real n8n workflow downloaded from GitHub', 'Download the n8n self-hosted AI starter kit demo workflow from raw.githubusercontent.com and import it.',
  'Imported or refused politely, with a readable report of what could not be converted; the result opens.', async () => {
    const r = await direct('https://raw.githubusercontent.com/n8n-io/self-hosted-ai-starter-kit/main/n8n/demo-data/workflows/srOnR8PAY3u4RSwb.json');
    ok(r.status === 200, `download ${r.status}`);
    const wfJson = JSON.parse(r.body);
    const imp = await api('POST', '/api/import/n8n', { token, body: { workflow: wfJson } });
    ok(imp.status < 500, `${imp.status} ${JSON.stringify(imp.data).slice(0, 200)}`);
    if (imp.status === 201) {
      const open = await api('GET', `/api/workflows/${imp.data.workflow.id}`, { token });
      ok(open.status === 200, 'imported workflow does not open');
      return `imported "${wfJson.name}": ${wfJson.nodes.length} nodes; report: ${show(JSON.stringify(imp.data.report), 220)}`;
    }
    ok(typeof imp.data.error === 'string' && imp.data.error.length > 5, JSON.stringify(imp.data));
    return `politely refused (${imp.status}): ${show(imp.data.error, 160)}`;
  });

test('RW-09', 'AI + real data: a local model reads today\'s Hacker News titles and returns structured JSON', 'HN top stories -> one text -> LLM (Ollama qwen3.5:4b) with "parse reply as JSON".',
  'A parsed object with a short theme and a mood from the allowed list.', async () => {
    const models = await fetch('http://localhost:11434/api/tags').then((r) => r.json()).catch(() => null);
    if (!models?.models?.length) throw new Skip('Ollama is not running');
    const model = models.models[0].name;
    const nodes = [...hnNodes(8).slice(0, 7), node('agg', 'data.aggregate', 'All', { field: 'stories' }),
      node('txt', 'data.set', 'Titles as text', { fields: [{ name: 'titles', value: '{{ $json.stories.slice(0, 6).map((s) => s.title).join(" | ") }}' }], keepOthers: false }),
      node('llm', 'ai.llm', 'Read the news', { provider: 'ollama', model, temperature: 0, system: 'You are a concise news analyst. Answer with JSON only.', prompt: 'Here are today\'s top Hacker News titles: {{ $json.titles }}\nReply ONLY with JSON like {"theme": "<three words>", "mood": "positive" | "neutral" | "negative"}', maxTokens: '', parseJson: true })];
    const x = await run(token, 'AI news', nodes);
    ok(x.r.data.status === 'success', x.err());
    const o = x.out('llm')[0];
    ok(typeof o.parsed?.theme === 'string' && o.parsed.theme.length > 2 && ['positive', 'neutral', 'negative'].includes(o.parsed.mood), JSON.stringify(o.parsed ?? o.text));
    timings.aiNews = { ms: x.ms, model, tokens: o.usage?.completion_tokens };
    return `${model} -> ${JSON.stringify(o.parsed)} in ${(x.ms / 1000).toFixed(1)} s (${o.usage?.completion_tokens} tokens)`;
  });

test('RW-10', 'AI agent with a real tool: it fetches live weather from the internet and answers', 'Agent (Ollama) with the http_get tool: temperature in Paris from the Open-Meteo URL.',
  'The tool is called with the real URL and the answer contains a temperature.', async () => {
    const models = await fetch('http://localhost:11434/api/tags').then((r) => r.json()).catch(() => null);
    if (!models?.models?.length) throw new Skip('Ollama is not running');
    const x = await run(token, 'Agent weather', [node('a', 'ai.agent', 'Weather agent', { provider: 'ollama', model: models.models[0].name, temperature: 0, maxSteps: 4, tools: '["http_get"]', system: 'You answer using the http_get tool. Be brief.', prompt: 'Use http_get on https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current=temperature_2m and tell me the current temperature in Paris in degrees Celsius.' })]);
    ok(x.r.data.status === 'success', x.err());
    const o = x.out('a')[0];
    ok(o.steps.some((s) => s.tool === 'http_get' && /open-meteo/.test(JSON.stringify(s.input))), `tool use: ${JSON.stringify(o.steps).slice(0, 200)}`);
    ok(/\d/.test(o.text), `answer: ${o.text}`);
    timings.agent = { ms: x.ms, steps: o.steps.length };
    return `tool called ${o.steps.length}x; answer "${show(o.text, 90)}" in ${(x.ms / 1000).toFixed(1)} s`;
  });

const SCHEDULE = { wfId: null, startedAt: 0 };
test('RW-11', 'A real schedule: a workflow set to run every minute fetches live data on its own', 'Activate "* * * * *" (Hacker News top story), keep working, then look at the run history about 75 s later.',
  'At least one run started by the scheduler, successful, with real data.', async () => {
    if (!SCHEDULE.wfId) throw new Error('schedule not prepared');
    const wait = 80000 - (Date.now() - SCHEDULE.startedAt);
    if (wait > 0) await sleep(wait);
    const list = await api('GET', '/api/executions?limit=20', { token: scheduleToken });
    const mine = (list.data.items ?? list.data).filter((e) => e.workflowId === SCHEDULE.wfId || e.workflow_id === SCHEDULE.wfId || e.workflowName === 'Every minute');
    ok(mine.length >= 1, `no scheduled run after ${Math.round((Date.now() - SCHEDULE.startedAt) / 1000)} s: ${JSON.stringify(list.data).slice(0, 200)}`);
    ok(mine.every((e) => e.status === 'success'), `statuses ${mine.map((e) => e.status)}`);
    const detail = (await api('GET', `/api/executions/${mine[0].id}`, { token: scheduleToken })).data;
    ok(detail.mode && detail.mode !== 'manual', `mode ${detail.mode}: a scheduled run must not be recorded as a manual one`);
    const out = detail.results?.g?.output?.[0]?.[0]?.json;
    ok(out && (out.title || out.ok), `no real data in the run: ${JSON.stringify(out)?.slice(0, 120)}`);
    await api('POST', `/api/workflows/${SCHEDULE.wfId}/deactivate`, { token: scheduleToken });
    return `${mine.length} scheduled run(s), mode "${detail.mode}", top story "${show(out.title ?? 'item', 60)}"`;
  });
let scheduleToken = null;

/* ------------------------------ run ------------------------------ */
scheduleToken = await newUser();
if (!ONLY || ONLY.includes('RW-11')) {
  const nodes = [node('s', 'trigger.cron', 'Every minute', { cron: '* * * * *', timezone: 'UTC' }), node('t', 'rest.hackernews', 'Top ids', { operation: 'topStories' }), node('l', 'data.limit', 'One', { max: 1 }), node('g', 'rest.hackernews', 'Story', { operation: 'item', item__id: '{{ $json.value }}' })];
  const wf = await createWf(scheduleToken, 'Every minute', nodes, [edge('s', 't'), edge('t', 'l'), edge('l', 'g')]);
  const act = await api('POST', `/api/workflows/${wf.id}/activate`, { token: scheduleToken });
  ok(act.data.active === true, `schedule activate failed ${JSON.stringify(act.data)}`);
  SCHEDULE.wfId = wf.id; SCHEDULE.startedAt = Date.now();
}
console.log(`real-world QA: ${REG.length} scenarios${ONLY ? ` (only ${ONLY})` : ''}`);
for (const t of REG) {
  if (ONLY && !ONLY.includes(t.id)) continue;
  const t0 = Date.now(); let status = 'PASS'; let actual = '';
  try { actual = (await t.fn()) ?? ''; } catch (e) { if (e instanceof Skip) { status = 'NOT TESTABLE'; actual = e.message; } else { status = 'FAIL'; actual = String(e.message ?? e).slice(0, 700); } }
  results.push({ id: t.id, title: t.title, steps: t.steps, expected: t.expected, status, actual, ms: Date.now() - t0 });
  console.log(`${status === 'PASS' ? 'ok  ' : status === 'FAIL' ? 'FAIL' : 'skip'} ${t.id} ${t.title} (${((Date.now() - t0) / 1000).toFixed(1)}s)\n      ${actual}`);
}
h.stop();
const count = (s) => results.filter((r) => r.status === s).length;
fs.writeFileSync(RESULTS, JSON.stringify({ summary: { pass: count('PASS'), fail: count('FAIL'), notTestable: count('NOT TESTABLE'), seconds: Math.round((Date.now() - T0) / 1000) }, timings, results }, null, 2));
console.log(`\n${count('PASS')} pass, ${count('FAIL')} fail, ${count('NOT TESTABLE')} not testable in ${Math.round((Date.now() - T0) / 1000)} s\ntimings: ${JSON.stringify(timings)}`);
process.exit(0);
