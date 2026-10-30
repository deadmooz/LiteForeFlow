// Where does the memory of a big run go?   node --expose-gc server/test/bench/memory.mjs [items]
// Prints heap and RSS after: start, a big run, a forced garbage collection.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
process.env.LITEFOREFLOW_SECRET = 'mem';
process.env.AUTH_RATE_LIMIT_PER_MIN = '100000';
const { createApp } = await import('../../src/app.js');
const { startWorker, closeQueue } = await import('../../src/queue.js');
const { loadPlugins } = await import('../../src/plugins.js');
const { closeDb } = await import('../../src/db.js');
const { drainSandboxPool } = await import('../../src/sandbox.js');
await loadPlugins();
await startWorker();
const server = createApp().listen(0);
const base = `http://localhost:${server.address().port}`;
const api = async (m, u, t, b) => (await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) })).json();
const token = (await api('POST', '/api/auth/signup', null, { email: 'm@example.com', password: 'password123', name: 'M' })).token;
const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
const mb = (n) => (n / 1048576).toFixed(0).padStart(4);
const priv = () => Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${process.pid}).PrivateMemorySize64"`).toString().trim());
const show = (label) => { const m = process.memoryUsage(); console.log(`${label.padEnd(34)} rss ${mb(m.rss)} MB  private ${mb(priv())} MB   heap used ${mb(m.heapUsed)} MB   heap total ${mb(m.heapTotal)} MB   external ${mb(m.external)} MB   arrayBuffers ${mb(m.arrayBuffers)} MB`); };
const n = Number(process.argv[2] ?? 50000);
const nodes = [node('t', 'trigger.manual', 'S'), node('g', 'data.code', 'Gen', { code: `return Array.from({length:${n}},(_,i)=>({id:i, v:(i*7919)%10007, name:'item'+i, tags:['a','b'], nested:{x:i%10}}));` }), ...(process.argv[3] === 'gen' ? [] : process.argv[3] === 'limit' ? [node('x', 'data.limit', 'L', { max: 5 })] : [node('x', 'tools.sort', 'Sort', { field: 'v', kind: 'number' }), node('y', 'tools.unique', 'U', { field: 'id' }), node('z', 'data.aggregate', 'Agg', { field: 'all' })])];
if (process.argv[3] === 'host') {
  // no sandbox at all: the items arrive in a webhook body (about 4 MB) and go through sort, unique and aggregate on the host
  const hn = [node('t', 'trigger.webhook', 'Hook', { path: 'big', method: 'POST', respond: 'lastNode' }), node('s', 'data.splitOut', 'Split', { field: 'body.items' }), node('x', 'tools.sort', 'Sort', { field: 'v', kind: 'number' }), node('y', 'tools.unique', 'U', { field: 'id' }), node('z', 'data.limit', 'L', { max: 5 })];
  const hw = (await api('POST', '/api/workflows', token, { name: 'host', definition: { nodes: hn, connections: hn.slice(1).map((x, i) => edge(hn[i].id, x.id)) } })).id;
  await api('POST', `/api/workflows/${hw}/activate`, token);
  const body = JSON.stringify({ items: Array.from({ length: Math.min(n, 30000) }, (_, i) => ({ id: i, v: (i * 7919) % 10007, name: 'item' + i, tags: ['a', 'b'], nested: { x: i % 10 } })) });
  show('host mode: after start');
  global.gc?.(); show('host mode: after start + gc');
  const t1 = Date.now();
  const hr = await fetch(`${base}/webhook/big`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  console.log(`webhook: ${hr.status} in ${Date.now() - t1} ms`); await hr.arrayBuffer();
  show('right after the big run');
  global.gc?.(); await new Promise((res) => setTimeout(res, 300)); global.gc?.(); show('after gc (twice)');
  drainSandboxPool(); show('after emptying the isolate pool');
  server.close(); await closeQueue(); await closeDb(); process.exit(0);
}
const wf = (await api('POST', '/api/workflows', token, { name: 'big', definition: { nodes, connections: nodes.slice(1).map((x, i) => edge(nodes[i].id, x.id)) } })).id;
show('after start');
global.gc?.(); show('after start + gc');
const t0 = Date.now();
const r = await api('POST', `/api/workflows/${wf}/run`, token);
console.log(`run: ${r.status} in ${Date.now() - t0} ms`);
show('right after the big run');
await new Promise((res) => setTimeout(res, 500));
show('0.5 s later');
global.gc?.(); show('after forced gc');
await new Promise((res) => setTimeout(res, 300));
global.gc?.(); show('after second gc');
drainSandboxPool(); global.gc?.(); await new Promise((res) => setTimeout(res, 300)); show('after emptying the isolate pool');
server.close();
await closeQueue();
await closeDb();
process.exit(0);
