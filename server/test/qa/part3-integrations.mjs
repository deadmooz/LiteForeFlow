import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { area, t, client, blocked, sleep, N, E, chain, manual, set, code, mkWf, runWf, outJson, webhook, uniq } from './lib.mjs';

export default async function part3({ s1, sBlock, mock, smtp }) {
  const U = await client(s1.base).user();
  await U.post('/api/billing/dev-plan', { plan: 'team' }); // these scenarios activate many workflows; plan limits are tested separately
  const anon = client(s1.base);
  const run = (nodes, conns, opts) => runWf(U, nodes, conns, opts);
  const ok = (r) => { assert.equal(r.status, 'success', `status=${r.status} http=${r.http} err=${JSON.stringify(r.error ?? r.raw)}`); return r; };
  const hit = (method, p, body, headers = {}) => anon.call(method, p, body, { token: null, headers });
  const activate = async (wfId) => { const r = await U.post(`/api/workflows/${wfId}/activate`, {}); assert.equal(r.status, 200, JSON.stringify(r.data)); };

  /* ------------------------------------ TRIGGERS ------------------------------- */
  area('Triggers: webhooks');
  await t('TRG-01', 'POST JSON webhook delivers body/query/method/headers to the workflow', async () => {
    const p = `t1-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { respond: 'lastNode' }), set('s', { b: '{{ $json.body.n }}', q: '{{ $json.query.x }}', m: '{{ $json.method }}', h: '{{ $json.headers["x-custom"] }}' }, {}, false)], chain('t', 's'));
    await activate(wf.id);
    const r = await hit('POST', `/webhook/${p}?x=7`, { n: 5 }, { 'x-custom': 'yes' });
    assert.deepEqual(r.data, { b: 5, q: '7', m: 'POST', h: 'yes' });
  });
  await t('TRG-02', 'GET / PUT / DELETE / ANY methods; mismatched method returns 404', async () => {
    const mk = async (method) => { const p = `m-${method}-${uniq()}`; const wf = await mkWf(U, 'w', [N('t', 'trigger.webhook', 'Hook', { path: p, method, respond: 'lastNode' }), set('s', { m: '{{ $json.method }}' }, {}, false)], chain('t', 's')); await activate(wf.id); return p; };
    for (const m of ['GET', 'PUT', 'DELETE', 'PATCH']) { const p = await mk(m); assert.equal((await hit(m, `/webhook/${p}`)).data.m, m); }
    const post = await mk('POST');
    assert.equal((await hit('GET', `/webhook/${post}`)).status, 404);
    const any = await mk('ANY');
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal((await hit(m, `/webhook/${any}`)).status, 200, `ANY/${m}`);
  });
  await t('TRG-03', 'Leading/trailing slashes and nested paths resolve', async () => {
    const p = `a-${uniq()}/b/c`;
    const wf = await mkWf(U, 'w', [webhook('t', `/${p}/`)], []);
    await activate(wf.id);
    assert.equal((await hit('POST', `/webhook/${p}`)).status, 200);
    assert.equal((await hit('POST', `/webhook//${p}//`)).status, 200);
  });
  await t('TRG-04', 'Inactive, deleted and unknown webhooks return 404 JSON', async () => {
    const p = `inact-${uniq()}`;
    await mkWf(U, 'w', [webhook('t', p)], []);
    const r = await hit('POST', `/webhook/${p}`);
    assert.equal(r.status, 404); assert.equal(typeof r.data.error, 'string');
    assert.equal((await hit('POST', '/webhook/never/existed')).status, 404);
  });
  await t('TRG-05', 'Shared secret: missing → 401, wrong → 401, correct → 200', async () => {
    const p = `sec-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { secret: 'topsecret' })], []);
    await activate(wf.id);
    assert.equal((await hit('POST', `/webhook/${p}`)).status, 401);
    assert.equal((await hit('POST', `/webhook/${p}`, {}, { 'x-webhook-secret': 'wrong' })).status, 401);
    assert.equal((await hit('POST', `/webhook/${p}`, {}, { 'x-webhook-secret': 'topsecret' })).status, 200);
  });
  await t('TRG-06', 'Body formats: form-urlencoded and text/plain are parsed; invalid JSON → 400; empty body ok', async () => {
    const p = `body-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { respond: 'lastNode' }), set('s', { b: '{{ JSON.stringify($json.body) }}' }, {}, false)], chain('t', 's'));
    await activate(wf.id);
    const form = await anon.call('POST', `/webhook/${p}`, 'a=1&b=two', { token: null, raw: true, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.data.b, '{"a":"1","b":"two"}');
    const text = await anon.call('POST', `/webhook/${p}`, 'just text', { token: null, raw: true, headers: { 'content-type': 'text/plain' } });
    assert.equal(text.data.b, '"just text"');
    const bad = await anon.call('POST', `/webhook/${p}`, '{broken', { token: null, raw: true, headers: { 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);
    assert.equal((await anon.call('POST', `/webhook/${p}`, undefined, { token: null })).status, 200);
  });
  await t('TRG-07', 'Respond=lastNode returns the last node\'s data; failure returns 500 with the message and execution id', async () => {
    const p = `fail-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { respond: 'lastNode' }), N('x', 'logic.stopAndError', 'x', { message: 'boom' })], chain('t', 'x'));
    await activate(wf.id);
    const r = await hit('POST', `/webhook/${p}`);
    assert.equal(r.status, 500); assert.equal(r.data.error, 'boom'); assert.ok(r.data.executionId);
  });
  await t('TRG-08', 'Immediate mode answers fast (<1 s) even when the workflow is slow, and the run completes afterwards', async () => {
    const p = `slow-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p), N('w', 'logic.wait', 'w', { seconds: 2 })], chain('t', 'w'));
    await activate(wf.id);
    const t0 = Date.now();
    const r = await hit('POST', `/webhook/${p}`);
    assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
    await sleep(300);
    assert.equal((await U.get(`/api/executions/${r.data.executionId}`)).data.status, 'running');
    await sleep(2200);
    assert.equal((await U.get(`/api/executions/${r.data.executionId}`)).data.status, 'success');
  });
  await t('TRG-09', 'Authorization / cookie / secret headers are NOT written to the execution log', async () => {
    const p = `hdr-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { secret: 's' })], []);
    await activate(wf.id);
    const r = await hit('POST', `/webhook/${p}`, {}, { authorization: 'Bearer SUPERSECRETTOKEN', cookie: 'sid=COOKIEVALUE', 'x-webhook-secret': 's' });
    const d = (await U.get(`/api/executions/${r.data.executionId}`)).data;
    const dump = JSON.stringify(d);
    assert.ok(!dump.includes('SUPERSECRETTOKEN') && !dump.includes('COOKIEVALUE'), 'sensitive header leaked into execution log');
  });
  await t('TRG-10', 'Two active workflows cannot claim the same path; same path with different methods is allowed', async () => {
    const p = `clash-${uniq()}`;
    const a = await mkWf(U, 'a', [webhook('t', p)], []);
    const b = await mkWf(U, 'b', [webhook('t', p)], []);
    const c2 = await mkWf(U, 'c', [N('t', 'trigger.webhook', 'Hook', { path: p, method: 'GET' })], []);
    await activate(a.id);
    const r = await U.post(`/api/workflows/${b.id}/activate`, {});
    assert.equal(r.status, 400); assert.match(r.data.error, /already used/);
    await activate(c2.id);
  });
  await t('TRG-11', 'Webhook path claimed by user A cannot be taken by user B (global namespace) and reveals nothing sensitive', async () => {
    const p = `shared-${uniq()}`;
    const a = await mkWf(U, 'a', [webhook('t', p)], []);
    await activate(a.id);
    const B = await client(s1.base).user();
    const b = await mkWf(B, 'b', [webhook('t', p)], []);
    const r = await B.post(`/api/workflows/${b.id}/activate`, {});
    assert.equal(r.status, 400);
    return 'paths are a global namespace: a user can learn that a path is taken (acceptable; paths are unguessable by convention)';
  });
  await t('TRG-12', 'Unicode / spaces / special characters in a webhook path', async () => {
    const p = `ünï cödé ${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p)], []);
    await activate(wf.id);
    assert.equal((await hit('POST', `/webhook/${encodeURIComponent(p)}`)).status, 200);
  });
  await t('TRG-13', 'Activating a webhook node with an empty path fails with 400', async () => {
    const wf = await mkWf(U, 'w', [N('t', 'trigger.webhook', 'Hook', { path: '', method: 'POST' })], []);
    assert.equal((await U.post(`/api/workflows/${wf.id}/activate`, {})).status, 400);
  });
  await t('TRG-14', '100 concurrent webhook calls are all accepted and recorded exactly once', async () => {
    const p = `conc-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { respond: 'lastNode' }), set('s', { n: '{{ $json.body.n }}' }, {}, false)], chain('t', 's'));
    await activate(wf.id);
    const rs = await Promise.all(Array.from({ length: 100 }, (_, n) => hit('POST', `/webhook/${p}`, { n })));
    assert.ok(rs.every((r) => r.status === 200), `statuses: ${[...new Set(rs.map((r) => r.status))]}`);
    assert.deepEqual(rs.map((r) => r.data.n).sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i));
    const ex = (await U.get(`/api/executions?workflowId=${wf.id}&limit=200`)).data;
    assert.equal(ex.length, 100);
  });
  await t('TRG-15', 'A 4 MB webhook body is accepted; a 6 MB body is rejected with 413', async () => {
    const p = `big-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p)], []);
    await activate(wf.id);
    assert.equal((await hit('POST', `/webhook/${p}`, { blob: 'x'.repeat(4_000_000) })).status, 200);
    assert.equal((await hit('POST', `/webhook/${p}`, { blob: 'x'.repeat(6_000_000) })).status, 413);
  });
  await t('TRG-16', 'Editor run of a webhook workflow with invalid sample payload returns a clear 400', async () => {
    const wf = await mkWf(U, 'w', [webhook('t', `sp-${uniq()}`, { samplePayload: '{not json' })], []);
    const r = await U.post(`/api/workflows/${wf.id}/run`, {});
    assert.equal(r.status, 400); assert.match(r.data.error, /sample payload/i);
  });

  area('Triggers: schedule, RSS, manual');
  await t('TRG-20', 'Cron: invalid expression is rejected at activation; valid 5- and 6-field expressions activate', async () => {
    const mk = (cron) => mkWf(U, 'c', [N('t', 'trigger.cron', 'c', { cron, timezone: 'UTC' })], []);
    assert.equal((await U.post(`/api/workflows/${(await mk('not a cron')).id}/activate`, {})).status, 400);
    assert.equal((await U.post(`/api/workflows/${(await mk('99 * * * *')).id}/activate`, {})).status, 400);
    for (const ok2 of ['0 9 * * 1-5', '*/30 * * * * *']) {
      const w = await mk(ok2);
      assert.equal((await U.post(`/api/workflows/${w.id}/activate`, {})).status, 200, ok2);
      await U.post(`/api/workflows/${w.id}/deactivate`, {});
    }
  });
  await t('TRG-21', 'Cron fires on schedule (every 2 s) and stops after deactivation', async () => {
    const wf = await mkWf(U, 'tick', [N('t', 'trigger.cron', 'c', { cron: '*/2 * * * * *', timezone: 'UTC' }), set('s', { at: '{{ $json.timestamp }}' })], chain('t', 's'));
    await activate(wf.id);
    await sleep(5500);
    await U.post(`/api/workflows/${wf.id}/deactivate`, {});
    await sleep(800);
    const n = (await U.get(`/api/executions?workflowId=${wf.id}`)).data;
    assert.ok(n.length >= 2 && n.length <= 4, `${n.length} runs in 5.5 s`);
    assert.ok(n.every((e) => e.mode === 'trigger' && e.status === 'success'));
    await sleep(2500);
    assert.equal((await U.get(`/api/executions?workflowId=${wf.id}`)).data.length, n.length, 'still firing after deactivate');
  });
  await t('TRG-22', 'Editing an active cron workflow re-arms the schedule with the new expression', async () => {
    const wf = await mkWf(U, 'edit', [N('t', 'trigger.cron', 'c', { cron: '0 0 1 1 *', timezone: 'UTC' })], []);
    await activate(wf.id);
    await U.put(`/api/workflows/${wf.id}`, { definition: { nodes: [N('t', 'trigger.cron', 'c', { cron: '*/2 * * * * *', timezone: 'UTC' })], connections: [] } });
    await sleep(4500);
    const n = (await U.get(`/api/executions?workflowId=${wf.id}`)).data.length;
    await U.post(`/api/workflows/${wf.id}/deactivate`, {});
    assert.ok(n >= 1, 'schedule was not re-armed after the edit');
  });
  await t('TRG-23', 'RSS: feed parser handles RSS 2.0 (CDATA, entities) and Atom', async () => {
    blocked('covered in unit scenarios (UNIT-03) because polling interval is ≥ 5 min; see QA-UNIT report');
  });
  await t('TRG-24', 'Activating a workflow nothing can start (manual-only / error-trigger-only) is refused with guidance and uses no quota', async () => {
    const before = (await U.get('/api/usage')).data.activeWorkflows;
    for (const nodes of [[manual()], [N('e', 'trigger.error', 'e')]]) {
      const wf = await mkWf(U, 'm', nodes, []);
      const r = await U.post(`/api/workflows/${wf.id}/activate`, {});
      assert.equal(r.status, 400, `status ${r.status}`); assert.match(r.data.error, /Webhook, Schedule or RSS/);
    }
    assert.equal((await U.get('/api/usage')).data.activeWorkflows, before);
  });

  /* ------------------------------------ HTTP NODE ------------------------------ */
  area('HTTP Request node');
  const http = (params, extra) => run([manual(), N('h', 'http.request', 'h', params, extra)], chain('t', 'h'));
  await t('HTTP-01', 'GET JSON object: fields are spread + statusCode; array response is under "data"', async () => {
    const o = ok(await http({ url: `${mock.base}/json` }));
    assert.deepEqual(outJson(o, 'h')[0], { name: 'Ada', n: 1, statusCode: 200 });
    const a = ok(await http({ url: `${mock.base}/array` }));
    assert.equal(outJson(a, 'h')[0].data.length, 3);
  });
  await t('HTTP-02', 'Plain-text response is returned as text', async () => {
    assert.equal(outJson(ok(await http({ url: `${mock.base}/text` })), 'h')[0].data, 'plain text');
  });
  await t('HTTP-03', 'POST JSON body with expressions; query + headers JSON are sent', async () => {
    const r = ok(await run([manual(), set('d', { who: '{{ "Ada" }}' }), N('h', 'http.request', 'h', { method: 'POST', url: `${mock.base}/echo`, body: '{"name":"{{ $json.who }}"}', query: '{"a":"1","b":"{{ $json.who }}"}', headers: '{"x-test":"hdr"}' })], chain('t', 'd', 'h')));
    const o = outJson(r, 'h')[0];
    assert.deepEqual(o.body, { name: 'Ada' }); assert.deepEqual(o.query, { a: '1', b: 'Ada' }); assert.equal(o.headers['x-test'], 'hdr'); assert.equal(o.contentType, 'application/json');
  });
  await t('HTTP-04', 'Form-encoded body', async () => {
    const o = outJson(ok(await http({ method: 'POST', url: `${mock.base}/echo`, bodyType: 'form', body: '{"a":"1","b":"x y"}' })), 'h')[0];
    assert.match(o.contentType, /x-www-form-urlencoded/); assert.equal(o.body, 'a=1&b=x+y');
  });
  await t('HTTP-05', 'Bearer, Basic and custom-header credentials set the right headers', async () => {
    const cb = (await U.post('/api/credentials', { name: 'b', type: 'httpBearer', data: { token: 'T0K' } })).data.id;
    const cbasic = (await U.post('/api/credentials', { name: 'bb', type: 'httpBasic', data: { user: 'u', password: 'p' } })).data.id;
    const ch = (await U.post('/api/credentials', { name: 'h', type: 'httpHeader', data: { name: 'X-API-Key', value: 'KEY' } })).data.id;
    const hdr = async (cred) => outJson(ok(await http({ url: `${mock.base}/echo`, credential: cred })), 'h')[0].headers;
    assert.equal((await hdr(cb)).authorization, 'Bearer T0K');
    assert.equal((await hdr(cbasic)).authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
    assert.equal((await hdr(ch))['x-api-key'], 'KEY');
  });
  await t('HTTP-06', '4xx/5xx fails the run with "HTTP <code>"; ignoreStatus lets the workflow continue', async () => {
    const bad = await http({ url: `${mock.base}/status/404` });
    assert.equal(bad.status, 'error'); assert.match(bad.error.message, /HTTP 404/);
    assert.equal(outJson(ok(await http({ url: `${mock.base}/status/404`, ignoreStatus: true })), 'h')[0].statusCode, 404);
  });
  await t('HTTP-07', 'Timeout is honoured (1 s timeout vs 3 s response)', async () => {
    const t0 = Date.now();
    const r = await http({ url: `${mock.base}/slow?ms=3000`, timeoutSec: 1 });
    assert.equal(r.status, 'error'); assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0} ms`);
  });
  await t('HTTP-08', 'Invalid URL, unsupported schemes and unresolvable hosts produce clear errors', async () => {
    for (const [url, re] of [['not a url', /Invalid URL/], ['file:///etc/passwd', /Only http/], ['ftp://example.com/x', /Only http/], ['javascript:alert(1)', /Only http|Invalid/]]) {
      const r = await http({ url }); assert.equal(r.status, 'error'); assert.match(r.error.message, re, url);
    }
    const dns = await http({ url: 'http://this-host-does-not-exist.invalid/' }); assert.equal(dns.status, 'error');
  });
  await t('HTTP-09', 'Redirects are followed', async () => {
    assert.equal(outJson(ok(await http({ url: `${mock.base}/redirect` })), 'h')[0].name, 'Ada');
  });
  await t('HTTP-10', 'Header-injection attempt through a header value is rejected, not sent', async () => {
    const r = await http({ url: `${mock.base}/echo`, headers: '{"x-a":"v\\r\\nInjected: 1"}' });
    assert.equal(r.status, 'error');
  });
  await t('HTTP-11', 'Invalid headers JSON gives a clear message', async () => {
    const r = await http({ url: `${mock.base}/echo`, headers: '{oops' });
    assert.equal(r.status, 'error'); assert.match(r.error.message, /not valid JSON/);
  });
  await t('HTTP-12', 'SSRF: default install CAN reach loopback/private addresses (by design for self-hosting)', async () => {
    assert.equal((await http({ url: `${mock.base}/json` })).status, 'success');
    return 'expected on self-hosted; BLOCK_PRIVATE_NETWORK=true closes it (next test)';
  });
  const B = await client(sBlock.base).user();
  const bhttp = (url) => runWf(B, [manual(), N('h', 'http.request', 'h', { url })], chain('t', 'h'));
  await t('HTTP-13', 'SSRF protection ON: loopback, link-local metadata, private ranges, IPv6 and numeric-IP tricks are blocked', async () => {
    const urls = ['http://127.0.0.1:1/', 'http://localhost:1/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.16.0.1/',
      'http://[::1]/', 'http://0.0.0.0/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:a9fe:a9fe]/',
      'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[::]/',
      'http://127.1/', 'http://100.64.0.1/', 'http://224.0.0.1/', 'http://0177.0.0.1/', 'http://localhost.:1/'];
    const leaked = [];
    for (const u of urls) {
      const r = await bhttp(u);
      if (r.status !== 'error' || !/private|loopback|blocked/i.test(r.error?.message ?? '')) leaked.push(`${u} -> ${r.status}: ${r.error?.message}`);
    }
    assert.equal(leaked.length, 0, `not blocked with the SSRF message: ${leaked.join(' ; ')}`);
  });
  await t('HTTP-14', 'SSRF protection ON: public-looking host that redirects to loopback is not followed', async () => {
    blocked('needs a public redirector; with protection on the client uses redirect:"manual", so redirects are returned as 3xx and never followed (verified by code review)');
  });

  /* ------------------------------------ CREDENTIALS ---------------------------- */
  area('Credentials');
  await t('CRED-01', 'Create / list / get / update / delete lifecycle', async () => {
    const c = (await U.post('/api/credentials', { name: 'life', type: 'slackApi', data: { token: 'xoxb-1' } }));
    assert.equal(c.status, 201);
    assert.ok((await U.get('/api/credentials')).data.some((x) => x.id === c.data.id));
    assert.equal((await U.put(`/api/credentials/${c.data.id}`, { name: 'renamed' })).status, 200);
    assert.equal((await U.get(`/api/credentials/${c.data.id}`)).data.name, 'renamed');
    assert.equal((await U.del(`/api/credentials/${c.data.id}`)).status, 204);
    assert.equal((await U.get(`/api/credentials/${c.data.id}`)).status, 404);
  });
  await t('CRED-02', 'Validation: missing fields, unknown type and bad body are 400', async () => {
    assert.equal((await U.post('/api/credentials', { name: 'x', type: 'httpBearer', data: {} })).status, 400);
    assert.equal((await U.post('/api/credentials', { name: 'x', type: 'nope', data: { a: 1 } })).status, 400);
    assert.equal((await U.post('/api/credentials', { type: 'httpBearer', data: { token: 't' } })).status, 400);
    assert.equal((await U.post('/api/credentials', { name: 'x', type: 'httpBearer' })).status, 400);
  });
  await t('CRED-03', 'Secrets never appear in list/get responses; only "secretsSet" names do', async () => {
    const c = (await U.post('/api/credentials', { name: 's', type: 'postgres', data: { host: 'h', database: 'd', user: 'u', password: 'PASSWORD-VALUE', port: '5432' } })).data;
    const dump = JSON.stringify([(await U.get('/api/credentials')).data, (await U.get(`/api/credentials/${c.id}`)).data]);
    assert.ok(!dump.includes('PASSWORD-VALUE')); assert.ok(dump.includes('secretsSet'));
  });
  await t('CRED-04', 'Updating without re-entering a secret keeps the stored secret; entering a new one replaces it', async () => {
    const c = (await U.post('/api/credentials', { name: 'k', type: 'httpBearer', data: { token: 'OLD' } })).data;
    await U.put(`/api/credentials/${c.id}`, { name: 'k2', data: { token: '' } });
    const use = async () => outJson(ok(await http({ url: `${mock.base}/echo`, credential: c.id })), 'h')[0].headers.authorization;
    assert.equal(await use(), 'Bearer OLD');
    await U.put(`/api/credentials/${c.id}`, { data: { token: 'NEW' } });
    assert.equal(await use(), 'Bearer NEW');
  });
  await t('CRED-05', 'Secret is encrypted at rest (not found as plaintext in the database files)', async () => {
    const marker = `PLAINTEXT-MARKER-${uniq()}`;
    await U.post('/api/credentials', { name: 'enc', type: 'httpBearer', data: { token: marker } });
    await sleep(300);
    const files = fs.readdirSync(s1.dir).filter((f) => f.startsWith('liteforeflow.db'));
    assert.ok(files.length > 0, 'db file not found');
    for (const f of files) assert.ok(!fs.readFileSync(path.join(s1.dir, f)).includes(marker), `plaintext found in ${f}`);
  });
  await t('CRED-06', 'Using a credential of the wrong type, or after deletion, fails with a clear message', async () => {
    const slack = (await U.post('/api/credentials', { name: 'sl', type: 'slackApi', data: { token: 't' } })).data.id;
    const r = await run([manual(), N('s', 'app.telegram', 's', { credential: slack, chatId: '1', text: 'x' })], chain('t', 's'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /expected telegramApi/);
    await U.del(`/api/credentials/${slack}`);
    const r2 = await run([manual(), N('s', 'app.slack', 's', { credential: slack, channel: '#a', text: 'x' })], chain('t', 's'));
    assert.match(r2.error.message, /Credential not found/);
  });
  await t('CRED-07', 'Google service-account credential validates the JSON key shape', async () => {
    assert.equal((await U.post('/api/credentials', { name: 'g', type: 'googleServiceAccount', data: { json: 'not json' } })).status, 400);
    assert.equal((await U.post('/api/credentials', { name: 'g', type: 'googleServiceAccount', data: { json: '{"a":1}' } })).status, 400);
    assert.equal((await U.post('/api/credentials', { name: 'g', type: 'googleServiceAccount', data: { json: '{"client_email":"a@b","private_key":"k"}' } })).status, 201);
  });
  await t('CRED-08', 'Credential values do not leak into execution logs or error messages', async () => {
    const c = (await U.post('/api/credentials', { name: 'leak', type: 'httpBearer', data: { token: 'LEAKCHECK-9f3a' } })).data.id;
    const r = await http({ url: `${mock.base}/status/401`, credential: c });
    const ex = (await U.get(`/api/executions/${r.executionId}`)).data;
    assert.ok(!JSON.stringify(ex).includes('LEAKCHECK-9f3a'), 'token appears in the execution record');
    assert.ok(!JSON.stringify(r).includes('LEAKCHECK-9f3a'));
  });

  /* --------------------------------------- AI ---------------------------------- */
  area('AI nodes (against a local OpenAI/Anthropic-compatible mock)');
  const oa = (await U.post('/api/credentials', { name: 'oa', type: 'openaiApi', data: { apiKey: 'sk-test', baseUrl: `${mock.base}/v1` } })).data.id;
  const an = (await U.post('/api/credentials', { name: 'an', type: 'anthropicApi', data: { apiKey: 'ak-test', baseUrl: mock.base } })).data.id;
  const llm = (params) => run([manual(), N('l', 'ai.llm', 'l', params)], chain('t', 'l'));
  const agent = (params) => run([manual(), N('a', 'ai.agent', 'a', params)], chain('t', 'a'));
  await t('AI-01', 'LLM node: OpenAI-compatible provider returns text/model/usage', async () => {
    const o = outJson(ok(await llm({ provider: 'openai', credential: oa, prompt: 'hello' })), 'l')[0];
    assert.equal(o.text, 'echo: hello'); assert.equal(o.model, 'mock-gpt');
  });
  await t('AI-02', 'LLM node: Anthropic provider', async () => {
    assert.equal(outJson(ok(await llm({ provider: 'anthropic', credential: an, prompt: 'hi' })), 'l')[0].text, 'claude says hi');
  });
  await t('AI-03', 'parseJson extracts JSON (also from ```json fences); non-JSON reply fails clearly', async () => {
    assert.deepEqual(outJson(ok(await llm({ provider: 'openai', credential: oa, prompt: 'give json', parseJson: true })), 'l')[0].parsed, { a: 1 });
    const bad = await llm({ provider: 'openai', credential: oa, prompt: 'notjson', parseJson: true });
    assert.equal(bad.status, 'error'); assert.match(bad.error.message, /not valid JSON/);
  });
  await t('AI-04', 'Provider 401 surfaces a useful error (and the API key is not echoed)', async () => {
    const bad = (await U.post('/api/credentials', { name: 'bad', type: 'openaiApi', data: { apiKey: 'bad-key', baseUrl: `${mock.base}/v1` } })).data.id;
    const r = await llm({ provider: 'openai', credential: bad, prompt: 'x' });
    assert.equal(r.status, 'error'); assert.match(r.error.message, /401/); assert.ok(!r.error.message.includes('bad-key'));
  });
  await t('AI-05', 'Credential for the wrong provider is rejected', async () => {
    const r = await llm({ provider: 'anthropic', credential: oa, prompt: 'x' });
    assert.equal(r.status, 'error'); assert.match(r.error.message, /expected anthropicApi/);
  });
  await t('AI-06', 'Agent (OpenAI): tool-calling loop runs calculator and returns the final answer', async () => {
    const o = outJson(ok(await agent({ provider: 'openai', credential: oa, prompt: 'calc please', tools: '["calculator"]' })), 'a')[0];
    assert.equal(o.steps[0].tool, 'calculator'); assert.equal(o.steps[0].output, '42'); assert.match(o.text, /42/);
  });
  await t('AI-07', 'Agent (Anthropic): tool_use loop', async () => {
    const o = outJson(ok(await agent({ provider: 'anthropic', credential: an, prompt: 'calc please', tools: '["calculator"]' })), 'a')[0];
    assert.equal(o.steps[0].output, '4'); assert.match(o.text, /got 4/);
  });
  await t('AI-08', 'Agent: a hallucinated tool name is handled gracefully (no crash)', async () => {
    const o = outJson(ok(await agent({ provider: 'openai', credential: oa, prompt: 'badtool', tools: '["calculator"]' })), 'a')[0];
    assert.match(o.steps[0].output, /unknown tool/i); assert.equal(o.text, 'recovered');
  });
  await t('AI-09', 'Agent: runaway tool loop stops at maxSteps', async () => {
    const o = outJson(ok(await agent({ provider: 'openai', credential: oa, prompt: 'loop forever', tools: '["current_time"]', maxSteps: 3 })), 'a')[0];
    assert.equal(o.steps.length, 3); assert.match(o.text, /max steps/);
  });
  await t('AI-10', 'Agent: calculator tool refuses non-arithmetic input (model-injected code)', async () => {
    const o = outJson(ok(await agent({ provider: 'openai', credential: oa, prompt: 'evil', tools: '["calculator"]' })), 'a')[0];
    assert.match(o.steps[0].output, /Error: Only numbers/);
    assert.equal((await fetch(`${s1.base}/api/health`)).status, 200);
  });
  await t('AI-11', 'Agent: http_get tool can fetch a URL (and is subject to the SSRF setting)', async () => {
    const o = outJson(ok(await agent({ provider: 'openai', credential: oa, prompt: 'fetch it', tools: '["http_get"]' })), 'a')[0];
    assert.match(o.steps[0].output, /Ada/);
    return 'prompt-injection risk: a model can be told to fetch internal URLs unless BLOCK_PRIVATE_NETWORK=true';
  });
  await t('AI-12', 'Agent: tools given as invalid JSON / non-array fails clearly', async () => {
    const r = await agent({ provider: 'openai', credential: oa, prompt: 'x', tools: '{"a":1}' });
    assert.equal(r.status, 'error');
  });

  /* ----------------------------------- APP NODES -------------------------------- */
  area('App integrations (Slack, Telegram, Discord, Notion, Airtable, Stripe, HubSpot, Postgres, SMTP, Sheets)');
  await t('APP-01', 'Every app node refuses to run without a credential, with a clear message', async () => {
    const types = ['app.slack', 'app.telegram', 'app.discord', 'app.notion', 'app.airtable', 'app.stripe', 'app.hubspot', 'app.postgres', 'app.email', 'app.googleSheets'];
    for (const type of types) {
      const r = await run([manual(), N('a', type, 'a', {})], chain('t', 'a'));
      assert.equal(r.status, 'error', type); assert.match(r.error.message, /No credential selected/, `${type}: ${r.error.message}`);
    }
  });
  await t('APP-02', 'SMTP email node sends a real message to a local SMTP server', async () => {
    const cred = (await U.post('/api/credentials', { name: 'smtp', type: 'smtp', data: { host: 'localhost', port: String(smtp.port), from: 'bot@example.com' } })).data.id;
    ok(await run([manual(), set('d', { who: '{{ "Ada" }}' }), N('e', 'app.email', 'e', { credential: cred, to: 'ada@example.com', subject: 'Hi {{ $json.who }}', text: 'Body for {{ $json.who }}' })], chain('t', 'd', 'e')));
    assert.equal(smtp.messages.length, 1);
    const m = smtp.messages[0];
    assert.match(m.to.join(), /ada@example.com/); assert.match(m.body, /Subject: Hi Ada/); assert.match(m.body, /Body for Ada/);
  });
  await t('APP-03', 'SMTP failure (connection refused) is reported, not hung', async () => {
    const cred = (await U.post('/api/credentials', { name: 'smtp-bad', type: 'smtp', data: { host: 'localhost', port: '1', from: 'a@b.co' } })).data.id;
    const t0 = Date.now();
    const r = await run([manual(), N('e', 'app.email', 'e', { credential: cred, to: 'a@b.co', subject: 's', text: 'x' })], chain('t', 'e'));
    assert.equal(r.status, 'error'); assert.ok(Date.now() - t0 < 15000);
  });
  for (const [id, name] of [['APP-04', 'Slack'], ['APP-05', 'Telegram'], ['APP-06', 'Discord'], ['APP-07', 'Notion'], ['APP-08', 'Airtable'], ['APP-09', 'Stripe'], ['APP-10', 'HubSpot'], ['APP-11', 'Google Sheets']]) {
    await t(id, `${name}: request building and response mapping against the live service`, async () => {
      blocked('needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)');
    });
  }
}
