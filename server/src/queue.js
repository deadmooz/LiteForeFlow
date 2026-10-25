import cron from 'node-cron';
import { config } from './config.js';

/*
 * Execution queue with two interchangeable drivers behind one interface:
 *   memory  — in-process concurrency limiter + node-cron timers (default; single process only)
 *   bullmq  — Redis-backed BullMQ queue, workers in any number of processes, job schedulers for cron/polling
 *
 *   setJobHandler(fn)                       fn(payload) -> result   (runs inside a worker)
 *   enqueue(payload, { wait })              queue a job; with wait:true resolves to the handler's result
 *   upsertSchedule / removeSchedule         durable recurring jobs (cron expression or fixed interval)
 *   startWorker / startEvents / closeQueue  lifecycle
 */

export const queueMode = config.redisUrl ? 'bullmq' : 'memory';
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RESULT_BYTES = 1_000_000;

let handler = async () => { throw new Error('No job handler registered'); };
let failedHandler = async () => {};
export const setJobHandler = (fn) => { handler = fn; };
export const setFailedHandler = (fn) => { failedHandler = fn; };

/** Keeps job results (stored in Redis) bounded; full data lives in the executions table. */
function boundResult(result) {
  if (result === undefined || result === null) return result;
  const json = JSON.stringify(result);
  if (json.length <= MAX_RESULT_BYTES) return result;
  return { ...result, lastOutput: (result.lastOutput ?? []).slice(0, 20), results: undefined, truncated: true };
}

/* ------------------------------------ memory ---------------------------------- */
function createMemoryDriver() {
  let running = 0;
  const waiting = [];
  const schedules = new Map();
  const acquire = () => new Promise((resolve) => {
    if (running < config.maxConcurrency) { running += 1; resolve(); } else waiting.push(resolve);
  });
  const release = () => { const next = waiting.shift(); if (next) next(); else running -= 1; };

  const execute = async (payload) => {
    await acquire();
    try { return await handler(payload); } finally { release(); }
  };

  return {
    async enqueue(payload, { wait } = {}) {
      const p = execute(payload);
      if (wait) return p;
      p.catch((e) => console.error('[queue] job failed:', e.message));
      return undefined;
    },
    async upsertSchedule(key, spec, payload) {
      schedules.get(key)?.();
      const fire = () => { execute(payload).catch((e) => console.error(`[schedule ${key}]`, e.message)); };
      if (spec.pattern) {
        if (!cron.validate(spec.pattern)) throw new Error(`Invalid cron expression "${spec.pattern}"`);
        const task = cron.schedule(spec.pattern, fire, { timezone: spec.tz || 'UTC' });
        schedules.set(key, () => task.stop());
      } else {
        const timer = setInterval(fire, spec.every);
        timer.unref();
        schedules.set(key, () => clearInterval(timer));
      }
    },
    async removeSchedule(key) { schedules.get(key)?.(); schedules.delete(key); },
    async startWorker() { /* jobs run in-process as they are enqueued */ },
    async startEvents() {},
    async stats() { return { mode: 'memory', running, waiting: waiting.length }; },
    async close() { for (const stop of schedules.values()) stop(); schedules.clear(); },
  };
}

/* ------------------------------------ bullmq ---------------------------------- */
async function createBullDriver() {
  const { Queue, Worker, QueueEvents } = await import('bullmq');
  const { default: IORedis } = await import('ioredis');
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', (e) => console.error('[redis]', e.message));
  // BullMQ does not own connections we hand it, so every duplicate must be closed by us on shutdown.
  const extra = [];
  const dup = () => { const c = connection.duplicate(); c.on('error', (e) => console.error('[redis]', e.message)); extra.push(c); return c; };
  const name = config.queueName;
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { age: 3600, count: 2000 }, removeOnFail: { age: 86400 } },
  });
  let worker = null;
  let events = null;

  const getEvents = async () => {
    if (!events) {
      events = new QueueEvents(name, { connection: dup() });
      events.on('error', (e) => console.error('[queue-events]', e.message));
      events.on('failed', ({ jobId, failedReason }) => {
        Promise.resolve(failedHandler(jobId, failedReason)).catch((e) => console.error('[queue] failed-handler:', e.message));
      });
      await events.waitUntilReady();
    }
    return events;
  };

  return {
    async enqueue(payload, { wait, jobId } = {}) {
      const depth = await queue.getWaitingCount();
      if (depth >= config.maxQueueDepth) {
        const err = new Error('The execution queue is full, please retry shortly');
        err.status = 503;
        throw err;
      }
      const ev = wait ? await getEvents() : null; // subscribe before adding so the completion event cannot be missed
      const job = await queue.add(payload.kind, payload, jobId ? { jobId } : undefined);
      if (!wait) return undefined;
      return job.waitUntilFinished(ev, WAIT_TIMEOUT_MS);
    },
    async upsertSchedule(key, spec, payload) {
      await queue.upsertJobScheduler(key, spec.pattern ? { pattern: spec.pattern, tz: spec.tz || 'UTC' } : { every: spec.every }, {
        name: payload.kind, data: payload,
        opts: { removeOnComplete: true, removeOnFail: { age: 3600 } },
      });
    },
    async removeSchedule(key) { await queue.removeJobScheduler(key); },
    async startWorker() {
      if (worker) return;
      worker = new Worker(name, async (job) => boundResult(await handler(job.data)), {
        connection: dup(),
        concurrency: config.maxConcurrency,
        lockDuration: config.workerLockMs,
        stalledInterval: config.workerStalledMs,
        maxStalledCount: 0, // never re-run a workflow after a worker crash: side effects could repeat
      });
      worker.on('error', (e) => console.error('[worker]', e.message));
      worker.on('failed', (job, e) => console.error(`[worker] job ${job?.id} failed:`, e.message));
      await worker.waitUntilReady();
    },
    startEvents: getEvents,
    async stats() { return { mode: 'bullmq', ...(await queue.getJobCounts('waiting', 'active', 'delayed', 'failed')) }; },
    async close() {
      await worker?.close();
      await events?.close();
      await queue.close();
      for (const c of [...extra, connection]) c.disconnect();
    },
  };
}

const driver = queueMode === 'bullmq' ? await createBullDriver() : createMemoryDriver();

export const enqueue = (payload, opts) => driver.enqueue(payload, opts);
export const upsertSchedule = (key, spec, payload) => driver.upsertSchedule(key, spec, payload);
export const removeSchedule = (key) => driver.removeSchedule(key);
export const startWorker = () => driver.startWorker();
export const startEvents = () => driver.startEvents();
export const queueStats = () => driver.stats();
export const closeQueue = () => driver.close();
