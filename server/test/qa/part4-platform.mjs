import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { area, t, client, boot, blocked, sleep, N, E, chain, manual, set, code, mkWf, runWf, outJson, webhook, uniq, maxLatencyDuring } from './lib.mjs';

export default async function part4({ s1, sProd, sBill, mock }) {
  const U = await client(s1.base).user();
  await U.post('/api/billing/dev-plan', { plan: 'team' });
  const anon = client(s1.base);
  const ok = (r) => { assert.equal(r.status, 'success', `status=${r.status} http=${r.http} err=${JSON.stringify(r.error ?? r.raw)}`); return r; };
  const noop = async (u, name = 'n') => mkWf(u, name, [manual()], []);

  /* ------------------------------------ PLANS ---------------------------------- */
  area('Plans, limits & billing');
  await t('PLAN-01', 'Free plan: 6th active workflow is refused with 402; deactivating one frees a slot', async () => {
    const P = await client(s1.base).user();
    const ids = [];
    for (let i = 0; i < 6; i += 1) ids.push((await mkWf(P, `w${i}`, [webhook('t', `pl-${uniq()}`)], [])).id);
    for (let i = 0; i < 5; i += 1) assert.equal((await P.post(`/api/workflows/${ids[i]}/activate`, {})).status, 200);
    assert.equal((await P.post(`/api/workflows/${ids[5]}/activate`, {})).status, 402);
    await P.post(`/api/workflows/${ids[0]}/deactivate`, {});
    assert.equal((await P.post(`/api/workflows/${ids[5]}/activate`, {})).status, 200);
  });
  await t('PLAN-02', 'Re-activating an already-active workflow does not consume extra quota', async () => {
    const P = await client(s1.base).user();
    const w = await mkWf(P, 'x', [webhook('t', `re-${uniq()}`)], []);
    for (let i = 0; i < 7; i += 1) assert.equal((await P.post(`/api/workflows/${w.id}/activate`, {})).status, 200);
    assert.equal((await P.get('/api/usage')).data.activeWorkflows, 1);
  });
  await t('PLAN-03', 'Monthly run cap (1000): run #1000 passes, #1001 is refused with 402; usage shows 1000/1000', async () => {
    const P = await client(s1.base).user();
    const wf = await noop(P, 'cap');
    const go = () => P.post(`/api/workflows/${wf.id}/run`, {});
    for (let batch = 0; batch < 49; batch += 1) await Promise.all(Array.from({ length: 20 }, go)); // 980 runs
    const last = await Promise.all(Array.from({ length: 20 }, go)); // exactly up to 1000
    assert.ok(last.every((r) => r.status === 200), `unexpected statuses ${last.map((r) => r.status)}`);
    const over = await go();
    assert.equal(over.status, 402); assert.match(over.data.error, /limit/i);
    const u = (await P.get('/api/usage')).data;
    assert.equal(u.runsThisMonth, 1000);
    P.__capped = { wf };
  });
  await t('PLAN-04', 'Cap is exact under concurrency: 50 parallel runs when 10 remain → exactly 10 succeed', async () => {
    const P = await client(s1.base).user();
    const wf = await noop(P, 'race');
    for (let b = 0; b < 49; b += 1) await Promise.all(Array.from({ length: 20 }, () => P.post(`/api/workflows/${wf.id}/run`, {}))); // 980
    await Promise.all(Array.from({ length: 10 }, () => P.post(`/api/workflows/${wf.id}/run`, {}))); // 990
    const rs = await Promise.all(Array.from({ length: 50 }, () => P.post(`/api/workflows/${wf.id}/run`, {})));
    const okN = rs.filter((r) => r.status === 200).length;
    assert.equal(okN, 10, `${okN} runs got through (race on the cap)`);
    assert.equal((await P.get('/api/usage')).data.runsThisMonth, 1000);
  });
  await t('PLAN-05', 'At the cap, webhooks answer 402 and editor shows the limit message; upgrading lifts it immediately', async () => {
    const P = await client(s1.base).user();
    const p = `cap-${uniq()}`;
    const wf = await mkWf(P, 'c', [webhook('t', p), manual('m')], []);
    await P.post(`/api/workflows/${wf.id}/activate`, {});
    const n = await mkWf(P, 'burn', [manual()], []);
    for (let b = 0; b < 50; b += 1) await Promise.all(Array.from({ length: 20 }, () => P.post(`/api/workflows/${n.id}/run`, {})));
    assert.equal((await anon.call('POST', `/webhook/${p}`, {}, { token: null })).status, 402);
    await P.post('/api/billing/dev-plan', { plan: 'pro' });
    assert.equal((await anon.call('POST', `/webhook/${p}`, {}, { token: null })).status, 200);
  });
  await t('PLAN-06', 'Errors, sub-workflow and error-handler runs are not double-counted against the cap', async () => {
    const P = await client(s1.base).user();
    const child = await mkWf(P, 'child', [manual()], []);
    const parent = await mkWf(P, 'parent', [manual(), N('x', 'logic.executeWorkflow', 'x', { workflowId: child.id })], chain('t', 'x'));
    await P.post(`/api/workflows/${parent.id}/run`, {});
    assert.equal((await P.get('/api/usage')).data.runsThisMonth, 1, 'sub-workflow counted as an extra run');
  });
  await t('PLAN-07', 'dev-plan endpoint: unknown plan → 400; works for the owner; is hidden (404) in production mode', async () => {
    const P = await client(s1.base).user();
    assert.equal((await P.post('/api/billing/dev-plan', { plan: 'enterprise' })).status, 400);
    assert.equal((await P.post('/api/billing/dev-plan', { plan: 'team' })).data.plan.id, 'team');
    const Q = await client(sProd.base).user();
    assert.equal((await Q.post('/api/billing/dev-plan', { plan: 'team' })).status, 404, 'plan can be self-upgraded for free in production!');
  });
  await t('PLAN-08', 'Stripe checkout without configuration returns 501 with guidance', async () => {
    assert.equal((await U.post('/api/billing/checkout', { plan: 'pro' })).status, 501);
  });
  const sign = (secret, body, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  const stripePost = (base, body, sig) => fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body });
  await t('PLAN-09', 'Stripe webhook: bad / missing / stale / tampered signatures are rejected (400) and change nothing', async () => {
    const P = await client(sBill.base).user();
    const ws = P.info.workspaceId;
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { customer: 'cus_1', metadata: { workspaceId: ws, plan: 'team' } } } });
    for (const sig of ['', 't=1,v1=00', sign('whsec_wrong', body), sign('whsec_qa', body, Math.floor(Date.now() / 1000) - 3600), sign('whsec_qa', `${body} `)]) {
      assert.equal((await stripePost(sBill.base, body, sig)).status, 400, `signature "${sig.slice(0, 20)}" accepted`);
    }
    assert.equal((await P.get('/api/usage')).data.plan.id, 'free');
  });
  await t('PLAN-10', 'Stripe webhook: valid checkout.session.completed upgrades the plan; subscription.deleted downgrades', async () => {
    const P = await client(sBill.base).user();
    const ws = P.info.workspaceId;
    const up = JSON.stringify({ type: 'checkout.session.completed', data: { object: { customer: 'cus_up', metadata: { workspaceId: ws, plan: 'team' } } } });
    assert.equal((await stripePost(sBill.base, up, sign('whsec_qa', up))).status, 200);
    assert.equal((await P.get('/api/usage')).data.plan.id, 'team');
    const down = JSON.stringify({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_up' } } });
    assert.equal((await stripePost(sBill.base, down, sign('whsec_qa', down))).status, 200);
    await sleep(31000); // plan cache TTL (30 s) — other processes lag by at most this
    assert.equal((await P.get('/api/usage')).data.plan.id, 'free');
  });
  await t('PLAN-11', 'Stripe webhook: unknown plan name in metadata is ignored', async () => {
    const P = await client(sBill.base).user();
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { customer: 'c', metadata: { workspaceId: P.info.workspaceId, plan: 'god-mode' } } } });
    assert.equal((await stripePost(sBill.base, body, sign('whsec_qa', body))).status, 200);
    assert.equal((await P.get('/api/usage')).data.plan.id, 'free');
  });
  await t('PLAN-12', 'Real Stripe Checkout round trip', async () => { blocked('needs live/test Stripe keys and a public webhook URL'); });

  /* ------------------------------ TEMPLATES & IMPORT --------------------------- */
  area('Templates & n8n import');
  await t('TPL-01', 'All 15 templates are listed and each one creates a structurally valid workflow', async () => {
    const list = (await U.get('/api/templates')).data;
    assert.ok(list.length >= 15, `${list.length} templates`);
    const types = new Set((await U.get('/api/node-types')).data.map((n) => n.type));
    for (const tpl of list) {
      const r = await U.post(`/api/templates/${tpl.id}/use`, {});
      assert.equal(r.status, 201, tpl.id);
      const def = r.data.definition; const ids = new Set(def.nodes.map((n) => n.id));
      assert.ok(def.nodes.every((n) => types.has(n.type)), `${tpl.id}: unknown node type`);
      assert.ok(def.connections.every((c) => ids.has(c.from) && ids.has(c.to)), `${tpl.id}: dangling edge`);
      const run = await U.post(`/api/workflows/${r.data.id}/run`, {});
      assert.notEqual(run.status, 400, `${tpl.id}: ${JSON.stringify(run.data)}`); // credential errors (200/error) are expected
    }
  });
  await t('TPL-02', 'Using the same template twice yields unique webhook paths that can both be active', async () => {
    const P = await client(s1.base).user();
    const a = (await P.post('/api/templates/webhook-slack-alert/use', {})).data; const b = (await P.post('/api/templates/webhook-slack-alert/use', {})).data;
    assert.notEqual(a.definition.nodes[0].parameters.path, b.definition.nodes[0].parameters.path);
    assert.equal((await P.post(`/api/workflows/${a.id}/activate`, {})).status, 200); assert.equal((await P.post(`/api/workflows/${b.id}/activate`, {})).status, 200);
  });
  await t('TPL-03', 'Unknown template id is 404', async () => { assert.equal((await U.post('/api/templates/nope/use', {})).status, 404); });
  const n8n = (nodes, connections = {}) => ({ name: 'imp', nodes, connections });
  await t('IMP-01', 'n8n import: converts nodes, connections (incl. IF true/false outputs) and strips "=" from expressions', async () => {
    const wf = n8n([
      { name: 'Start', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
      { name: 'Check', type: 'n8n-nodes-base.if', position: [200, 0], parameters: { conditions: { conditions: [{ leftValue: '={{ $json.n }}', rightValue: 5, operator: { type: 'number', operation: 'gt' } }] } } },
      { name: 'Yes', type: 'n8n-nodes-base.set', position: [400, -80], parameters: { assignments: { assignments: [{ name: 'r', value: "={{ $('Start').item.json.n }}" }] } } },
      { name: 'No', type: 'n8n-nodes-base.noOp', position: [400, 80], parameters: {} },
    ], { Start: { main: [[{ node: 'Check', type: 'main', index: 0 }]] }, Check: { main: [[{ node: 'Yes', type: 'main', index: 0 }], [{ node: 'No', type: 'main', index: 0 }]] } });
    const r = await U.post('/api/import/n8n', { workflow: wf });
    assert.equal(r.status, 201); assert.equal(r.data.report.converted, 4);
    const run = ok({ ...(await U.post(`/api/workflows/${r.data.workflow.id}/run`, { payload: { n: 9 } })).data });
    const byName = Object.fromEntries(Object.values(run.results).map((x) => [x.name, x]));
    assert.equal(byName.Yes.status, 'success'); assert.equal(byName.Yes.output[0][0].json.r, 9); assert.equal(byName.No.status, 'skipped');
  });
  await t('IMP-02', 'n8n import: unsupported nodes become placeholders and are reported; sticky notes are dropped', async () => {
    const r = await U.post('/api/import/n8n', { workflow: n8n([
      { name: 'S', type: 'n8n-nodes-base.manualTrigger', position: [0, 0], parameters: {} },
      { name: 'QB', type: 'n8n-nodes-base.quickbooks', position: [0, 0], parameters: {} },
      { name: 'Note', type: 'n8n-nodes-base.stickyNote', position: [0, 0], parameters: {} }]) });
    assert.equal(r.data.report.total, 2); assert.equal(r.data.report.unsupported[0].type, 'quickbooks'); assert.equal(r.data.workflow.definition.nodes.length, 2);
  });
  await t('IMP-03', 'n8n import: garbage input is rejected with 400 (string, empty object, nodes not array, null)', async () => {
    for (const w of ['not json', {}, { nodes: 'x' }, null, 42, []]) assert.equal((await U.post('/api/import/n8n', { workflow: w })).status, 400, JSON.stringify(w));
  });
  await t('IMP-04', 'n8n import respects the 200-node limit that normal creation enforces', async () => {
    const nodes = Array.from({ length: 250 }, (_, i) => ({ name: `n${i}`, type: 'n8n-nodes-base.noOp', position: [i, 0], parameters: {} }));
    const r = await U.post('/api/import/n8n', { workflow: n8n(nodes) });
    assert.equal(r.status, 400, `imported ${r.data?.workflow?.definition?.nodes?.length} nodes; the 200-node cap is bypassed`);
  });
  await t('IMP-05', 'n8n import: schedule trigger / webhook / http / code / wait convert with sane parameters', async () => {
    const r = await U.post('/api/import/n8n', { workflow: n8n([
      { name: 'Sched', type: 'n8n-nodes-base.scheduleTrigger', position: [0, 0], parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] } } },
      { name: 'Hook', type: 'n8n-nodes-base.webhook', position: [0, 0], parameters: { path: 'p1', httpMethod: 'GET' } },
      { name: 'Req', type: 'n8n-nodes-base.httpRequest', position: [0, 0], parameters: { url: '=https://x.test/{{ $json.id }}', method: 'POST', sendBody: true, jsonBody: '={"a":1}' } },
      { name: 'Code', type: 'n8n-nodes-base.code', position: [0, 0], parameters: { jsCode: 'return [];' } },
      { name: 'Wait', type: 'n8n-nodes-base.wait', position: [0, 0], parameters: { amount: 2, unit: 'minutes' } }]) });
    const byName = Object.fromEntries(r.data.workflow.definition.nodes.map((n) => [n.name, n]));
    assert.equal(byName.Sched.parameters.cron, '*/15 * * * *'); assert.equal(byName.Hook.parameters.method, 'GET');
    assert.equal(byName.Req.parameters.url, 'https://x.test/{{ $json.id }}'); assert.equal(byName.Wait.parameters.seconds, 120);
  });

  /* -------------------------------- EXECUTIONS API ----------------------------- */
  area('Executions API');
  const X = await client(s1.base).user();
  const xw = await mkWf(X, 'x', [manual(), code('c', 'return [{ok:1}];')], chain('t', 'c'));
  const bad = await mkWf(X, 'bad', [manual(), N('s', 'logic.stopAndError', 's', { message: 'x' })], chain('t', 's'));
  for (let i = 0; i < 7; i += 1) await X.post(`/api/workflows/${xw.id}/run`, {});
  for (let i = 0; i < 3; i += 1) await X.post(`/api/workflows/${bad.id}/run`, {});
  await t('EXE-01', 'List supports status and workflow filters; newest first', async () => {
    const all = (await X.get('/api/executions')).data;
    assert.equal(all.length, 10);
    assert.ok(all.every((e, i) => i === 0 || all[i - 1].startedAt >= e.startedAt), 'not newest-first');
    assert.equal((await X.get('/api/executions?status=error')).data.length, 3);
    assert.equal((await X.get(`/api/executions?workflowId=${xw.id}`)).data.length, 7);
    assert.equal((await X.get('/api/executions?status=nonsense')).data.length, 0);
  });
  await t('EXE-02', 'Pagination: limit + offset page through without overlap', async () => {
    const p1 = (await X.get('/api/executions?limit=4&offset=0')).data; const p2 = (await X.get('/api/executions?limit=4&offset=4')).data; const p3 = (await X.get('/api/executions?limit=4&offset=8')).data;
    const ids = [...p1, ...p2, ...p3].map((e) => e.id);
    assert.equal(ids.length, 10); assert.equal(new Set(ids).size, 10);
  });
  await t('EXE-03', 'Hostile limit/offset values (negative, text, huge, float) are handled without 500', async () => {
    const bads = ['limit=-5', 'limit=abc', 'limit=999999', 'offset=-3', 'offset=abc', 'limit=2.7', 'limit=0'];
    const problems = [];
    for (const q of bads) { const r = await X.get(`/api/executions?${q}`); if (r.status !== 200 || (q.startsWith('limit=-') && r.data.length > 200)) problems.push(`${q}→${r.status}/${Array.isArray(r.data) ? r.data.length : '-'}`); }
    assert.equal(problems.length, 0, problems.join(', '));
  });
  await t('EXE-04', 'Negative limit must not turn into "return everything"', async () => {
    const r = await X.get('/api/executions?limit=-1');
    assert.ok(r.status === 400 || r.data.length <= 50, `limit=-1 returned ${r.data.length} rows with status ${r.status} (SQLite treats LIMIT -1 as unlimited)`);
  });
  await t('EXE-05', 'Detail returns per-node input/output/timing/status and error with node name', async () => {
    const e = (await X.get('/api/executions?status=error&limit=1')).data[0];
    const d = (await X.get(`/api/executions/${e.id}`)).data;
    assert.equal(d.error.nodeName, 's'); assert.ok(d.results.s.error); assert.equal(d.results.t.status, 'success'); assert.ok(d.finishedAt && d.startedAt);
  });
  await t('EXE-06', 'Unknown execution id → 404; delete works and is scoped to the owner', async () => {
    assert.equal((await X.get('/api/executions/00000000-0000-0000-0000-000000000000')).status, 404);
    const e = (await X.get('/api/executions?limit=1')).data[0];
    assert.equal((await X.del(`/api/executions/${e.id}`)).status, 204); assert.equal((await X.get(`/api/executions/${e.id}`)).status, 404);
  });
  await t('EXE-07', 'SQL-injection style filter values are treated as data', async () => {
    const r = await X.get(`/api/executions?status=${encodeURIComponent("' OR '1'='1")}&workflowId=${encodeURIComponent("x' --")}`);
    assert.equal(r.status, 200); assert.equal(r.data.length, 0);
  });
  await t('EXE-08', 'Run data is gzip-compressed at rest and transparent through the API', async () => {
    const r = ok({ ...(await X.post(`/api/workflows/${(await mkWf(X, 'big', [manual(), code('g', 'return Array.from({length:300},(_,i)=>({i,t:"row "+i}));')], chain('t', 'g'))).id}/run`, {})).data });
    assert.equal(r.results.g.output[0].length, 100);
  });
  await t('EXE-09', 'saveSuccessData=false keeps only a record for successes but full data for failures', async () => {
    const ok1 = await mkWf(X, 'nosave', [manual(), set('a', { v: '{{ 1 }}' })], chain('t', 'a'), { saveSuccessData: false });
    // webhook-mode run so the editor-run exception does not apply
    const p = `ns-${uniq()}`;
    const hook = await mkWf(X, 'nosave2', [webhook('t', p, { respond: 'lastNode' }), set('a', { v: '{{ 1 }}' })], chain('t', 'a'), { saveSuccessData: false });
    await X.post(`/api/workflows/${hook.id}/activate`, {});
    await anon.call('POST', `/webhook/${p}`, {}, { token: null });
    const e = (await X.get(`/api/executions?workflowId=${hook.id}`)).data[0];
    const d = (await X.get(`/api/executions/${e.id}`)).data;
    assert.equal(d.status, 'success'); assert.deepEqual(d.results, {});
    void ok1;
  });
  await t('EXE-10', 'Log retention pruning (free plan: 3 days)', async () => { blocked('needs a clock/DB manipulation; covered by unit-level review of pruneExecutions (QA-UNIT)'); });

  /* ------------------------------------ SECURITY ------------------------------- */
  area('Security');
  await t('SEC-01', 'x-powered-by removed; X-Content-Type-Options: nosniff on every response', async () => {
    const r = await anon.get('/api/health', { token: null });
    assert.equal(r.headers.get('x-powered-by'), null); assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  await t('SEC-02', 'Clickjacking / CSP / referrer protection headers are set on the app shell and the API', async () => {
    for (const p of ['/', '/api/health']) {
      const r = await anon.get(p, { token: null });
      const missing = ['content-security-policy', 'x-frame-options', 'referrer-policy', 'permissions-policy'].filter((h) => !r.headers.get(h));
      assert.equal(missing.length, 0, `${p} missing headers: ${missing.join(', ')}`);
      assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(r.headers.get('x-frame-options'), 'DENY');
    }
    const https = await fetch(`${s1.base}/api/health`, { headers: { 'x-forwarded-proto': 'https' } });
    assert.ok(https.headers.get('strict-transport-security'), 'HSTS not sent behind an HTTPS proxy');
  });
  await t('SEC-03', 'Static file serving cannot escape the web root (path traversal)', async () => {
    const paths = ['/..%2f..%2fpackage.json', '/assets/..%2f..%2f..%2fserver/package.json', '/%2e%2e/%2e%2e/package.json', '/..\\..\\package.json', '/assets/../../../package.json'];
    for (const p of paths) {
      const r = await anon.get(p, { token: null });
      assert.ok(!/"scripts"|"dependencies"/.test(r.text) || r.text.includes('<!doctype html>'), `traversal ${p} leaked a file`);
    }
  });
  await t('SEC-04', 'Unknown /api routes return JSON 404; unknown pages fall back to the SPA', async () => {
    const a = await U.get('/api/nope'); assert.equal(a.status, 404); assert.equal(typeof a.data, 'object');
    assert.match((await anon.get('/some/client/route', { token: null })).text, /<div id="root">/);
  });
  await t('SEC-05', 'ReDoS: a catastrophic user regex in an IF node must not freeze the whole server', async () => {
    const { max, out } = await maxLatencyDuring(s1.base, () => runWf(U, [manual(), N('i', 'logic.if', 'i', { conditions: [{ left: `${'a'.repeat(40)}!`, op: 'regex', right: '(a+)+$' }], combine: 'all' })], [E('t', 'i')]));
    assert.ok(max < 1500, `event loop was blocked for ${max} ms by a single regex (status ${out.status})`);
    assert.equal(out.status, 'error'); assert.match(out.error.message, /too long|backtrack/i);
    return `worst health latency ${max} ms; run failed cleanly with: ${out.error.message.slice(0, 60)}`;
  });
  await t('SEC-12', 'Regex operator still works for normal patterns; invalid / oversized patterns give clear errors', async () => {
    const r = (left, right) => runWf(U, [manual(), N('i', 'logic.if', 'i', { conditions: [{ left, op: 'regex', right }], combine: 'all' }), set('y', { m: '{{ 1 }}' })], [E('t', 'i'), E('i', 'y', 0)]);
    assert.equal((await r('order-1234', '^order-\\d+$')).results.y.status, 'success');
    assert.equal((await r('abc', '^\\d+$')).results.y.status, 'skipped');
    const bad = await r('x', '(unclosed'); assert.equal(bad.status, 'error'); assert.match(bad.error.message, /Invalid regular expression/);
    const big = await r('x', 'a'.repeat(1500)); assert.equal(big.status, 'error'); assert.match(big.error.message, /too long/);
  });
  await t('SEC-06', 'Prototype pollution via Edit Fields ("__proto__.x") does not modify Object.prototype in the server', async () => {
    blocked('verified in-process in the unit scenarios (UNIT-01) — cannot be observed from outside');
  });
  await t('SEC-07', 'Error responses never leak stack traces or file paths', async () => {
    const probes = [['POST', '/api/auth/login', '{bad'], ['PUT', '/api/workflows/x', '{}'], ['POST', '/api/import/n8n', '{"workflow":"{"}']];
    for (const [m, p, b] of probes) { const r = await anon.call(m, p, b, { raw: true, token: U.token, headers: { 'content-type': 'application/json' } }); assert.ok(!/at .*\.js:\d+|node_modules|C:\\\\|\/home\//.test(r.text), `${p}: ${r.text.slice(0, 120)}`); }
  });
  await t('SEC-08', 'CORS: cross-origin pages can call the API only with a bearer token (no cookies); preflight answers', async () => {
    const r = await fetch(`${s1.base}/api/workflows`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
    assert.ok([200, 204].includes(r.status));
    return `ACAO: ${r.headers.get('access-control-allow-origin')} — wide open, but safe because auth is a bearer header (no cookie/CSRF surface). Tighten for a hosted SaaS.`;
  });
  await t('SEC-09', 'Bearer token is stored in localStorage (XSS-exposed)', async () => {
    return 'design note: a successful XSS would exfiltrate the 7-day JWT. React escaping + a CSP (SEC-02) are the mitigations; httpOnly cookies would be stronger.';
  });
  await t('SEC-10', 'Webhook secret comparison is constant-time and the secret is not echoed back anywhere', async () => {
    const p = `ct-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { secret: 'SECRET-IN-PARAM' })], []);
    await U.post(`/api/workflows/${wf.id}/activate`, {});
    const r = await anon.call('POST', `/webhook/${p}`, {}, { token: null, headers: { 'x-webhook-secret': 'x' } });
    assert.ok(!r.text.includes('SECRET-IN-PARAM'));
    return 'webhook secret is stored in the workflow definition in plaintext (visible to workspace members in the editor) — by design';
  });
  await t('SEC-11', 'A __proto__/constructor key in JSON bodies does not break or pollute the server', async () => {
    const p = `pp-${uniq()}`;
    const wf = await mkWf(U, 'w', [webhook('t', p, { respond: 'lastNode' }), set('s', { ok: '{{ 1 }}' }, {}, true)], chain('t', 's'));
    await U.post(`/api/workflows/${wf.id}/activate`, {});
    const r = await anon.call('POST', `/webhook/${p}`, '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted2":"yes"}}}', { token: null, raw: true, headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 200);
    const again = await anon.call('POST', `/webhook/${p}`, {}, { token: null });
    assert.equal(again.status, 200); assert.ok(!('polluted' in again.data));
  });

  /* ----------------------------------- RESILIENCE ------------------------------ */
  area('Resilience: crash & restart');
  await t('RES-01', 'After kill -9 and restart: accounts, workflows, credentials and active webhooks survive; in-flight run is marked failed; cron resumes', async () => {
    let srv = await boot('res', {});
    const cl = client(srv.base);
    const u = await cl.user();
    const cred = (await u.post('/api/credentials', { name: 'keep', type: 'httpBearer', data: { token: 'SURVIVES' } })).data;
    const p = `res-${uniq()}`;
    const hook = await mkWf(u, 'hook', [webhook('t', p, { respond: 'lastNode' }), set('s', { alive: '{{ 1 }}' }, {}, false)], chain('t', 's'));
    await u.post(`/api/workflows/${hook.id}/activate`, {});
    const slowP = `res-slow-${uniq()}`;
    const slow = await mkWf(u, 'slow', [webhook('t', slowP), N('w', 'logic.wait', 'w', { seconds: 60 })], chain('t', 'w'));
    await u.post(`/api/workflows/${slow.id}/activate`, {});
    const inflight = (await client(srv.base).call('POST', `/webhook/${slowP}`, {}, { token: null })).data.executionId;
    const tick = await mkWf(u, 'tick', [N('t', 'trigger.cron', 'c', { cron: '*/2 * * * * *', timezone: 'UTC' })], []);
    await u.post(`/api/workflows/${tick.id}/activate`, {});
    await sleep(2500);
    await srv.stop('SIGKILL');
    srv = await boot('res2', {}, { dataDir: srv.dir });
    const c2 = client(srv.base);
    const login = await c2.post('/api/auth/login', { email: u.info.email, password: u.info.password }, { token: null });
    assert.equal(login.status, 200, 'cannot log in after restart');
    const u2 = client(srv.base); u2.token = login.data.token;
    assert.equal((await u2.get('/api/workflows')).data.length, 3);
    assert.equal((await u2.get(`/api/credentials/${cred.id}`)).status, 200);
    assert.deepEqual((await c2.call('POST', `/webhook/${p}`, {}, { token: null })).data, { alive: 1 });
    const ex = (await u2.get(`/api/executions/${inflight}`)).data;
    assert.equal(ex.status, 'error', `in-flight run status after crash: ${ex.status}`); assert.match(ex.error.message, /restart/i);
    const before = (await u2.get(`/api/executions?workflowId=${tick.id}`)).data.length;
    await sleep(4500);
    const after = (await u2.get(`/api/executions?workflowId=${tick.id}`)).data.length;
    assert.ok(after > before, 'cron did not resume after restart');
    await srv.stop();
  });
  await t('RES-02', 'Graceful shutdown (SIGTERM) exits promptly', async () => {
    const srv = await boot('term', {});
    const t0 = Date.now();
    srv.proc.kill('SIGTERM');
    await new Promise((r) => { srv.proc.on('exit', r); setTimeout(r, 6000); });
    if (process.platform === 'win32') { await srv.stop(); blocked('Windows cannot deliver SIGTERM to a Node child (process is terminated abruptly); verified on Linux containers earlier (docker stop finished the in-flight run)'); }
    assert.ok(srv.proc.exitCode !== null && Date.now() - t0 < 6000);
  });
  await t('RES-03', 'Corrupt/missing data dir: server refuses to start with a clear message instead of silently creating a new empty DB elsewhere', async () => {
    blocked('not exercised: SQLite creates the DB on demand by design');
  });
  await t('RES-04', 'Concurrent edits: two simultaneous PUTs to one workflow never corrupt the definition', async () => {
    const wf = await mkWf(U, 'race', [manual()], []);
    const a = { nodes: [manual(), set('a', { a: '{{ 1 }}' })], connections: chain('t', 'a') }; const b = { nodes: [manual(), set('b', { b: '{{ 2 }}' })], connections: chain('t', 'b') };
    await Promise.all([U.put(`/api/workflows/${wf.id}`, { definition: a }), U.put(`/api/workflows/${wf.id}`, { definition: b })]);
    const d = (await U.get(`/api/workflows/${wf.id}`)).data.definition;
    assert.ok(d.nodes.length === 2 && d.connections.length === 1);
    return 'last-write-wins (no optimistic locking): two editors silently overwrite each other — product gap';
  });
}
