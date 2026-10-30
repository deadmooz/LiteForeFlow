/*
 * REST connector: one JSON file per service -> one node + one credential type.
 * Read plugins/rest-connector/services/_example-service.json (and docs/PLUGINS.md) to describe your own.
 * Your own service files go in  <data folder>/plugin-data/rest-connector/services/  (created on first use).
 */
import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[a-z][a-z0-9]{1,24}$/;
const KINDS = new Set(['string', 'text', 'number', 'boolean', 'json', 'options']);
const WHERE = new Set(['path', 'query', 'body', 'header', 'ui']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const get = (obj, p) => String(p ?? '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const fill = (tpl, values) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => (values[k] === undefined ? m : values[k]));

/** Returns a list of plain-language problems with a service file (empty = fine). */
export function checkSpec(spec) {
  const bad = [];
  if (!SAFE_ID.test(spec?.id ?? '')) bad.push('"id" must be 2-25 lowercase letters/numbers, starting with a letter');
  if (!spec?.name) bad.push('"name" is missing');
  if (!/^https?:\/\//.test(spec?.baseUrl ?? '')) bad.push('"baseUrl" must start with http:// or https://');
  const auth = spec?.auth ?? { type: 'none' };
  if (!['none', 'bearer', 'header', 'basic', 'query'].includes(auth.type)) bad.push(`auth.type "${auth.type}" is not one of none, bearer, header, basic, query`);
  if (auth.type === 'header' && !auth.header) bad.push('auth.header (the header name) is missing');
  if (auth.type === 'query' && !(auth.params?.length)) bad.push('auth.params (the query parameters to send) is missing');
  if (!Array.isArray(spec?.operations) || !spec.operations.length) bad.push('"operations" needs at least one operation');
  const opIds = new Set();
  for (const op of spec?.operations ?? []) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(op.id ?? '')) bad.push(`operation id "${op.id}" must be letters and numbers only`);
    if (opIds.has(op.id)) bad.push(`operation id "${op.id}" is used twice`);
    opIds.add(op.id);
    if (!op.label) bad.push(`operation "${op.id}" needs a "label"`);
    if (!METHODS.has(op.method ?? 'GET')) bad.push(`operation "${op.id}": method must be GET, POST, PUT, PATCH or DELETE`);
    if (!String(op.path ?? '').startsWith('/')) bad.push(`operation "${op.id}": "path" must start with /`);
    const names = new Set();
    for (const f of op.fields ?? []) {
      if (!/^\w+$/.test(f.name ?? '')) bad.push(`operation "${op.id}": field name "${f.name}" must be letters, numbers or _`);
      if (names.has(f.name)) bad.push(`operation "${op.id}": field "${f.name}" appears twice`);
      names.add(f.name);
      if (!WHERE.has(f.in ?? 'query')) bad.push(`field "${f.name}": "in" must be path, query, body, header or ui`);
      if (!KINDS.has(f.type ?? 'string')) bad.push(`field "${f.name}": type "${f.type}" is not one of ${[...KINDS].join(', ')}`);
    }
    for (const m of String(op.path).matchAll(/\{(\w+)\}/g)) if (!(op.fields ?? []).some((f) => f.name === m[1])) bad.push(`operation "${op.id}": path uses {${m[1]}} but there is no field with that name`);
  }
  return bad;
}

function authFields(auth) {
  const secret = (name, label) => ({ name, label, type: 'password', required: true });
  switch (auth.type) {
    case 'bearer': case 'header': return [secret('token', auth.label || 'API token')];
    case 'basic': return [{ name: 'user', label: auth.userLabel || 'Username', type: 'string', required: true }, secret('password', auth.passwordLabel || 'Password')];
    case 'query': return auth.params.map((p) => ({ name: p.name, label: p.label || p.name, type: p.secret === false ? 'string' : 'password', required: true }));
    default: return [];
  }
}

function applyAuth(auth, cred, headers, query) {
  switch (auth.type) {
    case 'bearer': headers.authorization = `Bearer ${cred.token}`; break;
    case 'header': headers[auth.header] = `${auth.prefix ?? ''}${cred.token}`; break;
    case 'basic': headers.authorization = `Basic ${Buffer.from(`${cred.user}:${cred.password}`).toString('base64')}`; break;
    case 'query': for (const p of auth.params) query[p.as ?? p.name] = cred[p.name]; break;
    default:
  }
}

/** The human reason inside a service's error answer: {message}, {error:{message}}, {error:"..."}, {reason}, {detail}, {errors:[{message}]} ... */
export function reasonOf(d) {
  const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return text(d.message) ?? text(d.error?.message) ?? text(d.reason) ?? text(d.detail) ?? text(d.error_description) ?? text(d.error) ?? text(d.errors?.[0]?.message) ?? text(d.errors?.[0]) ?? '';
}

export function register(sdk) {
  const dirs = [path.join(sdk.pluginDir, 'services'), path.join(sdk.dataDir(), 'services')];
  const files = dirs.flatMap((d) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => path.join(d, f)); } catch { return []; } });
  const loaded = [];
  for (const file of files) {
    let spec;
    try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { sdk.log(`${path.basename(file)} skipped: not valid JSON (${e.message})`); continue; }
    const problems = checkSpec(spec);
    if (problems.length) { sdk.log(`${path.basename(file)} skipped: ${problems[0]}`); continue; }
    if (loaded.includes(spec.id)) { sdk.log(`${path.basename(file)} skipped: service "${spec.id}" was already loaded`); continue; }
    try { registerService(sdk, spec); loaded.push(spec.id); } catch (e) { sdk.log(`${path.basename(file)} skipped: ${e.message}`); }
  }
}

