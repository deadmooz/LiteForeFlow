// Black-box QA toolkit: boots real server processes, talks to them over HTTP only, records PASS/FAIL/BLOCKED.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const srcIndex = path.join(here, '../../src/index.js');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------ result recording ----------------------------- */
export const results = [];
let currentArea = '';
export const area = (name) => { currentArea = name; console.log(`\n== ${name}`); };
export class Blocked extends Error {}
export const blocked = (why) => { throw new Blocked(why); };

export async function t(id, title, fn) {
  const rec = { id, area: currentArea, title, status: 'PASS', note: '' };
  try {
    const note = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('TEST TIMEOUT after 150 s — the system under test hung')), 150_000))]);
    if (typeof note === 'string') rec.note = note;
  } catch (e) {
    if (e instanceof Blocked) { rec.status = 'BLOCKED'; rec.note = e.message; } else {
      rec.status = 'FAIL';
      rec.note = (e.message ?? String(e)).split('\n').slice(0, 4).join(' | ').slice(0, 400);
    }
  }
  results.push(rec);
  console.log(`  ${rec.status === 'PASS' ? '✔' : rec.status === 'FAIL' ? '✖' : '○'} ${id} ${title}${rec.note ? `  — ${rec.note}` : ''}`);
}

export function summary() {
  const c = (s) => results.filter((r) => r.status === s).length;
  return { total: results.length, pass: c('PASS'), fail: c('FAIL'), blocked: c('BLOCKED') };
}

/* ---------------------------------- servers ---------------------------------- */
let nextPort = 3300;
export async function boot(name, env = {}, { dataDir } = {}) {
  const port = nextPort++;
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), `qa-${name}-`));
  const flags = ['--max-semi-space-size=2', '--max-old-space-size=192'];
  const proc = spawn(process.execPath, [...flags, srcIndex], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, LITEFOREFLOW_SECRET: 'qa-secret', AUTH_RATE_LIMIT_PER_MIN: '100000', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 150; i += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
    if (proc.exitCode !== null) throw new Error(`server ${name} exited early:\n${log}`);
    await sleep(100);
  }
  return {
    name, base, port, dir, proc, log: () => log,
    stop: async (signal = 'SIGKILL') => { proc.kill(signal); await sleep(300); },
  };
}

/* ----------------------------------- client ---------------------------------- */
export function client(base) {
  const c = {
    base, token: null,
    async call(method, url, body, { headers = {}, token = c.token, raw = false } = {}) {
      const res = await fetch(base + url, {
        method,
        headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
      });
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, data, headers: res.headers, text };
    },
    get: (u, o) => c.call('GET', u, undefined, o),
    post: (u, b, o) => c.call('POST', u, b, o),
    put: (u, b, o) => c.call('PUT', u, b, o),
    del: (u, o) => c.call('DELETE', u, undefined, o),
    async signup(email = `qa-${Math.random().toString(36).slice(2, 10)}@example.com`, password = 'password123', name = 'QA') {
      const r = await c.post('/api/auth/signup', { email, password, name }, { token: null });
      if (r.status !== 201) throw new Error(`signup failed ${r.status} ${JSON.stringify(r.data)}`);
      return { token: r.data.token, email, password, workspaceId: r.data.workspaces[0].id, user: r.data.user };
    },
    /** A fresh isolated user wrapped as its own client. */
    async user() {
      const s = await c.signup();
      const u = client(base);
      u.token = s.token;
      u.info = s;
      return u;
    },
  };
  return c;
}

/* --------------------------------- workflow DSL ------------------------------ */
export const N = (id, type, name, parameters = {}, extra = {}) => ({ id, type, name, parameters, position: { x: 0, y: 0 }, ...extra });
export const E = (from, to, fromOutput = 0, toInput = 0) => ({ from, to, fromOutput, toInput });
export const chain = (...ids) => ids.slice(1).map((id, i) => E(ids[i], id));
export const manual = (id = 't') => N(id, 'trigger.manual', 'Start');
export const set = (id, fields, extra = {}, keepOthers = true) => N(id, 'data.set', id, { fields: Object.entries(fields).map(([name, value]) => ({ name, value })), keepOthers }, extra);
export const code = (id, src, mode = 'runOnce', extra = {}) => N(id, 'data.code', id, { mode, code: src }, extra);

