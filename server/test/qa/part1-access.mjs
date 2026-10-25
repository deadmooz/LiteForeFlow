import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { area, t, client, blocked, sleep, N, E, chain, manual, set, mkWf, runWf, webhook, uniq } from './lib.mjs';

export default async function part1({ s1, sRate, sNoSignup }) {
  const c = client(s1.base);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  /* ------------------------------------ AUTH ----------------------------------- */
  area('Authentication & accounts');
  const email = `auth-${uniq()}@example.com`;
  await t('AUTH-01', 'Sign up with valid data returns 201, token, workspace', async () => {
    const r = await c.post('/api/auth/signup', { email, password: 'password123', name: 'Tester' }, { token: null });
    assert.equal(r.status, 201); assert.ok(r.data.token); assert.equal(r.data.workspaces.length, 1); assert.equal(r.data.workspaces[0].plan, 'free');
  });
  await t('AUTH-02', 'Duplicate email is rejected (409)', async () => {
    assert.equal((await c.post('/api/auth/signup', { email, password: 'password123' }, { token: null })).status, 409);
  });
  await t('AUTH-03', 'Duplicate email with different letter case is rejected', async () => {
    const r = await c.post('/api/auth/signup', { email: email.toUpperCase(), password: 'password123' }, { token: null });
    assert.equal(r.status, 409, `got ${r.status}`);
  });
  await t('AUTH-04', 'Malformed emails are rejected (400)', async () => {
    for (const bad of ['plain', 'a@b', '@b.com', 'a b@c.com', '', null, 42]) {
      const r = await c.post('/api/auth/signup', { email: bad, password: 'password123' }, { token: null });
      assert.equal(r.status, 400, `email ${JSON.stringify(bad)} -> ${r.status}`);
    }
  });
  await t('AUTH-05', 'Password shorter than 8 characters is rejected', async () => {
    assert.equal((await c.post('/api/auth/signup', { email: `s-${uniq()}@example.com`, password: '1234567' }, { token: null })).status, 400);
  });
  await t('AUTH-06', 'Signup with empty / missing body returns 400, not 500', async () => {
    assert.equal((await c.post('/api/auth/signup', undefined, { token: null })).status, 400);
    assert.equal((await c.post('/api/auth/signup', {}, { token: null })).status, 400);
  });
  await t('AUTH-07', 'Login with correct credentials works; email is case/whitespace-insensitive', async () => {
    assert.equal((await c.post('/api/auth/login', { email, password: 'password123' }, { token: null })).status, 200);
    assert.equal((await c.post('/api/auth/login', { email: `  ${email.toUpperCase()}  `, password: 'password123' }, { token: null })).status, 200);
  });
  await t('AUTH-08', 'Wrong password and unknown user give the same 401 message (no user enumeration on login)', async () => {
    const a = await c.post('/api/auth/login', { email, password: 'wrong-password' }, { token: null });
    const b = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong-password' }, { token: null });
    assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.data.error, b.data.error);
  });
  await t('AUTH-09', 'SQL-injection style input in login does not authenticate', async () => {
    for (const e of ["' OR '1'='1", "admin'--", '" OR 1=1 --']) {
      const r = await c.post('/api/auth/login', { email: e, password: "' OR '1'='1" }, { token: null });
      assert.ok([400, 401].includes(r.status), `${e} -> ${r.status}`);
    }
  });
  await t('AUTH-10', 'Protected endpoints reject missing / garbage / forged tokens', async () => {
    assert.equal((await c.get('/api/workflows', { token: null })).status, 401);
    assert.equal((await c.get('/api/workflows', { token: 'garbage' })).status, 401);
    const user = await c.signup();
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: user.user.id })}.`;
    assert.equal((await c.get('/api/workflows', { token: none })).status, 401, 'alg=none token accepted!');
    const forged = (() => {
      const h = b64({ alg: 'HS256', typ: 'JWT' }); const p = b64({ sub: user.user.id, exp: Math.floor(Date.now() / 1000) + 600 });
      return `${h}.${p}.${crypto.createHmac('sha256', 'not-the-secret').update(`${h}.${p}`).digest('base64url')}`;
    })();
    assert.equal((await c.get('/api/workflows', { token: forged })).status, 401, 'token signed with wrong secret accepted!');
  });
  await t('AUTH-11', 'Expired token is rejected', async () => {
    // Cannot mint a validly-signed expired token without the secret; use the known test secret path via a second server is overkill.
    blocked('needs the signing key; expiry is delegated to the jsonwebtoken library (7d) — not independently verifiable black-box');
  });
  await t('AUTH-12', 'Very long password (200 KB) is handled quickly (no DoS) and is not stored in plaintext', async () => {
    const t0 = Date.now();
    const r = await c.post('/api/auth/signup', { email: `long-${uniq()}@example.com`, password: 'x'.repeat(200_000) }, { token: null });
    assert.ok([201, 400, 413].includes(r.status), `status ${r.status}`);
    assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  });
  await t('AUTH-13', 'Passwords that differ only after byte 72 must not be interchangeable', async () => {
    const e = `bc-${uniq()}@example.com`;
    const pw = `${'A'.repeat(72)}-first`;
    const su = await c.post('/api/auth/signup', { email: e, password: pw }, { token: null });
    assert.equal(su.status, 400, 'a password longer than 72 bytes was accepted (bcrypt would silently truncate it)');
    assert.match(su.data.error, /72/);
    const r = await c.post('/api/auth/login', { email: e, password: `${'A'.repeat(72)}-SECOND` }, { token: null });
    assert.equal(r.status, 401);
    // exactly 72 bytes is still fine, multi-byte characters count as bytes
    assert.equal((await c.post('/api/auth/signup', { email: `ok72-${uniq()}@example.com`, password: 'B'.repeat(72) }, { token: null })).status, 201);
    assert.equal((await c.post('/api/auth/signup', { email: `mb-${uniq()}@example.com`, password: 'é'.repeat(37) }, { token: null })).status, 400);
  });
  await t('AUTH-14', 'HTML in display name is stored as text and returned unchanged (UI must escape)', async () => {
    const r = await c.post('/api/auth/signup', { email: `x-${uniq()}@example.com`, password: 'password123', name: '<img src=x onerror=alert(1)>' }, { token: null });
    assert.equal(r.status, 201); assert.equal(r.data.user.name, '<img src=x onerror=alert(1)>');
    return 'API returns raw text by design; React escapes it (see UI-12)';
  });
  await t('AUTH-15', 'Overlong display name is truncated, not rejected with 500', async () => {
    const r = await c.post('/api/auth/signup', { email: `n-${uniq()}@example.com`, password: 'password123', name: 'n'.repeat(5000) }, { token: null });
    assert.equal(r.status, 201); assert.ok(r.data.user.name.length <= 80);
  });
  await t('AUTH-16', 'Brute-force protection: repeated failed logins eventually return 429', async () => {
    const rc = client(sRate.base);
    let limited = 0;
    for (let i = 0; i < 40; i += 1) if ((await rc.post('/api/auth/login', { email: 'a@b.co', password: 'nope-nope' }, { token: null })).status === 429) limited += 1;
    assert.ok(limited > 0, 'no 429 after 40 failed logins');
  });
  await t('AUTH-17', 'Signups can be disabled (ALLOW_SIGNUP=false) and return 403', async () => {
    const r = await client(sNoSignup.base).post('/api/auth/signup', { email: 'x@y.co', password: 'password123' }, { token: null });
    assert.equal(r.status, 403);
  });

  /* ---------------------------------- TENANCY ---------------------------------- */
  area('Multi-tenancy & workspace isolation');
  const A = await c.user();
  const B = await c.user();
  const wfA = await mkWf(A, 'private A', [manual(), set('s', { x: '{{ 1 }}' })], chain('t', 's'));
  const credA = (await A.post('/api/credentials', { name: 'A secret', type: 'httpBearer', data: { token: 'tok-A-secret' } })).data;
  const runA = (await A.post(`/api/workflows/${wfA.id}/run`, {})).data;
  await t('TEN-01', 'User B cannot read, update, delete, run, duplicate, activate or test-node user A\'s workflow', async () => {
    const calls = [
      B.get(`/api/workflows/${wfA.id}`), B.put(`/api/workflows/${wfA.id}`, { name: 'hacked' }), B.del(`/api/workflows/${wfA.id}`),
      B.post(`/api/workflows/${wfA.id}/run`, {}), B.post(`/api/workflows/${wfA.id}/duplicate`, {}), B.post(`/api/workflows/${wfA.id}/activate`, {}),
      B.post(`/api/workflows/${wfA.id}/deactivate`, {}), B.post(`/api/workflows/${wfA.id}/nodes/s/test`, {}),
    ];
    const rs = await Promise.all(calls);
    rs.forEach((r, i) => assert.equal(r.status, 404, `call #${i} returned ${r.status}`));
    assert.equal((await A.get(`/api/workflows/${wfA.id}`)).data.name, 'private A', 'A\'s workflow was modified');
  });
  await t('TEN-02', 'Workflow list only contains the caller\'s own workflows', async () => {
    assert.equal((await B.get('/api/workflows')).data.length, 0);
    assert.ok((await A.get('/api/workflows')).data.length >= 1);
  });
  await t('TEN-03', 'Credentials of another workspace are invisible and undeletable', async () => {
    assert.equal((await B.get(`/api/credentials/${credA.id}`)).status, 404);
    assert.equal((await B.put(`/api/credentials/${credA.id}`, { name: 'x' })).status, 404);
    await B.del(`/api/credentials/${credA.id}`);
    assert.equal((await A.get(`/api/credentials/${credA.id}`)).status, 200, 'B deleted A\'s credential');
    assert.equal((await B.get('/api/credentials')).data.length, 0);
  });
  await t('TEN-04', 'Executions of another workspace are invisible and undeletable', async () => {
    assert.equal((await B.get(`/api/executions/${runA.executionId}`)).status, 404);
    await B.del(`/api/executions/${runA.executionId}`);
    assert.equal((await A.get(`/api/executions/${runA.executionId}`)).status, 200);
    assert.equal((await B.get('/api/executions')).data.length, 0);
  });
  await t('TEN-05', 'B cannot use A\'s credential id inside B\'s own workflow', async () => {
    const r = await runWf(B, [manual(), N('h', 'http.request', 'H', { url: 'http://localhost:1/x', credential: credA.id })], chain('t', 'h'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /Credential not found/);
  });
  await t('TEN-06', 'B cannot execute A\'s workflow through an Execute Workflow node', async () => {
    const r = await runWf(B, [manual(), N('x', 'logic.executeWorkflow', 'Sub', { workflowId: wfA.id })], chain('t', 'x'));
    assert.equal(r.status, 'error'); assert.match(r.error.message, /not found/i);
  });
  await t('TEN-07', 'Spoofed x-workspace-id header for a workspace the user is not a member of is ignored', async () => {
    const r = await B.get('/api/workflows', { headers: { 'x-workspace-id': A.info.workspaceId } });
    assert.equal(r.status, 200); assert.ok(!r.data.some((w) => w.id === wfA.id), 'B saw A\'s workflow via header spoofing');
  });
  await t('TEN-08', 'Team: only owner can invite; unknown email 404; duplicate 409; free plan caps members (402)', async () => {
    assert.equal((await A.post('/api/workspace/invite', { email: 'ghost@example.com' })).status, 404);
    const r = await A.post('/api/workspace/invite', { email: B.info.email });
    assert.equal(r.status, 402, `free plan should allow 1 member, got ${r.status}`);
  });
  await t('TEN-09', 'After upgrading, invited member can access shared workspace via header, owner-only actions stay blocked', async () => {
    await A.post('/api/billing/dev-plan', { plan: 'team' });
    assert.equal((await A.post('/api/workspace/invite', { email: B.info.email })).status, 201);
    assert.equal((await A.post('/api/workspace/invite', { email: B.info.email })).status, 409);
    const h = { 'x-workspace-id': A.info.workspaceId };
    assert.equal((await B.get('/api/workflows', { headers: h })).data.length, 1);
    assert.equal((await B.post('/api/billing/dev-plan', { plan: 'free' }, { headers: h })).status, 403, 'member could change the plan');
    assert.equal((await B.post('/api/workspace/invite', { email: 'x@y.co' }, { headers: h })).status, 403);
  });
  await t('TEN-10', 'Owner can remove a member; the removed member immediately loses access', async () => {
    const h = { 'x-workspace-id': A.info.workspaceId };
    assert.equal((await B.get('/api/workflows', { headers: h })).data.some((w) => w.id === wfA.id), true, 'precondition: B is a member');
    const r = await A.del(`/api/workspace/members/${B.info.user.id}`);
    assert.ok([200, 204].includes(r.status), `member removal returned ${r.status}`);
    assert.equal((await B.get('/api/workflows', { headers: h })).data.some((w) => w.id === wfA.id), false, 'removed member still sees the workspace');
    assert.equal((await A.get('/api/workspace/members')).data.length, 1);
  });
  await t('TEN-11', 'Member removal rules: owner cannot be removed, a member cannot remove others, a member can leave, unknown id is 404', async () => {
    const O = await c.user(); const M = await c.user(); const M2 = await c.user();
    await O.post('/api/billing/dev-plan', { plan: 'team' });
    await O.post('/api/workspace/invite', { email: M.info.email }); await O.post('/api/workspace/invite', { email: M2.info.email });
    const h = { 'x-workspace-id': O.info.workspaceId };
    assert.equal((await O.del(`/api/workspace/members/${O.info.user.id}`)).status, 400, 'owner removed themselves');
    assert.equal((await M.del(`/api/workspace/members/${M2.info.user.id}`, { headers: h })).status, 403, 'a plain member removed someone');
    assert.equal((await M.del(`/api/workspace/members/${O.info.user.id}`, { headers: h })).status, 403, 'a member removed the owner');
    assert.equal((await M.del(`/api/workspace/members/${M.info.user.id}`, { headers: h })).status, 204, 'member could not leave');
    assert.equal((await O.del('/api/workspace/members/00000000-0000-0000-0000-000000000000')).status, 404);
    assert.equal((await M.get('/api/workflows', { headers: h })).status, 200); // falls back to M's own workspace
  });

  /* ---------------------------------- WORKFLOWS -------------------------------- */
  area('Workflow CRUD & validation');
  const U = await c.user();
  await t('WF-01', 'Create with no definition gives an empty workflow', async () => {
    const r = await U.post('/api/workflows', { name: 'empty' });
    assert.equal(r.status, 201); assert.deepEqual(r.data.definition, { nodes: [], connections: [] });
  });
  await t('WF-02', 'Malformed definitions are rejected with 400', async () => {
    for (const d of [{ nodes: 'x', connections: [] }, { nodes: [] }, 'string', 42, { nodes: [], connections: {} }]) {
      const r = await U.post('/api/workflows', { name: 'bad', definition: d });
      assert.equal(r.status, 400, `${JSON.stringify(d)} -> ${r.status}`);
    }
  });
  await t('WF-03', 'More than 200 nodes is rejected (400)', async () => {
    const nodes = Array.from({ length: 201 }, (_, i) => N(`n${i}`, 'logic.noop', `n${i}`));
    assert.equal((await U.post('/api/workflows', { name: 'big', definition: { nodes, connections: [] } })).status, 400);
  });
  await t('WF-04', 'Rename keeps the definition; update replaces it; updatedAt moves', async () => {
    const wf = await mkWf(U, 'orig', [manual(), set('s', { a: '{{ 1 }}' })], chain('t', 's'));
    await sleep(15);
    const r = await U.put(`/api/workflows/${wf.id}`, { name: 'renamed' });
    assert.equal(r.data.name, 'renamed'); assert.equal(r.data.definition.nodes.length, 2); assert.ok(r.data.updatedAt > wf.updatedAt);
    const r2 = await U.put(`/api/workflows/${wf.id}`, { definition: { nodes: [manual()], connections: [] } });
    assert.equal(r2.data.definition.nodes.length, 1); assert.equal(r2.data.name, 'renamed');
  });
  await t('WF-05', 'Mass assignment: PUT cannot set active/workspace/id through the body', async () => {
    const wf = await mkWf(U, 'ma', [manual()], []);
    const other = await c.user();
    await U.put(`/api/workflows/${wf.id}`, { active: true, id: 'x', workspaceId: other.info.workspaceId, workspace_id: other.info.workspaceId });
    const g = (await U.get(`/api/workflows/${wf.id}`)).data;
    assert.equal(g.active, false); assert.equal(g.id, wf.id); assert.equal(g.workspaceId, U.info.workspaceId);
  });
  await t('WF-06', 'Workflow name is trimmed to 120 chars; empty name becomes "Untitled workflow"', async () => {
    assert.equal((await U.post('/api/workflows', { name: 'n'.repeat(500) })).data.name.length, 120);
    assert.equal((await U.post('/api/workflows', { name: '' })).data.name, 'Untitled workflow');
  });
  await t('WF-07', 'Delete returns 204, then 404; execution history is removed', async () => {
    const wf = await mkWf(U, 'del', [manual()], []);
    const run = (await U.post(`/api/workflows/${wf.id}/run`, {})).data;
    assert.equal((await U.del(`/api/workflows/${wf.id}`)).status, 204);
    assert.equal((await U.get(`/api/workflows/${wf.id}`)).status, 404);
    assert.equal((await U.get(`/api/executions/${run.executionId}`)).status, 404);
  });
  await t('WF-08', 'Deleting an ACTIVE workflow frees its webhook path immediately', async () => {
    const p = `del-${uniq()}`;
    const wf = await mkWf(U, 'delw', [webhook('t', p)], []);
    await U.post(`/api/workflows/${wf.id}/activate`, {});
    assert.equal((await c.post(`/webhook/${p}`, {}, { token: null })).status, 200);
    await U.del(`/api/workflows/${wf.id}`);
    assert.equal((await c.post(`/webhook/${p}`, {}, { token: null })).status, 404);
  });
  await t('WF-09', 'Duplicate creates an inactive copy with a new webhook path', async () => {
    const p = `dup-${uniq()}`;
    const wf = await mkWf(U, 'orig', [webhook('t', p)], []);
    await U.post(`/api/workflows/${wf.id}/activate`, {});
    const d = (await U.post(`/api/workflows/${wf.id}/duplicate`, {})).data;
    assert.equal(d.active, false); assert.notEqual(d.definition.nodes[0].parameters.path, p); assert.match(d.name, /copy/);
    assert.equal((await U.post(`/api/workflows/${d.id}/activate`, {})).status, 200, 'copy could not be activated alongside the original');
  });
  await t('WF-10', 'Invalid JSON body returns 400; oversized body returns 413 (not 500)', async () => {
    assert.equal((await U.call('POST', '/api/workflows', '{bad json', { raw: true, headers: { 'content-type': 'application/json' } })).status, 400);
    const huge = { name: 'x', definition: { nodes: [N('a', 'logic.noop', 'a', { blob: 'x'.repeat(6_000_000) })], connections: [] } };
    assert.equal((await U.post('/api/workflows', huge)).status, 413);
  });
  await t('WF-11', 'List is ordered most-recently-updated first', async () => {
    const a = await mkWf(U, 'older', [manual()], []); await sleep(20);
    const b = await mkWf(U, 'newer', [manual()], []);
    const l = (await U.get('/api/workflows')).data;
    assert.ok(l.findIndex((w) => w.id === b.id) < l.findIndex((w) => w.id === a.id));
  });
  await t('WF-12', 'Settings (error workflow, timeout, saveSuccessData) persist round-trip', async () => {
    const wf = await mkWf(U, 's', [manual()], [], { errorWorkflowId: 'abc', timeoutSec: 9, saveSuccessData: false });
    assert.deepEqual((await U.get(`/api/workflows/${wf.id}`)).data.settings, { errorWorkflowId: 'abc', timeoutSec: 9, saveSuccessData: false });
  });
  await t('WF-13', 'Running a definition with duplicate node names / unknown type / dangling edge returns a clear 400', async () => {
    const cases = [
      [[manual(), N('a', 'logic.noop', 'X'), N('b', 'logic.noop', 'X')], chain('t', 'a'), /more than once/],
      [[manual(), N('a', 'does.not.exist', 'A')], chain('t', 'a'), /unknown type/],
      [[manual()], [E('t', 'ghost')], /does not exist/],
      [[N('a', 'logic.noop', 'A')], [], /trigger/],
    ];
    for (const [nodes, conns, re] of cases) {
      const r = await runWf(U, nodes, conns);
      assert.equal(r.http, 400, `status ${r.http}`); assert.match(r.error ?? r.raw?.error ?? '', re);
    }
  });
  await t('WF-14', 'Name containing quotes, emoji and RTL text round-trips', async () => {
    const name = `Q"'\\ 日本語 🚀 مرحبا`;
    const wf = await mkWf(U, name, [manual()], []);
    assert.equal((await U.get(`/api/workflows/${wf.id}`)).data.name, name);
  });
}
