import crypto from 'node:crypto';
import { defineNode, credentialProperty } from './registry.js';
import { httpRequest, formEncode } from '../http.js';
import { config } from '../config.js';

/* Each integration is one declarative object. All of these call vendor REST APIs directly. */

const apiError = (e, pick) => {
  const d = e.response?.data;
  const msg = d && typeof d === 'object' ? pick(d) : null;
  if (msg) throw new Error(msg);
  throw e;
};

/* ----------------------------------- Slack ------------------------------------ */
defineNode({
  type: 'app.slack', name: 'Slack', group: 'app', icon: '💬', credentialType: 'slackApi',
  description: 'Post a message to a Slack channel.',
  properties: [
    credentialProperty('slackApi'),
    { name: 'channel', label: 'Channel (ID or #name)', type: 'string', required: true, placeholder: '#general' },
    { name: 'text', label: 'Message', type: 'text', required: true, default: 'Hello from LiteForeFlow' },
  ],
  async executeItem(ctx, item, i) {
    const { token } = await ctx.credential();
    const res = await httpRequest({
      method: 'POST', url: 'https://slack.com/api/chat.postMessage', headers: { authorization: `Bearer ${token}` },
      body: { channel: (await ctx.param('channel', i)), text: (await ctx.param('text', i)) },
    });
    if (!res.data.ok) throw new Error(`Slack error: ${res.data.error}`);
    return { ok: true, channel: res.data.channel, ts: res.data.ts };
  },
});

/* ---------------------------------- Telegram ---------------------------------- */
defineNode({
  type: 'app.telegram', name: 'Telegram', group: 'app', icon: '✈️', credentialType: 'telegramApi',
  description: 'Send a Telegram message from your bot.',
  properties: [
    credentialProperty('telegramApi'),
    { name: 'chatId', label: 'Chat ID', type: 'string', required: true },
    { name: 'text', label: 'Message', type: 'text', required: true },
    { name: 'parseMode', label: 'Parse mode', type: 'options', default: '', options: ['', 'Markdown', 'HTML'] },
  ],
  async executeItem(ctx, item, i) {
    const { token } = await ctx.credential();
    const pm = ctx.rawParam('parseMode');
    try {
      const res = await httpRequest({
        method: 'POST', url: `https://api.telegram.org/bot${token}/sendMessage`,
        body: { chat_id: (await ctx.param('chatId', i)), text: (await ctx.param('text', i)), ...(pm ? { parse_mode: pm } : {}) },
      });
      return { ok: true, messageId: res.data.result?.message_id };
    } catch (e) { return apiError(e, (d) => d.description && `Telegram error: ${d.description}`); }
  },
});

/* ----------------------------------- Discord ---------------------------------- */
defineNode({
  type: 'app.discord', name: 'Discord', group: 'app', icon: '🎮', credentialType: 'discordWebhook',
  description: 'Post a message to a Discord channel via webhook.',
  properties: [
    credentialProperty('discordWebhook'),
    { name: 'content', label: 'Message', type: 'text', required: true },
    { name: 'username', label: 'Bot name (optional)', type: 'string' },
  ],
  async executeItem(ctx, item, i) {
    const { url } = await ctx.credential();
    const u = (await ctx.param('username', i));
    const res = await httpRequest({
      method: 'POST', url: `${url}${url.includes('?') ? '&' : '?'}wait=true`,
      body: { content: (await ctx.param('content', i)), ...(u ? { username: u } : {}) },
    });
    return { ok: true, id: res.data?.id };
  },
});

/* ----------------------------------- Notion ----------------------------------- */
const notionHeaders = (token) => ({ authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28' });
const notionTitle = (rich = []) => rich.map((t) => t.plain_text).join('') || '(untitled)';

// Column types the editor can fill in with a plain input, and how each is sent to Notion.
const NOTION_COLUMNS = {
  rich_text: { input: 'string', send: (v) => ({ rich_text: [{ text: { content: String(v) } }] }) },
  number: { input: 'number', send: (v) => ({ number: Number(v) }) },
  select: { input: 'options', send: (v) => ({ select: { name: String(v) } }) },
  status: { input: 'options', send: (v) => ({ status: { name: String(v) } }) },
  multi_select: { input: 'tags', send: (v) => ({ multi_select: String(v).split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name })) }) },
  checkbox: { input: 'boolean', send: (v) => ({ checkbox: v === true || v === 'true' }) },
  date: { input: 'date', send: (v) => ({ date: { start: String(v) } }) },
  url: { input: 'string', send: (v) => ({ url: String(v) }) },
  email: { input: 'string', send: (v) => ({ email: String(v) }) },
  phone_number: { input: 'string', send: (v) => ({ phone_number: String(v) }) },
};

