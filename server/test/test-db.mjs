// The tests run against a real Postgres, like the product does (the Docker edition has no other database).
// `npm test` starts a throwaway one in Docker (scripts/test-db.mjs); set TEST_DATABASE_URL to use your own.
// Every suite gets its own schema, so suites never see each other's data.
import crypto from 'node:crypto';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres:test@127.0.0.1:55432/postgres';

/** Points the app at a fresh schema. Call it before importing anything from server/src. Returns the schema name. */
export function useTestDatabase(prefix = 'ff_test') {
  const schema = `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.PG_SCHEMA = schema;
  return schema;
}

/** Removes the schema a suite used (call it after closeDb()). */
export async function dropTestSchema(schema) {
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await c.connect();
  try { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await c.end(); }
}
