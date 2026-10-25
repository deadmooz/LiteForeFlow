import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.js';

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice(7));
  return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

async function assertAllowedHost(url) {
  if (!config.blockPrivateNetwork) return;
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

export async function httpRequest({
  method = 'GET', url, headers = {}, query, body, bodyType = 'json',
  timeoutMs = 30000, ignoreStatus = false, responseType = 'auto',
}) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs are supported');
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  await assertAllowedHost(u.toString());

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

  const res = await fetch(u, {
    method, headers: h, body: payload,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: config.blockPrivateNetwork ? 'manual' : 'follow',
  });
  const text = await res.text();
  let data = text;
  const ct = res.headers.get('content-type') || '';
  if (responseType === 'json' || (responseType === 'auto' && (ct.includes('json') || /^\s*[[{]/.test(text)))) {
    try { data = JSON.parse(text); } catch { /* keep text */ }
  }
  const out = { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), data };
  if (!res.ok && !ignoreStatus) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${truncate(text, 300)}`);
    err.response = out;
    throw err;
  }
  return out;
}