/** Accepts a database id the way people actually have it: with dashes, or a whole link copied from the browser. */
export function cleanNotionId(value) {
  const s = String(value ?? '').trim();
  const dashed = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0].replace(/-/g, '');
  const plain = s.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i)?.[0];
  const id = dashed ?? plain;
  return id ? id.toLowerCase() : s;
}

const schemaCache = new Map(); // "token:databaseId" -> { at, schema }; a short cache so a 500-item run asks Notion once
async function notionSchema(token, databaseId, { fresh = false } = {}) {
  const k = `${token.slice(-8)}:${databaseId}`;
  const hit = schemaCache.get(k);
  if (!fresh && hit && Date.now() - hit.at < 30000) return hit.schema;
  const res = await httpRequest({ url: `${config.notionUrl}/v1/databases/${databaseId}`, headers: notionHeaders(token) });
  const schema = { title: notionTitle(res.data.title), properties: res.data.properties ?? {} };
  schemaCache.set(k, { at: Date.now(), schema });
  return schema;
}

defineNode({
  type: 'app.notion', name: 'Notion', group: 'app', icon: '📓', credentialType: 'notionApi',
  description: 'Add rows to a Notion database or read them. Pick the database and fill in its columns - no IDs or JSON to write.',
  properties: [
    credentialProperty('notionApi'),
    { name: 'operation', label: 'What to do', type: 'options', default: 'createPage', options: [{ value: 'createPage', label: 'Add a row to a database' }, { value: 'queryDatabase', label: 'Read rows from a database' }] },
    { name: 'databaseId', label: 'Database', type: 'options', dynamic: true, options: [], required: true, help: 'Only databases you shared with your integration (⋯ → Connections in Notion) appear here.' },
    { name: 'title', label: 'Title', type: 'string', showIf: { operation: 'createPage' }, help: 'The text for the row\'s title column.' },
    { name: 'columns', label: 'Columns', type: 'fields', fieldsFor: 'databaseId', showIf: { operation: 'createPage' } },
    { name: 'filter', label: 'Only rows matching (Notion filter JSON)', type: 'json', default: '', showIf: { operation: 'queryDatabase' }, advanced: true, help: 'Leave empty to read every row.' },
    { name: 'titleProperty', label: 'Title column name', type: 'string', default: '', showIf: { operation: 'createPage' }, advanced: true, help: 'Leave empty: it is found automatically.' },
    { name: 'properties', label: 'Extra columns (Notion JSON)', type: 'json', default: '{}', showIf: { operation: 'createPage' }, advanced: true, help: 'For column types the list above does not cover.' },
  ],
  async loadOptions(ctx) {
    const { token } = await ctx.credential();
    if (!token) throw new Error('Pick a Notion credential first');
    const res = await httpRequest({
      method: 'POST', url: `${config.notionUrl}/v1/search`, headers: notionHeaders(token), timeoutMs: 20000,
      body: { filter: { property: 'object', value: 'database' }, page_size: 100 },
    });
    const list = (res.data.results ?? []).map((d) => ({ value: d.id, label: notionTitle(d.title) }));
    if (!list.length) throw new Error('No database is shared with this integration yet. In Notion open your database, click ⋯ → Connections and add it.');
    return list;
  },
  async loadFields(ctx) {
    const { token } = await ctx.credential();
    const db = cleanNotionId(ctx.param('databaseId'));
    if (!token || !db) return [];
    const { properties } = await notionSchema(token, db, { fresh: true }); // the editor must show a column you just added in Notion
    return Object.entries(properties)
      .filter(([, p]) => NOTION_COLUMNS[p.type])
      .map(([name, p]) => ({
        name, label: name, type: NOTION_COLUMNS[p.type].input,
        options: (p[p.type]?.options ?? []).map((o) => o.name),
      }));
  },
  async executeItem(ctx, item, i) {
    const { token } = await ctx.credential();
    const db = cleanNotionId(await ctx.param('databaseId', i));
    if (!db) throw new Error('Pick a database first');
    try {
      if (ctx.rawParam('operation') === 'queryDatabase') {
        const filter = (await ctx.jsonParam('filter', i));
        const res = await httpRequest({
          method: 'POST', url: `${config.notionUrl}/v1/databases/${db}/query`, headers: notionHeaders(token), body: filter ? { filter } : {},
        });
        return res.data.results.map((p) => ({ id: p.id, url: p.url, properties: p.properties }));
      }
      const { properties: schema } = await notionSchema(token, db);
      const titleName = ctx.rawParam('titleProperty') || Object.keys(schema).find((k) => schema[k].type === 'title') || 'Name';
      const properties = { ...((await ctx.jsonParam('properties', i)) ?? {}) };
      const columns = (await ctx.param('columns', i)) ?? {};
      for (const [name, v] of Object.entries(columns)) {
        if (v === '' || v === undefined || v === null) continue;
        const kind = NOTION_COLUMNS[schema[name]?.type];
        if (!kind) throw new Error(`The database has no fillable column called "${name}"`);
        if (kind.input === 'number' && !Number.isFinite(Number(v))) throw new Error(`The column "${name}" needs a number, but got "${v}"`);
        properties[name] = kind.send(v);
      }
      properties[titleName] = { title: [{ text: { content: String((await ctx.param('title', i)) ?? '') } }] };
      const res = await httpRequest({
        method: 'POST', url: `${config.notionUrl}/v1/pages`, headers: notionHeaders(token),
        body: { parent: { database_id: db }, properties },
      });
      return { id: res.data.id, url: res.data.url };
    } catch (e) { return apiError(e, (d) => d.message && `Notion error: ${d.message}`); }
  },
});

