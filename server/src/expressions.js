import { Sandbox, SandboxError } from './sandbox.js';

/*
 * Expressions ({{ ... }}) and the Code node run inside an isolated-vm V8 isolate (see sandbox.js):
 * no Node.js globals, separate heap with a memory cap, wall-clock timeouts, JSON-only data exchange,
 * and asynchronous execution so user code can never block the server's event loop.
 *
 * Speed: a plain lookup such as {{ $json.customer.name }} or {{ $node["Fetch"].json.id }} needs no JavaScript engine at
 * all, so it is answered directly (about 100x faster). Anything else (arithmetic, method calls, ternaries ...) goes to the
 * sandbox, which keeps ONE context per node run and swaps in only the current item.
 */

const EXPR_RE = /\{\{([\s\S]+?)\}\}/g;
const EXPR_TIMEOUT_MS = 1000;
const NEEDS_EXTRA = /\$(node|input)\b/;

/* ------------------------------ plain lookups, no sandbox ------------------------------ */
const MISS = Symbol('miss');
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const LOOKUP = /^\s*(\$json|\$itemIndex|\$now|\$workflow|\$node\[\s*(?:"([^"\\]+)"|'([^'\\]+)')\s*\]\.json)((?:\.[A-Za-z_$][\w$]*|\[\d{1,6}\]|\[\s*"[^"\\]*"\s*\]|\[\s*'[^'\\]*'\s*\])*)\s*$/;
const SEGMENT = /\.([A-Za-z_$][\w$]*)|\[(\d{1,6})\]|\[\s*"([^"\\]*)"\s*\]|\[\s*'([^'\\]*)'\s*\]/g;
const hasOwn = Object.prototype.hasOwnProperty;

/** The value of a plain property path, or MISS when real JavaScript is needed (so errors read exactly as before). */
function lookup(code, base, getExtra) {
  const m = LOOKUP.exec(code);
  if (!m) return MISS;
  let cur;
  switch (m[1].slice(0, 5)) {
    case '$json': cur = base.$json; break;
    case '$item': cur = base.$itemIndex; break;
    case '$now': cur = base.$now; break;
    case '$work': cur = base.$workflow; break;
    default: {
      const nodes = getExtra().$node;
      const name = m[2] ?? m[3];
      if (!nodes || !hasOwn.call(nodes, name) || !nodes[name]) return MISS;
      cur = nodes[name].json;
    }
  }
  if (m[4]) {
    for (const seg of m[4].matchAll(SEGMENT)) {
      const key = seg[1] ?? seg[2] ?? seg[3] ?? seg[4];
      if (cur === null || cur === undefined || FORBIDDEN_KEYS.has(key)) return MISS;
      if (typeof cur === 'string') {
        if (key === 'length') cur = cur.length;
        else if (/^\d+$/.test(key)) cur = cur[key];
        else return MISS;
      } else if (typeof cur === 'object') {
        cur = hasOwn.call(cur, key) ? cur[key] : undefined;
      } else return MISS;
    }
  }
  // what the sandbox would have returned after JSON.stringify -> JSON.parse
  if (cur !== null && typeof cur === 'object') return JSON.parse(JSON.stringify(cur));
  if (typeof cur === 'number' && !Number.isFinite(cur)) return null;
  return cur;
}

/**
 * Resolves {{ }} expressions for the items of ONE node run.
 * `baseFn(i)` supplies the cheap variables of item i ($json, $itemIndex, $workflow, $now); `extraFn()` the costly shared ones
 * ($node, $input), and is called at most once. Pass the node run's `sandbox`. Call release() when the node is done.
 */
