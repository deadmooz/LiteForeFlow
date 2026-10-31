// Repeatable speed + memory benchmark. Starts a fresh copy of the app, runs the scenarios below and prints a table.
//   node server/test/bench/bench.mjs [label] [--only=S3,S5] [--cwd=<folder of another checkout>] [--repeat=3]
// Memory is the app process's working set (what Task Manager shows), sampled every 100 ms, so "peak" is real.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, sleep, FORK, FLAGS } from '../qa/fork-lib.mjs';

const args = process.argv.slice(2);
const label = args.find((a) => !a.startsWith('--')) ?? 'run';
const opt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(a.indexOf('=') + 1) : d; };
const only = opt('only', '')?.split(',').filter(Boolean);
const cwd = opt('cwd', FORK);
const repeat = Number(opt('repeat', 1));
const nodeFlags = opt('flags', '');
const v8 = opt('v8', '');
if (v8) FLAGS.splice(0, FLAGS.length, ...v8.split(' ').filter(Boolean)); // replace the launcher's V8 flags for an experiment

const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });

// Node's built-in fetch adds ~13 ms per call on Windows (it would swamp every API number), so plain http with keep-alive is used.
const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const request = (method, urlStr, { token, body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(urlStr);
  const payload = body === undefined ? null : JSON.stringify(body);
  const r = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}) } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
  });
  r.on('error', reject); if (payload) r.write(payload); r.end();
});

/* ---------- memory sampler: one PowerShell loop printing the working set every 100 ms ---------- */
function sampler(pid) {
  const ps = spawn('powershell', ['-NoProfile', '-Command', `while($true){ try { (Get-Process -Id ${pid}).WorkingSet64 } catch { break }; Start-Sleep -Milliseconds 100 }`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let last = 0; let peak = 0;
  ps.stdout.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) { const v = Number(l); if (v) { last = v; if (v > peak) peak = v; } } });
  return { now: () => last / 1048576, peak: () => peak / 1048576, resetPeak: () => { peak = last; }, stop: () => ps.kill() };
}

