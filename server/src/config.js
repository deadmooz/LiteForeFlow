import path from 'node:path';
import fs from 'node:fs';

const env = process.env;
const port = Number(env.PORT) || 3000;

export const config = {
  port,
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.resolve(process.cwd(), 'data'),
  dbPath: env.DB_PATH || null,
  // Set DATABASE_URL for Postgres (required for multi-process); otherwise SQLite in DATA_DIR.
  databaseUrl: env.DATABASE_URL || '',
  pgSchema: env.PG_SCHEMA || '',
  pgPoolSize: Number(env.PG_POOL_SIZE) || 10,
  // Set REDIS_URL to run executions through BullMQ workers; otherwise an in-process queue is used.
  redisUrl: env.REDIS_URL || '',
  queueName: env.QUEUE_NAME || 'liteforeflow-executions',
  // A running job's lock is renewed automatically; if its worker dies the job is declared failed after ~lock + stalled interval.
  workerLockMs: Number(env.WORKER_LOCK_MS) || 60_000,
  workerStalledMs: Number(env.WORKER_STALLED_INTERVAL_MS) || 15_000,
  maxQueueDepth: Number(env.MAX_QUEUE_DEPTH) || 10000,
  // all = API + worker + scheduler in one process | api = HTTP + enqueue + schedules | worker = executes jobs only
  role: env.LITEFOREFLOW_ROLE || 'all',
  maxConcurrency: Number(env.MAX_CONCURRENCY) || 10,
  // When true, the HTTP node refuses to call loopback/private addresses (recommended for hosted multi-tenant use).
  blockPrivateNetwork: env.BLOCK_PRIVATE_NETWORK === 'true',
  enableCodeNode: env.ENABLE_CODE_NODE !== 'false',
  // Set SAVE_SUCCESS_DATA=false to keep only a one-line record of successful runs (errors always keep full data).
  saveSuccessData: env.SAVE_SUCCESS_DATA !== 'false',
  authRateLimitPerMin: Number(env.AUTH_RATE_LIMIT_PER_MIN) || 20,
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  isProd: env.NODE_ENV === 'production',
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices: { pro: env.STRIPE_PRICE_PRO || '', team: env.STRIPE_PRICE_TEAM || '' },
  },
};

fs.mkdirSync(config.dataDir, { recursive: true });
