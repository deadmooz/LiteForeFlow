import { config } from './config.js';
import { queueMode, startWorker, startEvents, closeQueue } from './queue.js';
import './jobs.js';
import { closeDb, dialect } from './db.js';
import { createApp } from './app.js';
import { initScheduler } from './scheduler.js';
import { failInflightExecutions } from './runner.js';

const role = config.role;
if (!['all', 'api', 'worker'].includes(role)) throw new Error(`LITEFOREFLOW_ROLE must be all, api or worker (got "${role}")`);
if (role !== 'all' && (queueMode !== 'bullmq' || dialect !== 'postgres')) {
  throw new Error(`LITEFOREFLOW_ROLE=${role} needs both DATABASE_URL (Postgres) and REDIS_URL — SQLite and the in-process queue cannot be shared between processes`);
}

const stops = [];
let server = null;

if (role !== 'worker') {
  if (queueMode === 'memory') await failInflightExecutions(); // anything in flight died with the previous process
  stops.push(await initScheduler());
  if (queueMode === 'bullmq') await startEvents(); // lets this process mark executions of crashed workers as failed
  server = createApp().listen(config.port, () => {
    console.log(`LiteForeFlow ${role} listening on ${config.publicUrl}  (db: ${dialect}, queue: ${queueMode})`);
  });
}
if (role !== 'api') {
  await startWorker();
  console.log(`LiteForeFlow worker started (concurrency ${config.maxConcurrency}, db: ${dialect}, queue: ${queueMode})`);
}

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`${signal} received, shutting down…`);
  setTimeout(() => process.exit(1), 30_000).unref(); // hard stop if a job refuses to finish
  stops.forEach((s) => s());
  if (server) await new Promise((r) => server.close(r));
  await closeQueue(); // waits for in-flight jobs to finish
  await closeDb();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
