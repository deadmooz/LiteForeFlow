import { defineNode, credentialProperty } from './registry.js';
import { httpRequest } from '../http.js';
import { runCode, testRegex, createItemCodeRunner } from '../expressions.js';
import { config } from '../config.js';
import { get } from '../db.js';
import { loadCredential } from '../credentials.js';

const passTrigger = (ctx, inputs) => [inputs[0]];

/* ---------------------------------- Triggers ---------------------------------- */

defineNode({
  type: 'trigger.manual', name: 'Manual Trigger', group: 'trigger', icon: '▶️', isTrigger: true, inputs: 0,
  description: 'Start the workflow by clicking Run in the editor.',
  execute: passTrigger,
});

defineNode({
  type: 'trigger.webhook', name: 'Webhook', group: 'trigger', icon: '🪝', isTrigger: true, inputs: 0,
  description: 'Start the workflow when an HTTP request hits its URL.',
  properties: [
    { name: 'path', label: 'Path', type: 'string', required: true, help: 'Served at /webhook/<path> while the workflow is active.' },
    { name: 'method', label: 'HTTP method', type: 'options', default: 'POST', options: ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    { name: 'respond', label: 'Respond', type: 'options', default: 'immediately', options: ['immediately', 'lastNode', 'responseNode'], help: '"lastNode" waits for the run and returns the last node output. "responseNode" waits and sends what a "Respond to Webhook" node (plugin) sets: status, headers and body.' },
    { name: 'secret', label: 'Shared secret (optional)', type: 'string', help: 'If set, callers must send it in the x-webhook-secret header.' },
    { name: 'samplePayload', label: 'Sample payload for test runs', type: 'json', default: '{\n  "body": { "hello": "world" }\n}' },
  ],
  execute: passTrigger,
});

defineNode({
  type: 'trigger.cron', name: 'Schedule', group: 'trigger', icon: '⏰', isTrigger: true, inputs: 0,
  description: 'Start the workflow on a schedule, for example every day at 9:00.',
  properties: [
    // The UI shows a friendly picker for 'schedule'; what is stored is still a plain cron expression.
    { name: 'cron', label: 'When to run', type: 'schedule', default: '0 * * * *', required: true },
    { name: 'timezone', label: 'Timezone', type: 'timezone', default: 'UTC' },
  ],
  execute: passTrigger,
});

defineNode({
  type: 'trigger.rss', name: 'RSS Feed', group: 'trigger', icon: '📰', isTrigger: true, inputs: 0,
  description: 'Poll an RSS/Atom feed and start the workflow for each new entry.',
  properties: [
    { name: 'url', label: 'Feed URL', type: 'string', required: true },
    { name: 'intervalMinutes', label: 'Check every (minutes)', type: 'number', default: 15 },
  ],
  execute: passTrigger,
});

defineNode({
  type: 'trigger.error', name: 'Error Trigger', group: 'trigger', icon: '🚨', isTrigger: true, inputs: 0,
  description: 'Start this workflow when another workflow fails. Set it as the other workflow\'s "Error workflow".',
  execute: passTrigger,
});

/* ----------------------------------- Core ------------------------------------- */

defineNode({
  type: 'http.request', name: 'HTTP Request', group: 'core', icon: '🌐',
  description: 'Call any REST API.',
  credentialType: ['httpBearer', 'httpBasic', 'httpHeader'],
  properties: [
    { name: 'method', label: 'Method', type: 'options', default: 'GET', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] },
    { name: 'url', label: 'URL', type: 'string', required: true, placeholder: 'https://api.example.com/items' },
    { name: 'credential', label: 'Authentication (optional)', type: 'credential', credentialType: ['httpBearer', 'httpBasic', 'httpHeader'] },
    { name: 'headers', label: 'Headers (JSON)', type: 'json', default: '{}' },
    { name: 'query', label: 'Query params (JSON)', type: 'json', default: '{}' },
    { name: 'bodyType', label: 'Body type', type: 'options', default: 'json', options: ['json', 'form', 'text'], showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
    { name: 'body', label: 'Body', type: 'text', default: '', showIf: { method: ['POST', 'PUT', 'PATCH', 'DELETE'] } },
    { name: 'timeoutSec', label: 'Timeout (seconds)', type: 'number', default: 30 },
    { name: 'ignoreStatus', label: 'Do not fail on 4xx/5xx', type: 'boolean', default: false },
  ],
  // Two steps so that read-only calls for many items can wait for the web service at the same time (see registry.js).
  concurrency: 5,
  parallelSafe: (req) => req.method === 'GET' || req.method === 'HEAD',
  async prepareItem(ctx, item, i) {
    const headers = { ...((await ctx.jsonParam('headers', i)) ?? {}) };
    const credId = ctx.rawParam('credential');
    if (credId) {
      // looked up once per node run, not once per item
      ctx.scratch.auth ??= (async () => {
        const row = await get('SELECT type FROM credentials WHERE id = ? AND workspace_id = ?', credId, ctx.workspaceId);
        if (!row) throw new Error('Credential not found');
        return { type: row.type, data: await loadCredential(ctx.workspaceId, credId, row.type) };
      })();
      const { type, data: c } = await ctx.scratch.auth;
      if (type === 'httpBearer') headers.authorization = `Bearer ${c.token}`;
      else if (type === 'httpBasic') headers.authorization = `Basic ${Buffer.from(`${c.user}:${c.password}`).toString('base64')}`;
      else if (type === 'httpHeader') headers[c.name] = c.value;
    }
    return {
      method: (await ctx.param('method', i)), url: (await ctx.param('url', i)), headers,
      query: (await ctx.jsonParam('query', i)) ?? {}, body: (await ctx.param('body', i)), bodyType: (await ctx.param('bodyType', i)),
      timeoutMs: Number((await ctx.param('timeoutSec', i)) || 30) * 1000, ignoreStatus: !!(await ctx.param('ignoreStatus', i)),
    };
  },
  async runPrepared(ctx, req) {
    const res = await httpRequest({ ...req, signal: ctx.signal });
    const d = res.data;
    // Arrays are returned under `data`; objects are spread for convenient access ({{ $json.name }}).
    return Array.isArray(d) || typeof d !== 'object' || d === null
      ? { data: d, statusCode: res.status }
      : { ...d, statusCode: res.status };
  },
});

/* ----------------------------------- Logic ------------------------------------ */

const OPS = {
  equals: (a, b) => String(a) === String(b),
  notEquals: (a, b) => String(a) !== String(b),
  contains: (a, b) => String(a).includes(String(b)),
  notContains: (a, b) => !String(a).includes(String(b)),
  startsWith: (a, b) => String(a).startsWith(String(b)),
  endsWith: (a, b) => String(a).endsWith(String(b)),
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  isEmpty: (a) => a === undefined || a === null || a === '' || (Array.isArray(a) && a.length === 0),
  isNotEmpty: (a) => !OPS.isEmpty(a),
  isTrue: (a) => a === true || a === 'true',
  isFalse: (a) => a === false || a === 'false',
};
export const conditionOperators = Object.keys(OPS);

export async function checkConditions(conds, combine, sandbox) {
  const list = Array.isArray(conds) ? conds : [];
  if (!list.length) return true;
  const test = async (c) => {
    // User-supplied regular expressions can backtrack catastrophically, so they never run on the server's own thread.
    if (c.op === 'regex') return testRegex(c.right, c.left, { sandbox });
    const fn = OPS[c.op];
    if (!fn) throw new Error(`Unknown operator "${c.op}"`);
    return fn(c.left, c.right);
  };
  for (const c of list) {
    const ok = await test(c);
    if (combine === 'any' && ok) return true;
    if (combine !== 'any' && !ok) return false;
  }
  return combine !== 'any';
}

defineNode({
  type: 'logic.if', name: 'IF', group: 'logic', icon: '🔀', outputs: 2, outputLabels: ['true', 'false'],
  description: 'Route items down the true or false branch.',
  properties: [
    { name: 'conditions', label: 'Conditions', type: 'conditions', default: [{ left: '{{ $json.value }}', op: 'equals', right: '' }] },
    { name: 'combine', label: 'Match', type: 'options', default: 'all', options: ['all', 'any'] },
  ],
  async execute(ctx, inputs) {
    const t = [];
    const f = [];
    for (let i = 0; i < inputs[0].length; i += 1) {
      const ok = await checkConditions(await ctx.param('conditions', i), ctx.rawParam('combine'), ctx.sandbox);
      (ok ? t : f).push(inputs[0][i]);
    }
    return [t, f];
  },
});

defineNode({
  type: 'logic.switch', name: 'Switch', group: 'logic', icon: '🔢', outputs: 2, dynamicOutputs: 'switch',
  description: 'Route each item to the output whose case matches. Last output is the fallback.',
  properties: [
    { name: 'value', label: 'Value', type: 'string', default: '{{ $json.type }}' },
    { name: 'cases', label: 'Cases (JSON array)', type: 'json', default: '["a"]', help: 'One output per case, plus a fallback output.' },
  ],
  async execute(ctx, inputs) {
    let cases = ctx.rawParam('cases');
    if (typeof cases === 'string') { try { cases = JSON.parse(cases); } catch { throw new Error('Cases must be a JSON array'); } }
    if (!Array.isArray(cases)) throw new Error('Cases must be a JSON array');
    const outs = Array.from({ length: cases.length + 1 }, () => []);
    for (let i = 0; i < inputs[0].length; i += 1) {
      const v = String(await ctx.param('value', i));
      const idx = cases.findIndex((c) => String(c) === v);
      outs[idx === -1 ? cases.length : idx].push(inputs[0][i]);
    }
    return outs;
  },
});

defineNode({
  type: 'logic.merge', name: 'Merge', group: 'logic', icon: '🔗', inputs: 2,
  description: 'Combine the items of two branches.',
  properties: [
    { name: 'mode', label: 'Mode', type: 'options', default: 'append', options: ['append', 'combineByPosition', 'combineByKey'] },
    { name: 'keyA', label: 'Key in input 1', type: 'string', showIf: { mode: 'combineByKey' } },
    { name: 'keyB', label: 'Key in input 2', type: 'string', showIf: { mode: 'combineByKey' } },
  ],
  execute(ctx, inputs) {
    const [a, b] = inputs;
    const mode = ctx.rawParam('mode');
    if (mode === 'append') return [[...a, ...b]];
    if (mode === 'combineByPosition') {
      return [Array.from({ length: Math.max(a.length, b.length) }, (_, i) => ({ json: { ...(a[i]?.json ?? {}), ...(b[i]?.json ?? {}) } }))];
    }
    const [kA, kB] = [ctx.rawParam('keyA'), ctx.rawParam('keyB')];
    if (!kA || !kB) throw new Error('Both key fields are required');
    const lookup = new Map(b.map((x) => [String(x.json[kB]), x]));
    return [a.filter((x) => lookup.has(String(x.json[kA]))).map((x) => ({ json: { ...x.json, ...lookup.get(String(x.json[kA])).json } }))];
  },
});

defineNode({
  type: 'logic.wait', name: 'Wait', group: 'logic', icon: '⏳',
  description: 'Pause the run (max 5 minutes in V1).',
  properties: [{ name: 'seconds', label: 'Seconds', type: 'number', default: 5 }],
  async execute(ctx, inputs) {
    const s = Math.min(300, Math.max(0, Number(ctx.rawParam('seconds')) || 0));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, s * 1000);
      ctx.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(ctx.signal.reason); }, { once: true }); // stop waiting when the run times out
    });
    return [inputs[0]];
  },
});

