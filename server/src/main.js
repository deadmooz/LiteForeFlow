import { config } from './config.js';
import { queueMode, startWorker, startEvents, closeQueue } from './queue.js';
import './jobs.js';
import { closeDb, get } from './db.js';
import { initScheduler } from './scheduler.js';
import { failInflightExecutions } from './runner.js';
import { loadPlugins, watchPlugins } from './plugins.js';
import { startChangeFeed } from './changes.js';

const role = config.role;
if (!['all', 'api', 'worker'].includes(role)) throw new Error(`LITEFOREFLOW_ROLE must be all, api or worker (got "${role}")`);
if (role !== 'all' && queueMode !== 'bullmq') {
  throw new Error(`LITEFOREFLOW_ROLE=${role} needs REDIS_URL — the in-process queue cannot be shared between processes`);
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

const stops = [];
let server = null;

try {
  stops.push(await startChangeFeed()); // keeps the small workflow caches correct across processes
  await loadPlugins(); // before anything can run or validate a workflow that uses a plugin's nodes
  if (queueMode === 'bullmq') stops.push(watchPlugins()); // several processes share the plugin folder: stay in step with each other
  if (role !== 'worker') {
    if (queueMode === 'memory') await failInflightExecutions(); // anything in flight died with the previous process
    stops.push(await initScheduler());
    if (queueMode === 'bullmq') await startEvents(); // lets this process mark executions of crashed workers as failed
    server = await listen((await import('./app.js')).createApp()); // a worker never loads the web stack
    if (role === 'all' && queueMode === 'memory') {
      const firstRun = (await get('SELECT COUNT(*) AS n FROM users')).n === 0;
      console.log('');
      console.log('  LiteForeFlow is running!');
      console.log(`    Open in your browser:  ${config.publicUrl}`);
      console.log(`    Your data is saved in: ${config.dataDir}`);
      if (firstRun) console.log('    First time? Click "Create an account" on the page - it is free and stays on this computer.');
      console.log('    To stop: press Ctrl+C in this window');
      console.log('');
    } else {
      console.log(`LiteForeFlow ${role} listening on ${config.publicUrl}  (queue: ${queueMode})`);
    }
  }
  if (role !== 'api') {
    await startWorker();
    if (role === 'worker') console.log(`LiteForeFlow worker started (concurrency ${config.maxConcurrency}, queue: ${queueMode})`);
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
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
