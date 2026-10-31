// QA for the Ollama provider, against a REAL Ollama server. Boots its own copy of the app (own port, own temp data
// folder, never touches yours), runs every case below and writes docs/QA_OLLAMA_REPORT.md + ollama-qa-results.json.
//   node server/test/qa/ollama-qa.mjs [model]        (default model: the first one `ollama list` shows)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { FORK, launch, sleep } from './fork-lib.mjs';

const OLLAMA = 'http://localhost:11434';
const results = [];
const T0 = Date.now();

/* ------------------------------ helpers ------------------------------ */
const installed = await fetch(`${OLLAMA}/api/tags`).then((r) => r.json()).then((d) => d.models.map((m) => m.name)).catch(() => null);
if (!installed?.length) { console.error('Ollama is not running or has no models. Start it ("ollama serve") and pull one ("ollama pull llama3.2").'); process.exit(2); }
const MODEL = process.argv[2] || installed[0];
console.log(`Ollama models: ${installed.join(', ')}  | testing with: ${MODEL}`);

async function boot(name, env = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `ollqa-${name}-`));
  const port = 5710 + boot.n++;
  const h = launch('node', FORK, { env: { PORT: String(port), DATA_DIR: data, LITEFOREFLOW_SECRET: 'qa-secret', AUTH_RATE_LIMIT_PER_MIN: '1000', ...env } });
  if (!(await h.ready)) throw new Error(`app ${name} did not start:\n${h.log()}`);
  const base = h.url.replace(/\/$/, '');
  const api = async (method, url, { token, body } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = text; try { data = JSON.parse(text); } catch { /* text */ }
    return { status: res.status, data };
  };
  const s = await api('POST', '/api/auth/signup', { body: { email: 'qa@example.com', password: 'password123', name: 'QA' } });
  return { h, base, api, token: s.data.token, port };
}
boot.n = 0;

const node = (id, type, name, parameters = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 } });
const edge = (from, to) => ({ from, to, fromOutput: 0, toInput: 0 });
async function run(app, nodes, { timeout = 280000 } = {}) {
  const all = [node('t', 'trigger.manual', 'Start'), ...nodes];
  const conns = nodes.map((n, i) => edge(i ? nodes[i - 1].id : 't', n.id));
  const wf = await app.api('POST', '/api/workflows', { token: app.token, body: { name: 'qa', definition: { nodes: all, connections: conns } } });
  const t0 = Date.now();
  const r = await Promise.race([app.api('POST', `/api/workflows/${wf.data.id}/run`, { token: app.token }), sleep(timeout).then(() => ({ data: { status: 'timeout' } }))]);
  return { ...r, ms: Date.now() - t0, wfId: wf.data.id, out: (id) => r.data.results?.[id]?.output?.[0]?.map((i) => i.json) ?? [], text: JSON.stringify(r.data) };
}
const llm = (extra = {}, id = 'l') => node(id, 'ai.llm', 'LLM', { provider: 'ollama', model: MODEL, temperature: 0, maxTokens: 1024, ...extra });

class Skip extends Error {}
const ONLY = process.env.ONLY?.split(',');
async function test(id, title, steps, expected, fn) {
  if (ONLY && !ONLY.includes(id)) return;
  const t0 = Date.now();
  let status = 'PASS'; let actual = '';
  try { actual = (await fn()) ?? ''; } catch (e) {
    if (e instanceof Skip) { status = 'NOT TESTABLE'; actual = e.message; } else { status = 'FAIL'; actual = String(e.message ?? e).slice(0, 600); }
  }
  results.push({ id, title, steps, expected, status, actual, ms: Date.now() - t0 });
  console.log(`${status === 'PASS' ? 'ok  ' : status === 'FAIL' ? 'FAIL' : 'skip'} ${id} ${title} (${((Date.now() - t0) / 1000).toFixed(1)}s)${status === 'PASS' ? '' : '\n      ' + actual}`);
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };
const show = (s, n = 80) => String(s).replace(/\s+/g, ' ').slice(0, n);

/* ------------------------------ the cases ------------------------------ */
const app = await boot('main'); // default OLLAMA_HOST = localhost:11434
let credId;