defineNode({
  type: 'logic.noop', name: 'No Operation', group: 'logic', icon: '➖',
  description: 'Pass items through unchanged. Handy as a junction point.',
  execute: (ctx, inputs) => [inputs[0]],
});

defineNode({
  type: 'logic.stopAndError', name: 'Stop and Error', group: 'logic', icon: '🛑',
  description: 'Fail the run on purpose with a message (triggers the error workflow).',
  properties: [{ name: 'message', label: 'Error message', type: 'string', default: 'Something went wrong' }],
  async execute(ctx) { throw new Error(String(await ctx.param('message'))); },
});

defineNode({
  type: 'logic.executeWorkflow', name: 'Execute Workflow', group: 'logic', icon: '🧩',
  description: 'Run another workflow in this workspace and use its result.',
  properties: [{ name: 'workflowId', label: 'Workflow ID', type: 'string', required: true, help: 'Found in the editor URL.' }],
  async execute(ctx, inputs) {
    const r = await ctx.executeWorkflow(ctx.rawParam('workflowId'), inputs[0]);
    return [r.lastOutput];
  },
});

/* ------------------------------------ Data ------------------------------------ */

// Field names come from users: "__proto__.x" or "constructor.prototype.x" must never reach Object.prototype.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const setPath = (obj, path, value) => {
  const keys = path.split('.');
  if (keys.some((k) => FORBIDDEN_KEYS.has(k))) throw new Error(`Field name "${path}" is not allowed ("__proto__", "constructor" and "prototype" are reserved)`);
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!hasOwn(cur, k) || typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[keys.at(-1)] = value;
};
const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null || !hasOwn(Object(o), k) ? undefined : o[k]), obj);

