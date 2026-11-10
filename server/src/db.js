import crypto from 'node:crypto';
import { config } from './config.js';

/*
 * One tiny async interface over Postgres (pg). The Docker edition has no other database.
 * SQL is written once with `?` placeholders; they are turned into $1, $2 ... before a query is sent.
 */

const MIGRATIONS = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free', stripe_customer_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, definition TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}',
  static_data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_ws ON workflows(workspace_id);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_ws ON credentials(workspace_id);
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_name TEXT NOT NULL,
  status TEXT NOT NULL, mode TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, data TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_exec_ws_started ON executions(workspace_id, started_at);
CREATE INDEX IF NOT EXISTS idx_exec_wf ON executions(workflow_id, started_at);
CREATE TABLE IF NOT EXISTS usage (
  workspace_id TEXT NOT NULL, month TEXT NOT NULL, runs INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (workspace_id, month)
);
CREATE TABLE IF NOT EXISTS webhooks (
  path TEXT NOT NULL, method TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL, PRIMARY KEY (path, method)
);`,
  },
  { id: 2, sql: 'ALTER TABLE executions ADD COLUMN worker TEXT' },
  {
    id: 3,
    sql: `
CREATE TABLE IF NOT EXISTS schedules (
  key TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_schedules_wf ON schedules(workflow_id);`,
  },
  {
    id: 4,
    sql: `
CREATE TABLE IF NOT EXISTS alert_state (
  workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
  last_sent TEXT NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0, last_error TEXT
);`,
  },
];

const splitStatements = (sql) => sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

/* ----------------------------------- Postgres --------------------------------- */
async function createPostgres() {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set. The Docker edition needs Postgres: start it with  docker compose up -d --build');
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(20, (v) => parseInt(v, 10)); // COUNT(*) etc. come back as numbers,
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => { i += 1; return `$${i}`; }); };
  // Postgres cannot store a NUL character in text and answers with an internal error; tell the caller what is wrong instead.
  const bind = (p) => p.map((v) => {
    if (typeof v === 'string' && v.includes('\u0000')) throw Object.assign(new Error('Text cannot contain the NUL (zero) character'), { status: 400 });
    return v === undefined ? null : v;
  });

  const schema = config.pgSchema;
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('PG_SCHEMA must be a simple identifier');
    const boot = new pg.Client({ connectionString: config.databaseUrl });
    await boot.connect();
    try {
      await boot.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    } catch (e) {
      // Several processes starting together can race on CREATE SCHEMA IF NOT EXISTS (unique violation / duplicate schema): the loser is fine.
      if (e.code !== '23505' && e.code !== '42P06') throw e;
    }
    await boot.end();
  }
  const pool = new pg.Pool({
    connectionString: config.databaseUrl, max: config.pgPoolSize,
    // A dead or unreachable database must produce a fast error, not requests that wait forever.
    connectionTimeoutMillis: config.pgConnectTimeoutMs, query_timeout: config.pgQueryTimeoutMs, idleTimeoutMillis: 30_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  pool.on('error', (e) => console.error('[pg] idle client error:', e.message));

  // Workflows contain arbitrary Unicode (emoji, arrows, any language); a non-UTF8 database would reject them at runtime.
  const enc = (await pool.query('SHOW server_encoding')).rows[0]?.server_encoding;
  if (enc && enc.toUpperCase() !== 'UTF8') {
    throw new Error(`Postgres database encoding is ${enc}; LiteForeFlow requires UTF8 (create it with: CREATE DATABASE liteforeflow ENCODING 'UTF8' TEMPLATE template0)`);
  }

  const make = (client) => ({
    all: async (sql, ...p) => (await client.query(toPg(sql), bind(p))).rows,
    get: async (sql, ...p) => (await client.query(toPg(sql), bind(p))).rows[0],
    run: async (sql, ...p) => ({ changes: (await client.query(toPg(sql), bind(p))).rowCount }),
  });
  return {
    ...make(pool),
    exec: async (sql) => { for (const st of splitStatements(sql)) await pool.query(st); },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(make(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally { client.release(); }
    },
    close: async () => pool.end(),
    pool,
  };
}

const driver = await createPostgres();

async function migrate() {
  await driver.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS) {
    if (await driver.get('SELECT id FROM migrations WHERE id = ?', m.id)) continue;
    await driver.transaction(async (tx) => {
      for (const st of splitStatements(m.sql)) await tx.run(st);
      await tx.run('INSERT INTO migrations (id, applied_at) VALUES (?, ?)', m.id, new Date().toISOString());
    });
  }
}

/** Serialises boot-time migrations across processes (Postgres advisory lock). */
async function withMigrationLock(fn) {
  const client = await driver.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}
await withMigrationLock(migrate);

export const all = driver.all;
export const get = driver.get;
export const run = driver.run;
export const transaction = driver.transaction;
export const closeDb = driver.close;
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
