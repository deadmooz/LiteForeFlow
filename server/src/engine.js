import { createNodeEvaluator } from './expressions.js';
import { Sandbox } from './sandbox.js';
import { getNodeType, withDefaults } from './nodes/index.js';
import { loadCredential } from './credentials.js';
import { pluginForMissingType } from './plugins.js';
import { config } from './config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const MAX_SUBWORKFLOW_DEPTH = 5;

export class WorkflowError extends Error {
  constructor(message, nodeId, nodeName) {
    super(message);
    this.nodeId = nodeId;
    this.nodeName = nodeName;
  }
}

/** Static checks used before activation / running. Returns a list of human-readable problems. */
export function validateWorkflow(def) {
  const issues = [];
  const nodes = def?.nodes ?? [];
  const conns = def?.connections ?? [];
  const ids = new Set();
  const names = new Set();
  for (const n of nodes) {
    if (ids.has(n.id)) issues.push(`Duplicate node id ${n.id}`);
    ids.add(n.id);
    if (names.has(n.name)) issues.push(`Node name "${n.name}" is used more than once (names must be unique)`);
    names.add(n.name);
    if (!getNodeType(n.type)) {
      const p = pluginForMissingType(n.type);
      issues.push(p
        ? `Node "${n.name}" comes from the plugin "${p.name}", which is ${p.status === 'disabled' ? 'switched off (turn it on under Plugins)' : p.status === 'error' ? 'broken (see the Plugins page)' : 'not installed'}`
        : `Node "${n.name}" has unknown type ${n.type}`);
    }
  }
  for (const c of conns) {
    if (!ids.has(c.from) || !ids.has(c.to)) issues.push('A connection points to a node that does not exist');
  }
  if (!nodes.some((n) => getNodeType(n.type)?.isTrigger)) issues.push('Workflow needs at least one trigger node');
  try { reachableOrder(nodes, conns, nodes.find((n) => getNodeType(n.type)?.isTrigger)?.id); } catch (e) { issues.push(e.message); }
  return issues;
}

/** Nodes reachable from `startId`, in topological order. Throws on cycles. */
export function reachableOrder(nodes, conns, startId) {
  if (!startId) return [];
  const reachable = new Set([startId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift();
    for (const c of conns) if (c.from === cur && !reachable.has(c.to)) { reachable.add(c.to); queue.push(c.to); }
  }
  const indeg = new Map([...reachable].map((id) => [id, 0]));
  for (const c of conns) if (reachable.has(c.from) && reachable.has(c.to)) indeg.set(c.to, indeg.get(c.to) + 1);
  const ready = [...reachable].filter((id) => indeg.get(id) === 0);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const c of conns) {
      if (c.from === id && reachable.has(c.to)) {
        indeg.set(c.to, indeg.get(c.to) - 1);
        if (indeg.get(c.to) === 0) ready.push(c.to);
      }
    }
  }
  if (order.length !== reachable.size) {
    throw new Error('Workflow contains a loop. Cycles are not supported yet — nodes already process every item, or use "Split Out" for arrays.');
  }
  return order;
}

const toItems = (arr) => arr.map((it) => (it && typeof it === 'object' && 'json' in it ? it : { json: it }));

/**
 * Executes a workflow graph. Never throws for node failures — returns { status: 'error', error }.
 * opts: { workflow, workspaceId, mode, triggerNodeId, triggerItems, onlyNode, onlyInput,
 *         staticData, depth, runSubWorkflow }
 */
