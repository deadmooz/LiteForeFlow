import vm from 'node:vm';
import { createRequire } from 'node:module';

/*
 * Sandbox for {{ expressions }} and the Code node.
 *
 * STRONG mode (default, package "isolated-vm"): code runs in its own V8 isolate with a memory cap and a wall-clock
 * timeout, executed on a separate thread so the server never freezes. No Node.js globals exist inside.
 *
 * BASIC mode (automatic fallback when isolated-vm could not be installed, or LITEFOREFLOW_SANDBOX=vm): a locked-down
 * node:vm context (no require/process, no eval, timeouts). Perfectly fine on your own computer; it has no memory cap and
 * runs on the main thread, so do not offer a server in BASIC mode to people you do not trust.
 *
 * Data crosses the boundary only as JSON strings in both modes, so no host object or constructor is reachable.
 *
 * Speed and memory (measured): creating an isolate costs ~1.9 ms and a context ~0.5 ms, while running a compiled script
 * costs ~0.06 ms. So
 *   - isolates are POOLED: a node run borrows one and gives it back (a few idle ones are kept for a short while);
 *     an isolate that timed out, ran out of memory or got big is thrown away instead of reused, so one workflow can
 *     never leave damage behind for the next;
 *   - compiled scripts are cached per isolate;
 *   - reusable() gives ONE context for all items of a node run; only the current item is swapped in. Data shared by all
 *     items ($node, $input) is kept inside the isolate as text and parsed fresh for each item on first use, so an
 *     expression that changes it (for example list.reverse()) can never affect the next item.
 * Always call dispose() when the node run is over.
 */

const MEMORY_MB = Number(process.env.SANDBOX_MEMORY_MB) || 64;
const MAX_RESULT_CHARS = 5_000_000;
const MAX_LOG_LINES = 200;
const POOL_IDLE_MAX = 2; // isolates kept ready
const POOL_IDLE_MS = 10_000; // ...for this long
const POOL_MAX_USES = 400; // then replaced
const POOL_MAX_HEAP = 4 * 1048576; // an isolate that holds more than this (a big job) is dropped at once, so its memory is freed; small jobs stay under ~2 MB
const SCRIPT_CACHE_MAX = 300;
const SYNC_TRY_MS = 10; // an expression gets this long on the calling thread before it is handed to the isolate's own thread
const YIELD_EVERY = 256; // ...and long loops let the rest of the server breathe this often

let ivmModule;
const loadIvm = () => {
  if (ivmModule !== undefined) return ivmModule;
  try {
    ivmModule = process.env.LITEFOREFLOW_SANDBOX === 'vm' ? null : createRequire(import.meta.url)('isolated-vm');
  } catch {
    ivmModule = null;
  }
  // Servers that host other people's workflows (the Docker image) refuse to run with the weaker sandbox.
  if (!ivmModule && process.env.LITEFOREFLOW_REQUIRE_STRONG_SANDBOX === 'true') {
    throw new Error('The strong code sandbox (isolated-vm) is required here but could not be loaded. '
      + 'Reinstall with a working build toolchain, or unset LITEFOREFLOW_REQUIRE_STRONG_SANDBOX to accept the basic sandbox.');
  }
  return ivmModule;
};

export const sandboxMode = () => (loadIvm() ? 'isolated-vm' : 'basic');

let warned = false;
function warnBasic() {
  if (warned) return;
  warned = true;
  console.warn('[liteforeflow] Using the built-in basic code sandbox (the stronger "isolated-vm" is not installed). '
    + 'This is fine on your own computer. If other people will use this server, run: npm install isolated-vm');
}

const LOGGING = `
  const logs = [];
  globalThis.__logs = logs;
  const fmt = (x) => { try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch (e) { return String(x); } };
  globalThis.console = { log: (...a) => { if (logs.length < ${MAX_LOG_LINES}) logs.push(a.map(fmt).join(' ').slice(0, 2000)); } };
  globalThis.console.info = globalThis.console.warn = globalThis.console.error = globalThis.console.log;
`;

/** One-shot contexts (Code node "run once", regular expressions): everything arrives as one JSON object of globals. */
const BOOTSTRAP = `
(function () {
  Object.assign(globalThis, JSON.parse(globalThis.__raw));
  delete globalThis.__raw;
  const raw = globalThis.$input;
  if (raw && Array.isArray(raw.all)) {
    const all = raw.all.map((j) => ({ json: j }));
    globalThis.$input = { all: () => all, first: () => all[0], last: () => all[all.length - 1], item: { json: globalThis.$json } };
  }
  ${LOGGING}
})();
`;

/**
 * Reusable contexts (one per node run): __setShared(raw) once for data every item can see, then __setItem(raw) per item.
 * $node and $input are getters that parse the shared text fresh for each item, only if an expression touches them.
 */
