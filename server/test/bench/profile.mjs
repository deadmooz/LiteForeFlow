// CPU profile of the busiest paths, inside one process:  node --cpu-prof --cpu-prof-dir=<dir> server/test/bench/profile.mjs [small|list|items]
// then:  node server/test/bench/top.mjs <dir>   prints the functions that used the most time.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'));
process.env.LITEFOREFLOW_SECRET = 'prof';
process.env.AUTH_RATE_LIMIT_PER_MIN = '100000';
process.env.DB_PATH = ':memory:';
const { createApp } = await import('../../src/app.js');
const { startWorker, closeQueue } = await import('../../src/queue.js');
const { loadPlugins } = await import('../../src/plugins.js');
const { closeDb } = await import('../../src/db.js');
await loadPlugins();
await startWorker();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
const api = async (m, u, t, b) => (await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) })).json();
const token = (await api('POST', '/api/auth/signup', null, { email: 'p@example.com', password: 'password123', name: 'P' })).token;
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
const mk = async (nodes) => (await api('POST', '/api/workflows', token, { name: 'p', definition: { nodes: [node('t', 'trigger.manual', 'S'), ...nodes], connections: nodes.map((n, i) => edge(i ? nodes[i - 1].id : 't', n.id)) } })).id;
const which = process.argv[2] ?? 'small';
const t0 = Date.now();

if (which === 'small') {
  const id = await mk([node('a', 'data.set', 'A', { fields: [{ name: 'a', value: '{{ $now }}' }, { name: 'b', value: 'x' }], keepOthers: true }), node('b', 'logic.if', 'If', { conditions: [{ left: '{{ $json.b }}', op: 'equals', right: 'x' }] }), node('c', 'data.set', 'C', { fields: [{ name: 'c', value: '{{ $json.a }}' }], keepOthers: true })]);
  for (let i = 0; i < 300; i += 1) await api('POST', `/api/workflows/${id}/run`, token);
} else if (which === 'list') {
  const id = await mk([node('a', 'logic.noop', 'A')]);
  for (let i = 0; i < 100; i += 1) await api('POST', `/api/workflows/${id}/run`, token);
  for (let i = 0; i < 300; i += 1) { await api('GET', '/api/executions?limit=20', token); await api('GET', '/api/workflows', token); }
} else {
  const id = await mk([node('g', 'data.code', 'Gen', { code: 'return Array.from({length:5000},(_,i)=>({id:i, v:i%100, nested:{x:i%10}}));' }), node('x', 'data.set', 'Set', { fields: [{ name: 'k', value: '{{ $json.v }}' }, { name: 'n', value: '{{ $json.nested.x }}' }], keepOthers: true })]);
  await api('POST', `/api/workflows/${id}/run`, token);
}
console.log(`${which}: ${Date.now() - t0} ms`);
server.close();
await closeQueue();
await closeDb();
process.exit(0);
