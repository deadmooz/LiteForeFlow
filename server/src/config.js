import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Optional settings file: copy .env.example to .env (next to package.json). Real environment variables still win.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (fs.existsSync(envFile)) {
  try {
    // Notepad may save with a BOM (UTF-8) or as UTF-16; either would hide the first setting, so decode it ourselves.
    const raw = fs.readFileSync(envFile);
    const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8')).replace(/^﻿/, '');
    for (const [k, v] of Object.entries(parseEnv(text))) if (!(k in process.env)) process.env[k] = v; // real variables win
  } catch (e) { console.warn(`[liteforeflow] Could not read ${envFile}: ${e.message}`); }
}

const env = process.env;

/** "localhost:11434", "0.0.0.0:11434" or a full URL -> a usable http(s) base URL without a trailing slash. */
function ollamaUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) return 'http://localhost:11434';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  try {
    const u = new URL(v);
    if (u.hostname === '0.0.0.0') u.hostname = 'localhost'; // 0.0.0.0 is a listen address, not somewhere to connect to
    if (!u.port && u.protocol === 'http:') u.port = '11434';
    return u.origin;
  } catch { return 'http://localhost:11434'; }
}
const port = Number(env.PORT) || 3000;

export const config = {
  port,
  publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  // Always next to the app (not the current folder), so starting it from anywhere finds the same data.
  dataDir: env.DATA_DIR || fileURLToPath(new URL('../../data', import.meta.url)),
  dbPath: env.DB_PATH || null,
  // Set DATABASE_URL for Postgres (required for multi-process); otherwise SQLite in DATA_DIR.
  databaseUrl: env.DATABASE_URL || '',
  pgSchema: env.PG_SCHEMA || '',
  pgConnectTimeoutMs: Number(env.PG_CONNECT_TIMEOUT_MS) || 5000,
  pgQueryTimeoutMs: Number(env.PG_QUERY_TIMEOUT_MS) || 30_000,
  pgPoolSize: Number(env.PG_POOL_SIZE) || 10,
  // Set REDIS_URL to run executions through BullMQ workers; otherwise an in-process queue is used.
  redisUrl: env.REDIS_URL || '',
  queueName: env.QUEUE_NAME || 'liteforeflow-executions',
  // A running job's lock is renewed automatically; if its worker dies the job is declared failed after ~lock + stalled interval.
  workerLockMs: Number(env.WORKER_LOCK_MS) || 60_000,
  workerStalledMs: Number(env.WORKER_STALLED_INTERVAL_MS) || 15_000,
  queueEnqueueTimeoutMs: Number(env.QUEUE_ENQUEUE_TIMEOUT_MS) || 5000,
  maxQueueDepth: Number(env.MAX_QUEUE_DEPTH) || 10000,
  // all = API + worker + scheduler in one process | api = HTTP + enqueue + schedules | worker = executes jobs only
  role: env.LITEFOREFLOW_ROLE || 'all',
  maxConcurrency: Number(env.MAX_CONCURRENCY) || 10,
  // When true, the HTTP node refuses to call loopback/private addresses (recommended for hosted multi-tenant use).
  blockPrivateNetwork: env.BLOCK_PRIVATE_NETWORK === 'true',
  // Where the local Ollama server lives (same variable Ollama itself uses; "host:port" without http:// is fine).
  // It stays reachable for the AI nodes even when BLOCK_PRIVATE_NETWORK=true.
  ollamaUrl: ollamaUrl(env.OLLAMA_HOST),
  // Only changed by the test-suite (to point Notion calls at a fake server).
  notionUrl: (env.LITEFOREFLOW_NOTION_URL || 'https://api.notion.com').replace(/\/$/, ''),
  // Extra folder to look for plugins in (besides ./plugins and <data>/plugins).
  pluginsDir: env.PLUGINS_DIR || '',
  // How many items a read-only API block (HTTP Request GET, REST connector GET) may fetch at the same time. 1 = strictly one by one.
  itemConcurrency: Math.min(20, Math.max(1, Number(env.ITEM_CONCURRENCY) || 5)),
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
