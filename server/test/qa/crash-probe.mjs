import { launch, killTree, api, signup, getJson, sleep, FORK } from './fork-lib.mjs';
const payloads = { 'import("fs")': 'return import("fs");', 'Promise.reject()': 'return Promise.reject(new Error("x"));', 'async function that throws': 'return (async () => { throw new Error("boom"); })();' };
for (const [name, mode] of [['basic', 'vm'], ['strong', '']]) {
  for (const [label, src] of Object.entries(payloads)) {
    const h = launch('node', FORK, { env: { PORT: String(3900 + Math.floor(Math.random() * 90)), LITEFOREFLOW_SANDBOX: mode, DATA_DIR: `${process.env.TEMP}/probe-${Math.random().toString(36).slice(2)}` } });
    await h.ready; const base = h.url; const u = await signup(base);
    const w = await api(base, 'POST', '/api/workflows', { name: 'p', definition: { nodes: [{ id: 't', type: 'trigger.manual', name: 'Start', parameters: {}, position: { x: 0, y: 0 } }, { id: 'c', type: 'data.code', name: 'Code', parameters: { mode: 'runOnce', code: src }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }] } }, u.token);
    const r = await api(base, 'POST', `/api/workflows/${w.data.id}/run`, {}, u.token); await sleep(800);
    let alive = true; try { await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) }); } catch { alive = false; }
    console.log(`${name.padEnd(6)} | ${label.padEnd(28)} | run status=${r.data.status ?? 'n/a'} | server alive afterwards: ${alive}${alive ? '' : '   <-- PROCESS DIED: ' + (h.log().match(/Error[^\n]*/) ?? [''])[0]}`);
    killTree(h.proc); await sleep(300);
  }
}
process.exit(0);