const REUSABLE_BOOTSTRAP = `
(function () {
  ${LOGGING}
  let nodesRaw = '{}'; let allRaw = '[]';
  let nodeCache; let allCache;
  const allItems = () => (allCache ??= JSON.parse(allRaw).map((j) => ({ json: j })));
  Object.defineProperty(globalThis, '$node', { configurable: true, get() { return (nodeCache ??= JSON.parse(nodesRaw)); }, set() {} });
  Object.defineProperty(globalThis, '$input', {
    configurable: true,
    get() { return { all: () => allItems(), first: () => allItems()[0], last: () => allItems()[allItems().length - 1], item: { json: globalThis.$json } }; },
    set() {},
  });
  globalThis.__setNodes = (raw) => { nodesRaw = raw; nodeCache = undefined; };
  globalThis.__setAll = (raw) => { allRaw = raw; allCache = undefined; };
  globalThis.__setItem = (raw) => {
    const o = JSON.parse(raw);
    globalThis.$json = o.$json; globalThis.$itemIndex = o.$itemIndex; globalThis.$workflow = o.$workflow; globalThis.$now = o.$now;
    nodeCache = undefined; allCache = undefined;
    logs.length = 0;
  };
})();
`;

export class SandboxError extends Error {
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.fatal = fatal; // timed out / out of memory: the isolate must not be reused
  }
}

const friendly = (e) => {
  const m = String(e?.message ?? e);
  if (/timed out/i.test(m)) return { message: 'timed out (possible infinite loop)', fatal: true };
  if (/memory limit|disposed/i.test(m)) return { message: 'ran out of memory', fatal: true };
  return { message: m, fatal: false };
};
const toError = (e) => { const f = friendly(e); return new SandboxError(f.message, { fatal: f.fatal }); };

const checkSize = (out) => {
  if (typeof out === 'string' && out.length > MAX_RESULT_CHARS) throw new Error('result is too large');
  return out;
};

/* ---------------------------------- isolate pool ---------------------------------- */
const idle = [];

function acquireEntry() {
  const entry = idle.pop();
  if (entry) { clearTimeout(entry.timer); return entry; }
  return { iso: new (loadIvm().Isolate)({ memoryLimit: MEMORY_MB }), scripts: new Map(), uses: 0, timer: null };
}

function discard(entry) {
  clearTimeout(entry.timer);
  try { if (!entry.iso.isDisposed) entry.iso.dispose(); } catch { /* already gone */ }
}

function releaseEntry(entry, poisoned) {
  entry.uses += 1;
  let keep = !poisoned && !entry.iso.isDisposed && entry.uses < POOL_MAX_USES && idle.length < POOL_IDLE_MAX;
  if (keep) {
    try { keep = entry.iso.getHeapStatisticsSync().used_heap_size < POOL_MAX_HEAP; } catch { keep = false; }
  }
  if (!keep) { discard(entry); return; }
  entry.timer = setTimeout(() => { const i = idle.indexOf(entry); if (i >= 0) idle.splice(i, 1); discard(entry); }, POOL_IDLE_MS);
  entry.timer.unref?.();
  idle.push(entry);
}

/** For tests and clean shutdowns. */
export function drainSandboxPool() {
  while (idle.length) discard(idle.pop());
}

export class Sandbox {
  #entry = null;
  #poisoned = false;
  #basicScripts = new Map();

  #isolate() {
    if (!this.#entry || this.#entry.iso.isDisposed) this.#entry = acquireEntry();
    return this.#entry;
  }

