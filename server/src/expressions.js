import { Sandbox, SandboxError } from './sandbox.js';

/*
 * Expressions ({{ ... }}) and the Code node run inside an isolated-vm V8 isolate (see sandbox.js):
 * no Node.js globals, separate heap with a memory cap, wall-clock timeouts, JSON-only data exchange.
 */

const EXPR_RE = /\{\{([\s\S]+?)\}\}/g;
const EXPR_TIMEOUT_MS = 1000;

/**
 * Creates a resolver for one item. `baseFn` supplies cheap variables ($json, $itemIndex...);
 * `extraFn` supplies expensive ones ($node, $input) only when an expression references them.
 * Pass a shared `sandbox` so all items of a node run reuse one isolate.
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

  const evalCode = (code) => {
    const needsExtra = /\$(node|input)\b/.test(code);
    try {
      const out = getCtx(needsExtra).run(
        `(function () { const __v = (${code}\n); const __s = JSON.stringify(__v); return __s === undefined ? '' : __s; })()`,
        EXPR_TIMEOUT_MS,
      );
      return out === '' ? undefined : JSON.parse(out);
    } catch (e) {
      throw new Error(`Expression error in {{ ${code.trim()} }}: ${e.message}`);
    }
  };

  const resolveString = (str) => {
    if (!str.includes('{{')) return str;
    const matches = [...str.matchAll(EXPR_RE)];
    if (matches.length === 1 && matches[0][0] === str.trim()) return evalCode(matches[0][1]);
    return str.replace(EXPR_RE, (_, code) => {
      const v = evalCode(code);
      if (v === undefined || v === null) return '';
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  };

  const resolve = (value) => {
    if (typeof value === 'string') return resolveString(value);
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
    }
    return value;
  };

  return { resolve, release: () => ctx?.release() };
}

/** Runs user code synchronously in an isolate. Returns { result, logs }. */
export function runCode(code, data, { timeoutMs = 5000, sandbox } = {}) {
  const sb = sandbox ?? new Sandbox();
  let ctx;
  try {
    ctx = sb.context(data);
    const out = ctx.run(
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