async function run() {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-'));
  const t0 = Date.now();
  const h = launch('node', cwd, { env: { PORT: '5990', DATA_DIR: data, LITEFOREFLOW_SECRET: 'bench', AUTH_RATE_LIMIT_PER_MIN: '100000', NODE_OPTIONS: nodeFlags } });
  if (!(await h.ready)) throw new Error('app did not start:\n' + h.log().slice(-500));
  const startMs = Date.now() - t0;
  const base = h.url.replace(/\/$/, '');
  const mem = sampler(h.proc.pid);
  const api = async (method, url, { token, body } = {}) => {
    const res = await request(method, base + url, { token, body });
    let d = res.text; try { d = JSON.parse(res.text); } catch { /* text */ }
    return { status: res.status, data: d };
  };
  const token = (await api('POST', '/api/auth/signup', { body: { email: 'bench@example.com', password: 'password123', name: 'Bench' } })).data.token;
  await sleep(1200);
  const idle = mem.now();
  const rows = [];

  const wfOf = async (nodes, name) => {
    const all = [node('t', 'trigger.manual', 'Start'), ...nodes];
    const wf = await api('POST', '/api/workflows', { token, body: { name, definition: { nodes: all, connections: nodes.map((n, i) => edge(i ? nodes[i - 1].id : 't', n.id)) } } });
    if (wf.status !== 201) throw new Error(`workflow: ${JSON.stringify(wf.data)}`);
    return wf.data.id;
  };
  const gen = (n) => node('g', 'data.code', 'Gen', { code: `return Array.from({length:${n}},(_,i)=>({id:i, v:(i*7919)%10007, name:'item'+i, tags:['a','b'], nested:{x:i%10}}));` });
  const scenario = async (id, title, units, fn) => {
    if (only.length && !only.includes(id)) return;
    await sleep(300); mem.resetPeak();
    const before = mem.now();
    const t = Date.now();
    let note = '';
    try { note = (await fn()) ?? ''; } catch (e) { note = `FAILED: ${String(e.message).slice(0, 160)}`; }
    const ms = Date.now() - t;
    await sleep(250);
    rows.push({ id, title, units, ms, perUnit: units ? ms / units : null, peakMb: mem.peak(), growMb: mem.peak() - before, afterMb: mem.now(), note });
    process.stdout.write(`  ${id.padEnd(4)} ${title.padEnd(46)} ${String(ms).padStart(7)} ms ${units ? `${(ms / units).toFixed(3).padStart(8)} ms/unit` : ' '.repeat(16)}  peak ${mem.peak().toFixed(0).padStart(4)} MB  after ${mem.now().toFixed(0).padStart(4)} MB ${note ? ` ${note}` : ''}\n`);
  };
  const runWf = async (id) => { const r = await api('POST', `/api/workflows/${id}/run`, { token }); if (r.data.status !== 'success') throw new Error(JSON.stringify(r.data.error ?? r.data).slice(0, 200)); return ''; };

  console.log(`\n== ${label} (cwd ${path.basename(cwd)}${nodeFlags ? `, ${nodeFlags}` : ''}) ==  start-up ${startMs} ms, idle ${idle.toFixed(0)} MB`);

  const s1 = await wfOf([gen(10000), node('x', 'data.set', 'Set', { fields: [{ name: 'k', value: '{{ $json.v }}' }, { name: 'n', value: '{{ $json.nested.x }}' }], keepOthers: true })], 'S1');
  await scenario('S1', '10,000 items, 2 plain {{ $json.path }} lookups', 10000, () => runWf(s1));

  const s2 = await wfOf([gen(10000), node('x', 'logic.if', 'IF', { conditions: [{ left: '{{ $json.v }}', op: 'gt', right: '5000' }] })], 'S2');
  await scenario('S2', '10,000 items through IF (1 lookup)', 10000, () => runWf(s2));

  const s3 = await wfOf([gen(3000), node('x', 'data.set', 'Set', { fields: [{ name: 'k', value: '{{ $json.v * 2 + 1 }}' }], keepOthers: true })], 'S3');
  await scenario('S3', '3,000 items, real JavaScript expression', 3000, () => runWf(s3));

  const s4 = await wfOf([gen(2000), node('x', 'data.set', 'Set', { fields: [{ name: 'first', value: '{{ $node["Gen"].json.name }}' }, { name: 'idx', value: '{{ $itemIndex }}' }], keepOthers: false })], 'S4');
  await scenario('S4', '2,000 items, {{ $node[...] }} lookup (was O(n^2))', 2000, () => runWf(s4));

  const s5 = await wfOf([gen(50000), node('x', 'tools.sort', 'Sort', { field: 'v', kind: 'number' }), node('y', 'tools.unique', 'U', { field: 'id' }), node('z', 'data.aggregate', 'Agg', { field: 'all' })], 'S5');
  await scenario('S5', '50,000 items, no expressions (sort, unique, aggregate)', 50000, () => runWf(s5));

  const s6 = await wfOf([gen(30000), node('x', 'data.limit', 'Limit', { max: 5 })], 'S6');
  await scenario('S6', '30,000 items generated, keep 5 (memory)', 30000, () => runWf(s6));

  const s7 = await wfOf([node('a', 'data.set', 'A', { fields: [{ name: 'a', value: '{{ $now }}' }, { name: 'b', value: 'x' }], keepOthers: true }), node('b', 'logic.if', 'If', { conditions: [{ left: '{{ $json.b }}', op: 'equals', right: 'x' }] }), node('c', 'data.set', 'C', { fields: [{ name: 'c', value: '{{ $json.a }}' }], keepOthers: true })], 'S7');
  await scenario('S7', '300 small runs, 3 nodes, 4 expressions each', 300, async () => { for (let i = 0; i < 300; i += 1) await runWf(s7); });

  const hook = await wfOf([node('r', 'respond.webhook', 'Respond', { status: 200, send: 'json', json: '{"ok": true, "n": "{{ $json.query.n }}"}' })], 'S8');
  void hook;
  const wh = await api('POST', '/api/workflows', { token, body: { name: 'hook', definition: { nodes: [node('t', 'trigger.webhook', 'Hook', { path: 'bench', method: 'ANY', respond: 'responseNode' }), node('r', 'respond.webhook', 'Respond', { status: 200, send: 'json', json: '{"ok": true, "n": "{{ $json.query.n }}"}' })], connections: [edge('t', 'r')] } } });
  await api('POST', `/api/workflows/${wh.data.id}/activate`, { token });
  await scenario('S8', '400 webhook calls, 8 at a time', 400, async () => {
    let n = 0;
    await Promise.all(Array.from({ length: 8 }, async () => { while (n < 400) { const i = n++; const r = await request('GET', `${base}/webhook/bench?n=${i}`); if (r.status !== 200) throw new Error(`call ${i}: ${r.status}`); } }));
  });

  await scenario('S9', '300 x list executions + 300 x list workflows', 600, async () => { for (let i = 0; i < 300; i += 1) { await api('GET', '/api/executions?limit=20', { token }); await api('GET', '/api/workflows', { token }); } });

  // an upstream service that takes 100 ms per answer: the typical "one API call for every item" workflow
  const upstream = http.createServer((q, r) => setTimeout(() => { r.setHeader('content-type', 'application/json'); r.end('{"ok":true}'); }, 100)).listen(0);
  const s11 = await wfOf([node('g', 'data.code', 'Gen', { code: 'return Array.from({length:40},(_,i)=>({i}));' }), node('x', 'http.request', 'GET each', { method: 'GET', url: `http://127.0.0.1:${upstream.address().port}/item?i={{ $json.i }}` })], 'S11');
  await scenario('S11', '40 items, one GET each to a 100 ms service', 40, () => runWf(s11));
  upstream.close();

  await scenario('S10', 'then 25 s of doing nothing (idle pool, GC, memory trim)', 0, async () => { await sleep(25000); });

  mem.stop();
  const final = { label, startMs, idleMb: idle, rows };
  h.stop();
  await sleep(500);
  return final;
}

const results = [];
for (let i = 0; i < repeat; i += 1) results.push(await run());
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), `result-${label}.json`);
fs.writeFileSync(out, JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
console.log(`\nsaved ${path.relative(FORK, out)}`);
process.exit(0);