await test('OLL-01', 'Ollama shows up as a provider and as a credential type', 'Ask the server for its node types and credential types.',
  'The LLM and AI Agent nodes list "ollama" as a provider; "Ollama (local AI)" is a credential type; the node credential is optional.', async () => {
    const types = (await app.api('GET', '/api/node-types', { token: app.token })).data;
    const list = Array.isArray(types) ? types : types.nodes ?? [];
    for (const t of ['ai.llm', 'ai.agent']) {
      const prov = list.find((n) => n.type === t).properties.find((p) => p.name === 'provider');
      ok(prov.options.includes('ollama'), `${t} has no ollama option`);
      ok(!list.find((n) => n.type === t).properties.find((p) => p.name === 'credential').required, `${t} still requires a credential`);
    }
    const ct = (await app.api('GET', '/api/credential-types', { token: app.token })).data;
    ok(JSON.stringify(ct).includes('ollamaApi'), 'ollamaApi credential type missing');
    return 'provider options and credential type present';
  });

await test('OLL-02', 'LLM answers with no credential at all', 'LLM node, provider ollama, no credential, prompt "Reply with exactly: PONG".',
  'Run succeeds; output text contains PONG; no credential needed.', async () => {
    const r = await run(app, [llm({ prompt: 'Reply with exactly: PONG' })]);
    ok(r.data.status === 'success', r.text.slice(0, 400));
    const o = r.out('l')[0]; ok(/PONG/i.test(o.text), `text was: ${show(o.text)}`);
    return `"${show(o.text)}" in ${(r.ms / 1000).toFixed(1)}s, model=${o.model}, tokens=${o.usage?.total_tokens}`;
  });

await test('OLL-03', 'Blank model uses the default (llama3.2) - friendly error if it is not installed', 'LLM node, provider ollama, Model left empty.',
  installed.some((m) => m.startsWith('llama3.2')) ? 'Works with llama3.2.' : 'Error says llama3.2 is missing, tells the user to run "ollama pull llama3.2" and lists the installed models.', async () => {
    const r = await run(app, [llm({ model: '', prompt: 'hi' })]);
    if (installed.some((m) => m.startsWith('llama3.2'))) { ok(r.data.status === 'success', r.text.slice(0, 300)); return 'llama3.2 installed, default model worked'; }
    ok(r.data.status === 'error', 'expected an error');
    ok(/ollama pull llama3\.2/.test(r.text), `no pull hint: ${r.text.slice(0, 300)}`);
    ok(installed.every((m) => r.text.includes(m)), 'installed models not listed');
    return show(JSON.stringify(r.data.error ?? r.data), 220);
  });

await test('OLL-04', 'Saving an Ollama credential with every field empty is accepted, and the secret never comes back', 'Create credential type ollamaApi with {} then another with a fake API key; read them back.',
  'Both saved (201). The API key is never returned by the API.', async () => {
    const a = await app.api('POST', '/api/credentials', { token: app.token, body: { name: 'Local', type: 'ollamaApi', data: {} } });
    ok(a.status === 201, `empty credential rejected: ${a.status} ${JSON.stringify(a.data)}`);
    credId = a.data.id;
    const b = await app.api('POST', '/api/credentials', { token: app.token, body: { name: 'Keyed', type: 'ollamaApi', data: { baseUrl: OLLAMA, apiKey: 'sekret-123-xyz' } } });
    ok(b.status === 201, `keyed credential rejected: ${b.status}`);
    const list = await app.api('GET', '/api/credentials', { token: app.token });
    ok(!JSON.stringify(list.data).includes('sekret-123-xyz'), 'API key leaked by GET /credentials');
    app.keyedId = b.data.id;
    return 'both saved, key not in list response';
  });

await test('OLL-05', 'LLM with an explicit credential and address works', 'LLM node using the "Local" credential (empty) and a second using baseUrl http://localhost:11434.',
  'Both runs succeed.', async () => {
    const r1 = await run(app, [llm({ credential: credId, prompt: 'Reply with exactly: OK1' })]);
    ok(r1.data.status === 'success' && /OK1/i.test(r1.out('l')[0].text), r1.text.slice(0, 300));
    const c = await app.api('POST', '/api/credentials', { token: app.token, body: { name: 'Explicit', type: 'ollamaApi', data: { baseUrl: `${OLLAMA}/` } } });
    const r2 = await run(app, [llm({ credential: c.data.id, prompt: 'Reply with exactly: OK2' })]);
    ok(r2.data.status === 'success' && /OK2/i.test(r2.out('l')[0].text), r2.text.slice(0, 300));
    return 'empty credential and explicit address (with trailing slash) both worked';
  });