defineNode({
  type: 'data.set', name: 'Edit Fields', group: 'data', icon: '✏️',
  description: 'Add or overwrite fields on each item. Values can use {{ expressions }}.',
  properties: [
    { name: 'fields', label: 'Fields', type: 'keyvalue', default: [{ name: 'field', value: '' }] },
    { name: 'keepOthers', label: 'Keep other fields', type: 'boolean', default: true },
  ],
  async executeItem(ctx, item, i) {
    const out = ctx.rawParam('keepOthers') ? structuredClone(item.json) : {};
    for (const f of (await ctx.param('fields', i)) ?? []) if (f.name) setPath(out, f.name, f.value);
    return out;
  },
});

defineNode({
  type: 'data.code', name: 'Code', group: 'data', icon: '🧮',
  description: 'Transform data with JavaScript (synchronous).',
  properties: [
    { name: 'mode', label: 'Mode', type: 'options', default: 'runOnce', options: ['runOnce', 'eachItem'], help: 'runOnce: `items` is an array of all item objects. eachItem: `$json` is the current item.' },
    {
      name: 'code', label: 'JavaScript', type: 'code',
      default: '// runOnce: return an array of objects\nreturn items.map((item) => ({ ...item }));',
    },
  ],
  async execute(ctx, inputs) {
    if (!config.enableCodeNode) throw new Error('The Code node is disabled on this server');
    const code = ctx.rawParam('code');
    const unwrap = (o) => (o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === 1 && o.json && typeof o.json === 'object' ? o.json : o);
    const nodesData = {};
    if (ctx.rawParam('mode') === 'eachItem') {
      const out = [];
      const runner = createItemCodeRunner(ctx.sandbox, code, inputs[0].map((x) => x.json)); // the list is handed over once, not once per item
      try {
        for (let i = 0; i < inputs[0].length; i += 1) {
          const { result, logs } = await runner.run(inputs[0][i].json, i);
          logs.forEach((l) => ctx.log(l));
          if (result !== null && result !== undefined) out.push({ json: unwrap(result) });
        }
      } finally { runner.release(); }
      return [out];
    }
    const { result, logs } = await runCode(code, { items: inputs[0].map((i) => i.json), $input: { all: inputs[0].map((i) => i.json) }, $node: nodesData }, { sandbox: ctx.sandbox });
    logs.forEach((l) => ctx.log(l));
    if (result === null || result === undefined) return [[]];
    return [(Array.isArray(result) ? result : [result]).map((r) => ({ json: unwrap(r) }))];
  },
});