/* ---------------------------------- Airtable ---------------------------------- */
defineNode({
  type: 'app.airtable', name: 'Airtable', group: 'app', icon: '🗂️', credentialType: 'airtableApi',
  description: 'Create or list Airtable records.',
  properties: [
    credentialProperty('airtableApi'),
    { name: 'operation', label: 'Operation', type: 'options', default: 'createRecord', options: ['createRecord', 'listRecords'] },
    { name: 'baseId', label: 'Base ID', type: 'string', required: true, placeholder: 'appXXXXXXXX' },
    { name: 'table', label: 'Table name or ID', type: 'string', required: true },
    { name: 'fields', label: 'Fields (JSON)', type: 'json', default: '{\n  "Name": "{{ $json.name }}"\n}', showIf: { operation: 'createRecord' } },
    { name: 'filterByFormula', label: 'Filter formula (optional)', type: 'string', showIf: { operation: 'listRecords' } },
    { name: 'maxRecords', label: 'Max records', type: 'number', default: 50, showIf: { operation: 'listRecords' } },
  ],
  async executeItem(ctx, item, i) {
    const { token } = await ctx.credential();
    const url = `https://api.airtable.com/v0/${(await ctx.param('baseId', i))}/${encodeURIComponent((await ctx.param('table', i)))}`;
    const headers = { authorization: `Bearer ${token}` };
    try {
      if (ctx.rawParam('operation') === 'listRecords') {
        const res = await httpRequest({ url, headers, query: { filterByFormula: (await ctx.param('filterByFormula', i)) || undefined, maxRecords: (await ctx.param('maxRecords', i)) } });
        return res.data.records.map((r) => ({ id: r.id, ...r.fields }));
      }
      const res = await httpRequest({ method: 'POST', url, headers, body: { fields: (await ctx.jsonParam('fields', i)) ?? {}, typecast: true } });
      return { id: res.data.id, ...res.data.fields };
    } catch (e) { return apiError(e, (d) => d.error?.message && `Airtable error: ${d.error.message}`); }
  },
});

