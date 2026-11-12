// Makes sure a throwaway Postgres for the tests is running in Docker (port 55432), and clears old test schemas.
// Runs before `npm test`. Skipped when TEST_DATABASE_URL points at your own database.
import { execFileSync, spawnSync } from 'node:child_process';

if (process.env.TEST_DATABASE_URL) process.exit(0);
const NAME = 'liteforeflow-test-pg';
const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });

if (docker('info').status !== 0) {
  console.error('\n  The tests need Postgres, which runs in Docker - but Docker is not running. Start Docker Desktop and try again.\n');
  process.exit(1);
}
const state = docker('inspect', '-f', '{{.State.Running}}', NAME);
if (state.status !== 0) {
  execFileSync('docker', ['run', '-d', '--name', NAME, '-p', '127.0.0.1:55432:5432', '-e', 'POSTGRES_PASSWORD=test', 'postgres:17'], { stdio: 'ignore' });
} else if (state.stdout.trim() !== 'true') {
  execFileSync('docker', ['start', NAME], { stdio: 'ignore' });
}
for (let i = 0; i < 60; i += 1) {
  if (docker('exec', NAME, 'pg_isready', '-U', 'postgres').status === 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}
// pg_isready answers a moment before connections from outside work: wait for a real query
const { default: pg } = await import('pg');
const url = 'postgres://postgres:test@127.0.0.1:55432/postgres';
for (let i = 0; i < 30; i += 1) {
  const c = new pg.Client({ connectionString: url });
  try {
    await c.connect();
    const { rows } = await c.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'ff\_%'");
    for (const r of rows) await c.query(`DROP SCHEMA IF EXISTS ${r.nspname} CASCADE`);
    await c.end();
    process.exit(0);
  } catch { await c.end().catch(() => {}); await new Promise((r) => setTimeout(r, 1000)); }
}
console.error('\n  The test Postgres did not come up (container ' + NAME + ').\n');
process.exit(1);
