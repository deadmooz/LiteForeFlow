import { uid } from './db.js';

/*
 * Best-effort converter from an exported n8n workflow (JSON) to a LiteForeFlow definition.
 * Returns the definition plus a compatibility report so users see exactly what needs attention.
 */

const T = 'n8n-nodes-base.';

/** `={{ $('Node').item.json.x }}` -> `{{ $node["Node"].json.x }}` etc. */
export function convertExpression(value) {
  if (typeof value === 'string') {
    let s = value.startsWith('=') ? value.slice(1) : value;
    s = s.replace(/\$\(\s*['"]([^'"]+)['"]\s*\)\.(?:item|first\(\)|last\(\))\.json/g, '$node["$1"].json');
    s = s.replace(/\$input\.item\.json/g, '$json');
    return s;
  }
  if (Array.isArray(value)) return value.map(convertExpression);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convertExpression(v)]));
  return value;
}

const kvToObject = (list) => JSON.stringify(Object.fromEntries((list ?? []).map((p) => [p.name, convertExpression(p.value)])));

function cronFromRule(p) {
  const rule = p.rule?.interval?.[0];
  if (!rule) return null;
  if (rule.expression) return rule.expression;
  if (rule.field === 'minutes') return `*/${rule.minutesInterval || 5} * * * *`;
  if (rule.field === 'hours') return `${rule.triggerAtMinute ?? 0} */${rule.hoursInterval || 1} * * *`;
  if (rule.field === 'days') return `${rule.triggerAtMinute ?? 0} ${rule.triggerAtHour ?? 0} */${rule.daysInterval || 1} * *`;
  if (rule.field === 'cronExpression') return rule.expression;
  return null;
}

const opMap = {
  equals: 'equals', notEquals: 'notEquals', contains: 'contains', notContains: 'notContains', startsWith: 'startsWith',
  endsWith: 'endsWith', gt: 'gt', gte: 'gte', lt: 'lt', lte: 'lte', empty: 'isEmpty', notEmpty: 'isNotEmpty', regex: 'regex',
  true: 'isTrue', false: 'isFalse', larger: 'gt', largerEqual: 'gte', smaller: 'lt', smallerEqual: 'lte',
};

function convertConditions(p) {
  const out = [];
  if (p.conditions?.conditions) {
    for (const c of p.conditions.conditions) {
      out.push({ left: convertExpression(c.leftValue), op: opMap[c.operator?.operation] ?? 'equals', right: convertExpression(c.rightValue ?? '') });
    }
  } else if (p.conditions) {
    for (const group of Object.values(p.conditions)) {
      if (!Array.isArray(group)) continue;
      for (const c of group) out.push({ left: convertExpression(c.value1), op: opMap[c.operation] ?? 'equals', right: convertExpression(c.value2 ?? '') });
    }
  }
  return { conditions: out, combine: p.combinator === 'or' || p.combineOperation === 'any' ? 'any' : 'all' };
}