function registerService(sdk, spec) {
  const auth = spec.auth ?? { type: 'none' };
  const credType = `rest_${spec.id}`;
  const credFields = [...(spec.credentialFields ?? []).map((f) => ({ required: true, type: 'string', ...f })), ...authFields(auth)];
  const key = (op, f) => `${op.id}__${f.name}`;

  /** URL, headers and query for a call, with the credential applied. */
  const prepare = (cred, op, valueOf) => {
    const headers = { 'user-agent': 'LiteForeFlow', accept: 'application/json', ...(spec.headers ?? {}) };
    const query = {};
    const body = {};
    const values = {};
    for (const f of op.fields ?? []) {
      let v = valueOf(f);
      if (v === '' || v === undefined || v === null) {
        if (f.required && (f.in ?? 'query') !== 'ui') throw new Error(`${f.label || f.name} is required for "${op.label}"`);
        continue;
      }
      if (f.type === 'json' && typeof v === 'string') { try { v = JSON.parse(v); } catch { throw new Error(`${f.label || f.name} is not valid JSON`); } }
      if (f.type === 'number') v = Number(v);
      values[f.name] = v;
      const as = f.as ?? f.name;
      switch (f.in ?? 'query') {
        case 'query': query[as] = typeof v === 'object' ? JSON.stringify(v) : v; break;
        case 'body': body[as] = v; break;
        case 'header': headers[as] = String(v); break;
        default:
      }
    }
    const base = fill(spec.baseUrl, cred).replace(/\/$/, '');
    const route = String(op.path).replace(/\{(\w+)\}/g, (m, k) => {
      const f = op.fields.find((x) => x.name === k);
      if (values[k] === undefined) throw new Error(`${f?.label || k} is required for "${op.label}"`);
      const pieces = f?.raw ? String(values[k]).split('/') : [String(values[k])];
      if (pieces.some((x) => x === '.' || x === '..')) throw new Error(`${f?.label || k} cannot contain "." or ".." parts`);
      return pieces.map(encodeURIComponent).join('/');
    });
    applyAuth(auth, cred, headers, query);
    return { url: `${base}${route}`, headers, query, body };
  };

  const buildRequest = (cred, op, valueOf) => {
    const { url, headers, query, body } = prepare(cred, op, valueOf);
    const method = op.method ?? 'GET';
    return { method, url, headers, query, body: method === 'GET' || !Object.keys(body).length ? undefined : body };
  };

  /** Sends one prepared request and turns a failure into a plain sentence. */
  const send = async (req, signal) => {
    const { method, url, headers, query, body } = req;
    try {
      return (await sdk.httpRequest({ method, url, headers, query, body, timeoutMs: 30000, signal })).data;
    } catch (e) {
      const d = e.response?.data;
      const said = d && typeof d === 'object' ? reasonOf(d) : (typeof d === 'string' && !/^\s*</.test(d) ? d.slice(0, 160) : ''); // an HTML error page is not worth showing
      if (!e.response) {
        const host = (() => { try { return new URL(url).host; } catch { return url; } })();
        const code = e.cause?.code;
        if (e.name === 'TimeoutError') throw new Error(`${spec.name}: ${host} did not answer in 30 seconds`);
        if (e.message === 'fetch failed' || code) {
          const why = code === 'ECONNREFUSED' ? 'connection refused' : code === 'ENOTFOUND' ? 'no such address' : code === 'ECONNRESET' ? 'connection dropped' : code || 'network error';
          throw new Error(`${spec.name}: could not connect to ${host} (${why}). Check the address and your internet connection.`);
        }
      }
      throw Object.assign(new Error(`${spec.name}: ${e.response ? `HTTP ${e.response.status}${said ? ` - ${typeof said === 'string' ? said : JSON.stringify(said)}` : ''}` : e.message}`), { response: e.response });
    }
  };

  const call = (cred, op, valueOf, ctx) => send(buildRequest(cred, op, valueOf), ctx?.signal);

  const toRows = (data, resultPath) => {
    const picked = resultPath ? get(data, resultPath) : data;
    if (picked === undefined || picked === null) return []; // the answer has nothing at that place: no hollow item
    const list = Array.isArray(picked) ? picked : [picked];
    return list.slice(0, 1000).map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }));
  };

  const credProp = auth.type !== 'none' || credFields.length ? sdk.credentialProperty(credType) : null;
  if (credProp) {
    sdk.defineCredentialType({
      id: credType, name: spec.name, fields: credFields, setup: spec.setup,
      async test(data) {
        const t = spec.test;
        if (!t?.path) return { ok: true, message: 'Saved. This service has no automatic test; run a workflow to try it.', untested: true };
        const op = { id: 'test', label: 'test', method: 'GET', path: t.path, fields: [] };
        const res = await call(data, op, () => undefined);
        return t.say ? fill(t.say, { ...Object.fromEntries(Object.entries(res ?? {}).map(([k, v]) => [k, typeof v === 'object' ? '' : v])) }) : 'Connected.';
      },
    });
  }

  const props = [
    ...(credProp ? [credProp] : []),
    { name: 'operation', label: 'What to do', type: 'options', default: spec.operations[0].id, options: spec.operations.map((o) => ({ value: o.id, label: o.label })) },
  ];
  for (const op of spec.operations) {
    for (const f of op.fields ?? []) {
      const kind = f.type ?? 'string';
      const dynamic = kind === 'options' && f.options && !Array.isArray(f.options);
      props.push({
        // numbers are typed into a text box so {{ expressions }} work; they are converted to numbers when the call is made
        name: key(op, f), label: f.label || f.name, type: kind === 'options' ? 'options' : kind === 'number' ? 'string' : kind, default: f.default,
        required: !!f.required, placeholder: f.placeholder, help: f.help, showIf: { operation: op.id },
        ...(kind === 'options' && Array.isArray(f.options) ? { options: f.options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) })) } : {}),
        ...(dynamic ? { dynamic: true, options: [] } : {}),
      });
    }
  }

  sdk.defineNode({
    type: `rest.${spec.id}`, name: spec.name, group: 'app', icon: spec.icon || '🔌', description: spec.description || `Use ${spec.name} (REST).`,
    ...(credProp ? { credentialType: credType } : {}),
    properties: props,
    // Two steps: settings are read one item at a time, then read-only (GET) calls wait for the service several at a time.
    concurrency: 5,
    parallelSafe: (p) => p.req.method === 'GET',
    async prepareItem(ctx, item, i) {
      const op = spec.operations.find((o) => o.id === ctx.rawParam('operation'));
      if (!op) throw new Error('Pick what to do');
      ctx.scratch.cred ??= credProp ? ctx.credential() : Promise.resolve({}); // the credential is opened once per node run
      const cred = await ctx.scratch.cred;
      const values = {};
      for (const f of op.fields ?? []) values[f.name] = await ctx.param(key(op, f), i);
      return { op, req: buildRequest(cred, op, (f) => values[f.name]) };
    },
    async runPrepared(ctx, p) {
      const data = await send(p.req, ctx.signal);
      if (data === '' || data === undefined || data === null) return { ok: true };
      return toRows(data, p.op.result);
    },
    async loadOptions(ctx, propName) {
      const op = spec.operations.find((o) => propName.startsWith(`${o.id}__`));
      const f = op?.fields.find((x) => key(op, x) === propName);
      const src = f?.options;
      if (!src || Array.isArray(src)) return [];
      const cred = credProp ? await ctx.credential() : {};
      if (credProp && !ctx.param('credential')) throw new Error('Pick a credential first');
      const lookup = { id: `${op.id}-options`, label: f.label || f.name, method: 'GET', path: src.from, fields: [] };
      // {placeholders} in the list address come from other fields of the same operation (e.g. the Trello board for its lists)
      const needed = [...src.from.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const filled = {};
      for (const n of needed) {
        const other = op.fields.find((x) => x.name === n);
        const v = ctx.param(key(op, other ?? { name: n }));
        if (v === undefined || v === '') throw new Error(`Pick "${other?.label || n}" first`);
        filled[n] = v;
        lookup.fields.push({ name: n, in: 'path', raw: true });
      }
      const data = await call(cred, lookup, (x) => filled[x.name]);
      return toRows(data, src.result).map((r) => ({ value: String(get(r, src.value ?? 'id') ?? ''), label: String(get(r, src.label ?? 'name') ?? get(r, src.value ?? 'id') ?? '') })).filter((o) => o.value);
    },
  });
}
