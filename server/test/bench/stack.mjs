// Before/after benchmark of a RUNNING Docker stack (the one from `docker compose up`).
//   node server/test/bench/stack.mjs [--url http://localhost:3000] [--pg liteforeflow-docker-postgres-1] [--label before]
// It makes its own account (bench-stack@example.com) and cleans it up at the end, so your data is not touched.
// Measures: how many webhook calls are accepted in 5 s, how long until every run has finished, how fast the workflow
// list loads with 300 workflows, and what the hourly cleanup queries cost on 200,000 stored runs.
import http from 'node:http';
import { execFileSync, execFile } from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const base = new URL(arg('url', 'http://localhost:3000'));
const PG = arg('pg', 'liteforeflow-docker-postgres-1');
const LABEL = arg('label', 'run');
const CONC = Number(arg('conc', 16));
const QUICK = process.argv.includes('--quick'); // intake only: skips the workflow-list and cleanup measurements
const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const call = (method, path, body, token, raw) => new Promise((resolve) => {
  const data = body === undefined ? undefined : Buffer.from(raw ? body : JSON.stringify(body));
  const req = http.request({ agent, host: base.hostname, port: base.port, method, path, headers: {
    ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() }));
  });
  req.on('error', () => resolve({ status: 0, text: '' }));
  if (data) req.write(data); req.end();
});
const json = (r) => { try { return JSON.parse(r.text); } catch { return {}; } };