  #script(entry, key, source) {
    let s = entry.scripts.get(key);
    if (!s) {
      s = entry.iso.compileScriptSync(source);
      if (entry.scripts.size >= SCRIPT_CACHE_MAX) entry.scripts.clear();
      entry.scripts.set(key, s);
    }
    return s;
  }

  #fail(e) {
    const err = e instanceof SandboxError ? e : toError(e);
    if (err.fatal) this.#poisoned = true;
    return err;
  }

  /** Creates a context pre-loaded with `data` (a JSON-serialisable object of globals). One-shot use. */
  context(data) {
    return loadIvm() ? this.#strongContext(data) : this.#basicContext(data);
  }

  #strongContext(data) {
    const entry = this.#isolate();
    const iso = entry.iso;
    const ctx = iso.createContextSync();
    try {
      ctx.global.setSync('__raw', JSON.stringify(data));
      this.#script(entry, '\0boot', BOOTSTRAP).runSync(ctx, { timeout: 1000 }); // trusted, bounded setup code
    } catch (e) {
      ctx.release();
      throw this.#fail(e);
    }
    return {
      /** Runs untrusted source that evaluates to a string, off the event loop. Resolves to that string. */
      run: async (source, timeoutMs) => {
        try {
          return checkSize(await iso.compileScriptSync(source).run(ctx, { timeout: timeoutMs }));
        } catch (e) {
          throw this.#fail(e);
        }
      },
      release: () => { try { ctx.release(); } catch { /* isolate already gone */ } },
    };
  }

  #basicContext(data) {
    warnBasic();
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    try {
      ctx.__raw = JSON.stringify(data);
      vm.runInContext(BOOTSTRAP, ctx, { timeout: 1000 });
    } catch (e) {
      throw toError(e);
    }
    return {
      run: async (source, timeoutMs) => {
        try {
          return checkSize(new vm.Script(source).runInContext(ctx, { timeout: timeoutMs }));
        } catch (e) {
          throw toError(e);
        }
      },
      release: () => {},
    };
  }

  /**
   * One context for every evaluation of a node run.
   *   setShared({ nodes, all })   data all items can see; stored once, parsed per item only when used
   *   setItem(obj)     the current item ({ $json, $itemIndex, $workflow, $now })
   *   run(source, ms)  runs untrusted source that evaluates to a string; compiled once per distinct source
   */
  reusable() {
    return loadIvm() ? this.#strongReusable() : this.#basicReusable();
  }

  #strongReusable() {
    const entry = this.#isolate();
    const iso = entry.iso;
    const ctx = iso.createContextSync();
    try {
      this.#script(entry, '\0reuse', REUSABLE_BOOTSTRAP).runSync(ctx, { timeout: 1000 });
    } catch (e) {
      ctx.release();
      throw this.#fail(e);
    }
    let calls = 0;
    const setItemScript = this.#script(entry, '\0setItem', '__setItem(__raw)');
    const setNodesScript = this.#script(entry, '\0setNodes', '__setNodes(__raw)');
    const setAllScript = this.#script(entry, '\0setAll', '__setAll(__raw)');
    const send = (script, json) => {
      try {
        ctx.global.setSync('__raw', json);
        script.runSync(ctx, { timeout: 1000 });
      } catch (e) { throw this.#fail(e); }
    };
    return {
      setShared: ({ nodes, all }) => { if (nodes !== undefined) send(setNodesScript, JSON.stringify(nodes)); if (all !== undefined) send(setAllScript, JSON.stringify(all)); },
      setItem: (obj) => send(setItemScript, JSON.stringify(obj)),
      run: async (source, timeoutMs) => {
        try {
          const script = this.#script(entry, source, source);
          // Most expressions take ~5 microseconds; the hop to the isolate's thread would cost ~60. So try right here first, with a
          // short limit, and only a slow one (or an infinite loop) goes the safe asynchronous way, with the full timeout.
          let out = null;
          try { out = script.runSync(ctx, { timeout: Math.min(SYNC_TRY_MS, timeoutMs) }); } catch (e) { if (!/timed out/i.test(String(e?.message))) throw e; }
          if (out === null) out = await script.run(ctx, { timeout: timeoutMs });
          if (++calls % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
          return checkSize(out);
        } catch (e) {
          throw this.#fail(e);
        }
      },
      release: () => { try { ctx.release(); } catch { /* isolate already gone */ } },
    };
  }

  #basicReusable() {
    warnBasic();
    let calls = 0;
    const ctx = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    try {
      vm.runInContext(REUSABLE_BOOTSTRAP, ctx, { timeout: 1000 });
    } catch (e) {
      throw toError(e);
    }
    const call = (fn, json) => {
      try { ctx.__raw = json; vm.runInContext(`${fn}(__raw)`, ctx, { timeout: 1000 }); } catch (e) { throw toError(e); }
    };
    return {
      setShared: ({ nodes, all }) => { if (nodes !== undefined) call('__setNodes', JSON.stringify(nodes)); if (all !== undefined) call('__setAll', JSON.stringify(all)); },
      setItem: (obj) => call('__setItem', JSON.stringify(obj)),
      run: async (source, timeoutMs) => {
        try {
          let s = this.#basicScripts.get(source);
          if (!s) { if (this.#basicScripts.size >= SCRIPT_CACHE_MAX) this.#basicScripts.clear(); s = new vm.Script(source); this.#basicScripts.set(source, s); }
          const out = checkSize(s.runInContext(ctx, { timeout: timeoutMs }));
          if (++calls % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
          return out;
        } catch (e) {
          throw toError(e);
        }
      },
      release: () => {},
    };
  }

  dispose() {
    if (this.#entry) releaseEntry(this.#entry, this.#poisoned);
    this.#entry = null;
    this.#poisoned = false;
    this.#basicScripts.clear();
  }
}
