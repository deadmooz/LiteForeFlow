// Seeds an empty server with an account and a large execution history so the editor's lists can be tested at scale.
//   node server/test/ui/seed.mjs <baseUrl> [--rows 100000] [--sqlite <path to liteforeflow.db>]
// Rows are written straight into the database (SQLite here; on Postgres use the SQL printed with --sql).
// Prints { token, workspace, email, password } as JSON for the browser scripts.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const base = process.argv[2] ?? 'http://127.0.0.1:3300';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const ROWS = Number(arg('rows', 100000));
const dbPath = arg('sqlite');
const pgContainer = arg('pg-container'); // Docker: rows are generated inside Postgres with generate_series
const email = arg('email', 'ui@example.com');
const password = 'ui-test-password';

const call = async (method, url, body, token) => {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

let s = await call('POST', '/api/auth/signup', { email, password });
if (s.status === 409) s = await call('POST', '/api/auth/login', { email, password });
const token = s.data.token;
const me = (await call('GET', '/api/me', undefined, token)).data;
const ws = me.currentWorkspaceId;

const names = ['Daily report', 'Slack alert', 'Sync customers', 'Invoice webhook', 'RSS digest', 'Backup check', 'Lead router', 'Stripe events'];
const ids = [];
for (const name of names) {
  const r = await call('POST', '/api/workflows', { name, definition: { nodes: [{ id: 'start', type: 'trigger.manual', name: 'Manual Trigger', parameters: {}, position: { x: 80, y: 160 } }], connections: [] } }, token);
  ids.push([r.data.id, name]);
}

if (dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  const ins = db.prepare('INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at, finished_at, data, error) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const modes = ['webhook', 'manual', 'schedule'];
  const t0 = Date.now();
  db.exec('BEGIN');
  for (let i = 0; i < ROWS; i += 1) {
    const [wid, wname] = ids[i % ids.length];
    const started = new Date(t0 - i * 1500);
    const failed = i % 11 === 0;
    ins.run(randomUUID(), ws, wid, wname, failed ? 'error' : 'success', modes[i % 3], started.toISOString(), new Date(+started + 120 + (i % 900)).toISOString(), null,
      failed ? JSON.stringify({ message: `Request to https://api.example.com/v1/items/${i} failed with 502`, nodeName: 'HTTP Request' }) : null);
  }
  db.exec('COMMIT');
  db.close();
}
if (pgContainer) {
  const { execFileSync } = await import('node:child_process');
  const values = ids.map(([id, name], i) => `(${i}, '${id}', '${name}')`).join(',');
  execFileSync('docker', ['exec', pgContainer, 'psql', '-U', 'liteforeflow', '-c', `UPDATE workspaces SET plan = 'team'`], { stdio: 'ignore' });
  const sql = `INSERT INTO executions (id, workspace_id, workflow_id, workflow_name, status, mode, started_at, finished_at, data, error)
    SELECT gen_random_uuid()::text, '${ws}', w.id, w.name, CASE WHEN g % 11 = 0 THEN 'error' ELSE 'success' END, (ARRAY['webhook','manual','schedule'])[g % 3 + 1],
      to_char((now() - g * interval '1.5 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      to_char((now() - g * interval '1.5 seconds' + (120 + g % 900) * interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      NULL, CASE WHEN g % 11 = 0 THEN '{"message":"Request to https://api.example.com/v1/items failed with 502","nodeName":"HTTP Request"}' END
    FROM generate_series(0, ${ROWS - 1}) g JOIN (VALUES ${values}) AS w(i, id, name) ON w.i = g % ${ids.length}`;
  execFileSync('docker', ['exec', '-i', pgContainer, 'psql', '-U', 'liteforeflow'], { input: sql, stdio: ['pipe', 'ignore', 'inherit'] });
}
console.log(JSON.stringify({ token, workspace: ws, email, password, workflows: ids.length, rows: dbPath || pgContainer ? ROWS : 0 }));