export async function runWorkflow(opts) {
  const { workflow, workspaceId, onlyNode, onlyInput, depth = 0, runSubWorkflow } = opts;
  const settings = { timeoutSec: 300, ...(workflow.settings || {}) };
  const nodes = workflow.definition?.nodes ?? [];
  const conns = workflow.definition?.connections ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const staticData = opts.staticData ?? {};
  const results = {};
  const outputs = {};
  const startedAt = new Date().toISOString();
  const timeoutMs = clamp(settings.timeoutSec, 1, 3600) * 1000;
  let lastOutput = [];
  let response = null; // what a "Respond to Webhook" node (plugin) wants the caller to receive
  let error = null;

  // One abort signal per run: it fires when the workflow timeout elapses, even in the middle of a slow node.
  const abort = new AbortController();
  const timeoutError = new Error(`Workflow timed out after ${settings.timeoutSec}s`);
  const timer = setTimeout(() => abort.abort(timeoutError), timeoutMs);
  const timedOut = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(timeoutError), { once: true }));
  timedOut.catch(() => {}); // never an unhandled rejection when nobody is racing it

  const finish = (status) => {
    clearTimeout(timer);
    for (const [id, r] of Object.entries(results)) r.name = byId.get(id)?.name;
    return { status, error, results, lastOutput, response, staticData, startedAt, finishedAt: new Date().toISOString() };
  };

  let order;
  let startId;
  try {
    if (onlyNode) {
      if (!byId.has(onlyNode)) throw new Error('Node not found');
      startId = onlyNode;
      order = [onlyNode];
    } else {
      const start = opts.triggerNodeId
        ? byId.get(opts.triggerNodeId)
        : nodes.find((n) => !n.disabled && getNodeType(n.type)?.isTrigger);
      if (!start) throw new Error('Workflow has no trigger node');
      startId = start.id;
      order = reachableOrder(nodes, conns, startId);
    }
  } catch (e) {
    error = { message: e.message };
    return finish('error');
  }

  const nodesData = () => {
    const out = {};
    for (const [id, outs] of Object.entries(outputs)) {
      const items = (outs?.[0] ?? []).map((i) => i.json);
      out[byId.get(id).name] = { json: items[0] ?? {}, items };
    }
    return out;
  };

  for (const id of order) {
    const node = byId.get(id);
    const type = getNodeType(node.type);
    try {
      if (abort.signal.aborted) throw timeoutError;
      if (!type) throw new Error(`Unknown node type ${node.type}`);

      const inputs = Array.from({ length: type.inputs || 1 }, () => []);
      if (id === startId) {
        inputs[0] = onlyNode ? (onlyInput ?? [{ json: {} }]) : (opts.triggerItems ?? [{ json: {} }]);
      } else {
        for (const c of conns) {
          const produced = c.to === id ? outputs[c.from]?.[c.fromOutput ?? 0] : null;
          if (produced?.length) inputs[c.toInput ?? 0].push(...produced);
        }
        if (inputs.every((a) => a.length === 0)) {
          results[id] = { status: 'skipped' };
          continue;
        }
      }

      if (node.disabled && !onlyNode) {
        outputs[id] = [inputs[0]];
        results[id] = { status: 'skipped', note: 'disabled', input: inputs, output: outputs[id] };
        continue;
      }

      const params = withDefaults(type, node.parameters);
      const logs = [];
      const sandbox = new Sandbox(); // borrows a pooled V8 isolate on first use; given back by dispose()
      // One evaluator per node run: plain lookups never touch the sandbox, everything else shares one context, and the costly
      // shared data ($node, $input) is built once, not once per item.
      const evaluator = createNodeEvaluator({
        baseFn: (i) => {
          const item = inputs[0][i] ?? inputs[0][0];
          return { $json: item?.json ?? {}, $itemIndex: i, $workflow: { id: workflow.id, name: workflow.name }, $now: new Date().toISOString() };
        },
        extraFn: () => ({ $node: nodesData(), $input: { all: inputs[0].map((x) => x.json) } }),
        sandbox,
      });

      const ctx = {
        node, inputs, staticData, workspaceId, depth, sandbox, signal: abort.signal,
        scratch: {}, // a place for a block to remember things (a loaded credential) for the length of this node run
        workflow: { id: workflow.id, name: workflow.name },
        rawParam: (name) => params[name],
        param: (name, i = 0) => evaluator.resolve(params[name], i),
        /** Parses a JSON-typed parameter, resolving {{ expressions }} (inside or outside of strings). */
        jsonParam: async (name, i = 0) => {
          const raw = params[name];
          if (raw === undefined || raw === null || raw === '') return undefined;
          if (typeof raw !== 'string') return evaluator.resolve(raw, i);
          let parsed;
          try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
          if (parsed !== undefined) return evaluator.resolve(parsed, i);
          const resolved = await evaluator.resolve(raw, i);
          if (typeof resolved !== 'string') return resolved;
          try { return JSON.parse(resolved); } catch { throw new Error(`"${name}" is not valid JSON`); }
        },
        credential: () => loadCredential(workspaceId, params.credential, type.credentialType),
        log: (msg) => logs.push(String(msg)),
        /** Sets the HTTP answer for the webhook that started this run: { status, headers, body }. The last call wins. */
        setResponse: (r) => { response = r; },
        executeWorkflow: async (workflowId, items) => {
          if (!runSubWorkflow) throw new Error('Sub-workflows are not available here');
          if (depth >= MAX_SUBWORKFLOW_DEPTH) throw new Error('Sub-workflow nesting is too deep');
          return runSubWorkflow({ workflowId, workspaceId, items, depth: depth + 1 });
        },
      };

      const maxTries = node.retryOnFail ? clamp(Number(node.maxTries) || 3, 1, 5) : 1;
      const waitMs = clamp(Number(node.waitBetweenTries ?? 1000), 0, 30000);
      const t0 = Date.now();
      let out;
      let lastErr;
      let tries = 0;
      while (tries < maxTries) {
        tries += 1;
        try {
          const attempt = executeNode(type, ctx, inputs);
          attempt.catch(() => {}); // if the timeout wins the race, the abandoned attempt must not raise an unhandled rejection
          out = await Promise.race([attempt, timedOut]);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (abort.signal.aborted) break; // out of time: do not retry
          if (tries < maxTries) await Promise.race([sleep(waitMs), timedOut]).catch(() => {});
        }
      }
      evaluator.release();
      sandbox.dispose();
      const base = { input: inputs, durationMs: Date.now() - t0, tries, logs: logs.length ? logs : undefined };

      if (lastErr) {
        if (node.continueOnFail) {
          outputs[id] = [inputs[0].map((it) => ({ json: { ...it.json, error: lastErr.message } }))];
          results[id] = { ...base, status: 'error', continued: true, error: lastErr.message, output: outputs[id] };
          continue;
        }
        results[id] = { ...base, status: 'error', error: lastErr.message };
        throw new WorkflowError(lastErr.message, id, node.name);
      }

      outputs[id] = out;
      results[id] = { ...base, status: 'success', output: out };
      lastOutput = out.find((o) => o.length) ?? out[0] ?? [];
    } catch (e) {
      if (!results[id]) results[id] = { status: 'error', error: e.message };
      error = { message: e.message, nodeId: id, nodeName: node.name };
      return finish('error');
    }
  }
  return finish('success');
}

