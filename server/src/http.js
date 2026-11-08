import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable: refuse
  const [a, b] = parts;
  return (
    a === 10 || a === 127 || a === 0 || a >= 224 || // private, loopback, "this network", multicast/reserved
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Expands any textual IPv6 form (including "::" and a dotted IPv4 tail) to 16 bytes, or null if invalid. */
function ipv6Bytes(ip) {
  let s = ip.toLowerCase().split('%')[0];
  const tail4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail4) {
    const p = tail4[2].split('.').map(Number);
    if (p.some((n) => n > 255)) return null;
    s = `${tail4[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const groups = halves.length === 1 ? head : [...head, ...Array(fill).fill('0'), ...rest];
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return bytes;
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const b = ipv6Bytes(ip);
  if (!b) return true; // cannot understand it: refuse
  const v4 = (o) => isPrivateIPv4(`${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`);
  const zeros = (n) => b.slice(0, n).every((x) => x === 0);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return v4(12); // IPv4-mapped  ::ffff:a.b.c.d (also its hex spelling)
  if (zeros(12)) return v4(12); // IPv4-compatible, plus :: and ::1
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return v4(12); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) >= 0x80) || b[0] === 0xff; // unique-local, link/site-local, multicast
}

async function assertAllowedHost(url, trustedOrigin) {
  if (!config.blockPrivateNetwork) return;
  if (trustedOrigin && new URL(url).origin === trustedOrigin) return; // an address the server admin chose (e.g. OLLAMA_HOST)
  const { hostname } = new URL(url);
  const host = hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('Requests to private or loopback network addresses are blocked on this server');
  }
}

const hasHeader = (h, name) => Object.keys(h).some((k) => k.toLowerCase() === name);
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function formEncode(obj, prefix = '', params = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, params);
    else params.append(key, String(v));
  }
  return params;
}

/** Reads the answer, but stops at HTTP_MAX_RESPONSE_MB: one huge download must not take the whole server's memory. */
async function readLimited(res, host) {
  const limit = config.httpMaxResponseBytes;
  const tooBig = () => new Error(`The answer from ${host} is larger than ${Math.round(limit / 1048576)} MB, the most a block may download (setting HTTP_MAX_RESPONSE_MB). Ask the service for less (paging, filters).`);
  const declared = Number(res.headers.get('content-length'));
  if (declared > limit) { res.body?.cancel().catch(() => {}); throw tooBig(); }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { reader.cancel().catch(() => {}); throw tooBig(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

const NET_REASONS = {
  ENOTFOUND: 'no server has that name - check the address', EAI_AGAIN: 'the name could not be looked up - check your internet connection',
  ECONNREFUSED: 'the connection was refused - is the service running on that port?', ECONNRESET: 'the connection was dropped',
  ETIMEDOUT: 'the connection timed out', EHOSTUNREACH: 'the host cannot be reached', ENETUNREACH: 'the network cannot be reached',
  CERT_HAS_EXPIRED: 'its security certificate has expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'it uses a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'its security certificate cannot be verified', ERR_TLS_CERT_ALTNAME_INVALID: 'its security certificate is for another name',
};

/**
 * fetch only says "fetch failed"; this says which host and why. The original error stays as `cause`, timeouts keep
 * the name TimeoutError and a cancelled run stays an AbortError, so callers can still tell them apart.
 */
function networkError(e, host, timeoutMs) {
  if (e.name === 'AbortError') return e;
  const code = e.cause?.code;
  const reason = e.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} seconds`
    : NET_REASONS[code] ?? (code ? `network error ${code}` : e.cause?.message || e.message);
  const err = new Error(`Could not reach ${host}: ${reason}`, { cause: e.cause ?? e });
  if (e.name === 'TimeoutError') err.name = 'TimeoutError';
  err.unreachable = true;
  return err;
}

export async function httpRequest({
  method = 'GET', url, headers = {}, query, body, bodyType = 'json',
  timeoutMs = 30000, ignoreStatus = false, responseType = 'auto', signal, trustedOrigin,
}) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are supported');
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  await assertAllowedHost(u.toString(), trustedOrigin);

  const h = { ...headers };
  let payload;
  if (body !== undefined && body !== null && body !== '' && !['GET', 'HEAD'].includes(method)) {
    if (bodyType === 'json') {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!hasHeader(h, 'content-type')) h['content-type'] = 'application/json';
    } else if (bodyType === 'form') {
      const obj = typeof body === 'string' ? JSON.parse(body) : body;
      payload = formEncode(obj).toString();
      if (!hasHeader(h, 'content-type')) h['content-type'] = 'application/x-www-form-urlencoded';
    } else {
      payload = String(body);
    }
  }

  let res;
  try {
    res = await fetch(u, {
      method, headers: h, body: payload,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      redirect: config.blockPrivateNetwork ? 'manual' : 'follow',
    });
  } catch (e) {
    throw networkError(e, u.host, timeoutMs);
  }
  let text;
  try { text = await readLimited(res, u.host); } catch (e) {
    throw e.name === 'TimeoutError' || e.cause ? networkError(e, u.host, timeoutMs) : e; // cut off half-way through the answer
  }
  let data = text;
  const ct = res.headers.get('content-type') || '';
  if (responseType === 'json' || (responseType === 'auto' && (ct.includes('json') || /^\s*[[{]/.test(text)))) {
    try { data = JSON.parse(text); } catch { /* keep text */ }
  }
  const out = { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), data };
  if (!res.ok && !ignoreStatus) {
    const said = text.trim();
    const err = new Error(`HTTP ${res.status} ${res.statusText}${said && said !== '{}' && said !== '[]' ? `: ${truncate(said, 300)}` : ''}`); // no ": {}" for an empty answer
    err.response = out;
    throw err;
  }
  return out;
}
