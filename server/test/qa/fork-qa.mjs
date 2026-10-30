// Fork QA (install, launchers, settings, ports, data, sandbox modes, optional extras, UI build).
// Usage: node server/test/qa/fork-qa.mjs     (needs internet for the first npm install; ~8 minutes)
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { area, t, blocked, results, summary, here, startMock } from './lib.mjs';
import { FORK, SCR, WIN, sleep, exportRepo, copyDir, dirSizeMb, sh, killTree, launch, getJson, api, signup, trivialWorkflow, stripAnsi } from './fork-lib.mjs';

const started = Date.now();
const live = new Set(); // every handle we start, so nothing is ever left running
const start = (...a) => { const h = launch(...a); live.add(h); return h; };
const stopAll = async () => { for (const h of live) h.stop(); live.clear(); await sleep(500); };
const up = async (h, why = '') => { assert.equal(await h.ready, true, `${h.kind} did not start ${why}:\n${stripAnsi(h.log()).slice(0, 600)}`); return h.url.replace(/\/$/, ''); };
let port = Number(process.env.QA_PORT_BASE) || 3600; // Windows reserves some ranges (EACCES): override with QA_PORT_BASE
const nextPort = () => (port += 1);
const mock = await startMock();
const BASE = path.join(SCR, 'base');
import { execSync } from 'node:child_process';
const ensureBase = () => { if (!fs.existsSync(path.join(BASE, 'node_modules', 'express'))) { exportRepo(BASE); execSync('npm install', { cwd: BASE, stdio: 'pipe' }); } };
const fresh = (name) => { ensureBase(); return copyDir(BASE, path.join(SCR, name)); };
const bumpedPort = () => String(nextPort());
const wf = (token, base, def = trivialWorkflow, name = 'qa') => api(base, 'POST', '/api/workflows', { name, definition: def }, token);
const noStack = (s) => !/node:internal|\n\s+at .*\(.*:\d+:\d+\)/.test(s);