await test('OLL-06', 'Sending the API key does not break Ollama and the key is not exposed in run data', 'Run LLM with the credential that has apiKey sekret-123-xyz, then fetch the execution record.',
  'Run succeeds; the key appears nowhere in the run result or the saved execution.', async () => {
    const r = await run(app, [llm({ credential: app.keyedId, prompt: 'Reply with exactly: KEY' })]);
    ok(r.data.status === 'success', r.text.slice(0, 300));
    ok(!r.text.includes('sekret-123-xyz'), 'key in run response');
    const ex = await app.api('GET', '/api/executions', { token: app.token });
    ok(!JSON.stringify(ex.data).includes('sekret-123-xyz'), 'key in executions list');
    return 'no leak';
  });

await test('OLL-07', 'System prompt is obeyed', 'System prompt "Always answer in ALL CAPITAL LETTERS", prompt "say hello to my friend".',
  'Reply is upper case.', async () => {
    const r = await run(app, [llm({ system: 'Always answer in ALL CAPITAL LETTERS.', prompt: 'say hello to my friend' })]);
    ok(r.data.status === 'success', r.text.slice(0, 300));
    const t = r.out('l')[0].text.replace(/[^A-Za-z]/g, ''); ok(t.length && t === t.toUpperCase(), `not upper case: ${show(r.out('l')[0].text)}`);
    return show(r.out('l')[0].text);
  });

await test('OLL-08', 'Expressions in the prompt use data from earlier steps, one answer per item', 'Edit Fields makes 3 items (names), LLM prompt "Reply with only the first letter of the name {{ $json.name }}".',
  '3 outputs, in order, each correct.', async () => {
    const code = node('c', 'data.code', 'Make items', { code: 'return [{name:"Zebra"},{name:"Mango"},{name:"Kiwi"}];' });
    const r = await run(app, [code, llm({ prompt: 'Reply with only the first letter of the name {{ $json.name }}. Nothing else.' })]);
    ok(r.data.status === 'success', r.text.slice(0, 300));
    const out = r.out('l'); ok(out.length === 3, `got ${out.length} outputs`);
    const letters = out.map((o) => o.text.replace(/[^A-Za-z]/g, '').toUpperCase());
    ok(letters.join(',') === 'Z,M,K', `letters ${letters.join(',')}`);
    return `Z,M,K in ${(r.ms / 1000).toFixed(1)}s for 3 items`;
  });

await test('OLL-09', 'Parse reply as JSON', 'LLM node, parseJson on, prompt asks for {"ok": true, "n": 3} only.',
  'Output has a parsed object. If the model adds extra text or breaks JSON, the error is understandable.', async () => {
    const r = await run(app, [llm({ prompt: 'Reply with only this JSON and nothing else: {"ok": true, "n": 3}', parseJson: true })]);
    ok(r.data.status === 'success', `${r.text.slice(0, 300)}`);
    ok(r.out('l')[0].parsed?.n === 3, `parsed=${JSON.stringify(r.out('l')[0].parsed)}`);
    return 'parsed ' + JSON.stringify(r.out('l')[0].parsed);
  });

await test('OLL-10', 'Unicode, emoji and a long prompt are handled', 'Prompt with Hindi, emoji and ~6000 characters of filler, asking for the word at the very end.',
  'Run succeeds; no crash or garbled request.', async () => {
    const filler = 'lorem ipsum '.repeat(500);
    const r = await run(app, [llm({ prompt: `नमस्ते 🙂 ${filler}\nThe secret word is BANANA. What is the secret word? Reply with one word.` })]);
    ok(r.data.status === 'success', r.text.slice(0, 300));
    ok(/banana/i.test(r.out('l')[0].text), `answer: ${show(r.out('l')[0].text)}`);
    return `answered "${show(r.out('l')[0].text, 40)}"`;
  });

