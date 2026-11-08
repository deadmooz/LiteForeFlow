// Payload stress test against a running server or Docker stack.
//   node server/test/ui/payload-stress.mjs <baseUrl> [--records 1000000] [--batch 5000] [--conc 8]
//        [--containers ffui-api-1,ffui-worker-1] [--pg-container ffui-postgres-1] [--round 1]
// 1) Edge cases: oversized / truncated / nested / hostile bodies must be refused with a 4xx and the server must stay up.
// 2) The 1M-record payload sent in batches: every answer must report the right count and sum (no loss, no mix-up).
// 3) Samples container CPU and memory (docker stats) and prints one compact result line.
import http from 'node:http';
import { execFile, execFileSync } from 'node:child_process';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:3188');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RECORDS = Number(arg('records', 1_000_000));
const BATCH = Number(arg('batch', 5000));
const CONC = Number(arg('conc', 8));
const containers = (arg('containers', '') || '').split(',').filter(Boolean);
const pgContainer = arg('pg-container');
const agent = new http.Agent({ keepAlive: true, maxSockets: CONC + 2 });

function send(method, path, body, { token, type = 'application/json', raw = false } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : (raw || typeof body === 'string' || Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(JSON.stringify(body)));
    const t0 = performance.now();
    let ttfb = 0;
    const req = http.request({ agent, host: base.hostname, port: base.port, method, path, headers: {
      ...(data ? { 'content-type': type, 'content-length': data.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      ttfb = performance.now() - t0;
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), ttfb, ms: performance.now() - t0 }));
    });
    req.on('error', (e) => resolve({ status: 0, text: String(e.code ?? e.message), ttfb, ms: performance.now() - t0 }));
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}
const json = (r) => { try { return JSON.parse(r.text); } catch { return {}; } };

// ---- setup: account, plan, workflow ----
const email = `stress${Date.now()}@example.com`;
const signup = json(await send('POST', '/api/auth/signup', { email, password: 'stress-test-password' }));
const token = signup.token;
if (pgContainer) execFileSync('docker', ['exec', pgContainer, 'psql', '-U', 'liteforeflow', '-c', "UPDATE workspaces SET plan = 'team'"], { stdio: 'ignore' });
const wf = json(await send('POST', '/api/workflows', { name: 'payload-stress', definition: {
  nodes: [
    { id: 't', type: 'trigger.webhook', name: 'Hook', parameters: { path: 'stress', method: 'POST', respond: 'lastNode' }, position: { x: 0, y: 0 } },
    { id: 'c', type: 'data.code', name: 'Code', parameters: { mode: 'runOnce', code: 'const r = items[0].body.records || []; return [{ count: r.length, sum: r.reduce((a, x) => a + x.v, 0) }];' }, position: { x: 0, y: 0 } },
  ],
  connections: [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }],
} }, { token }));
await send('POST', `/api/workflows/${wf.id}/activate`, undefined, { token });

const record = (i) => ({ id: i, v: i % 100, name: `item-${i}`, tags: ['a', 'b'], ok: true });
const batchBody = (from, n) => JSON.stringify({ records: Array.from({ length: n }, (_, k) => record(from + k)) });
const alive = async () => (await send('GET', '/api/health')).status === 200;

// ---- 1) edge cases ----
const results = [];
const edge = async (name, run, accept) => {
  const r = await run();
  const up = await alive();
  const pass = accept(r) && up;
  results.push({ name, status: r.status, ms: Math.round(r.ms), serverUp: up, pass });
};
const bigAll = JSON.stringify({ records: Array.from({ length: RECORDS }, (_, i) => record(i)) });
await edge(`single ${RECORDS.toLocaleString()}-record body (${(bigAll.length / 1048576).toFixed(0)} MB) is refused`, () => send('POST', '/webhook/stress', bigAll), (r) => r.status === 413);
await edge('6 MB body is refused', () => send('POST', '/webhook/stress', `{"records":[],"pad":"${'x'.repeat(6 * 1048576)}"}`), (r) => r.status === 413);
await edge('truncated JSON gets a 400', () => send('POST', '/webhook/stress', '{"records":[{"id":1,"v":', { raw: true }), (r) => r.status === 400);
await edge('garbage JSON gets a 400', () => send('POST', '/webhook/stress', '{bad json', { raw: true }), (r) => r.status === 400);
await edge('200,000-level nesting does not crash', () => send('POST', '/webhook/stress', '['.repeat(200000), { raw: true }), (r) => r.status >= 400 && r.status < 500);
await edge('NUL and control characters are accepted or refused cleanly', () => send('POST', '/webhook/stress', JSON.stringify({ records: [{ id: 1, v: 1, name: 'a\u0000b\u001f' }] })), (r) => r.status === 200 || (r.status >= 400 && r.status < 500));
await edge('invalid UTF-8 bytes do not crash', () => send('POST', '/webhook/stress', Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]), { raw: true }), (r) => r.status < 500);
await edge('empty body is answered', () => send('POST', '/webhook/stress', undefined), (r) => r.status === 200);
await edge('text/plain body is answered', () => send('POST', '/webhook/stress', '{"records":[{"id":1,"v":2}]}', { type: 'text/plain' }), (r) => r.status < 500);
await edge('__proto__ key does not pollute', () => send('POST', '/webhook/stress', '{"__proto__":{"x":1},"records":[{"id":1,"v":3}]}', { raw: true }), (r) => r.status === 200 && json(r).sum === 3);
await edge('wrong HTTP method on the webhook is 404, not 500', () => send('PUT', '/webhook/stress', '{}'), (r) => r.status === 404);

