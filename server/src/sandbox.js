import { createRequire } from 'node:module';

// The native module is only loaded the first time a node needs it, so workflows without expressions/code never pay for it.
let ivmModule = null;
const ivm = () => (ivmModule ??= createRequire(import.meta.url)('isolated-vm'));

/*
 * V8-isolate sandbox for {{ expressions }} and the Code node.
 *
 * Each isolate is a separate V8 heap with NO Node.js globals (no process, require, fetch, timers, Buffer)
 * and its own memory limit. Data crosses the boundary only as JSON strings, so no host object or
 * constructor is ever reachable from user code. Execution is wall-clock limited.
 *
 * One Sandbox is created per node run; it lazily owns one isolate, and every item gets a fresh,
 * cheap context inside it. Always call dispose() when the node run is over.
 */

const MEMORY_MB = Number(process.env.SANDBOX_MEMORY_MB) || 64;
const MAX_RESULT_CHARS = 5_000_000;
const MAX_LOG_LINES = 200;

const BOOTSTRAP = `
(function () {
  Object.assign(globalThis, JSON.parse(globalThis.__raw));
  delete globalThis.__raw;
  const raw = globalThis.$input;
  if (raw && Array.isArray(raw.all)) {
    const all = raw.all.map((j) => ({ json: j }));
    globalThis.$input = { all: () => all, first: () => all[0], last: () => all[all.length - 1], item: { json: globalThis.$json } };
  }
  const logs = [];
  globalThis.__logs = logs;
  const fmt = (x) => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } };
  globalThis.console = { log: (...a) => { if (logs.length < ${MAX_LOG_LINES}) logs.push(a.map(fmt).join(' ').slice(0, 2000)); } };
  globalThis.console.info = globalThis.console.warn = globalThis.console.error = globalThis.console.log;
})();
`;

export class SandboxError extends Error {}

const friendly = (e) => {
  const m = String(e?.message ?? e);
  if (/timed out/i.test(m)) return 'timed out (possible infinite loop)';
  if (/memory limit|disposed/i.test(m)) return 'ran out of memory';
  return m;
};

export class Sandbox {
  #iso = null;

  #isolate() {
    if (!this.#iso || this.#iso.isDisposed) this.#iso = new (ivm().Isolate)({ memoryLimit: MEMORY_MB });
    return this.#iso;
  }

  /** Creates a context pre-loaded with `data` (a JSON-serialisable object of globals). */
  context(data) {
    const iso = this.#isolate();
    const ctx = iso.createContextSync();
    try {
      ctx.global.setSync('__raw', JSON.stringify(data));
      iso.compileScriptSync(BOOTSTRAP).runSync(ctx, { timeout: 1000 });
    } catch (e) {
      ctx.release();
      throw new SandboxError(friendly(e));
    }
    return {
      /** Runs source that evaluates to a string; returns that string. */
      run: (source, timeoutMs) => {
        try {
          const out = iso.compileScriptSync(source).runSync(ctx, { timeout: timeoutMs });
          if (typeof out === 'string' && out.length > MAX_RESULT_CHARS) throw new Error('result is too large');
          return out;
        } catch (e) {
          throw new SandboxError(friendly(e));
        }
      },
      release: () => { try { ctx.release(); } catch { /* isolate already gone */ } },
    };
  }

  dispose() {
    if (this.#iso && !this.#iso.isDisposed) this.#iso.dispose();
    this.#iso = null;
  }
}