/* ----------------------------------- Stripe ----------------------------------- */
defineNode({
  type: 'app.stripe', name: 'Stripe', group: 'app', icon: '💳', credentialType: 'stripeApi',
  description: 'List or create customers, list recent payments.',
  properties: [
    credentialProperty('stripeApi'),
    { name: 'operation', label: 'Operation', type: 'options', default: 'listCustomers', options: ['listCustomers', 'createCustomer', 'listPayments'] },
    { name: 'limit', label: 'Limit', type: 'number', default: 10, showIf: { operation: ['listCustomers', 'listPayments'] } },
    { name: 'email', label: 'Email', type: 'string', showIf: { operation: 'createCustomer' } },
    { name: 'name', label: 'Name', type: 'string', showIf: { operation: 'createCustomer' } },
  ],
  async executeItem(ctx, item, i) {
    const { secretKey } = await ctx.credential();
    const headers = { authorization: `Bearer ${secretKey}` };
    const op = ctx.rawParam('operation');
    try {
      if (op === 'createCustomer') {
        const res = await httpRequest({
          method: 'POST', url: 'https://api.stripe.com/v1/customers', headers, bodyType: 'form',
          body: { email: (await ctx.param('email', i)), name: (await ctx.param('name', i)) },
        });
        return res.data;
      }
      const path = op === 'listPayments' ? 'payment_intents' : 'customers';
      const res = await httpRequest({ url: `https://api.stripe.com/v1/${path}`, headers, query: { limit: (await ctx.param('limit', i)) } });
      return res.data.data;
    } catch (e) { return apiError(e, (d) => d.error?.message && `Stripe error: ${d.error.message}`); }
  },
});

/* ----------------------------------- HubSpot ---------------------------------- */
defineNode({
  type: 'app.hubspot', name: 'HubSpot', group: 'app', icon: '🧲', credentialType: 'hubspotApi',
  description: 'Create or search HubSpot contacts.',
  properties: [
    credentialProperty('hubspotApi'),
    { name: 'operation', label: 'Operation', type: 'options', default: 'createContact', options: ['createContact', 'searchContacts'] },
    { name: 'email', label: 'Email', type: 'string', showIf: { operation: 'createContact' } },
    { name: 'firstname', label: 'First name', type: 'string', showIf: { operation: 'createContact' } },
    { name: 'lastname', label: 'Last name', type: 'string', showIf: { operation: 'createContact' } },
    { name: 'query', label: 'Search text', type: 'string', showIf: { operation: 'searchContacts' } },
  ],
  async executeItem(ctx, item, i) {
    const { token } = await ctx.credential();
    const headers = { authorization: `Bearer ${token}` };
    try {
      if (ctx.rawParam('operation') === 'searchContacts') {
        const res = await httpRequest({
          method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/contacts/search', headers,
          body: { query: (await ctx.param('query', i)), limit: 50 },
        });
        return res.data.results.map((r) => ({ id: r.id, ...r.properties }));
      }
      const properties = {};
      for (const k of ['email', 'firstname', 'lastname']) { const v = await ctx.param(k, i); if (v) properties[k] = v; }
      const res = await httpRequest({ method: 'POST', url: 'https://api.hubapi.com/crm/v3/objects/contacts', headers, body: { properties } });
      return { id: res.data.id, ...res.data.properties };
    } catch (e) { return apiError(e, (d) => d.message && `HubSpot error: ${d.message}`); }
  },
});

/* ---------------------------------- Postgres ---------------------------------- */
defineNode({
  type: 'app.postgres', name: 'Postgres', group: 'app', icon: '🐘', credentialType: 'postgres',
  description: 'Run a SQL query. Use $1, $2… placeholders with the parameters array — never paste values into SQL.',
  properties: [
    credentialProperty('postgres'),
    { name: 'query', label: 'SQL', type: 'code', default: 'SELECT * FROM my_table LIMIT 10', required: true },
    { name: 'params', label: 'Parameters (JSON array)', type: 'json', default: '[]' },
  ],
  async execute(ctx, inputs) {
    const c = await ctx.credential();
    let pg;
    try { pg = (await import('pg')).default; } catch { throw new Error('The Postgres node needs an extra package. Stop LiteForeFlow, run:  npm run scale-up  and start it again.'); }
    const client = new pg.Client({
      host: c.host, port: Number(c.port) || 5432, database: c.database, user: c.user, password: c.password,
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 10000,
    });
    await client.connect();
    try {
      const out = [];
      for (let i = 0; i < inputs[0].length; i += 1) {
        const params = (await ctx.jsonParam('params', i)) ?? [];
        const r = await client.query(ctx.rawParam('query'), params);
        if (r.rows.length) out.push(...r.rows.map((row) => ({ json: row })));
        else out.push({ json: { rowCount: r.rowCount } });
      }
      return [out];
    } finally { await client.end().catch(() => {}); }
  },
});