export async function mkWf(u, name, nodes, connections, settings) {
  const r = await u.post('/api/workflows', { name, definition: { nodes, connections }, settings });
  if (r.status !== 201) throw new Error(`create workflow failed ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}
/** Create + run in the editor. Returns the run body (status, error, results...). */
export async function runWf(u, nodes, connections, { payload, settings, name = 'qa' } = {}) {
  const wf = await mkWf(u, name, nodes, connections, settings);
  const r = await u.post(`/api/workflows/${wf.id}/run`, payload === undefined ? {} : { payload });
  return { wf, status: r.status, ...(typeof r.data === 'object' ? r.data : { raw: r.data }), http: r.status };
};
export const outJson = (run, nodeId, o = 0) => run.results?.[nodeId]?.output?.[o]?.map((i) => i.json);
export const webhook = (id, p, extra = {}) => N(id, 'trigger.webhook', 'Hook', { path: p, method: 'POST', respond: 'immediately', ...extra });
export const uniq = () => Math.random().toString(36).slice(2, 9);

/* ------------------------------ mock third party ------------------------------ */
export async function startMock() {
  const seen = [];
  let flaky = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, 'http://x');
      let body = raw;
      try { body = JSON.parse(raw); } catch { /* keep text */ }
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const json = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
      const p = url.pathname;
      if (p === '/json') return json(200, { name: 'Ada', n: 1 });
      if (p === '/array') return json(200, [{ id: 1 }, { id: 2 }, { id: 3 }]);
      if (p === '/text') { res.setHeader('content-type', 'text/plain'); return res.end('plain text'); }
      if (p === '/echo') return json(200, { method: req.method, query: Object.fromEntries(url.searchParams), headers: req.headers, body, contentType: req.headers['content-type'] });
      if (p.startsWith('/status/')) return json(Number(p.split('/')[2]), { error: `status ${p.split('/')[2]}` });
      if (p === '/slow') { await sleep(Number(url.searchParams.get('ms') ?? 3000)); return json(200, { slow: true }); }
      if (p === '/redirect') { res.statusCode = 302; res.setHeader('location', '/json'); return res.end(); }
      if (p === '/flaky') { flaky += 1; return flaky % 3 === 0 ? json(200, { ok: true, attempt: flaky }) : json(503, { error: 'try later' }); }
      if (p === '/feed.xml') {
        res.setHeader('content-type', 'application/rss+xml');
        return res.end('<rss><channel><item><title>One &amp; Two</title><link>http://x/1</link><guid>g1</guid></item><item><title><![CDATA[Three]]></title><link>http://x/3</link><guid>g3</guid></item></channel></rss>');
      }
      // --- OpenAI-compatible
      if (p === '/v1/chat/completions') {
        if (req.headers.authorization === 'Bearer bad-key') return json(401, { error: { message: 'Incorrect API key provided' } });
        const msgs = body.messages ?? [];
        const prompt = msgs.find((m) => m.role === 'user')?.content ?? '';
        const toolResults = msgs.filter((m) => m.role === 'tool').length;
        const call = (name, args) => json(200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `c${toolResults}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
        if (body.tools && prompt.includes('loop')) return call('current_time', {});
        if (body.tools && prompt.includes('badtool')) return toolResults ? json(200, { choices: [{ message: { role: 'assistant', content: 'recovered' } }] }) : call('rm_rf', { path: '/' });
        if (body.tools && prompt.includes('evil')) return toolResults ? json(200, { choices: [{ message: { role: 'assistant', content: `tool said: ${msgs.at(-1).content}` } }] }) : call('calculator', { expression: 'process.exit(1)' });
        if (body.tools && prompt.includes('calc') && !toolResults) return call('calculator', { expression: '6*7' });
        if (body.tools && prompt.includes('fetch') && !toolResults) return call('http_get', { url: `http://localhost:${server.address().port}/json` });
        const text = prompt.includes('notjson') ? 'hello there' : prompt.includes('json') ? '```json\n{"a":1}\n```' : `echo: ${prompt}`;
        return json(200, { model: 'mock-gpt', usage: { total_tokens: 3 }, choices: [{ message: { role: 'assistant', content: toolResults ? `final: ${msgs.at(-1).content}` : text } }] });
      }
      // --- Anthropic
      if (p === '/v1/messages') {
        if (req.headers['x-api-key'] === 'bad-key') return json(401, { type: 'error', error: { message: 'invalid x-api-key' } });
        const msgs = body.messages ?? [];
        const prompt = typeof msgs[0].content === 'string' ? msgs[0].content : '';
        const hasResult = msgs.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
        if (body.tools && prompt.includes('calc') && !hasResult) {
          return json(200, { model: 'mock-claude', stop_reason: 'tool_use', content: [{ type: 'text', text: 'let me compute' }, { type: 'tool_use', id: 'tu1', name: 'calculator', input: { expression: '2+2' } }] });
        }
        const last = msgs.at(-1);
        const txt = hasResult ? `got ${last.content[0].content}` : `claude says ${prompt}`;
        return json(200, { model: 'mock-claude', usage: { input_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: txt }] });
      }
      return json(404, { error: 'mock: not found' });
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  return { port, base: `http://localhost:${port}`, seen, close: () => server.close() };
}

/** Minimal SMTP server that records messages (no TLS, no auth) for testing the email node. */
export async function startSmtp() {
  const messages = [];
  const server = net.createServer((sock) => {
    let data = false;
    let buf = '';
    let mail = { from: '', to: [], body: '' };
    sock.write('220 qa-smtp ready\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (data) {
        if (buf.includes('\r\n.\r\n')) {
          mail.body = buf.split('\r\n.\r\n')[0];
          messages.push(mail);
          mail = { from: '', to: [], body: '' };
          data = false;
          buf = '';
          sock.write('250 queued\r\n');
        }
        return;
      }
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        const up = line.toUpperCase();
        if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250 qa-smtp\r\n');
        else if (up.startsWith('MAIL FROM')) { mail.from = line; sock.write('250 ok\r\n'); } else if (up.startsWith('RCPT TO')) { mail.to.push(line); sock.write('250 ok\r\n'); } else if (up === 'DATA') { data = true; sock.write('354 go\r\n'); } else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, r));
  return { port: server.address().port, messages, close: () => server.close() };
}

/** Measures how long the event loop of a server stays unresponsive while `during` runs. */
export async function maxLatencyDuring(base, during) {
  let max = 0;
  let stop = false;
  const pinger = (async () => {
    while (!stop) {
      const t0 = Date.now();
      try { await fetch(`${base}/api/health`); } catch { /* ignore */ }
      max = Math.max(max, Date.now() - t0);
      await sleep(50);
    }
  })();
  const out = await during();
  stop = true;
  await pinger;
  return { max, out };
}