async function executeNode(type, ctx, inputs) {
  if (type.prepareItem) {
    // Settings are read one item at a time (they may need the expression engine); only the waiting for the web service overlaps.
    const items = inputs[0];
    const prepared = [];
    for (let i = 0; i < items.length; i += 1) prepared.push(await type.prepareItem(ctx, items[i], i));
    const lanes = type.concurrency > 1 && prepared.length > 1 && prepared.every((p) => type.parallelSafe?.(p))
      ? Math.min(type.concurrency, config.itemConcurrency, prepared.length) : 1;
    const results = new Array(prepared.length);
    let next = 0;
    let failed = false;
    const lane = async () => {
      while (!failed) {
        const i = next;
        next += 1;
        if (i >= prepared.length) return;
        try { results[i] = await type.runPrepared(ctx, prepared[i], i); } catch (e) { failed = true; throw e; } // the others stop taking new work
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
    const out = [];
    results.forEach((r, i) => {
      if (r === null || r === undefined) return;
      for (const o of Array.isArray(r) ? r : [r]) out.push({ json: o, pairedItem: i });
    });
    return [out];
  }
  if (type.executeItem) {
    const out = [];
    for (let i = 0; i < inputs[0].length; i += 1) {
      const r = await type.executeItem(ctx, inputs[0][i], i);
      if (r === null || r === undefined) continue;
      for (const o of Array.isArray(r) ? r : [r]) out.push({ json: o, pairedItem: i });
    }
    return [out];
  }
  const r = await type.execute(ctx, inputs);
  if (!Array.isArray(r)) throw new Error('Node returned an invalid result');
  return r.map((o) => toItems(o ?? []));
}