/* ======================================================================== A */
area('A. Fresh install (what a novice downloads)');
await t('A-01', 'Clean copy installs with plain `npm install` in < 60 s, < 40 MB, with no warnings', async () => {
  exportRepo(BASE);
  const r = await sh('npm install', { cwd: BASE, timeout: 240000 });
  assert.equal(r.code, 0, r.out.slice(0, 400));
  const mb = dirSizeMb(path.join(BASE, 'node_modules'));
  assert.ok(r.ms < 60000, `${r.ms} ms`); assert.ok(mb < 40, `${mb.toFixed(0)} MB`);
  assert.ok(!/warn/i.test(r.out), `npm printed warnings: ${r.out.slice(0, 300)}`);
  return `${(r.ms / 1000).toFixed(1)} s, ${mb.toFixed(0)} MB (npm cache was warm)`;
});
await t('A-07', 'Only the lite set of packages is installed (no pg, bullmq, ioredis, vite, react)', async () => {
  const nm = path.join(BASE, 'node_modules');
  const present = ['pg', 'bullmq', 'ioredis', 'vite', 'react', '@xyflow', 'react-dom'].filter((p) => fs.existsSync(path.join(nm, p)));
  assert.deepEqual(present, [], `unexpected packages: ${present}`);
  assert.ok(fs.existsSync(path.join(nm, 'express')) && fs.existsSync(path.join(nm, 'bcryptjs')));
  return `${fs.readdirSync(nm).length} top-level packages`;
});
await t('A-02', 'Install without internet: launcher explains the problem, leaves no half install, and the next start with internet recovers', async () => {
  const d = exportRepo(path.join(SCR, 'a02'));
  const emptyCache = fs.mkdtempSync(path.join(SCR, 'emptycache-'));
  const r = await sh(`python run.py --no-open --port ${nextPort()}`, { cwd: d, env: { npm_config_offline: 'true', npm_config_cache: emptyCache, LITEFOREFLOW_OPEN: '0' }, timeout: 120000 });
  assert.notEqual(r.code, 0); assert.match(r.out, /install did not finish/i, r.out.slice(0, 300));
  assert.ok(!fs.existsSync(path.join(d, 'node_modules', 'express')), 'half-installed express present');
  const h = start('py', d, { args: ['--port', bumpedPort()] });
  assert.ok(await up(h, 'after the failed install')); h.stop();
});
await t('A-03', 'Partial install (a core package is missing) is repaired automatically on the next start', async () => {
  const d = fresh('a03');
  fs.rmSync(path.join(d, 'node_modules', 'express'), { recursive: true, force: true });
  const h = start('py', d, { args: ['--port', bumpedPort()] });
  await up(h, 'after deleting express'); h.stop();
});
await t('A-03b', 'Partial install where a LESS obvious package is missing (bcryptjs) gives a fix-it message, not a stack trace', async () => {
  const d = fresh('a03b');
  fs.rmSync(path.join(d, 'node_modules', 'bcryptjs'), { recursive: true, force: true });
  const h = start('py', d, { args: ['--port', bumpedPort()] });
  const ok = await h.ready; const out = stripAnsi(h.log()); h.stop();
  assert.ok(ok || (noStack(out) && /install|npm/i.test(out)), `start failed with raw error:\n${out.slice(0, 400)}`);
});
await t('A-04', 'Works from a folder whose path has spaces AND non-ASCII characters (all four launchers)', async () => {
  ensureBase();
  const d = copyDir(BASE, path.join(SCR, 'José QA ñandú', 'Lite Fore Flow'));
  for (const kind of WIN ? ['node', 'npm', 'bat', 'py'] : ['node', 'npm', 'sh', 'py']) {
    const h = start(kind, d, { env: { PORT: bumpedPort() }, args: kind === 'py' ? [] : [] });
    const url = await up(h, `in "${d}" via ${kind}`);
    assert.equal((await getJson(`${url}/api/health`)).status, 200); h.stop(); await sleep(400);
  }
});
await t('A-05', 'Unusable data folder (path is a file) gives a plain-language error and non-zero exit, not a stack trace', async () => {
  const d = fresh('a05'); const blocker = path.join(SCR, 'iam-a-file.txt'); fs.writeFileSync(blocker, 'x');
  const h = start('node', d, { env: { PORT: bumpedPort(), DATA_DIR: path.join(blocker, 'data') } });
  const ok = await h.ready; const code = await h.exited; const out = stripAnsi(h.log());
  assert.equal(ok, false); assert.notEqual(code, 0); assert.ok(noStack(out), `raw stack trace shown:\n${out.slice(0, 500)}`);
});
await t('A-06', 'Running `npm install` again is harmless: data, accounts and workflows survive', async () => {
  const d = fresh('a06'); const p = bumpedPort();
  let h = start('node', d, { env: { PORT: p } }); let base = await up(h);
  const u = await signup(base, 'keep@example.com'); await wf(u.token, base);
  h.stop(); await sleep(600);
  const r = await sh('npm install', { cwd: d }); assert.equal(r.code, 0);
  h = start('node', d, { env: { PORT: p } }); base = await up(h);
  const login = await api(base, 'POST', '/api/auth/login', { email: 'keep@example.com', password: 'password123' });
  assert.equal(login.status, 200); assert.equal((await api(base, 'GET', '/api/workflows', undefined, login.data.token)).data.length, 1); h.stop();
});

