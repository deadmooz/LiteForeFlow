// Load test:  node server/test/load.mjs [--mode workflow|ingest] [--total N] [--conc N] [--dir <code folder>] [--label text]
//   workflow  every request runs a real workflow (webhook -> Code -> Set) and waits for the answer
//   ingest    every request is a ~1 KB JSON event accepted by a webhook that answers "immediately" (the run is queued)
// Starts the server from --dir exactly as `npm start` would (SQLite, in-process queue) on a fresh data folder,
// or tests a running stack with --url (then memory numbers are not available).
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : acc), []));
const MODE = args.mode ?? 'workflow'; // workflow | ingest | api
const TOTAL = Number(args.total ?? 20000);
const CONC = Number(args.conc ?? 64);
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(args.dir ?? path.join(here, '../..'));
const PORT = Number(args.port ?? 3290);
const external = args.url;
const base = external ?? `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

async function rssMb(pid) {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`]);
      return Number(stdout.trim()) / 1048576;
    }
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Number(stdout.trim()) / 1024;
  } catch { return NaN; }
}

const agent = new http.Agent({ keepAlive: true, maxSockets: CONC });
const url = new URL(base);
function request(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({ agent, host: url.hostname, port: url.port, method, path: p, headers: {
      ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } }, (res) => {
      let n = 0; const chunks = [];
      res.on('data', (c) => { n += c.length; if (chunks.length < 8) chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode, bytes: n, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

let child = null; let dataDir = null; let startupMs = 0;
if (!external) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-load-'));
  const t0 = Date.now();
  child = spawn(process.execPath, [...(args.nodeargs ?? '--max-semi-space-size=2 --max-old-space-size=192').split(' ').filter((x) => x && x !== 'none'), path.join(dir, 'server/src/index.js')], {
    cwd: dir, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LITEFOREFLOW_SECRET: 'load-test-secret-0123456789', NODE_ENV: 'production', AUTH_RATE_LIMIT_PER_MIN: '1000' },
  });
  for (let i = 0; i < 200; i += 1) { try { if ((await request('GET', '/api/health')).status === 200) break; } catch { /* starting */ } await sleep(100); }
  startupMs = Date.now() - t0;
  await sleep(1500);
}
const idle = child ? await rssMb(child.pid) : NaN;

const email = `load${Date.now()}@example.com`;
const signup = JSON.parse((await request('POST', '/api/auth/signup', { email, password: 'load-test-password' })).text);
const token = signup.token;
const hook = (nodes, connections) => ({ nodes, connections });
const trigger = (respond) => ({ id: 't', type: 'trigger.webhook', name: 'Hook', parameters: { path: 'load', method: 'POST', respond }, position: { x: 0, y: 0 } });
if (!external) { // the free plan allows 1,000 runs a month; the benchmark workspace needs the biggest plan
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'liteforeflow.db'));
  db.exec("PRAGMA busy_timeout = 5000; UPDATE workspaces SET plan = 'team'");
  db.close();
  await sleep(100);
}
const definition = MODE === 'workflow'
  ? hook([trigger('lastNode'),
    { id: 'c', type: 'data.code', name: 'Code', parameters: { mode: 'runOnce', code: 'return [{ n: items[0].body.n, sq: items[0].body.n * items[0].body.n }];' }, position: { x: 0, y: 0 } },
    { id: 's', type: 'data.set', name: 'Set', parameters: { fields: [{ name: 'label', value: 'n={{ $json.n }} sq={{ $json.sq }}' }], keepOthers: true }, position: { x: 0, y: 0 } }],
  [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }, { from: 'c', to: 's', fromOutput: 0, toInput: 0 }])
  : hook([trigger('immediately'),
    { id: 's', type: 'data.set', name: 'Set', parameters: { fields: [{ name: 'seen', value: 'yes' }], keepOthers: true }, position: { x: 0, y: 0 } }],
  [{ from: 't', to: 's', fromOutput: 0, toInput: 0 }]);
const wf = JSON.parse((await request('POST', '/api/workflows', { name: `load-${MODE}`, definition }, token)).text);
await request('POST', `/api/workflows/${wf.id}/activate`, undefined, token);

const event = (n) => ({ n, id: `evt-${n}`, user: { id: n % 977, name: 'Load Test', tags: ['a', 'b', 'c'] }, items: Array.from({ length: 8 }, (_, i) => ({ sku: `SKU-${i}`, qty: i + 1, price: 9.99 })), note: 'x'.repeat(400) });

const lat = new Float64Array(TOTAL);
const why = {};
let next = 0; let failed = 0; let bytes = 0; let peak = idle || 0;
const sampler = child ? setInterval(async () => { peak = Math.max(peak, (await rssMb(child.pid)) || 0); }, 2000) : null;
const progress = setInterval(() => process.stderr.write(`  ${next}/${TOTAL}\r`), 3000);
const t1 = performance.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < TOTAL) {
    const n = next; next += 1;
    const s = performance.now();
    try {
      const r = MODE === 'api'
        ? (n % 4 === 0 ? await request('GET', '/api/health') : await request('GET', n % 4 === 1 ? '/api/workflows' : n % 4 === 2 ? '/api/executions?limit=20' : '/api/me', undefined, token))
        : await request('POST', '/webhook/load', event(n));
      if (r.status !== 200) { failed += 1; const k = `HTTP ${r.status}: ${r.text.slice(0, 80)}`; why[k] = (why[k] ?? 0) + 1; }
      bytes += r.bytes;
    } catch (e) { failed += 1; const k = `${e.code ?? e.name}`; why[k] = (why[k] ?? 0) + 1; }
    lat[n] = performance.now() - s;
  }
}));
const secs = (performance.now() - t1) / 1000;
clearInterval(progress); if (sampler) clearInterval(sampler);
process.stderr.write('\n');

const drainSecs = 0;
await sleep(1500);
const after = child ? await rssMb(child.pid) : NaN;
const sorted = Array.from(lat).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
let recorded = 'n/a';
if (dataDir && MODE !== 'api') {
  await sleep(3000); // let the in-process queue finish what it accepted
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'liteforeflow.db'));
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM executions GROUP BY status').all();
  db.close();
  recorded = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
  recorded.accepted = TOTAL - failed;
}
const dbBytes = dataDir ? fs.readdirSync(dataDir).filter((f) => f.startsWith('liteforeflow.db')).reduce((n, f) => n + fs.statSync(path.join(dataDir, f)).size, 0) : NaN;

if (child) { child.kill(); await sleep(500); try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* still closing */ } }
agent.destroy();
const f = (n, d = 0) => (Number.isFinite(n) ? n.toFixed(d) : 'n/a');
console.log(JSON.stringify({
  label: args.label ?? path.basename(dir), mode: MODE, requests: TOTAL, concurrency: CONC, failed, failedWhy: why,
  totalTime: `${f(secs, 1)} s (${f(secs / 60, 1)} min)`, throughput: `${f(TOTAL / secs)} req/s`,
  latencyMs: { p50: f(pct(0.5), 1), p95: f(pct(0.95), 1), p99: f(pct(0.99), 1), max: f(sorted[sorted.length - 1], 0) },
  recordedExecutions: recorded, startup: child ? `${startupMs} ms` : 'n/a', rssMB: { idle: f(idle), peak: f(peak), afterLoad: f(after) },
  dbSizeMB: f(dbBytes / 1048576, 1), jsonSentMB: f((TOTAL * JSON.stringify(event(1)).length) / 1048576),
}));