const converters = {
  [`${T}manualTrigger`]: () => ({ type: 'trigger.manual', parameters: {} }),
  [`${T}webhook`]: (p) => ({
    type: 'trigger.webhook',
    parameters: { path: p.path || uid().slice(0, 8), method: p.httpMethod || 'POST', respond: p.responseMode === 'lastNode' ? 'lastNode' : 'immediately' },
  }),
  [`${T}scheduleTrigger`]: (p) => {
    const cron = cronFromRule(p);
    return { type: 'trigger.cron', parameters: { cron: cron || '0 * * * *' }, note: cron ? null : 'schedule could not be converted — defaulted to hourly' };
  },
  [`${T}httpRequest`]: (p) => ({
    type: 'http.request',
    parameters: {
      method: p.method || 'GET', url: convertExpression(p.url),
      headers: p.sendHeaders ? kvToObject(p.headerParameters?.parameters) : '{}',
      query: p.sendQuery ? kvToObject(p.queryParameters?.parameters) : '{}',
      body: p.sendBody ? (p.jsonBody ? convertExpression(p.jsonBody) : kvToObject(p.bodyParameters?.parameters)) : '',
      bodyType: 'json',
    },
    note: p.authentication && p.authentication !== 'none' ? 'authentication must be re-created as a credential' : null,
  }),
  [`${T}if`]: (p) => ({ type: 'logic.if', parameters: convertConditions(p) }),
  [`${T}set`]: (p) => {
    const fields = p.assignments?.assignments
      ? p.assignments.assignments.map((a) => ({ name: a.name, value: convertExpression(a.value) }))
      : Object.values(p.values ?? {}).flat().map((a) => ({ name: a.name, value: convertExpression(a.value) }));
    return { type: 'data.set', parameters: { fields, keepOthers: p.includeOtherFields !== false && p.keepOnlySet !== true } };
  },
  [`${T}code`]: (p) => ({
    type: 'data.code',
    parameters: { mode: p.mode === 'runOnceForEachItem' ? 'eachItem' : 'runOnce', code: p.jsCode ?? '' },
    note: 'review code: only synchronous JavaScript is supported',
  }),
  [`${T}merge`]: (p) => ({ type: 'logic.merge', parameters: { mode: p.mode === 'combine' ? 'combineByPosition' : 'append' } }),
  [`${T}wait`]: (p) => ({ type: 'logic.wait', parameters: { seconds: Number(p.amount) * ({ minutes: 60, hours: 3600 }[p.unit] ?? 1) || 1 } }),
  [`${T}splitOut`]: (p) => ({ type: 'data.splitOut', parameters: { field: p.fieldToSplitOut } }),
  [`${T}aggregate`]: () => ({ type: 'data.aggregate', parameters: {} }),
  [`${T}limit`]: (p) => ({ type: 'data.limit', parameters: { max: p.maxItems ?? 10 } }),
  [`${T}noOp`]: () => ({ type: 'logic.noop', parameters: {} }),
  [`${T}slack`]: (p) => ({
    type: 'app.slack', parameters: { channel: convertExpression(p.channelId?.value ?? p.channel ?? ''), text: convertExpression(p.text ?? '') },
    note: 'select a Slack credential',
  }),
  [`${T}telegram`]: (p) => ({ type: 'app.telegram', parameters: { chatId: convertExpression(p.chatId ?? ''), text: convertExpression(p.text ?? '') }, note: 'select a Telegram credential' }),
  [`${T}discord`]: (p) => ({ type: 'app.discord', parameters: { content: convertExpression(p.content ?? p.text ?? '') }, note: 'select a Discord webhook credential' }),
};

const IGNORED = new Set([`${T}stickyNote`]);

export function convertN8nWorkflow(src) {
  const wf = typeof src === 'string' ? JSON.parse(src) : src;
  if (!wf || !Array.isArray(wf.nodes)) throw new Error('This does not look like an n8n workflow export (missing "nodes").');

  const idByName = new Map();
  const nodes = [];
  const report = { total: 0, converted: 0, unsupported: [], notes: [] };

  for (const src of wf.nodes) {
    if (IGNORED.has(src.type)) continue;
    report.total += 1;
    const conv = converters[src.type];
    const id = uid();
    idByName.set(src.name, id);
    const [x, y] = src.position ?? [0, 0];
    if (!conv) {
      report.unsupported.push({ name: src.name, type: src.type.replace(T, '') });
      nodes.push({ id, type: 'logic.noop', name: src.name, parameters: {}, position: { x, y }, disabled: false, notes: `Unsupported n8n node: ${src.type}` });
      continue;
    }
    const c = conv(src.parameters ?? {});
    report.converted += 1;
    if (c.note) report.notes.push({ name: src.name, note: c.note });
    nodes.push({
      id, type: c.type, name: src.name, parameters: c.parameters, position: { x, y }, disabled: !!src.disabled,
      continueOnFail: src.onError === 'continueRegularOutput' || !!src.continueOnFail, retryOnFail: !!src.retryOnFail,
      maxTries: src.maxTries, waitBetweenTries: src.waitBetweenTries,
    });
  }

  const connections = [];
  for (const [fromName, byType] of Object.entries(wf.connections ?? {})) {
    (byType.main ?? []).forEach((targets, fromOutput) => {
      for (const t of targets ?? []) {
        if (idByName.has(fromName) && idByName.has(t.node)) {
          connections.push({ from: idByName.get(fromName), fromOutput, to: idByName.get(t.node), toInput: t.index ?? 0 });
        }
      }
    });
  }

  if (report.unsupported.length) {
    report.notes.push({ name: 'Unsupported nodes', note: `${report.unsupported.length} node(s) were replaced by No Operation placeholders. Use the HTTP Request node to call that service's API.` });
  }
  return { name: wf.name || 'Imported workflow', definition: { nodes, connections }, report };
}