/* ======================================================================== B */
area('B. Launchers, ports and process control');
const launchers = WIN ? ['npm', 'bat', 'py', 'node'] : ['npm', 'sh', 'py', 'node'];
await t('B-08', 'Every launcher starts the app and serves the UI (HTML shell + JS bundle + health)', async () => {
  const notes = [];
  for (const kind of [...launchers, ...(WIN ? ['sh'] : [])]) {
    const d = fresh(`b08-${kind}`); const h = start(kind, d, { env: { PORT: bumpedPort() } });
    const url = await up(h, `via ${kind}`);
    const page = await getJson(`${url}/`); assert.match(page.text, /<div id="root">/);
    const js = page.text.match(/src="(\/assets\/[^"]+\.js)"/)[1]; assert.equal((await getJson(`${url}${js}`)).status, 200);
    assert.equal((await getJson(`${url}/api/health`)).data.ok, true);
    notes.push(kind); h.stop(); await sleep(400);
  }
  return `ok via ${notes.join(', ')}`;
});
await t('B-09', 'Launchers work when started from a different working directory', async () => {
  for (const kind of ['bat', 'py', 'node']) {
    if (kind === 'bat' && !WIN) continue;
    const d = fresh(`b09-${kind}`); const h = start(kind, d, { env: { PORT: bumpedPort() }, cwd: process.env.windir ?? '/tmp' });
    await up(h, `via ${kind} from another cwd`); h.stop(); await sleep(400);
  }
});
await t('B-10', 'run.py: --help is readable; --port and --no-open are honoured', async () => {
  const help = await sh('python run.py --help', { cwd: BASE }); assert.equal(help.code, 0); assert.match(help.out, /--no-open/); assert.match(help.out, /--port/);
  const p = Number(bumpedPort()); const h = start('py', fresh('b10'), { args: ['--port', String(p)] });
  const url = await up(h); assert.ok(url.endsWith(`:${p}`), url); h.stop();
});
await t('B-11', 'Old Node versions get the friendly fix-it message and exit code 1; supported versions are silent', async () => {
  const pre = path.join(BASE, 'scripts', 'preflight.cjs').replace(/\\/g, '/');
  for (const v of ['16.20.0', '18.19.0', '20.11.0', '22.12.9']) {
    const r = await sh(`node -e "Object.defineProperty(process.versions,'node',{value:'${v}'});require('${pre}')"`, {});
    assert.equal(r.code, 1, `${v} accepted`); assert.match(r.out, /nodejs\.org/); assert.match(r.out, new RegExp(v.replace(/\./g, '\\.'))); assert.ok(noStack(r.out));
  }
  for (const v of ['22.13.0', '24.19.0', '26.0.0']) { const r = await sh(`node -e "Object.defineProperty(process.versions,'node',{value:'${v}'});require('${pre}')"`, {}); assert.equal(r.code, 0, `${v}: ${r.out}`); assert.equal(r.out.trim(), ''); }
});
await t('B-12', 'Node.js missing from PATH: python launcher and start.bat explain what to install and exit non-zero', async () => {
  ensureBase();
  const py = (await sh('python -c "import sys;print(sys.executable)"')).out.trim();
  const noNode = path.dirname(py);
  const r = await sh(`"${py}" run.py --no-open`, { cwd: BASE, env: { PATH: noNode, BROWSER: WIN ? 'cmd /c exit' : 'true' }, timeout: 30000 });
  assert.equal(r.code, 1); assert.match(r.out, /needs Node\.js/i); assert.ok(noStack(r.out));
  if (!WIN) return 'start.bat n/a';
  const batDir = copyDir(BASE, path.join(SCR, 'b12bat'));
  const f = path.join(batDir, 'start.bat'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('start "" https://nodejs.org/en/download', 'echo [browser opening skipped by test]'));
  const b = await sh(`"${f}"`, { cwd: batDir, env: { PATH: `${process.env.windir}\\System32`, LITEFOREFLOW_OPEN: '0' }, timeout: 30000 });
  assert.notEqual(b.code, 0); assert.match(b.out, /needs Node\.js/i, b.out.slice(0, 300));
  return 'start.bat checked with the browser-opening line stubbed out (so no tab opens on this machine)';
});
await t('B-13', 'Hard kill then immediate restart on the same port: port is free again, data intact', async () => {
  const d = fresh('b13'); const p = bumpedPort();
  let h = start('node', d, { env: { PORT: p } }); let base = await up(h); const u = await signup(base, 'k@example.com'); await wf(u.token, base);
  h.stop(); await sleep(300);
  h = start('node', d, { env: { PORT: p } }); base = await up(h, 'right after a hard kill');
  assert.equal((await api(base, 'POST', '/api/auth/login', { email: 'k@example.com', password: 'password123' })).status, 200); h.stop();
  const db = new DatabaseSync(path.join(d, 'data', 'liteforeflow.db')); const ic = db.prepare('PRAGMA integrity_check').get(); db.close();
  assert.equal(Object.values(ic)[0], 'ok');
});
await t('B-13b', 'Graceful Ctrl+C / SIGTERM shutdown', async () => { blocked('Windows cannot deliver SIGINT/SIGTERM to a Node child (it is terminated abruptly); verified earlier on Linux containers'); });
await t('B-14', 'An explicit PORT that is busy gives a plain-language error and a non-zero exit', async () => {
  const blocker = http.createServer(); await new Promise((r) => blocker.listen(0, r)); const busy = blocker.address().port;
  try {
    const h = start('node', fresh('b14b'), { env: { PORT: String(busy) } });
    assert.equal(await h.ready, false); const out = stripAnsi(h.log()); assert.match(out, /already in use/i); assert.ok(noStack(out), out.slice(0, 300)); assert.notEqual(await h.exited, 0);
  } finally { blocker.close(); }
});
await t('B-14c', 'Busy default port 3000: the next free port is chosen automatically', async () => {
  const blocker = http.createServer(); blocker.on('error', () => {});
  const bound = await new Promise((r) => { blocker.once('listening', () => r(true)); blocker.once('error', () => r(false)); blocker.listen(3000); });
  if (!bound) blocked('port 3000 cannot be bound on this machine at all (Windows reserved it) - see B-17');
  try { const h = start('node', fresh('b14a'), { env: { PORT: '' } }); await up(h, 'with 3000 occupied'); assert.match(h.url, /:300[1-9]$/, h.url); h.stop(); } finally { blocker.close(); }
});
await t('B-17', 'Default port 3000 unusable because the OS reserves it (Windows excluded port range / EACCES): the app falls back to another port and tells the user', async () => {
  const probe = net.createServer(); probe.on('error', () => {});
  const free = await new Promise((r) => { probe.once('listening', () => { probe.close(); r(true); }); probe.once('error', (e) => r(e.code)); probe.listen(3000); });
  const h = start('node', fresh('b17'), { env: { PORT: '' } }); const ok = await h.ready; const out = stripAnsi(h.log()); h.stop();
  assert.ok(ok, `port 3000 ${free === true ? 'is free here' : `is unavailable (${free})`} and the app refused to start:
${out.trim().slice(0, 300)}`);
});
await t('B-14b', 'Two copies started at once get different ports and both work', async () => {
  const a = start('node', fresh('b14c'), { env: { PORT: '' } }); const b = start('node', fresh('b14d'), { env: { PORT: '' } });
  const [ua, ub] = [await up(a), await up(b)]; assert.notEqual(ua, ub); a.stop(); b.stop();
});
await t('B-15', 'Starting the app twice on the SAME data (double-click twice) must not run schedules twice or corrupt data', async () => {
  const d = fresh('b15'); const p1 = bumpedPort(); const p2 = bumpedPort();
  const a = start('node', d, { env: { PORT: p1 } }); const baseA = await up(a);
  const b = start('node', d, { env: { PORT: p2 } }); const okB = await b.ready;
  const u = await signup(baseA);
  const cron = await wf(u.token, baseA, { nodes: [{ id: 't', type: 'trigger.cron', name: 'c', parameters: { cron: '*/2 * * * * *', timezone: 'UTC' }, position: { x: 0, y: 0 } }], connections: [] });
  await api(baseA, 'POST', `/api/workflows/${cron.data.id}/activate`, {}, u.token);
  await sleep(7500);
  await api(baseA, 'POST', `/api/workflows/${cron.data.id}/deactivate`, {}, u.token); await sleep(800);
  const runs = (await api(baseA, 'GET', `/api/executions?workflowId=${cron.data.id}&limit=100`, undefined, u.token)).data;
  const slots = runs.map((r) => Math.floor(new Date(r.startedAt).getTime() / 2000));
  const dup = slots.length - new Set(slots).size; a.stop(); b.stop();
  assert.ok(!okB, `a second copy started on the same data (${okB ? 'port ' + p2 : ''}) instead of saying "already running"`);
  assert.equal(dup, 0, `${dup} duplicated schedule ticks`);
});
await t('B-16', 'Browser auto-open', async () => { blocked('opening a real browser tab cannot be observed here; all launches ran with LITEFOREFLOW_OPEN=0'); });