/* ----------------------------------- Email ------------------------------------ */
defineNode({
  type: 'app.email', name: 'Send Email (SMTP)', group: 'app', icon: '📧', credentialType: 'smtp',
  description: 'Send an email through any SMTP server (Gmail app password, SES, Mailgun, …).',
  properties: [
    credentialProperty('smtp'),
    { name: 'to', label: 'To', type: 'string', required: true },
    { name: 'subject', label: 'Subject', type: 'string', required: true },
    { name: 'text', label: 'Body (text)', type: 'text' },
    { name: 'html', label: 'Body (HTML, optional)', type: 'text' },
  ],
  async execute(ctx, inputs) {
    const c = await ctx.credential();
    const nodemailer = (await import('nodemailer')).default;
    const transport = nodemailer.createTransport({
      host: c.host, port: Number(c.port) || 587, secure: !!c.secure,
      auth: c.user ? { user: c.user, pass: c.password } : undefined,
    });
    const out = [];
    for (let i = 0; i < inputs[0].length; i += 1) {
      const info = await transport.sendMail({
        from: c.from, to: (await ctx.param('to', i)), subject: (await ctx.param('subject', i)),
        text: (await ctx.param('text', i)) || undefined, html: (await ctx.param('html', i)) || undefined,
      });
      out.push({ json: { messageId: info.messageId, accepted: info.accepted } });
    }
    return [out];
  },
});

/* -------------------------------- Google Sheets ------------------------------- */
const gTokenCache = new Map();
async function googleToken(serviceAccountJson, scope) {
  const key = JSON.parse(serviceAccountJson);
  const cacheKey = `${key.client_email}|${scope}`;
  const cached = gTokenCache.get(cacheKey);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.private_key).toString('base64url');
  const res = await httpRequest({
    method: 'POST', url: 'https://oauth2.googleapis.com/token', bodyType: 'form',
    body: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` },
  });
  gTokenCache.set(cacheKey, { token: res.data.access_token, exp: Date.now() + (res.data.expires_in ?? 3600) * 1000 });
  return res.data.access_token;
}

defineNode({
  type: 'app.googleSheets', name: 'Google Sheets', group: 'app', icon: '📊', credentialType: 'googleServiceAccount',
  description: 'Append rows to or read rows from a sheet. Share the sheet with the service account email first.',
  properties: [
    credentialProperty('googleServiceAccount'),
    { name: 'operation', label: 'Operation', type: 'options', default: 'appendRow', options: ['appendRow', 'getRows'] },
    { name: 'spreadsheetId', label: 'Spreadsheet ID', type: 'string', required: true, help: 'The long id in the sheet URL.' },
    { name: 'range', label: 'Sheet / range', type: 'string', default: 'Sheet1', help: 'e.g. Sheet1 or Sheet1!A:D' },
    { name: 'values', label: 'Row values (JSON array)', type: 'json', default: '["{{ $json.name }}", "{{ $json.email }}"]', showIf: { operation: 'appendRow' } },
  ],
  async executeItem(ctx, item, i) {
    const { json } = await ctx.credential();
    const op = ctx.rawParam('operation');
    const token = await googleToken(json, 'https://www.googleapis.com/auth/spreadsheets');
    const headers = { authorization: `Bearer ${token}` };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${(await ctx.param('spreadsheetId', i))}/values/${encodeURIComponent((await ctx.param('range', i)))}`;
    try {
      if (op === 'getRows') {
        const res = await httpRequest({ url: base, headers });
        const [head = [], ...rows] = res.data.values ?? [];
        return rows.map((r) => Object.fromEntries(head.map((h, idx) => [h, r[idx] ?? ''])));
      }
      const values = (await ctx.jsonParam('values', i));
      if (!Array.isArray(values)) throw new Error('Row values must be a JSON array');
      const res = await httpRequest({
        method: 'POST', url: `${base}:append`, headers, query: { valueInputOption: 'USER_ENTERED' }, body: { values: [values] },
      });
      return { updatedRange: res.data.updates?.updatedRange, updatedRows: res.data.updates?.updatedRows };
    } catch (e) { return apiError(e, (d) => d.error?.message && `Google Sheets error: ${d.error.message}`); }
  },
});
