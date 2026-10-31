import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { queueMode, startWorker, startEvents, closeQueue } from './queue.js';
import './jobs.js';
import { closeDb, dialect, get } from './db.js';
import { createApp } from './app.js';
import { initScheduler } from './scheduler.js';
import { failInflightExecutions } from './runner.js';
import { loadPlugins, watchPlugins } from './plugins.js';

const role = config.role;
if (!['all', 'api', 'worker'].includes(role)) throw new Error(`LITEFOREFLOW_ROLE must be all, api or worker (got "${role}")`);
if (role !== 'all' && (queueMode !== 'bullmq' || dialect !== 'postgres')) {
  throw new Error(`LITEFOREFLOW_ROLE=${role} needs both DATABASE_URL (Postgres) and REDIS_URL — SQLite and the in-process queue cannot be shared between processes`);
}

/** Listens on the wanted port; when the user did not pick one explicitly and it is taken or blocked, quietly tries the next ones. */
function listen(app) {
  const explicit = Boolean(process.env.PORT);
  return new Promise((resolve, reject) => {
    let port = config.port;
    let tries = 0;
    const attempt = () => {
      const server = app.listen(port);
      server.once('listening', () => resolve(server));
      server.once('error', (e) => {
        // EACCES: on Windows, WSL / Docker / Hyper-V reserve whole port ranges (often including 3000).
        if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && !explicit && tries < 40) { tries += 1; port += 1; attempt(); return; }
        if (e.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use by another program. Close it, or pick another port (for example: PORT=3001).`));
        else if (e.code === 'EACCES') reject(new Error(`Port ${port} is blocked by your computer (Windows reserves some port numbers). Pick another one, for example: PORT=8080.`));
        else reject(e);
      });
    };
    attempt();
  }).then((server) => {
    config.port = server.address().port;
    if (!process.env.PUBLIC_URL) config.publicUrl = `http://localhost:${config.port}`;
    return server;
  });
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * One server per data folder. Two servers on the same SQLite file would both run every schedule.
 * The lock file holds { pid, url }; it counts only if that process is alive AND answers on that address.
 */
async function acquireLock() {
  const file = path.join(config.dataDir, '.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      const release = () => { try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch { /* gone */ } };
      process.on('exit', release);
      return { update: (url) => fs.writeFileSync(file, JSON.stringify({ pid: process.pid, url })), release };
    } catch (e) {
      if (e.code !== 'EEXIST') return { update: () => {}, release: () => {} }; // a read-only folder is reported elsewhere
    }
    let held = null;
    try { held = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable = stale */ }
    if (held?.pid && held.pid !== process.pid && pidAlive(held.pid)) {
      let running = !held.url; // started a moment ago and has no address yet
      if (held.url) {
        try { running = (await fetch(`${held.url}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { running = false; }
      }
      if (running) throw new Error(`LiteForeFlow is already running with this data${held.url ? ` - open ${held.url}` : ''}. Close the other window first, or use a different DATA_DIR.`);
    }
    try { fs.unlinkSync(file); } catch { /* raced with another start */ }
  }
  throw new Error('Could not take the data-folder lock (data/.lock). Delete that file if no LiteForeFlow is running.');
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* the URL is printed anyway */ }
}

const stops = [];
let server = null;
let lock = null;

try {
  await loadPlugins(); // before anything can run or validate a workflow that uses a plugin's nodes
  if (queueMode === 'bullmq') stops.push(watchPlugins()); // several processes share the plugin folder: stay in step with each other
  if (role !== 'worker') {
    if (queueMode === 'memory' && dialect === 'sqlite') lock = await acquireLock();
    if (queueMode === 'memory') await failInflightExecutions(); // anything in flight died with the previous process
    stops.push(await initScheduler());
    if (queueMode === 'bullmq') await startEvents(); // lets this process mark executions of crashed workers as failed
    server = await listen(createApp());
    lock?.update(config.publicUrl);
    if (role === 'all' && queueMode === 'memory') {
      const firstRun = (await get('SELECT COUNT(*) AS n FROM users')).n === 0;
      console.log('');
      console.log('  LiteForeFlow is running!');
      console.log(`    Open in your browser:  ${config.publicUrl}`);
      console.log(`    Your data is saved in: ${config.dataDir}`);
      if (firstRun) console.log('    First time? Click "Create an account" on the page - it is free and stays on this computer.');
      console.log('    To stop: press Ctrl+C in this window');
      console.log('');
      if (process.env.LITEFOREFLOW_OPEN === '1') openBrowser(config.publicUrl);
    } else {
      console.log(`LiteForeFlow ${role} listening on ${config.publicUrl}  (db: ${dialect}, queue: ${queueMode})`);
    }
  }
  if (role !== 'api') {
    await startWorker();
    if (role === 'worker') console.log(`LiteForeFlow worker started (concurrency ${config.maxConcurrency}, db: ${dialect}, queue: ${queueMode})`);
  }
} catch (e) {
  console.error(`\n  LiteForeFlow could not start: ${e.message}\n`);
  process.exit(1);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down...`);
  setTimeout(() => process.exit(1), 30_000).unref(); // hard stop if a job refuses to finish
  stops.forEach((s) => s());
  if (server) await new Promise((r) => server.close(r));
  await closeQueue(); // waits for in-flight jobs to finish
  await closeDb();
  lock?.release();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