defineNode({
  type: 'data.splitOut', name: 'Split Out', group: 'data', icon: '✂️',
  description: 'Turn an array field into separate items.',
  properties: [{ name: 'field', label: 'Array field', type: 'string', default: 'data', help: 'Dot path, e.g. data.results' }],
  execute(ctx, inputs) {
    const out = [];
    const field = ctx.rawParam('field');
    for (const item of inputs[0]) {
      const arr = field ? getPath(item.json, field) : item.json;
      if (!Array.isArray(arr)) throw new Error(`Field "${field}" is not an array`);
      for (const el of arr) out.push({ json: el && typeof el === 'object' && !Array.isArray(el) ? el : { value: el } });
    }
    return [out];
  },
});

defineNode({
  type: 'data.aggregate', name: 'Aggregate', group: 'data', icon: '📦',
  description: 'Combine all items into a single item holding an array.',
  properties: [{ name: 'field', label: 'Output field', type: 'string', default: 'items' }],
  execute: (ctx, inputs) => [[{ json: { [ctx.rawParam('field') || 'items']: inputs[0].map((i) => i.json) } }]],
});

defineNode({
  type: 'data.limit', name: 'Limit', group: 'data', icon: '🔟',
  description: 'Keep only the first N items.',
  properties: [{ name: 'max', label: 'Max items', type: 'number', default: 10 }],
  execute: (ctx, inputs) => [inputs[0].slice(0, Math.max(0, Number(ctx.rawParam('max')) || 0))],
});

export { credentialProperty };
