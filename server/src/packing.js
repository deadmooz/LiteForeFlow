import zlib from 'node:zlib';

/*
 * Execution logs are the biggest thing we store. They are highly repetitive JSON, so gzip shrinks them
 * 5-10x (less disk, less I/O, smaller Postgres). Small payloads stay plain text; readers accept both,
 * so rows written by older builds keep working.
 */
const PREFIX = 'gz:';
const MIN_BYTES = 1024;

export function pack(json) {
  if (json == null || json.length < MIN_BYTES) return json;
  return PREFIX + zlib.gzipSync(json, { level: 3 }).toString('base64');
}

export function unpack(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  return zlib.gunzipSync(Buffer.from(stored.slice(PREFIX.length), 'base64')).toString('utf8');
}

export const parseStored = (stored) => (stored ? JSON.parse(unpack(stored)) : null);