// ---- 2) batches ----
const stats = { peak: Object.fromEntries(containers.map((c) => [c, { cpu: 0, memMB: 0 }])) };
let sampling = true;
const sample = async () => {
  while (sampling && containers.length) {
    await new Promise((resolve) => execFile('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}', ...containers], (err, out) => {
      for (const line of String(out ?? '').trim().split('\n')) {
        const [name, cpu, mem] = line.split('|');
        if (!stats.peak[name]) continue;
        const m = /([\d.]+)\s*(MiB|GiB|KiB)/.exec(mem ?? '');
        const mb = m ? Number(m[1]) * (m[2] === 'GiB' ? 1024 : m[2] === 'KiB' ? 1 / 1024 : 1) : 0;
        stats.peak[name].cpu = Math.max(stats.peak[name].cpu, parseFloat(cpu) || 0);
        stats.peak[name].memMB = Math.max(stats.peak[name].memMB, mb);
      }
      resolve();
    }));
  }
};
const sampler = sample();

// Found in round 1: finished jobs kept their whole request body in Redis. Failed runs take another path, so test it too:
// a workflow that always throws, hit with big bodies, must answer 500 each time and must not leave megabytes behind.
const boom = json(await send('POST', '/api/workflows', { name: 'always-fails', definition: {
  nodes: [
    { id: 't', type: 'trigger.webhook', name: 'Hook', parameters: { path: 'boom', method: 'POST', respond: 'lastNode' }, position: { x: 0, y: 0 } },
    { id: 'c', type: 'data.code', name: 'Code', parameters: { mode: 'runOnce', code: 'throw new Error("boom");' }, position: { x: 0, y: 0 } },
  ],
  connections: [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }],
} }, { token }));
await send('POST', `/api/workflows/${boom.id}/activate`, undefined, { token });
const bigBody = batchBody(0, 5000);
const booms = await Promise.all(Array.from({ length: 40 }, () => send('POST', '/webhook/boom', bigBody)));
results.push({ name: '40 failing runs with 300 KB bodies all answer 500 and the server stays up', status: booms.every((r) => r.status === 500) ? 500 : booms.find((r) => r.status !== 500)?.status, ms: 0, serverUp: await alive(), pass: booms.every((r) => r.status === 500) && await alive() });
// A burst of tiny "answer immediately" requests: nothing may be lost or rejected below the queue limit.
const tiny = await Promise.all(Array.from({ length: 300 }, (_, i) => send('POST', '/webhook/stress', JSON.stringify({ records: [{ id: i, v: 1 }] }))));
results.push({ name: '300 simultaneous tiny requests all succeed with the right answer', status: 200, ms: 0, serverUp: await alive(), pass: tiny.every((r) => r.status === 200 && json(r).count === 1 && json(r).sum === 1) });

const total = Math.ceil(RECORDS / BATCH);
const lat = []; const ttfb = [];
let next = 0; let wrong = 0; let failed = 0; let sent = 0;
const t0 = performance.now();
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < total) {
    const b = next; next += 1;
    const from = b * BATCH; const n = Math.min(BATCH, RECORDS - from);
    let want = 0; for (let i = from; i < from + n; i += 1) want += i % 100;
    const r = await send('POST', '/webhook/stress', batchBody(from, n));
    lat.push(r.ms); ttfb.push(r.ttfb);
    if (r.status !== 200) { failed += 1; continue; }
    const out = json(r);
    sent += n;
    if (out.count !== n || out.sum !== want) wrong += 1;
  }
}));
const secs = (performance.now() - t0) / 1000;
sampling = false; await sampler;
// Redis check: no stored key may stay large after the jobs finished (the payload is dropped on completion).
const redisContainer = arg('redis-container');
let redis = null;
if (redisContainer) {
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const mem = execFileSync('docker', ['exec', redisContainer, 'redis-cli', 'info', 'memory'], { encoding: 'utf8' });
    const used = Number(/used_memory:(\d+)/.exec(mem)?.[1] ?? 0);
    const keys = execFileSync('docker', ['exec', redisContainer, 'redis-cli', '--memkeys'], { encoding: 'utf8' });
    const biggest = Number(/Biggest\s+hash found .* has (\d+) bytes/.exec(keys)?.[1] ?? 0); // job records are hashes; the capped event stream is BullMQ's own
    const stream = Number(execFileSync('docker', ['exec', redisContainer, 'redis-cli', 'memory', 'usage', 'bull:liteforeflow-executions:events', 'samples', '0'], { encoding: 'utf8' }).trim() || 0);
    redis = { usedMB: +(used / 1048576).toFixed(1), biggestJobKB: +(biggest / 1024).toFixed(1), eventStreamMB: +(stream / 1048576).toFixed(1) };
    results.push({ name: 'Finished jobs and the event log in Redis stay small', status: 200, ms: 0, serverUp: true, pass: redis.biggestJobKB < 50 && redis.eventStreamMB < 8 });
  } catch (e) { redis = { error: String(e.message).slice(0, 80) }; }
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]); };

const out = {
  round: Number(arg('round', 1)), edgeCases: `${results.filter((r) => r.pass).length}/${results.length} passed`,
  records: RECORDS, batches: total, batchSize: BATCH, conc: CONC, failedBatches: failed, wrongAnswers: wrong, recordsAccepted: sent,
  totalSeconds: +secs.toFixed(1), recordsPerSec: Math.round(RECORDS / secs), reqPerSec: +(total / secs).toFixed(1),
  latencyMs: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: Math.round(Math.max(...lat)) }, ttfbMs: { p50: pct(ttfb, 0.5), p95: pct(ttfb, 0.95) },
  peak: stats.peak, redis,
  failedEdgeCases: results.filter((r) => !r.pass),
};
console.log(JSON.stringify(out));
agent.destroy();