const pgUser = execFileSync('docker', ['exec', PG, 'printenv', 'POSTGRES_USER'], { encoding: 'utf8' }).trim();
const pgDb = execFileSync('docker', ['exec', PG, 'printenv', 'POSTGRES_DB'], { encoding: 'utf8' }).trim();
const psql = (sql) => execFileSync('docker', ['exec', '-i', PG, 'psql', '-U', pgUser, '-d', pgDb, '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });

const email = 'bench-stack@example.com';
const password = 'bench-stack-password';
let s = await call('POST', '/api/auth/signup', { email, password });
if (s.status === 409) s = await call('POST', '/api/auth/login', { email, password });
const token = json(s).token;
const ws = json(s).workspaces[0].id;
psql(`UPDATE workspaces SET plan = 'team' WHERE id = '${ws}'`);

const result = { label: LABEL };
try {
  // ---- a webhook workflow (Webhook -> Edit Fields) ----
  const wf = json(await call('POST', '/api/workflows', { name: 'bench', definition: { nodes: [
    { id: 't', type: 'trigger.webhook', name: 'Webhook', parameters: { path: 'bench-stack', method: 'POST', respond: 'immediately' }, position: { x: 0, y: 0 } },
    { id: 's', type: 'data.set', name: 'Edit Fields', parameters: { fields: [{ name: 'ok', value: 'yes' }], keepOthers: true }, position: { x: 200, y: 0 } }],
    connections: [{ from: 't', to: 's', fromOutput: 0, toInput: 0 }] } }, token));
  if ((await call('POST', `/api/workflows/${wf.id}/activate`, undefined, token)).status !== 200) throw new Error('could not activate the benchmark workflow');

  // ---- intake: 5 seconds of small webhook calls ----
  const payload = JSON.stringify({ event: 'order', id: 1, amount: 42.5, tags: ['a', 'b'] });
  const count = () => Number(psql(`SELECT count(*) FROM executions WHERE workflow_id = '${wf.id}' AND status = 'success'`).trim());
  let ok = 0; let bad = 0; let stop = false; const lat = [];
  setTimeout(() => { stop = true; }, 5000);
  const samples = {};
  const sampler = setInterval(() => execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}'], (err, out) => {
    if (err) return;
    for (const line of out.trim().split('\n')) {
      const [name, cpu, mem] = line.split(' ');
      const short = name.replace(/^liteforeflow-docker-/, '').replace(/-\d+$/, '');
      if (short.startsWith('liteforeflow-test')) continue;
      (samples[short] ??= []).push({ cpu: parseFloat(cpu), mem: parseFloat(mem) * (mem.includes('GiB') ? 1024 : 1) });
    }
  }), 1000);
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (!stop) {
      const t = performance.now();
      const r = await call('POST', '/webhook/bench-stack', payload, undefined, true);
      lat.push(performance.now() - t);
      if (r.status === 200) ok += 1; else bad += 1;
    }
  }));
  const sendSec = (performance.now() - t0) / 1000;
  clearInterval(sampler);
  result.cpuPercent = {}; result.memMB = {};
  for (const [k, v] of Object.entries(samples)) { result.cpuPercent[k] = Math.round(v.reduce((a, x) => a + x.cpu, 0) / v.length); result.memMB[k] = Math.round(Math.max(...v.map((x) => x.mem))); }
  lat.sort((a, b) => a - b);
  result.accepted = ok; result.rejected = bad;
  result.acceptedPerSec = Math.round(ok / sendSec);
  result.p50ms = +lat[lat.length >> 1].toFixed(1);
  result.p99ms = +lat[Math.floor(lat.length * 0.99)].toFixed(1);
  // ---- drain: until every accepted run is recorded as finished ----
  let done = count();
  for (let i = 0; i < 240 && done < ok; i += 1) { await sleep(500); done = count(); }
  result.finishedRuns = done;
  result.secondsUntilAllFinished = +((performance.now() - t0) / 1000).toFixed(1);

  if (QUICK) throw Object.assign(new Error('quick'), { quick: true });
  // ---- workflow list with 300 workflows ----
  for (let i = 0; i < 300; i += 1) {
    await call('POST', '/api/workflows', { name: `filler ${i}`, definition: { nodes: Array.from({ length: 12 }, (_, k) => ({ id: `n${k}`, type: k ? 'data.set' : 'trigger.manual', name: `Step ${k}`, parameters: k ? { fields: [{ name: 'a', value: 'b' }] } : {}, position: { x: k * 200, y: 0 } })), connections: [] } }, token);
  }
  const times = [];
  for (let i = 0; i < 20; i += 1) { const t = performance.now(); const r = await call('GET', '/api/workflows', undefined, token); if (r.status !== 200) throw new Error('list failed'); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  result.listWorkflows300 = { medianMs: +times[10].toFixed(1), worstMs: +times[19].toFixed(1) };

  // ---- hourly cleanup queries on 200,000 stored runs ----
  psql(`INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at, finished_at)
        SELECT gen_random_uuid()::text, '${ws}', '${wf.id}', 'bench', 'success', 'webhook',
          to_char((now() - (g || ' seconds')::interval - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NULL
        FROM generate_series(1, 200000) g`);
  psql('ANALYZE executions');
  const explain = (sql) => {
    const out = psql(`BEGIN;\nEXPLAIN (ANALYZE, TIMING OFF) ${sql};\nROLLBACK;`);
    return Number(/Execution Time: ([\d.]+) ms/.exec(out)?.[1] ?? NaN);
  };
  const cutoff = new Date(Date.now() - 2 * 3_600_000).toISOString();
  result.lostRunSweepMs = explain(`UPDATE executions SET status = 'error' WHERE status IN ('queued','running') AND started_at < '${cutoff}'`);
} catch (e) {
  if (!e.quick) throw e;
} finally {
  // remove everything the benchmark made (scoped to its own workspace)
  psql(`DELETE FROM executions WHERE workspace_id = '${ws}';
        DELETE FROM usage WHERE workspace_id = '${ws}';
        DELETE FROM workspaces WHERE id = '${ws}';
        DELETE FROM users WHERE email = '${email}'`);
  // leave the database tidy, so the next measurement is not slowed by this one's leftovers
  for (const t of ['executions', 'workflows', 'usage']) psql(`VACUUM (ANALYZE) ${t}`);
}
console.log(JSON.stringify(result, null, 2));