export function createNodeEvaluator({ baseFn, extraFn, sandbox = new Sandbox() }) {
  let rc = null; // one reusable sandbox context for the whole node run
  let loaded = -1; // which item it currently holds
  let sharedSent = false;
  let extraValue;
  const getExtra = () => (extraValue ??= extraFn());
  let baseItem = -1;
  let baseValue;
  const baseOf = (i) => {
    if (baseItem !== i) { baseValue = baseFn(i); baseItem = i; }
    return baseValue;
  };

  const prepare = (i, needsExtra) => {
    rc ??= sandbox.reusable();
    if (needsExtra && !sharedSent) {
      const e = getExtra();
      rc.setShared({ nodes: e.$node, all: e.$input?.all });
      sharedSent = true;
    }
    if (loaded !== i) { rc.setItem(baseOf(i)); loaded = i; }
  };

  const evalCode = async (code, i) => {
    const hit = lookup(code, baseOf(i), getExtra);
    if (hit !== MISS) return hit;
    try {
      prepare(i, NEEDS_EXTRA.test(code));
      const out = await rc.run(`(function () { const __v = (${code}\n); const __s = JSON.stringify(__v); return __s === undefined ? '' : __s; })()`, EXPR_TIMEOUT_MS);
      return out === '' ? undefined : JSON.parse(out);
    } catch (e) {
      throw new Error(`Expression error in {{ ${code.trim()} }}: ${e.message}`);
    }
  };

  const resolveString = async (str, i) => {
    if (!str.includes('{{')) return str;
    const matches = [...str.matchAll(EXPR_RE)];
    if (matches.length === 1 && matches[0][0] === str.trim()) return evalCode(matches[0][1], i);
    let out = '';
    let last = 0;
    for (const m of matches) {
      out += str.slice(last, m.index);
      const v = await evalCode(m[1], i);
      out += v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      last = m.index + m[0].length;
    }
    return out + str.slice(last);
  };

  const resolve = async (value, i = 0) => {
    if (typeof value === 'string') return resolveString(value, i);
    if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await resolve(v, i)); return out; }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await resolve(v, i);
      return out;
    }
    return value;
  };

  return { resolve, release: () => { rc?.release(); rc = null; loaded = -1; sharedSent = false; } };
}

/** One-item resolver, kept for older callers and tests: createResolver(baseFn, extraFn, sandbox).resolve(value). */
export function createResolver(baseFn, extraFn, sandbox = new Sandbox()) {
  const ev = createNodeEvaluator({ baseFn: () => baseFn(), extraFn, sandbox });
  return { resolve: (value) => ev.resolve(value, 0), release: ev.release };
}

const codeWrapper = (code) => `(function () {
        const __r = (function () {\n${code}\n})();
        if (__r && typeof __r.then === 'function') { __r.then(null, function () {}); throw new Error('async code / Promises are not supported in V1. Return the value synchronously.'); }
        return JSON.stringify({ result: __r === undefined ? null : __r, logs: globalThis.__logs });
      })()`;

/** Runs user code in an isolate (off the event loop). Resolves to { result, logs }. */
export async function runCode(code, data, { timeoutMs = 5000, sandbox } = {}) {
  const sb = sandbox ?? new Sandbox();
  let ctx;
  try {
    ctx = sb.context(data);
    return JSON.parse(await ctx.run(codeWrapper(code), timeoutMs));
  } catch (e) {
    throw new Error(`Code error: ${e instanceof SandboxError ? e.message : String(e.message ?? e)}`);
  } finally {
    ctx?.release();
    if (!sandbox) sb.dispose();
  }
}

/**
 * The Code node in "each item" mode: the list of all items is handed over once, then each item swaps in cheaply
 * (before: the whole list was rebuilt and re-sent for every single item).
 */
export function createItemCodeRunner(sandbox, code, allJson, { timeoutMs = 5000 } = {}) {
  const rc = sandbox.reusable();
  rc.setShared({ all: allJson });
  const source = codeWrapper(code);
  return {
    async run(json, index) {
      try {
        rc.setItem({ $json: json, $itemIndex: index });
        return JSON.parse(await rc.run(source, timeoutMs));
      } catch (e) {
        throw new Error(`Code error: ${e instanceof SandboxError ? e.message : String(e.message ?? e)}`);
      }
    },
    release: () => rc.release(),
  };
}

const MAX_PATTERN_CHARS = 1000;
const MAX_SUBJECT_CHARS = 200_000;

/**
 * Tests a USER-SUPPLIED regular expression. It runs in the sandbox with a hard timeout, so a catastrophic
 * pattern such as (a+)+$ costs at most `timeoutMs` of a worker thread instead of freezing the server.
 */
export async function testRegex(pattern, subject, { timeoutMs = 250, sandbox } = {}) {
  const p = String(pattern);
  if (p.length > MAX_PATTERN_CHARS) throw new Error(`Regular expression is too long (max ${MAX_PATTERN_CHARS} characters)`);
  const sb = sandbox ?? new Sandbox();
  let ctx;
  try {
    ctx = sb.context({ __p: p, __s: String(subject).slice(0, MAX_SUBJECT_CHARS) });
    const out = await ctx.run(
      "(function () { try { return new RegExp(__p).test(__s) ? '1' : '0'; } catch (e) { return 'E' + e.message; } })()",
      timeoutMs,
    );
    if (out.startsWith('E')) throw new Error(`Invalid regular expression: ${out.slice(1)}`);
    return out === '1';
  } catch (e) {
    if (e instanceof SandboxError && /timed out/.test(e.message)) {
      throw new Error('Regular expression took too long to evaluate (possible catastrophic backtracking) - simplify the pattern');
    }
    throw e;
  } finally {
    ctx?.release();
    if (!sandbox) sb.dispose();
  }
}
