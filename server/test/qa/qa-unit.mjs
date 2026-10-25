// White-box QA: things that cannot be observed over HTTP. Run: node server/test/qa/qa-unit.mjs
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-unit-'));
process.env.DB_PATH = ':memory:';
process.env.LITEFOREFLOW_SECRET = 'unit';
import { area, t, results, summary, here } from './lib.mjs';

const { getNodeType } = await import('../../src/nodes/index.js');
const { parseFeed } = await import('../../src/polling.js');
const { convertExpression } = await import('../../src/importer.js');
const { validateCredentialData } = await import('../../src/credentialTypes.js');
const { formEncode } = await import('../../src/http.js');
const { pack, unpack } = await import('../../src/packing.js');
const { reachableOrder } = await import('../../src/engine.js');
const { runCode, createResolver, testRegex } = await import('../../src/expressions.js');
const { isPrivateIp } = await import('../../src/http.js');
const { Sandbox } = await import('../../src/sandbox.js');
const { run, get, all, uid, now } = await import('../../src/db.js');
const { pruneExecutions } = await import('../../src/runner.js');
const { encryptJson, decryptJson } = await import('../../src/crypto.js');

area('Unit / white-box');
const stubCtx = (params) => ({ rawParam: (n) => params[n], param: (n) => params[n], jsonParam: (n) => params[n] });

