import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/*
 * Execution logs are the biggest thing we store. They are highly repetitive JSON, so gzip shrinks them
 * 5-10x (less disk, less I/O, smaller Postgres). Small payloads stay plain text; readers accept both,
 * so rows written by older builds keep working.
 */
const PREFIX = 'gz:';
const MIN_BYTES = 8192; // below this Postgres compresses the text itself (TOAST), and our gzip would only cost CPU

export async function pack(json) {
  if (json == null || json.length < MIN_BYTES) return json;
  return PREFIX + (await gzip(json, { level: 3 })).toString('base64'); // on a thread-pool thread: a big log does not stall other runs
}

export function unpack(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  return zlib.gunzipSync(Buffer.from(stored.slice(PREFIX.length), 'base64')).toString('utf8');
}

/** Parses a stored log, decompressing on a thread-pool thread so a big log does not stall the server. */
export async function parseStoredAsync(stored) {
  if (!stored) return null;
  if (typeof stored === 'string' && stored.startsWith(PREFIX)) return JSON.parse((await gunzip(Buffer.from(stored.slice(PREFIX.length), 'base64'))).toString('utf8'));
  return JSON.parse(stored);
}