await test('OLL-11', 'Thinking models and a small "Max tokens" budget', 'LLM node, Max tokens = 40 on a thinking model; then the same prompt with Max tokens = 3000.',
  'Small budget: a clear error that tells the user to raise Max tokens (never a silent empty answer). Large budget: a real answer.', async () => {
    const prompt = 'Explain why the sky is blue in two sentences.';
    const small = await run(app, [llm({ maxTokens: 40, prompt })]);
    if (small.data.status === 'success') ok(small.out('l')[0].text.trim().length > 0, 'EMPTY reply with no explanation: the model spent its whole token budget thinking');
    else ok(small.text.includes('Max tokens') && small.text.includes('Raise'), `unclear error: ${small.text.slice(0, 300)}`);
    const big = await run(app, [llm({ maxTokens: 3000, prompt })]);
    ok(big.data.status === 'success' && big.out('l')[0].text.trim().length > 20, big.text.slice(0, 300));
    return `40 tokens -> ${small.data.status === 'error' ? 'clear error' : 'partial answer'}; 3000 tokens -> "${show(big.out('l')[0].text, 60)}"`;
  });

await test('OLL-31', 'Max tokens left blank gives a thinking model room to answer', 'LLM node on a long unusual prompt with Max tokens left empty (automatic).', 'Succeeds with a real answer; no "used all tokens" error.', async () => {
    const filler = 'lorem ipsum '.repeat(500);
    const r = await run(app, [llm({ maxTokens: '', prompt: `नमस्ते 🙂 ${filler}
The secret word is BANANA. What is the secret word? Reply with one word.` })]);
    ok(r.data.status === 'success', r.text.slice(0, 300));
    ok(/banana/i.test(r.out('l')[0].text), `answer: ${show(r.out('l')[0].text)}`);
    return `answered in ${(r.ms / 1000).toFixed(1)}s using ${r.out('l')[0].usage?.completion_tokens} tokens`;
  });

await test('OLL-12', 'Model that is not installed', 'LLM node with Model "no-such-model:1b".',
  'Error tells the user to run "ollama pull no-such-model:1b" and lists the installed models.', async () => {
    const r = await run(app, [llm({ model: 'no-such-model:1b', prompt: 'hi' })]);
    ok(r.data.status === 'error', 'expected error');
    ok(/ollama pull no-such-model:1b/.test(r.text), r.text.slice(0, 300));
    ok(r.text.includes(installed[0]), 'installed list missing');
    return show(JSON.stringify(r.data.error ?? r.data), 200);
  });

await test('OLL-13', 'Ollama is not running at the address', 'Credential with address http://127.0.0.1:1.',
  'Error says "Could not reach Ollama at http://127.0.0.1:1. Is it running?"', async () => {
    const c = await app.api('POST', '/api/credentials', { token: app.token, body: { name: 'Dead', type: 'ollamaApi', data: { baseUrl: 'http://127.0.0.1:1' } } });
    const r = await run(app, [llm({ credential: c.data.id, prompt: 'hi' })]);
    ok(r.data.status === 'error' && /Could not reach Ollama at http:\/\/127\.0\.0\.1:1/.test(r.text), r.text.slice(0, 300));
    return show(JSON.stringify(r.data.error ?? r.data), 200);
  });