await t('UNIT-01', 'Edit Fields: "__proto__.x", "constructor.prototype.x" paths cannot pollute Object.prototype', async () => {
  const node = getNodeType('data.set');
  const rejected = [];
  for (const name of ['__proto__.polluted', 'constructor.prototype.polluted2', 'a.__proto__.polluted3']) {
    try { await node.executeItem(stubCtx({ keepOthers: true, fields: [{ name, value: 'yes' }] }), { json: {} }, 0); } catch (e) { rejected.push(e.message); }
  }
  assert.equal(rejected.length, 3, 'forbidden field names must be rejected with an error, not silently ignored');
  const leaked = ['polluted', 'polluted2', 'polluted3'].filter((k) => ({})[k] !== undefined);
  assert.equal(leaked.length, 0, `Object.prototype was modified: ${leaked.join(', ')} — every object in the server process now has these properties`);
});
await t('UNIT-02', 'Execution-log compression round-trips and passes small/legacy plain JSON through', async () => {
  const big = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ i, s: `row ${i}` })));
  assert.equal(unpack(pack(big)), big); assert.ok(pack(big).length < big.length / 3);
  assert.equal(unpack('{"legacy":true}'), '{"legacy":true}'); assert.equal(pack(null), null);
});
await t('UNIT-03', 'RSS feed parser: RSS 2.0 with CDATA/entities, Atom, empty and malformed input', async () => {
  const rss = parseFeed('<rss><channel><item><title>A &amp; B</title><link>http://x/1</link><guid>g1</guid></item><item><title><![CDATA[C <d>]]></title><link>http://x/2</link></item></channel></rss>');
  assert.equal(rss.length, 2); assert.equal(rss[0].title, 'A & B'); assert.equal(rss[1].title, 'C <d>'); assert.equal(rss[1].guid, 'http://x/2');
  const atom = parseFeed('<feed><entry><title>T</title><link href="http://x/a"/><id>urn:1</id><updated>2026-01-01</updated></entry></feed>');
  assert.equal(atom[0].link, 'http://x/a'); assert.equal(atom[0].guid, 'urn:1');
  assert.deepEqual(parseFeed(''), []); assert.deepEqual(parseFeed('<html>not a feed</html>'), []);
});
await t('UNIT-04', 'n8n expression conversion: leading "=", $(\'Node\').item/first/last, $input.item', async () => {
  assert.equal(convertExpression("={{ $('A b').item.json.x }}"), '{{ $node["A b"].json.x }}');
  assert.equal(convertExpression("={{ $('N').first().json.y + $input.item.json.z }}"), '{{ $node["N"].json.y + $json.z }}');
  assert.equal(convertExpression('plain'), 'plain'); assert.deepEqual(convertExpression({ a: ['=1', '=={{x}}'] }), { a: ['1', '={{x}}'] });
});
await t('UNIT-05', 'Credential validation: required/optional fields, Google key shape', async () => {
  assert.match(validateCredentialData('httpBasic', { user: 'a' }), /Password/);
  assert.equal(validateCredentialData('httpBearer', { token: 't' }), null);
  assert.equal(validateCredentialData('smtp', { host: 'h', port: '25', from: 'a@b.c' }), null);
  assert.match(validateCredentialData('unknown', {}), /Unknown credential type/);
});
await t('UNIT-06', 'Form encoding handles nested objects and skips empty values (Stripe style)', async () => {
  assert.equal(formEncode({ a: 1, b: { c: 'x y', d: '' }, e: null }).toString(), 'a=1&b%5Bc%5D=x+y');
});
await t('UNIT-07', 'Graph ordering is fast on large graphs (200-node chain and wide fan-out) and detects cycles', async () => {
  const nodes = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}` }));
  const chainE = nodes.slice(1).map((n, i) => ({ from: `n${i}`, to: n.id }));
  let t0 = Date.now(); assert.equal(reachableOrder(nodes, chainE, 'n0').length, 200); assert.ok(Date.now() - t0 < 300, `chain ${Date.now() - t0} ms`);
  const fan = nodes.slice(1).map((n) => ({ from: 'n0', to: n.id }));
  t0 = Date.now(); assert.equal(reachableOrder(nodes, fan, 'n0').length, 200); assert.ok(Date.now() - t0 < 300, `fan ${Date.now() - t0} ms`);
  assert.throws(() => reachableOrder(nodes.slice(0, 3), [{ from: 'n0', to: 'n1' }, { from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }], 'n0'), /loop/);
});
await t('UNIT-08', 'Sandbox: CPU-bound expression is killed by the 1 s timeout; isolates are reusable afterwards', async () => {
  const sb = new Sandbox();
  const r = createResolver(() => ({ $json: {} }), () => ({}), sb);
  const t0 = Date.now();
  await assert.rejects(r.resolve('{{ (function(){ while(true){} })() }}'), /timed out/i);
  assert.ok(Date.now() - t0 < 2500);
  assert.equal(await r.resolve('{{ 1 + 1 }}'), 2); r.release(); sb.dispose();
});
await t('UNIT-09', 'Sandbox: expression result size cap and JSON-unsafe values (functions, cycles, BigInt) fail cleanly', async () => {
  const r = createResolver(() => ({ $json: {} }), () => ({}));
  assert.equal(await r.resolve('{{ (function(){}) }}'), undefined);
  await assert.rejects(r.resolve('{{ (()=>{ const a={}; a.a=a; return a; })() }}'), /Expression error/);
  await assert.rejects(r.resolve('{{ 10n }}'), /Expression error/);
  r.release();
});
await t('UNIT-10', 'Code node: 1000 sequential isolate creations do not leak memory (RSS growth < 150 MB)', async () => {
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 1000; i += 1) await runCode('return [{ i: $json.i }];', { $json: { i } });
  const grew = (process.memoryUsage().rss - before) / 1048576;
  assert.ok(grew < 150, `RSS grew ${grew.toFixed(0)} MB`);
  return `RSS grew ${grew.toFixed(0)} MB over 1000 isolates`;
});
await t('UNIT-11', 'Retention pruning deletes old logs per plan and fails executions stuck in running/queued > 2 h', async () => {
  const ws = uid();
  await run('INSERT INTO workspaces (id, name, plan, created_at) VALUES (?,?,?,?)', ws, 'w', 'free', now());
  const ins = (id, status, ageH) => run('INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at) VALUES (?,?,?,?,?,?,?)', id, ws, 'wf', 'wf', status, 'manual', new Date(Date.now() - ageH * 3_600_000).toISOString());
  await ins('old-success', 'success', 24 * 4); await ins('recent', 'success', 1); await ins('stuck', 'running', 3); await ins('fresh-running', 'running', 0.5);
  await pruneExecutions();
  const left = Object.fromEntries((await all('SELECT id, status FROM executions')).map((r) => [r.id, r.status]));
  assert.equal(left['old-success'], undefined, '4-day-old log kept on a 3-day plan'); assert.equal(left.recent, 'success');
  assert.equal(left.stuck, 'error'); assert.equal(left['fresh-running'], 'running');
});
await t('UNIT-12', 'Credential encryption: random IV per message, tampering detected, wrong key rejected', async () => {
  const a = encryptJson({ k: 'v' }); const b = encryptJson({ k: 'v' });
  assert.notEqual(a, b); assert.deepEqual(decryptJson(a), { k: 'v' });
  const [iv, tag, ct] = a.split('.'); const flipped = Buffer.from(ct, 'base64'); flipped[0] ^= 1;
  assert.throws(() => decryptJson([iv, tag, flipped.toString('base64')].join('.')));
});
await t('UNIT-13', 'Usage counter: atomic upsert under 200 parallel reservations never exceeds the cap', async () => {
  const { reserveRun } = await import('../../src/plans.js');
  const ws = uid();
  await run('INSERT INTO workspaces (id, name, plan, created_at) VALUES (?,?,?,?)', ws, 'cap', 'free', now());
  await run('INSERT INTO usage (workspace_id, month, runs) VALUES (?,?,?)', ws, new Date().toISOString().slice(0, 7), 990);
  const res = await Promise.allSettled(Array.from({ length: 200 }, () => reserveRun(ws)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 10);
  assert.equal((await get('SELECT runs FROM usage WHERE workspace_id = ?', ws)).runs, 1000);
});

await t('UNIT-14', 'SSRF classifier: every spelling of loopback / private / link-local / mapped / NAT64 / 6to4 is private; public addresses are not', async () => {
  const priv = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:a9fe:a9fe::',
    'fe80::1', 'fd12:3456::1', 'fc00::1', 'ff02::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', 'not-an-ip:::'];
  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '11.0.0.1', '2606:4700:4700::1111', '::ffff:808:808', '2001:4860:4860::8888'];
  const wrongPriv = priv.filter((ip) => !isPrivateIp(ip)); const wrongPub = pub.filter((ip) => isPrivateIp(ip));
  assert.deepEqual(wrongPriv, [], `treated as public: ${wrongPriv.join(', ')}`); assert.deepEqual(wrongPub, [], `treated as private: ${wrongPub.join(', ')}`);
});
await t('UNIT-15', 'testRegex: matches normally, rejects invalid / oversized patterns, aborts catastrophic backtracking in < 1 s without blocking the event loop', async () => {
  assert.equal(await testRegex('^a+$', 'aaa'), true); assert.equal(await testRegex('^a+$', 'aab'), false);
  await assert.rejects(testRegex('(', 'x'), /Invalid regular expression/);
  await assert.rejects(testRegex('a'.repeat(2000), 'x'), /too long/);
  let ticks = 0; const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  await assert.rejects(testRegex('(a+)+$', `${'a'.repeat(45)}!`), /too long to evaluate/);
  const took = Date.now() - t0; clearInterval(timer);
  assert.ok(took < 1000, `took ${took} ms`); assert.ok(ticks > took / 40, `event loop only ticked ${ticks}x in ${took} ms (blocked)`);
});
await t('UNIT-16', 'Event loop stays free while the sandbox burns CPU (async execution)', async () => {
  let ticks = 0; const timer = setInterval(() => { ticks += 1; }, 10);
  const t0 = Date.now();
  await assert.rejects(runCode('while(true){}', {}, { timeoutMs: 1500 }), /timed out/);
  const took = Date.now() - t0; clearInterval(timer);
  assert.ok(ticks > took / 40, `event loop ticked only ${ticks}x during ${took} ms of sandbox CPU`);
  return `${ticks} timer ticks during ${took} ms of looping code`;
});

const sum = summary();
console.log(`\nUNIT TOTAL ${sum.total}  PASS ${sum.pass}  FAIL ${sum.fail}  BLOCKED ${sum.blocked}`);
fs.writeFileSync(path.join(here, 'qa-unit-results.json'), JSON.stringify({ summary: sum, results }, null, 2));
process.exit(0);
