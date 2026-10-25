// Footprint benchmark:  node server/test/bench.mjs
// Starts the server exactly as `npm start` would (SQLite + in-process queue), then reports resident memory
// idle / under load, startup time and throughput. Works on Windows and Linux/macOS.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3099;
const base = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-bench-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const t0 = Date.now();
const child = spawn(process.execPath, [...((process.env.BENCH_NODE_ARGS ?? '--max-semi-space-size=2 --max-old-space-size=192').split(' ').filter(Boolean)), path.join(here, '../src/index.js')], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, LITEFOREFLOW_SECRET: 'bench', NODE_ENV: 'production' }, stdio: 'ignore',
});
for (let i = 0; i < 100; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ } await sleep(100); }
const startupMs = Date.now() - t0;
await sleep(2000);
const idle = await rssMb(child.pid);

const call = async (method, url, body, token) => (await (await fetch(base + url, {
  method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
})).json());
const { token } = await call('POST', '/api/auth/signup', { email: 'bench@example.com', password: 'bench-password' });
const wf = await call('POST', '/api/workflows', {
  name: 'bench', definition: {
    nodes: [
      { id: 't', type: 'trigger.webhook', name: 'Hook', parameters: { path: 'bench', method: 'POST', respond: 'lastNode' }, position: { x: 0, y: 0 } },
      { id: 'c', type: 'data.code', name: 'Code', parameters: { mode: 'runOnce', code: 'return [{ n: items[0].body.n, sq: items[0].body.n * items[0].body.n }];' }, position: { x: 0, y: 0 } },
      { id: 's', type: 'data.set', name: 'Set', parameters: { fields: [{ name: 'label', value: 'n={{ $json.n }} sq={{ $json.sq }}' }], keepOthers: true }, position: { x: 0, y: 0 } },
    ],
    connections: [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }, { from: 'c', to: 's', fromOutput: 0, toInput: 0 }],
  },
}, token);
await call('POST', `/api/workflows/${wf.id}/activate`, undefined, token);

const TOTAL = Number(process.env.BENCH_RUNS ?? 600);
const CONC = 10;
let done = 0;
let peak = 0;
const t1 = Date.now();
const sampler = setInterval(async () => { peak = Math.max(peak, (await rssMb(child.pid)) || 0); }, 1500);
await Promise.all(Array.from({ length: CONC }, async () => {
  while (done < TOTAL) {
    const n = done; done += 1;
    const r = await fetch(`${base}/webhook/bench`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n }) });
    if (!r.ok) throw new Error(`run ${n} failed: ${r.status}`);
    await r.json();
  }
}));
const secs = (Date.now() - t1) / 1000;
clearInterval(sampler);
await sleep(3000);
const after = await rssMb(child.pid);

child.kill();
await sleep(300);
fs.rmSync(dataDir, { recursive: true, force: true });
const fmt = (n) => `${n.toFixed(0)} MB`;
console.log(JSON.stringify({
  startup: `${startupMs} ms`, idleRSS: fmt(idle), peakRSSUnderLoad: fmt(peak), rssAfterLoadSettled: fmt(after),
  runs: TOTAL, concurrency: CONC, throughput: `${(TOTAL / secs).toFixed(0)} runs/s`, avgLatency: `${((secs * 1000 * CONC) / TOTAL).toFixed(0)} ms`,
}, null, 2));
