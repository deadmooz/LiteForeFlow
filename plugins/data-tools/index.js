import crypto from 'node:crypto';

/** Reads "a.b.c" out of an object. */
const pick = (obj, path) => String(path ?? '').split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
const put = (obj, path, value) => {
  const keys = String(path).split('.').filter(Boolean);
  const out = { ...obj };
  let cur = out;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) cur[k] = value;
    else { cur[k] = { ...(cur[k] && typeof cur[k] === 'object' ? cur[k] : {}) }; cur = cur[k]; }
  });
  return out;
};
const opt = (value, label) => ({ value, label });
/** JSON with the keys in a fixed order, so {a:1,b:2} and {b:2,a:1} count as the same item. */
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

export function register(sdk) {
  /* ---------------------------------- Filter ---------------------------------- */
  sdk.defineNode({
    type: 'tools.filter', name: 'Filter', group: 'logic', icon: '🧹',
    description: 'Keep only the items that match your conditions; the rest are dropped.',
    properties: [
      { name: 'conditions', label: 'Keep items where', type: 'conditions', default: [{ left: '{{ $json.value }}', op: 'equals', right: '' }] },
      { name: 'combine', label: 'Match', type: 'options', default: 'all', options: [opt('all', 'All conditions'), opt('any', 'Any condition')] },
    ],
    async execute(ctx, inputs) {
      const kept = [];
      for (let i = 0; i < inputs[0].length; i += 1) {
        if (await sdk.checkConditions(await ctx.param('conditions', i), ctx.rawParam('combine'), ctx.sandbox)) kept.push(inputs[0][i]);
      }
      return [kept];
    },
  });

  /* ----------------------------------- Sort ----------------------------------- */
  sdk.defineNode({
    type: 'tools.sort', name: 'Sort', group: 'data', icon: '↕️',
    description: 'Put the items in order by one of their fields.',
    properties: [
      { name: 'field', label: 'Sort by field', type: 'string', required: true, placeholder: 'price   (or customer.name)' },
      { name: 'direction', label: 'Order', type: 'options', default: 'asc', options: [opt('asc', 'Smallest / A first'), opt('desc', 'Largest / Z first')] },
      { name: 'kind', label: 'The field holds', type: 'options', default: 'auto', options: [opt('auto', 'Work it out'), opt('number', 'Numbers'), opt('text', 'Text'), opt('date', 'Dates')] },
    ],
    async execute(ctx, inputs) {
      const field = ctx.rawParam('field');
      if (!field) throw new Error('Tell the Sort node which field to sort by');
      const kind = ctx.rawParam('kind');
      const dir = ctx.rawParam('direction') === 'desc' ? -1 : 1;
      const key = (item) => {
        const v = pick(item.json, field);
        if (kind === 'number') return v === '' || v == null ? NaN : Number(v);
        if (kind === 'date') return v === '' || v == null ? NaN : new Date(v).getTime();
        if (kind === 'text') return String(v ?? '');
        return typeof v === 'number' ? v : (v !== '' && v != null && !Number.isNaN(Number(v)) ? Number(v) : String(v ?? ''));
      };
      const sorted = [...inputs[0]].sort((a, b) => {
        const x = key(a); const y = key(b);
        // empty values always go last, whatever the direction
        const xe = x === '' || x == null || Number.isNaN(x); const ye = y === '' || y == null || Number.isNaN(y);
        if (xe || ye) return xe === ye ? 0 : xe ? 1 : -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' }) * dir;
      });
      return [sorted];
    },
  });

  /* ------------------------------ Remove Duplicates ------------------------------ */
  sdk.defineNode({
    type: 'tools.unique', name: 'Remove Duplicates', group: 'data', icon: '♻️',
    description: 'Drop repeated items. Compare one field (for example email), or whole items.',
    properties: [
      { name: 'field', label: 'Compare field', type: 'string', placeholder: 'email   (empty = compare whole items)' },
      { name: 'keep', label: 'Keep', type: 'options', default: 'first', options: [opt('first', 'The first one'), opt('last', 'The last one')] },
    ],
    async execute(ctx, inputs) {
      const field = ctx.rawParam('field');
      const seen = new Map();
      inputs[0].forEach((item, idx) => {
        const k = stable(field ? pick(item.json, field) : item.json);
        if (!seen.has(k) || ctx.rawParam('keep') === 'last') seen.set(k, idx);
      });
      return [[...seen.values()].sort((a, b) => a - b).map((idx) => inputs[0][idx])];
    },
  });

  /* ------------------------------- Split into Batches ------------------------------- */
  sdk.defineNode({
    type: 'tools.chunk', name: 'Split into Batches', group: 'data', icon: '📦',
    description: 'Group items into batches of a set size. Each batch leaves as one item: { batch, total, items: [...] }.',
    properties: [{ name: 'size', label: 'Batch size', type: 'number', default: 10, required: true }],
    async execute(ctx, inputs) {
      const size = Math.max(1, Math.floor(Number(ctx.rawParam('size')) || 10));
      const all = inputs[0].map((i) => i.json);
      const total = Math.ceil(all.length / size);
      const out = [];
      for (let b = 0; b < total; b += 1) out.push({ json: { batch: b + 1, total, items: all.slice(b * size, (b + 1) * size) } });
      return [out];
    },
  });

  /* -------------------------------- Date & Time -------------------------------- */
  const UNITS = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 };
  const FORMATS = [
    opt('iso', '2026-03-05T14:30:00.000Z (ISO)'), opt('date', '2026-03-05 (date)'), opt('time', '14:30 (time)'),
    opt('datetime', '2026-03-05 14:30'), opt('long', '5 March 2026'), opt('unix', 'Unix seconds'), opt('ms', 'Milliseconds'),
  ];
  const addMonths = (d, n) => { const r = new Date(d); const day = r.getUTCDate(); r.setUTCDate(1); r.setUTCMonth(r.getUTCMonth() + n); r.setUTCDate(Math.min(day, new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate())); return r; };
  const parts = (d, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((p) => [p.type, p.value]));
  const formatDate = (d, fmt, tz) => {
    const p = parts(d, tz);
    switch (fmt) {
      case 'date': return `${p.year}-${p.month}-${p.day}`;
      case 'time': return `${p.hour}:${p.minute}`;
      case 'datetime': return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
      case 'long': return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(d);
      case 'unix': return Math.floor(d.getTime() / 1000);
      case 'ms': return d.getTime();
      default: return d.toISOString();
    }
  };
  sdk.defineNode({
    type: 'tools.dateTime', name: 'Date & Time', group: 'data', icon: '🗓️',
    description: 'Get the current time, add or subtract time, change how a date looks, or count the time between two dates.',
    properties: [
      { name: 'operation', label: 'What to do', type: 'options', default: 'format', options: [opt('now', 'Get the current date and time'), opt('format', 'Change how a date looks'), opt('add', 'Add time to a date'), opt('subtract', 'Subtract time from a date'), opt('diff', 'Time between two dates')] },
      { name: 'date', label: 'Date', type: 'string', default: '{{ $now }}', showIf: { operation: ['format', 'add', 'subtract', 'diff'] }, help: 'Any date text, for example 2026-03-05 or {{ $json.createdAt }}.' },
      { name: 'amount', label: 'Amount', type: 'number', default: 1, showIf: { operation: ['add', 'subtract'] } },
      { name: 'unit', label: 'Unit', type: 'options', default: 'days', options: ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'], showIf: { operation: ['add', 'subtract', 'diff'] } },
      { name: 'other', label: 'Other date', type: 'string', default: '{{ $now }}', showIf: { operation: 'diff' }, help: 'The result is (other date − date).' },
      { name: 'format', label: 'Show it as', type: 'options', default: 'iso', options: FORMATS, showIf: { operation: ['now', 'format', 'add', 'subtract'] } },
      { name: 'timezone', label: 'Timezone', type: 'timezone', default: 'UTC', showIf: { operation: ['now', 'format', 'add', 'subtract'] } },
      { name: 'outputField', label: 'Save the result in field', type: 'string', default: 'date' },
    ],
    async executeItem(ctx, item, i) {
      const op = ctx.rawParam('operation');
      const read = async (name) => {
        const raw = await ctx.param(name, i);
        let d;
        if (raw === '' || raw == null) d = new Date();
        else if (typeof raw === 'number') d = new Date(raw < 1e11 ? raw * 1000 : raw); // seconds or milliseconds
        else if (typeof raw === 'string' && /^\d{9,13}$/.test(raw)) d = new Date(Number(raw) * (raw.length <= 10 ? 1000 : 1));
        else d = new Date(raw);
        if (Number.isNaN(d.getTime())) throw new Error(`"${raw}" is not a date I understand. Try 2026-03-05 or 2026-03-05T14:30:00Z`);
        return d;
      };
      const tz = ctx.rawParam('timezone') || 'UTC';
      try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw new Error(`"${tz}" is not a timezone I know. Pick one from the list, for example UTC or Asia/Kolkata.`); }
      let result;
      if (op === 'now') result = formatDate(new Date(), ctx.rawParam('format'), tz);
      else if (op === 'format') result = formatDate(await read('date'), ctx.rawParam('format'), tz);
      else if (op === 'add' || op === 'subtract') {
        const n = Number(await ctx.param('amount', i)) * (op === 'add' ? 1 : -1);
        if (!Number.isFinite(n)) throw new Error('Amount must be a number, for example 3');
        const unit = ctx.rawParam('unit');
        const base = await read('date');
        const moved = unit === 'months' ? addMonths(base, n) : unit === 'years' ? addMonths(base, n * 12) : new Date(base.getTime() + n * UNITS[unit]);
        result = formatDate(moved, ctx.rawParam('format'), tz);
      } else {
        const ms = (await read('other')).getTime() - (await read('date')).getTime();
        const unit = ctx.rawParam('unit');
        result = unit === 'months' ? +(ms / 2629800000).toFixed(2) : unit === 'years' ? +(ms / 31557600000).toFixed(2) : +(ms / UNITS[unit]).toFixed(2);
      }
      return put(item.json, ctx.rawParam('outputField') || 'date', result);
    },
  });

  /* ----------------------------------- Crypto ----------------------------------- */
  sdk.defineNode({
    type: 'tools.crypto', name: 'Crypto', group: 'data', icon: '🔐',
    description: 'Hash or sign text (SHA-256, HMAC), make a UUID or random text, and convert to or from base64.',
    properties: [
      { name: 'operation', label: 'What to do', type: 'options', default: 'hash', options: [opt('hash', 'Hash text'), opt('hmac', 'Sign text with a secret (HMAC)'), opt('base64Encode', 'Text → base64'), opt('base64Decode', 'Base64 → text'), opt('uuid', 'Make a UUID'), opt('random', 'Make random text')] },
      { name: 'value', label: 'Text', type: 'string', default: '{{ $json.text }}', showIf: { operation: ['hash', 'hmac', 'base64Encode', 'base64Decode'] } },
      { name: 'algorithm', label: 'Algorithm', type: 'options', default: 'sha256', options: ['sha256', 'sha512', 'sha1', 'md5'], showIf: { operation: ['hash', 'hmac'] } },
      { name: 'secret', label: 'Secret', type: 'string', showIf: { operation: 'hmac' }, help: 'Stored inside the workflow. For real secrets, keep them in a credential and use an HTTP node instead.' },
      { name: 'encoding', label: 'Result as', type: 'options', default: 'hex', options: ['hex', 'base64'], showIf: { operation: ['hash', 'hmac'] } },
      { name: 'length', label: 'Length', type: 'number', default: 16, showIf: { operation: 'random' } },
      { name: 'outputField', label: 'Save the result in field', type: 'string', default: 'result' },
    ],
    async executeItem(ctx, item, i) {
      const op = ctx.rawParam('operation');
      const text = op === 'uuid' || op === 'random' ? '' : String(await ctx.param('value', i) ?? '');
      let result;
      const algorithm = ctx.rawParam('algorithm');
      if ((op === 'hash' || op === 'hmac') && !['sha256', 'sha512', 'sha1', 'md5'].includes(algorithm)) throw new Error(`The algorithm "${algorithm}" is not supported. Use sha256, sha512, sha1 or md5.`);
      if (op === 'hash') result = crypto.createHash(algorithm).update(text).digest(ctx.rawParam('encoding'));
      else if (op === 'hmac') {
        if (!ctx.rawParam('secret')) throw new Error('HMAC needs a secret');
        result = crypto.createHmac(ctx.rawParam('algorithm'), String(await ctx.param('secret', i))).update(text).digest(ctx.rawParam('encoding'));
      } else if (op === 'base64Encode') result = Buffer.from(text, 'utf8').toString('base64');
      else if (op === 'base64Decode') result = Buffer.from(text, 'base64').toString('utf8');
      else if (op === 'uuid') result = crypto.randomUUID();
      else result = crypto.randomBytes(Math.ceil(Math.min(256, Math.max(1, Number(ctx.rawParam('length')) || 16)) / 2)).toString('hex').slice(0, Math.min(256, Math.max(1, Number(ctx.rawParam('length')) || 16)));
      return put(item.json, ctx.rawParam('outputField') || 'result', result);
    },
  });
}
