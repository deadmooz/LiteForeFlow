// Helpers for fork QA: fresh "downloaded" copies of the repo, launching the app the way a novice would, process control.
import { spawn, execFile, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SCR = fs.mkdtempSync(path.join(os.tmpdir(), 'forkqa-'));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const WIN = process.platform === 'win32';
export const FLAGS = ['--max-semi-space-size=2', '--max-old-space-size=192'];

/** Extracts a clean copy of a git revision (what a user gets from "Download ZIP"). */
export function exportRepo(dest, rev = 'HEAD') {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execSync(`git clone -q "${FORK}" "${dest}"`, { stdio: 'pipe' });
  execSync(`git -C "${dest}" checkout -q ${rev}`, { stdio: 'pipe' });
  fs.rmSync(path.join(dest, '.git'), { recursive: true, force: true }); // a downloaded ZIP has no git history
  return dest;
}

export function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
  return dest;
}

export function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } };
  walk(dir);
  return total / 1048576;
}

/** Runs a command to completion. Never throws; returns { code, out, ms }. */
export function sh(cmd, { cwd, env = {}, timeout = 120000, input } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = execFile(cmd, { cwd, env: { ...process.env, ...env }, shell: true, timeout, windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}`, ms: Date.now() - t0, killed: !!err?.killed });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin?.end();
  });
}

export function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (WIN) execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
    else proc.kill('SIGKILL');
  } catch { /* already gone */ }
}

/** Starts the app (any launcher). Resolves once it prints its banner or exits. */
export function launch(kind, dir, { env = {}, cwd, args = [] } = {}) {
  const e = { ...process.env, LITEFOREFLOW_OPEN: '0', ...env };
  let proc;
  const run = (cmd, a, o = {}) => spawn(cmd, a, { cwd: cwd ?? dir, env: e, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...o });
  switch (kind) {
    case 'node': proc = run(process.execPath, [...FLAGS, path.join(dir, 'server/src/index.js')]); break;
    case 'npm': proc = run('npm', ['--prefix', `"${dir}"`, 'start'], { shell: true }); break;
    case 'bat': proc = run('cmd.exe', ['/c', path.join(dir, 'start.bat')]); break;
    case 'sh': proc = run('sh', [path.join(dir, 'start.sh')]); break;
    case 'py': proc = run('python', [path.join(dir, 'run.py'), '--no-open', ...args]); break;
    default: throw new Error(`unknown launcher ${kind}`);
  }
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const handle = { kind, proc, dir, log: () => log, url: null, stop: () => killTree(proc) };
  handle.ready = new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const m = log.match(/Open in your browser:\s+(http:\/\/\S+)/) ?? log.match(/listening on (http:\/\/\S+)/);
      if (m) { handle.url = m[1]; clearInterval(iv); resolve(true); } else if (proc.exitCode !== null) { clearInterval(iv); resolve(false); } else if (Date.now() - t0 > 90000) { clearInterval(iv); resolve(false); }
    }, 150);
  });
  handle.exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  return handle;
}

export async function getJson(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* text */ }
  return { status: r.status, data, text, headers: r.headers };
}

export async function api(base, method, url, body, token) {
  return getJson(base + url, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function signup(base, email = `u${Math.random().toString(36).slice(2, 8)}@example.com`, password = 'password123') {
  const r = await api(base, 'POST', '/api/auth/signup', { email, password });
  if (r.status !== 201) throw new Error(`signup ${r.status} ${JSON.stringify(r.data)}`);
  return { token: r.data.token, email, password };
}

export const trivialWorkflow = { nodes: [{ id: 't', type: 'trigger.manual', name: 'Start', parameters: {}, position: { x: 0, y: 0 } }, { id: 's', type: 'data.set', name: 'Set', parameters: { fields: [{ name: 'x', value: '{{ 6 * 7 }}' }], keepOthers: false }, position: { x: 200, y: 0 } }], connections: [{ from: 't', to: 's', fromOutput: 0, toInput: 0 }] };

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