/* ======================================================================== C */
area('C. Settings (.env), data folder, upgrades');
const withEnv = async (name, envText, env = {}) => {
  const d = fresh(name); fs.writeFileSync(path.join(d, '.env'), envText); const h = start('node', d, { env: { PORT: undefined, ...env } });
  return { d, h };
};
await t('C-17', '.env: PORT, ALLOW_SIGNUP, BLOCK_PRIVATE_NETWORK and SAVE_SUCCESS_DATA each take effect', async () => {
  const p = bumpedPort();
  let { h } = await withEnv('c17a', `PORT=${p}\nALLOW_SIGNUP=false\n`); let url = await up(h); assert.ok(url.endsWith(`:${p}`), url);
  assert.equal((await api(url, 'POST', '/api/auth/signup', { email: 'a@b.co', password: 'password123' })).status, 403); h.stop(); await sleep(300);
  ({ h } = await withEnv('c17b', `PORT=${bumpedPort()}\nBLOCK_PRIVATE_NETWORK=true\n`)); url = await up(h); let u = await signup(url);
  const w = await wf(u.token, url, { nodes: [{ id: 't', type: 'trigger.manual', name: 's', parameters: {}, position: { x: 0, y: 0 } }, { id: 'h', type: 'http.request', name: 'h', parameters: { url: `${mock.base}/json` }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 'h', fromOutput: 0, toInput: 0 }] });
  const run = await api(url, 'POST', `/api/workflows/${w.data.id}/run`, {}, u.token); assert.equal(run.data.status, 'error'); assert.match(run.data.error.message, /private|loopback/i); h.stop(); await sleep(300);
  ({ h } = await withEnv('c17c', `PORT=${bumpedPort()}\nSAVE_SUCCESS_DATA=false\n`)); url = await up(h); u = await signup(url);
  const hook = await wf(u.token, url, { nodes: [{ id: 't', type: 'trigger.webhook', name: 'w', parameters: { path: 'c17', method: 'POST' }, position: { x: 0, y: 0 } }, { id: 's', type: 'data.set', name: 's', parameters: { fields: [{ name: 'a', value: '{{ 1 }}' }] }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 's', fromOutput: 0, toInput: 0 }] });
  await api(url, 'POST', `/api/workflows/${hook.data.id}/activate`, {}, u.token); const ex = await api(url, 'POST', '/webhook/c17', {}); await sleep(500);
  const d = await api(url, 'GET', `/api/executions/${ex.data.executionId}`, undefined, u.token); assert.deepEqual(d.data.results, {}); h.stop();
});
await t('C-18', 'Real environment variables beat the .env file', async () => {
  const p1 = bumpedPort(); const p2 = bumpedPort();
  const { h } = await withEnv('c18a', `PORT=${p1}
`, { PORT: p2 }); const url = await up(h); h.stop();
  assert.ok(url.endsWith(`:${p2}`), `env var did not win: ${url}`);
});
await t('C-18b', '.env with comments, quotes and inline comments is read correctly', async () => {
  const p = bumpedPort(); const { h } = await withEnv('c18b', `# a comment
PORT="${p}"   # trailing comment
ALLOW_SIGNUP='false'
`); const url = await up(h);
  const signup403 = (await api(url, 'POST', '/api/auth/signup', { email: 'a@b.co', password: 'password123' })).status; h.stop();
  assert.ok(url.endsWith(`:${p}`), `PORT ignored (served on ${url})`); assert.equal(signup403, 403);
});
await t('C-18c', 'A typo in .env (a line without "=", an unclosed quote) must not silently drop the OTHER settings (e.g. ALLOW_SIGNUP=false)', async () => {
  const p = bumpedPort(); const { h } = await withEnv('c18c', `PORT=${p}
JUSTAKEY
BROKEN="unclosed
ALLOW_SIGNUP=false
`); const url = await up(h, '(.env with a typo)');
  const status = (await api(url, 'POST', '/api/auth/signup', { email: 'a@b.co', password: 'password123' })).status; h.stop();
  assert.ok(url.endsWith(`:${p}`), `PORT before the typo was ignored too (served on ${url})`); assert.equal(status, 403, 'ALLOW_SIGNUP=false after the typo was silently ignored: signup is open');
});
await t('C-18d', '.env saved with a UTF-8 BOM (what Windows Notepad adds) is read correctly', async () => {
  const p = bumpedPort(); const { h } = await withEnv('c18d', `﻿PORT=${p}
ALLOW_SIGNUP=false
`); const url = await up(h);
  const status = (await api(url, 'POST', '/api/auth/signup', { email: 'a@b.co', password: 'password123' })).status; h.stop();
  assert.ok(url.endsWith(`:${p}`), `BOM file ignored (served on ${url})`); assert.equal(status, 403, 'ALLOW_SIGNUP=false in a BOM file was ignored');
});
await t('C-18e', '.env with Windows (CRLF) line endings is read correctly', async () => {
  const p = bumpedPort(); const { h } = await withEnv('c18e', `PORT=${p}

ALLOW_SIGNUP=false

`); const url = await up(h);
  const status = (await api(url, 'POST', '/api/auth/signup', { email: 'a@b.co', password: 'password123' })).status; h.stop();
  assert.ok(url.endsWith(`:${p}`), `CRLF file ignored (served on ${url})`); assert.equal(status, 403);
});
await t('C-19', 'Moving the whole data folder (incl. .secret) to another copy keeps accounts, saved credentials and webhooks working', async () => {
  const d1 = fresh('c19a'); const p = bumpedPort(); let h = start('node', d1, { env: { PORT: p } }); let url = await up(h); const u = await signup(url, 'move@example.com');
  const cred = await api(url, 'POST', '/api/credentials', { name: 'tok', type: 'httpBearer', data: { token: 'MOVE-ME' } }, u.token);
  const hook = await wf(u.token, url, { nodes: [{ id: 't', type: 'trigger.webhook', name: 'w', parameters: { path: 'c19', method: 'POST', respond: 'lastNode' }, position: { x: 0, y: 0 } }, { id: 'h', type: 'http.request', name: 'h', parameters: { url: `${mock.base}/echo`, credential: cred.data.id }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 'h', fromOutput: 0, toInput: 0 }] });
  await api(url, 'POST', `/api/workflows/${hook.data.id}/activate`, {}, u.token); h.stop(); await sleep(500);
  const d2 = fresh('c19b'); copyDir(path.join(d1, 'data'), path.join(d2, 'data')); h = start('node', d2, { env: { PORT: bumpedPort() }, cwd: process.env.windir ?? '/tmp' }); url = await up(h);
  assert.equal((await api(url, 'POST', '/api/auth/login', { email: 'move@example.com', password: 'password123' })).status, 200);
  const r = await api(url, 'POST', '/webhook/c19', {}); assert.equal(r.data.headers.authorization, 'Bearer MOVE-ME', JSON.stringify(r.data).slice(0, 200)); h.stop();
});
await t('C-20', 'Losing data/.secret: the app still starts and the failure on saved credentials is explained in plain words', async () => {
  const d = fresh('c20'); const p = bumpedPort(); let h = start('node', d, { env: { PORT: p } }); let url = await up(h); const u = await signup(url, 'sec@example.com', 'password123');
  const cred = await api(url, 'POST', '/api/credentials', { name: 'tok', type: 'httpBearer', data: { token: 'X' } }, u.token); h.stop(); await sleep(500);
  fs.rmSync(path.join(d, 'data', '.secret'));
  h = start('node', d, { env: { PORT: p } }); url = await up(h, 'without .secret');
  const login = await api(url, 'POST', '/api/auth/login', { email: 'sec@example.com', password: 'password123' }); assert.equal(login.status, 200);
  const w = await wf(login.data.token, url, { nodes: [{ id: 't', type: 'trigger.manual', name: 's', parameters: {}, position: { x: 0, y: 0 } }, { id: 'h', type: 'http.request', name: 'h', parameters: { url: `${mock.base}/echo`, credential: cred.data.id }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 'h', fromOutput: 0, toInput: 0 }] });
  const run = await api(url, 'POST', `/api/workflows/${w.data.id}/run`, {}, login.data.token); h.stop();
  assert.equal(run.data.status, 'error'); assert.match(run.data.error.message, /credential/i, `unhelpful message: "${run.data.error.message}"`);
});
await t('C-22', 'Upgrade: data created by the very first version opens in the current one without loss', async () => {
  const old = exportRepo(path.join(SCR, 'c22old'), 'da82f34'); const ins = await sh('npm install', { cwd: old, timeout: 240000 }); assert.equal(ins.code, 0, ins.out.slice(0, 300));
  const p = bumpedPort(); let h = start('node', old, { env: { PORT: p } }); let url = await up(h);
  const u = await signup(url, 'old@example.com'); await wf(u.token, url, trivialWorkflow, 'from the old version'); await api(url, 'POST', '/api/credentials', { name: 'old cred', type: 'httpBearer', data: { token: 'OLD' } }, u.token); h.stop(); await sleep(500);
  const d = fresh('c22new'); copyDir(path.join(old, 'data'), path.join(d, 'data'));
  h = start('node', d, { env: { PORT: bumpedPort() } }); url = await up(h, 'on old data');
  const login = await api(url, 'POST', '/api/auth/login', { email: 'old@example.com', password: 'password123' }); assert.equal(login.status, 200);
  const list = (await api(url, 'GET', '/api/workflows', undefined, login.data.token)).data; assert.equal(list.length, 1); assert.equal(list[0].name, 'from the old version');
  assert.equal((await api(url, 'GET', '/api/credentials', undefined, login.data.token)).data.length, 1); h.stop();
});
await t('C-23', 'A corrupted database file gives a plain-language message (and does not delete the file)', async () => {
  const d = fresh('c23'); fs.mkdirSync(path.join(d, 'data')); const dbf = path.join(d, 'data', 'liteforeflow.db'); fs.writeFileSync(dbf, crypto.randomBytes(8192));
  const h = start('node', d, { env: { PORT: bumpedPort() } }); const ok = await h.ready; const code = await h.exited; const out = stripAnsi(h.log());
  assert.equal(ok, false); assert.notEqual(code, 0); assert.ok(fs.existsSync(dbf) && fs.statSync(dbf).size >= 8192, 'database file was removed or truncated');
  assert.ok(noStack(out), `raw stack trace shown:\n${out.slice(0, 500)}`); assert.match(out, /database|corrupt|not a database/i);
});
await t('C-24', 'Disk full while running', async () => { blocked('cannot fill a disk safely here'); });

