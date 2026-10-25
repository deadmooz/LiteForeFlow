// QA against the production stack. Needs Postgres (TEST_DATABASE_URL) and Redis (TEST_REDIS_URL) running.
// Redis outage scenarios need REDIS_STOP_CMD / REDIS_START_CMD (shell commands) to be set.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { area, t, boot, client, blocked, sleep, N, E, chain, manual, set, mkWf, runWf, outJson, webhook, uniq, results, summary, here } from './lib.mjs';

const exec = promisify(execCb);
const PG = process.env.TEST_DATABASE_URL; const REDIS = process.env.TEST_REDIS_URL;
if (!PG || !REDIS) { console.error('set TEST_DATABASE_URL and TEST_REDIS_URL'); process.exit(2); }
const run = crypto.randomBytes(3).toString('hex');
const schema = `qa_${run}`;
const env = (extra = {}) => ({ DATABASE_URL: PG, PG_SCHEMA: schema, REDIS_URL: REDIS, QUEUE_NAME: `qa-${run}`, ...extra });

area('Production stack: Postgres + Redis/BullMQ');
const a = await boot('all', env());
const U = await client(a.base).user();
const { default: pg } = await import('pg');

await t('INF-01', 'Postgres node: parameterised SELECT, quote-safe values, multi-row output, INSERT rowCount', async () => {
  const u = new URL(PG);
  const cred = (await U.post('/api/credentials', { name: 'pg', type: 'postgres', data: { host: u.hostname, port: u.port, database: u.pathname.slice(1), user: u.username, password: u.password } })).data.id;
  const q = (query, params = '[]') => runWf(U, [manual(), N('q', 'app.postgres', 'q', { credential: cred, query, params })], chain('t', 'q'));
  const r1 = await q("SELECT $1::int AS n, $2::text AS s, generate_series(1,3) AS g", `[7, "O'Brien; DROP TABLE x; --"]`);
  assert.equal(r1.status, 'success', JSON.stringify(r1.error)); assert.equal(outJson(r1, 'q').length, 3); assert.equal(outJson(r1, 'q')[0].s, "O'Brien; DROP TABLE x; --");
  const r2 = await q('CREATE TEMP TABLE tmp_qa(a int)'); assert.equal(r2.status, 'success');
  const r3 = await q('SELEKT 1'); assert.equal(r3.status, 'error'); assert.match(r3.error.message, /syntax/i);
  const r4 = await q('SELECT $1::int', '["not a number"]'); assert.equal(r4.status, 'error');
});
await t('INF-02', 'Executions API with float / negative / text limits on Postgres does not 500', async () => {
  await runWf(U, [manual()], []);
  const bad = [];
  for (const qs of ['limit=2.7', 'limit=-1', 'limit=abc', 'offset=-5', 'offset=1.5', 'limit=0']) { const r = await U.get(`/api/executions?${qs}`); if (r.status >= 500) bad.push(`${qs}→${r.status}`); }
  assert.equal(bad.length, 0, `server errors: ${bad.join(', ')}`);
});
await t('INF-03', 'Execution data is stored compressed in Postgres and readable via the API', async () => {
  const r = await runWf(U, [manual(), N('c', 'data.code', 'c', { mode: 'runOnce', code: 'return Array.from({length:100},(_,i)=>({i,text:"row "+i}));' })], chain('t', 'c'));
  const c = new pg.Client({ connectionString: PG }); await c.connect();
  const row = (await c.query(`SELECT data FROM ${schema}.executions WHERE id = $1`, [r.executionId])).rows[0]; await c.end();
  assert.ok(row.data.startsWith('gz:'), 'not compressed'); assert.equal(outJson(r, 'c').length, 100);
});
await t('INF-04', 'Two API processes + shared worker: workflow activated on one is served by the other; cron fires once per tick (not per instance)', async () => {
  const b = await boot('all2', env({ LITEFOREFLOW_ROLE: 'api' })); // second API, no worker
  try {
    const ub = client(b.base); ub.token = U.token;
    const p = `ha-${uniq()}`;
    const wf = await mkWf(U, 'ha', [webhook('t', p, { respond: 'lastNode' }), set('s', { via: '{{ "ok" }}' }, {}, false)], chain('t', 's'));
    assert.equal((await U.post(`/api/workflows/${wf.id}/activate`, {})).status, 200);
    assert.deepEqual((await client(b.base).call('POST', `/webhook/${p}`, {}, { token: null })).data, { via: 'ok' });
    const tick = await mkWf(U, 'tick', [N('t', 'trigger.cron', 'c', { cron: '*/3 * * * * *', timezone: 'UTC' }), set('s', { a: '{{ 1 }}' })], chain('t', 's'));
    await U.post('/api/billing/dev-plan', { plan: 'team' });
    await U.post(`/api/workflows/${tick.id}/activate`, {});
    await sleep(10500);
    await U.post(`/api/workflows/${tick.id}/deactivate`, {});
    await sleep(1500);
    const ex = (await U.get(`/api/executions?workflowId=${tick.id}&limit=100`)).data;
    const slots = ex.map((e) => Math.floor(new Date(e.startedAt).getTime() / 3000));
    assert.ok(ex.length >= 2 && ex.length <= 5, `${ex.length} ticks in 10.5 s`); assert.equal(new Set(slots).size, slots.length, 'duplicate tick (fired by both API instances?)');
  } finally { await b.stop(); }
});
await t('INF-05', '3 servers booting at once against a fresh schema all migrate safely (advisory lock)', async () => {
  const env2 = env({ PG_SCHEMA: `${schema}_mig`, QUEUE_NAME: `qa-${run}-mig` });
  const servers = await Promise.all([boot('m1', env2), boot('m2', env2), boot('m3', env2)]);
  try { for (const s of servers) assert.equal((await fetch(`${s.base}/api/health`)).status, 200); } finally { for (const s of servers) await s.stop(); }
});
await t('INF-06', 'Queue back-pressure: with MAX_QUEUE_DEPTH=1 and no worker, extra webhook calls get 503 (not a hang) and do not leave ghost "queued" runs', async () => {
  const q = await boot('qfull', env({ LITEFOREFLOW_ROLE: 'api', MAX_QUEUE_DEPTH: '1', QUEUE_NAME: `qa-${run}-full` }));
  try {
    const u = await client(q.base).user();
    const p = `qf-${uniq()}`;
    const wf = await mkWf(u, 'qf', [webhook('t', p)], []);
    await u.post(`/api/workflows/${wf.id}/activate`, {});
    const call = () => client(q.base).call('POST', `/webhook/${p}`, {}, { token: null });
    const r1 = await call(); const r2 = await call(); const r3 = await call();
    assert.equal(r1.status, 200); assert.equal(r2.status, 503, `second call got ${r2.status}`); assert.equal(r3.status, 503);
    const list = (await u.get(`/api/executions?workflowId=${wf.id}`)).data;
    const ghosts = list.filter((e) => e.status === 'queued').length;
    assert.equal(ghosts, 1, `${ghosts} executions stuck in "queued" (only the accepted one should be)`);
    const usage = (await u.get('/api/usage')).data.runsThisMonth;
    assert.equal(usage, 1, `refused requests still consumed monthly quota: usage=${usage}`);
  } finally { await q.stop(); }
});
await t('INF-07', 'Redis outage: API keeps answering reads, webhook calls fail fast with a 5xx, and everything recovers when Redis returns', async () => {
  if (!process.env.REDIS_STOP_CMD) blocked('set REDIS_STOP_CMD / REDIS_START_CMD to exercise');
  const p = `rd-${uniq()}`;
  const wf = await mkWf(U, 'rd', [webhook('t', p, { respond: 'lastNode' }), set('s', { ok: '{{ 1 }}' })], chain('t', 's'));
  await U.post(`/api/workflows/${wf.id}/activate`, {});
  await exec(process.env.REDIS_STOP_CMD); await sleep(1500);
  try {
    const t0 = Date.now();
    const reads = await U.get('/api/workflows'); assert.equal(reads.status, 200, 'read API broke during the outage');
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 12000);
    let status = 'hung';
    try { status = (await fetch(`${a.base}/webhook/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: ctrl.signal })).status; } catch { status = 'hung (no answer within 12 s)'; }
    clearTimeout(timer);
    assert.ok(typeof status === 'number' && status >= 500, `webhook during Redis outage: ${status} after ${Date.now() - t0} ms`);
  } finally {
    await exec(process.env.REDIS_START_CMD); await sleep(4000);
  }
  const after = await client(a.base).call('POST', `/webhook/${p}`, {}, { token: null });
  assert.equal(after.status, 200, `no recovery after Redis returned (${after.status})`);
});
await t('INF-08', 'Postgres outage: API answers 5xx quickly (no hang) and the process stays alive', async () => {
  if (!process.env.PG_KILL_CMD) blocked('set PG_KILL_CMD to exercise');
  await exec(process.env.PG_KILL_CMD); await sleep(1500);
  const t0 = Date.now();
  let status; try { status = (await fetch(`${a.base}/api/workflows`, { headers: { authorization: `Bearer ${U.token}` }, signal: AbortSignal.timeout(15000) })).status; } catch { status = 'hung'; }
  assert.ok(typeof status === 'number' && status >= 500, `got ${status} after ${Date.now() - t0} ms`);
  assert.equal(a.proc.exitCode, null, 'server process crashed when the database went away');
});

await a.stop();
const sum = summary();
console.log(`\nINFRA TOTAL ${sum.total}  PASS ${sum.pass}  FAIL ${sum.fail}  BLOCKED ${sum.blocked}`);
fs.writeFileSync(path.join(here, 'qa-infra-results.json'), JSON.stringify({ summary: sum, results }, null, 2));
try { const c = new pg.Client({ connectionString: PG }); await c.connect(); await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${schema}_mig CASCADE; DROP SCHEMA IF EXISTS ${schema}_full CASCADE`); await c.end(); } catch { /* db already stopped */ }
process.exit(0);