await test('OLL-14', 'Nonsense address in the credential', 'Credential address "not a url", and another "ftp://localhost:11434".',
  'A clear error, no crash, the app stays up.', async () => {
    const out = [];
    for (const bad of ['not a url', 'ftp://localhost:11434']) {
      const c = await app.api('POST', '/api/credentials', { token: app.token, body: { name: `Bad ${bad}`, type: 'ollamaApi', data: { baseUrl: bad } } });
      const r = await run(app, [llm({ credential: c.data.id, prompt: 'hi' })]);
      ok(r.data.status === 'error', `"${bad}" did not error`);
      ok(!/undefined|\[object/.test(r.text), `ugly message: ${r.text.slice(0, 200)}`);
      out.push(show(JSON.stringify(r.data.error ?? r.data), 110));
    }
    ok((await fetch(`${app.base}/api/health`)).ok, 'app died');
    return out.join(' | ');
  });

await test('OLL-15', 'A credential of the wrong type is refused', 'Ollama provider + an HTTP Bearer credential.',
  'Error names both types.', async () => {
    const c = await app.api('POST', '/api/credentials', { token: app.token, body: { name: 'Bearer', type: 'httpBearer', data: { token: 'x' } } });
    const r = await run(app, [llm({ credential: c.data.id, prompt: 'hi' })]);
    ok(r.data.status === 'error' && /httpBearer/.test(r.text) && /ollamaApi/.test(r.text), r.text.slice(0, 300));
    return show(JSON.stringify(r.data.error ?? r.data), 160);
  });

await test('OLL-16', 'Regression: OpenAI provider still needs a credential', 'LLM node, provider openai, no credential.', '"No credential selected".', async () => {
  const r = await run(app, [node('l', 'ai.llm', 'LLM', { provider: 'openai', prompt: 'hi' })]);
  ok(r.data.status === 'error' && /No credential selected/.test(r.text), r.text.slice(0, 300));
  return 'still enforced';
});

await test('OLL-17', 'AI Agent uses a tool (calculator) with a real model', 'Agent, provider ollama, tools ["calculator"], "What is 17% of 2450? Use the calculator tool."',
  'steps[0].tool = calculator, output 416.5; final text mentions 416.5.', async () => {
    const r = await run(app, [node('a', 'ai.agent', 'Agent', { provider: 'ollama', model: MODEL, temperature: 0, prompt: 'What is 17% of 2450? You must use the calculator tool.', tools: '["calculator"]' })]);
    ok(r.data.status === 'success', r.text.slice(0, 400));
    const o = r.out('a')[0];
    ok(o.steps.some((s) => s.tool === 'calculator' && s.output === '416.5'), `steps: ${JSON.stringify(o.steps).slice(0, 300)}`);
    ok(/416\.5/.test(o.text), `final text: ${show(o.text)}`);
    return `tool used, answer "${show(o.text, 60)}" in ${(r.ms / 1000).toFixed(1)}s`;
  });

await test('OLL-18', 'AI Agent with no tools just answers', 'Agent, tools [], prompt "Reply with exactly: DONE".', 'Success, steps empty, text DONE.', async () => {
  const r = await run(app, [node('a', 'ai.agent', 'Agent', { provider: 'ollama', model: MODEL, temperature: 0, prompt: 'Reply with exactly: DONE', tools: '[]' })]);
  ok(r.data.status === 'success' && /DONE/i.test(r.out('a')[0].text) && r.out('a')[0].steps.length === 0, r.text.slice(0, 300));
  return 'ok';
});

await test('OLL-19', 'AI Agent can chain two tools (clock then calculator) within max steps', 'Agent with current_time + calculator, "What year is it now, plus 10? Use tools."', 'Both tools show in steps; year+10 correct; or a clear "reached max steps" text.', async () => {
  const r = await run(app, [node('a', 'ai.agent', 'Agent', { provider: 'ollama', model: MODEL, temperature: 0, maxSteps: 6, prompt: 'Use current_time to find the current year, then use the calculator to add 10 to it. Reply with just the number.', tools: '["current_time","calculator"]' })]);
  ok(r.data.status === 'success', r.text.slice(0, 300));
  const o = r.out('a')[0]; const want = String(new Date().getUTCFullYear() + 10);
  ok(o.steps.some((s) => s.tool === 'current_time'), `clock not used: ${JSON.stringify(o.steps).slice(0, 200)}`);
  ok(o.text.includes(want), `expected ${want}, got "${show(o.text)}"`);
  return `answer ${show(o.text, 30)} after ${o.steps.length} tool calls`;
});

await test('OLL-20', 'Max tool steps is respected', 'Agent maxSteps 1 asked to use two tools.', 'Stops cleanly with "(stopped: reached max steps)" or answers; never loops forever.', async () => {
  const r = await run(app, [node('a', 'ai.agent', 'Agent', { provider: 'ollama', model: MODEL, temperature: 0, maxSteps: 1, prompt: 'Use current_time, then use the calculator to add 10 to the year. Reply with the number.', tools: '["current_time","calculator"]' })]);
  ok(r.data.status === 'success', r.text.slice(0, 300));
  ok(r.out('a')[0].steps.length <= 1, `ran ${r.out('a')[0].steps.length} steps with maxSteps 1`);
  return show(r.out('a')[0].text, 80);
});

await test('OLL-21', 'Single-node "Test this step" works for Ollama', 'POST /workflows/:id/nodes/:node/test for an LLM node.', 'Returns the model output.', async () => {
  const r = await run(app, [llm({ prompt: 'Reply with exactly: STEP' })]);
  const t = await app.api('POST', `/api/workflows/${r.wfId}/nodes/l/test`, { token: app.token, body: {} });
  ok(JSON.stringify(t.data).includes('STEP'), JSON.stringify(t.data).slice(0, 300));
  return 'ok';
});

await test('OLL-22', 'Two workflows at the same time', 'Run 3 LLM workflows in parallel.', 'All succeed; the app stays responsive.', async () => {
  const rs = await Promise.all([1, 2, 3].map((n) => run(app, [llm({ prompt: `Reply with exactly: P${n}` })])));
  rs.forEach((r, i) => ok(r.data.status === 'success' && new RegExp(`P${i + 1}`).test(r.out('l')[0].text), `run ${i + 1}: ${r.text.slice(0, 200)}`));
  return `3 parallel runs ok, slowest ${(Math.max(...rs.map((r) => r.ms)) / 1000).toFixed(1)}s`;
});

await test('OLL-23', 'Memory stays small (the app is meant to be lightweight)', 'Read the app process working set after all the runs above.', 'Under ~200 MB.', async () => {
  const mb = Number(execSync(`powershell -NoProfile -Command "[math]::Round((Get-Process -Id ${app.h.proc.pid}).WorkingSet64/1MB)"`).toString().trim());
  ok(mb < 200, `${mb} MB`);
  return `${mb} MB`;
});
app.h.stop();

/* --- server settings: OLLAMA_HOST variants and BLOCK_PRIVATE_NETWORK --- */
for (const [id, host, expectOk, label] of [
  ['OLL-24', '127.0.0.1:11434', true, 'OLLAMA_HOST=127.0.0.1:11434 (no http://)'],
  ['OLL-25', 'http://localhost:11434', true, 'OLLAMA_HOST=http://localhost:11434 (full URL)'],
  ['OLL-26', '0.0.0.0:11434', true, 'OLLAMA_HOST=0.0.0.0:11434 (how Ollama itself is often set to listen)'],
  ['OLL-27', '127.0.0.1:9', false, 'OLLAMA_HOST pointing at a closed port'],
]) {
  await test(id, label, `Start the app with ${label}; LLM node with no credential.`, expectOk ? 'Works.' : 'Friendly "Could not reach Ollama" error.', async () => {
    const a = await boot(id, { OLLAMA_HOST: host });
    try {
      const r = await run(a, [llm({ prompt: 'Reply with exactly: HOST' })]);
      if (expectOk) { ok(r.data.status === 'success' && /HOST/i.test(r.out('l')[0].text), r.text.slice(0, 300)); return 'worked'; }
      ok(r.data.status === 'error' && /Could not reach Ollama/.test(r.text), r.text.slice(0, 300));
      return show(JSON.stringify(r.data.error ?? r.data), 150);
    } finally { a.h.stop(); }
  });
}

await test('OLL-28', 'BLOCK_PRIVATE_NETWORK=true: Ollama still works, everything else local stays blocked', 'Start with BLOCK_PRIVATE_NETWORK=true. (a) LLM, no credential. (b) LLM with a credential for another local address. (c) HTTP Request node to localhost:11434.',
  '(a) works, (b) blocked, (c) blocked.', async () => {
    const a = await boot('block', { BLOCK_PRIVATE_NETWORK: 'true' });
    try {
      const ra = await run(a, [llm({ prompt: 'Reply with exactly: BLK' })]);
      ok(ra.data.status === 'success' && /BLK/i.test(ra.out('l')[0].text), `(a) ${ra.text.slice(0, 300)}`);
      const c = await a.api('POST', '/api/credentials', { token: a.token, body: { name: 'Other', type: 'ollamaApi', data: { baseUrl: `http://localhost:${a.port}` } } });
      const rb = await run(a, [llm({ credential: c.data.id, prompt: 'hi' })]);
      ok(rb.data.status === 'error' && /private or loopback/.test(rb.text), `(b) should be blocked: ${rb.text.slice(0, 300)}`);
      const rc = await run(a, [node('h', 'http.request', 'HTTP', { method: 'GET', url: `${OLLAMA}/api/tags` })]);
      ok(rc.data.status === 'error' && /private or loopback/.test(rc.text), `(c) should be blocked: ${rc.text.slice(0, 300)}`);
      return '(a) worked, (b) and (c) blocked';
    } finally { a.h.stop(); }
  });

await test('OLL-29', 'Model without tool support', 'Agent with a model that has no "tools" capability.', 'Message says the model cannot use tools.', async () => {
  const caps = {};
  for (const m of installed) caps[m] = (await fetch(`${OLLAMA}/api/show`, { method: 'POST', body: JSON.stringify({ model: m }) }).then((r) => r.json())).capabilities ?? [];
  const noTools = installed.find((m) => !caps[m].includes('tools') && caps[m].includes('completion'));
  if (!noTools) throw new Skip(`every installed model supports tools (${installed.join(', ')}); try "ollama pull gemma2:2b" and re-run`);
  const a = await boot('notools');
  try {
    const r = await run(a, [node('a', 'ai.agent', 'Agent', { provider: 'ollama', model: noTools, prompt: 'What is 2+2?', tools: '["calculator"]' })]);
    ok(r.data.status === 'error' && /cannot use tools/.test(r.text), r.text.slice(0, 300));
    return show(JSON.stringify(r.data.error ?? r.data), 150);
  } finally { a.h.stop(); }
});

await test('OLL-30', 'App restarts cleanly and an Ollama workflow still runs', 'Stop and start the app on the same data folder; run an LLM workflow.', 'Works after restart; credential still decrypts.', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ollqa-restart-'));
  const env = { DATA_DIR: data, LITEFOREFLOW_SECRET: 'qa-secret', AUTH_RATE_LIMIT_PER_MIN: '1000' };
  const mk = async (port) => { const h = launch('node', FORK, { env: { ...env, PORT: String(port) } }); ok(await h.ready, h.log()); return h; };
  let h = await mk(5790); let base = h.url.replace(/\/$/, '');
  const call = async (m, u, tok, body) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body && JSON.stringify(body) }); return r.json(); };
  const tok = (await call('POST', '/api/auth/signup', null, { email: 'r@example.com', password: 'password123', name: 'R' })).token;
  const cred = await call('POST', '/api/credentials', tok, { name: 'L', type: 'ollamaApi', data: { baseUrl: OLLAMA } });
  const wf = await call('POST', '/api/workflows', tok, { name: 'r', definition: { nodes: [node('t', 'trigger.manual', 'Start'), llm({ credential: cred.id, prompt: 'Reply with exactly: BACK' })], connections: [edge('t', 'l')] } });
  h.stop(); await sleep(1500);
  h = await mk(5791); base = h.url.replace(/\/$/, '');
  const tok2 = (await call('POST', '/api/auth/login', null, { email: 'r@example.com', password: 'password123' })).token;
  const r = await call('POST', `/api/workflows/${wf.id}/run`, tok2);
  h.stop();
  ok(r.status === 'success' && /BACK/i.test(JSON.stringify(r.results)), JSON.stringify(r).slice(0, 300));
  return 'ok';
});

/* ------------------------------ report ------------------------------ */
const count = (s) => results.filter((r) => r.status === s).length;
const summary = { model: MODEL, installed, pass: count('PASS'), fail: count('FAIL'), notTestable: count('NOT TESTABLE'), seconds: Math.round((Date.now() - T0) / 1000), ollama: await fetch(`${OLLAMA}/api/version`).then((r) => r.json()).catch(() => ({})) };
fs.writeFileSync(path.join(FORK, ONLY ? 'server/test/qa/ollama-qa-rerun.json' : 'server/test/qa/ollama-qa-results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(`\n${summary.pass} pass, ${summary.fail} fail, ${summary.notTestable} not testable in ${summary.seconds}s`);
process.exit(0);