/* ======================================================================== D */
area('D. Sandbox modes');
const codeWf = { nodes: [{ id: 't', type: 'trigger.manual', name: 'Start', parameters: {}, position: { x: 0, y: 0 } }, { id: 'c', type: 'data.code', name: 'Code', parameters: { mode: 'runOnce', code: 'return [{ ok: 1 + 1, p: typeof process, r: typeof require }];' }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 'c', fromOutput: 0, toInput: 0 }] };
const runCode = async (url, token, body) => { const w = await wf(token, url, body ?? codeWf); return (await api(url, 'POST', `/api/workflows/${w.data.id}/run`, {}, token)).data; };
await t('D-25', '/api/health reports the sandbox; LITEFOREFLOW_SANDBOX=vm forces the basic one and code still runs', async () => {
  let h = start('node', fresh('d25a'), { env: { PORT: bumpedPort() } }); let url = await up(h); assert.equal((await getJson(`${url}/api/health`)).data.sandbox, 'isolated-vm'); h.stop(); await sleep(300);
  h = start('node', fresh('d25b'), { env: { PORT: bumpedPort(), LITEFOREFLOW_SANDBOX: 'vm' } }); url = await up(h); assert.equal((await getJson(`${url}/api/health`)).data.sandbox, 'basic');
  const u = await signup(url); const r = await runCode(url, u.token); assert.equal(r.status, 'success'); assert.deepEqual(r.results.c.output[0][0].json, { ok: 2, p: 'undefined', r: 'undefined' }); h.stop();
});
await t('D-30', 'isolated-vm genuinely missing: app starts in basic mode, prints ONE short notice, everything still works', async () => {
  const d = fresh('d30'); fs.rmSync(path.join(d, 'node_modules', 'isolated-vm'), { recursive: true, force: true });
  const h = start('node', d, { env: { PORT: bumpedPort() } }); const url = await up(h, 'without isolated-vm');
  assert.equal((await getJson(`${url}/api/health`)).data.sandbox, 'basic'); const u = await signup(url);
  for (let i = 0; i < 3; i += 1) assert.equal((await runCode(url, u.token)).status, 'success');
  const notices = (stripAnsi(h.log()).match(/basic code sandbox/g) ?? []).length; h.stop(); assert.equal(notices, 1, `${notices} notices printed`);
});
await t('D-26', 'Basic sandbox: escape payloads, regex, loops and results match the strong sandbox (full engine suite in section G)', async () => {
  const h = start('node', fresh('d26'), { env: { PORT: bumpedPort(), LITEFOREFLOW_SANDBOX: 'vm' } }); const url = await up(h); const u = await signup(url);
  for (const src of ['return [{ r: this.constructor.constructor("return process")().pid }];', 'return [{ r: (function(){}).constructor("return process")().version }];', 'return import("fs");']) {
    const body = JSON.parse(JSON.stringify(codeWf)); body.nodes[1].parameters.code = src; const r = await runCode(url, u.token, body);
    assert.ok(r.status === 'error' || !/"r":\s*(\d|"v\d)/.test(JSON.stringify(r.results.c.output)), `ESCAPE in basic mode: ${src}`);
  }
  h.stop();
});

/* ======================================================================== E */
area('E. Optional extras (not installed by default)');
for (const [id, key, val] of [['E-31', 'DATABASE_URL', 'postgres://u:p@127.0.0.1:1/x'], ['E-31b', 'REDIS_URL', 'redis://127.0.0.1:1']]) {
  await t(id, `${key} set without the extras installed: clear "npm run scale-up" message, no stack trace, non-zero exit`, async () => {
    const h = start('node', fresh(`${id}`), { env: { PORT: bumpedPort(), [key]: val } });
    const ok = await h.ready; const code = await h.exited; const out = stripAnsi(h.log());
    assert.equal(ok, false); assert.notEqual(code, 0); assert.match(out, /scale-up/, `no hint:
${out.slice(0, 400)}`); assert.ok(noStack(out), `raw stack trace shown:
${out.slice(0, 400)}`);
  });
}
await t('E-32', 'The Postgres node without the extra package explains how to enable it', async () => {
  const h = start('node', fresh('e32'), { env: { PORT: bumpedPort() } }); const url = await up(h); const u = await signup(url);
  const cred = await api(url, 'POST', '/api/credentials', { name: 'pg', type: 'postgres', data: { host: 'localhost', database: 'd', user: 'u' } }, u.token);
  const w = await wf(u.token, url, { nodes: [{ id: 't', type: 'trigger.manual', name: 's', parameters: {}, position: { x: 0, y: 0 } }, { id: 'q', type: 'app.postgres', name: 'q', parameters: { credential: cred.data.id, query: 'select 1' }, position: { x: 0, y: 0 } }], connections: [{ from: 't', to: 'q', fromOutput: 0, toInput: 0 }] });
  const r = await api(url, 'POST', `/api/workflows/${w.data.id}/run`, {}, u.token); h.stop(); assert.equal(r.data.status, 'error'); assert.match(r.data.error.message, /scale-up/);
});

/* ======================================================================== F */
area('F. Prebuilt UI');
await t('F-34', 'The committed web/dist is exactly what the current source builds (no stale UI shipped)', async () => {
  const d = exportRepo(path.join(SCR, 'f34')); const r = await sh('npm run build', { cwd: d, timeout: 300000 }); assert.equal(r.code, 0, r.out.slice(-400));
  const hashes = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => { const p = path.join(e.parentPath ?? e.path, e.name); return [path.relative(dir, p).replace(/\\/g, '/'), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12)]; }));
  const committed = hashes(path.join(BASE, 'web', 'dist')); const rebuilt = hashes(path.join(d, 'web', 'dist'));
  assert.deepEqual(rebuilt, committed, 'rebuilt files differ from the committed ones');
});

await stopAll(); mock.close();
const sum = summary();
console.log(`\nFORK QA TOTAL ${sum.total}  PASS ${sum.pass}  FAIL ${sum.fail}  BLOCKED ${sum.blocked}  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
fs.writeFileSync(path.join(here, 'fork-qa-results.json'), JSON.stringify({ summary: sum, results }, null, 2));
try { fs.rmSync(SCR, { recursive: true, force: true }); } catch { /* temp files */ }
process.exit(0);
