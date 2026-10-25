import { Sandbox, SandboxError } from './sandbox.js';

/*
 * Expressions ({{ ... }}) and the Code node run inside an isolated-vm V8 isolate (see sandbox.js):
 * no Node.js globals, separate heap with a memory cap, wall-clock timeouts, JSON-only data exchange,
 * and asynchronous execution so user code can never block the server's event loop.
 */

const EXPR_RE = /\{\{([\s\S]+?)\}\}/g;
const EXPR_TIMEOUT_MS = 1000;

/**
 * Creates a resolver for one item. `baseFn` supplies cheap variables ($json, $itemIndex...);
 * `extraFn` supplies expensive ones ($node, $input) only when an expression references them.
 * Pass a shared `sandbox` so all items of a node run reuse one isolate.
 * `resolve(value)` is async and resolves {{ }} expressions anywhere inside strings/arrays/objects.
 */
export function createResolver(baseFn, extraFn, sandbox = new Sandbox()) {
  let ctx = null;
  let full = false;

  const getCtx = (needsExtra) => {
    if (!ctx || (needsExtra && !full)) {
      ctx?.release();
      ctx = sandbox.context(needsExtra ? { ...baseFn(), ...extraFn() } : baseFn());
      full = needsExtra;
    }
    return ctx;
  };

  const evalCode = async (code) => {
    const needsExtra = /\$(node|input)\b/.test(code);
    try {
      const out = await getCtx(needsExtra).run(
        `(function () { const __v = (${code}\n); const __s = JSON.stringify(__v); return __s === undefined ? '' : __s; })()`,
        EXPR_TIMEOUT_MS,
      );
      return out === '' ? undefined : JSON.parse(out);
    } catch (e) {
      throw new Error(`Expression error in {{ ${code.trim()} }}: ${e.message}`);
    }
  };

  const resolveString = async (str) => {
    if (!str.includes('{{')) return str;
    const matches = [...str.matchAll(EXPR_RE)];
    if (matches.length === 1 && matches[0][0] === str.trim()) return evalCode(matches[0][1]);
    let out = '';
    let last = 0;
    for (const m of matches) {
      out += str.slice(last, m.index);
      const v = await evalCode(m[1]);
      out += v === undefined || v === null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
      last = m.index + m[0].length;
    }
    return out + str.slice(last);
  };

  const resolve = async (value) => {
    if (typeof value === 'string') return resolveString(value);
    if (Array.isArray(value)) { const out = []; for (const v of value) out.push(await resolve(v)); return out; }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await resolve(v);
      return out;
    }
    return value;
  };

  return { resolve, release: () => ctx?.release() };
}

/** Runs user code in an isolate (off the event loop). Resolves to { result, logs }. */
export async function runCode(code, data, { timeoutMs = 5000, sandbox } = {}) {
  const sb = sandbox ?? new Sandbox();
  let ctx;
  try {
    ctx = sb.context(data);
    const out = await ctx.run(
      `(function () {
        const __r = (function () {\n${code}\n})();
        if (__r && typeof __r.then === 'function') throw new Error('async code / Promises are not supported in V1. Return the value synchronously.');
        return JSON.stringify({ result: __r === undefined ? null : __r, logs: globalThis.__logs });
      })()`,
      timeoutMs,
    );
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`Code error: ${e instanceof SandboxError ? e.message : String(e.message ?? e)}`);
  } finally {
    ctx?.release();
    if (!sandbox) sb.dispose();
  }
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
