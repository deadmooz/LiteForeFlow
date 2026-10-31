import { httpRequest } from './http.js';
import { config } from './config.js';

const secret = (name, label, extra = {}) => ({ name, label, type: 'password', required: true, ...extra });
const text = (name, label, extra = {}) => ({ name, label, type: 'string', required: true, ...extra });

export const credentialTypes = [
  { id: 'httpBearer', name: 'HTTP Bearer Token', fields: [secret('token', 'Token')] },
  { id: 'httpBasic', name: 'HTTP Basic Auth', fields: [text('user', 'Username'), secret('password', 'Password')] },
  { id: 'httpHeader', name: 'HTTP Header Auth', fields: [text('name', 'Header name', { placeholder: 'X-API-Key' }), secret('value', 'Header value')] },
  {
    id: 'slackApi', name: 'Slack (Bot token)', fields: [secret('token', 'Bot token (xoxb-…)')],
    setup: ['Go to https://api.slack.com/apps and create an app (From scratch).', 'Open OAuth & Permissions, add the "chat:write" scope, then Install to Workspace.', 'Copy the "Bot User OAuth Token" (starts with xoxb-) and paste it here.', 'In Slack, invite the bot to the channel: /invite @YourBot'],
  },
  {
    id: 'telegramApi', name: 'Telegram Bot', fields: [secret('token', 'Bot token')],
    setup: ['In Telegram, chat with @BotFather and send /newbot.', 'Follow the questions; it replies with a token like 123456:ABC-DEF…', 'Paste the token here. Send your bot a message once so it can reply to you.'],
  },
  { id: 'discordWebhook', name: 'Discord Webhook', fields: [secret('url', 'Webhook URL')] },
  {
    id: 'notionApi', name: 'Notion', fields: [secret('token', 'Integration token')],
    setup: ['Open https://www.notion.so/profile/integrations and click New integration.', 'Copy the "Internal Integration Secret" and paste it here.', 'IMPORTANT: in Notion open your database, click ⋯ → Connections → add your integration. Notion only shows what you share with it.'],
  },
  { id: 'airtableApi', name: 'Airtable', fields: [secret('token', 'Personal access token')] },
  { id: 'stripeApi', name: 'Stripe', fields: [secret('secretKey', 'Secret key')] },
  { id: 'hubspotApi', name: 'HubSpot', fields: [secret('token', 'Private app token')] },
  { id: 'openaiApi', name: 'OpenAI (or compatible)', setup: ['Create a key at https://platform.openai.com/api-keys and paste it here.', 'Using Groq, Together, LM Studio or another compatible service? Put its address (ending in /v1) in Base URL.'], fields: [secret('apiKey', 'API key'), text('baseUrl', 'Base URL', { required: false, placeholder: 'https://api.openai.com/v1' })] },
  { id: 'anthropicApi', name: 'Anthropic', fields: [secret('apiKey', 'API key'), text('baseUrl', 'Base URL', { required: false, placeholder: 'https://api.anthropic.com' })] },
  {
    id: 'ollamaApi', name: 'Ollama (local AI)',
    setup: ['Install Ollama from https://ollama.com/download and start it.', 'Download a model once, for example: ollama pull llama3.2', 'Running Ollama on this computer? Leave everything empty and just press Test connection.'],
    fields: [
      text('baseUrl', 'Ollama address', { required: false, placeholder: 'http://localhost:11434' }),
      secret('apiKey', 'API key (only if Ollama sits behind a proxy that asks for one)', { required: false }),
    ],
  },
  {
    id: 'postgres', name: 'Postgres',
    fields: [
      text('host', 'Host'), text('port', 'Port', { placeholder: '5432', required: false }), text('database', 'Database'),
      text('user', 'User'), secret('password', 'Password', { required: false }),
      { name: 'ssl', label: 'Use SSL', type: 'boolean', required: false },
    ],
  },
  {
    id: 'smtp', name: 'SMTP (Email)',
    fields: [
      text('host', 'Host'), text('port', 'Port', { placeholder: '587' }), text('user', 'User', { required: false }),
      secret('password', 'Password', { required: false }), text('from', 'Default From address', { placeholder: 'you@example.com' }),
      { name: 'secure', label: 'Use TLS (port 465)', type: 'boolean', required: false },
    ],
  },
  {
    id: 'googleServiceAccount', name: 'Google Service Account',
    fields: [{ name: 'json', label: 'Service account JSON key', type: 'text', required: true }],
  },
];

export const getCredentialType = (id) => credentialTypes.find((t) => t.id === id);

/** Plugins add their own credential types; switching a plugin off removes them again. */
export function addCredentialType(def) {
  if (getCredentialType(def.id)) throw new Error(`Credential type "${def.id}" already exists`);
  credentialTypes.push(def);
}
export function removePluginCredentialTypes(pluginId) {
  for (let i = credentialTypes.length - 1; i >= 0; i -= 1) if (credentialTypes[i].plugin === pluginId) credentialTypes.splice(i, 1);
}

/* ---- "Test connection": one cheap, read-only call per service, answered in plain words ---- */
const trimUrl = (u) => String(u).replace(/\/$/, '');
const TESTS = {
  async notionApi(d) {
    const h = { authorization: `Bearer ${d.token}`, 'Notion-Version': '2022-06-28' };
    const me = await httpRequest({ url: `${config.notionUrl}/v1/users/me`, headers: h, timeoutMs: 15000 });
    const found = await httpRequest({ method: 'POST', url: `${config.notionUrl}/v1/search`, headers: h, body: { filter: { property: 'object', value: 'database' }, page_size: 25 }, timeoutMs: 15000 });
    const n = found.data.results?.length ?? 0;
    return n
      ? `Connected${me.data.name ? ` as "${me.data.name}"` : ''}. ${n} database${n === 1 ? ' is' : 's are'} shared with it.`
      : { ok: true, warn: true, message: 'The token works, but no database is shared with it yet. In Notion open your database, click ⋯ → Connections and add this integration.' };
  },
  async slackApi(d) {
    const r = await httpRequest({ method: 'POST', url: 'https://slack.com/api/auth.test', headers: { authorization: `Bearer ${d.token}` }, timeoutMs: 15000 });
    if (!r.data.ok) throw new Error(`Slack says: ${r.data.error}`);
    return `Connected to ${r.data.team} as ${r.data.user}.`;
  },
  async telegramApi(d) {
    const r = await httpRequest({ url: `https://api.telegram.org/bot${d.token}/getMe`, timeoutMs: 15000, ignoreStatus: true });
    if (!r.data?.ok) throw new Error(r.data?.description || 'Telegram did not accept this token');
    return `Connected to bot @${r.data.result.username}.`;
  },
  async openaiApi(d) {
    const base = trimUrl(d.baseUrl || 'https://api.openai.com/v1');
    const r = await httpRequest({ url: `${base}/models`, headers: { authorization: `Bearer ${d.apiKey}` }, timeoutMs: 15000 });
    const n = r.data?.data?.length;
    return n ? `Connected. ${n} models available.` : 'Connected.';
  },
  async anthropicApi(d) {
    const base = trimUrl(d.baseUrl || 'https://api.anthropic.com');
    await httpRequest({ url: `${base}/v1/models`, headers: { 'x-api-key': d.apiKey, 'anthropic-version': '2023-06-01' }, timeoutMs: 15000 });
    return 'Connected.';
  },
  async ollamaApi(d) {
    const base = trimUrl(d.baseUrl || config.ollamaUrl);
    let r;
    try {
      r = await httpRequest({ url: `${base}/api/tags`, headers: d.apiKey ? { authorization: `Bearer ${d.apiKey}` } : {}, timeoutMs: 8000, trustedOrigin: config.ollamaUrl });
    } catch (e) {
      if (e.message === 'fetch failed') throw new Error(`Could not reach Ollama at ${base}. Is it running? Open the Ollama app (or run "ollama serve").`);
      throw e;
    }
    const names = (r.data?.models ?? []).map((m) => m.name);
    return names.length
      ? `Connected. Installed models: ${names.join(', ')}.`
      : { ok: true, warn: true, message: 'Ollama is running, but no model is installed yet. Run: ollama pull llama3.2' };
  },
};

/** Runs the type's connection test. Always resolves: { ok, message, warn? }. Plugin types may bring their own `test(data)`. */
export async function testCredential(typeId, data) {
  const type = getCredentialType(typeId);
  if (!type) return { ok: false, message: `Unknown credential type "${typeId}"` };
  const err = validateCredentialData(typeId, data);
  if (err) return { ok: false, message: err };
  const fn = type.test ? type.test.bind(type) : TESTS[typeId];
  if (!fn) return { ok: true, message: 'Saved. There is no automatic test for this type; run a workflow to try it.', untested: true };
  try {
    const r = await fn(data);
    return typeof r === 'string' ? { ok: true, message: r } : r;
  } catch (e) {
    const status = e.response?.status;
    const hint = status === 401 || status === 403 ? ' The key or token was rejected.' : '';
    return { ok: false, message: `${String(e.message).split('\n')[0].slice(0, 220)}${hint}` };
  }
}

export function validateCredentialData(typeId, data) {
  const type = getCredentialType(typeId);
  if (!type) return `Unknown credential type "${typeId}"`;
  for (const f of type.fields) {
    if (f.required && (data[f.name] === undefined || data[f.name] === '')) return `Missing field: ${f.label}`;
  }
  if (typeId === 'googleServiceAccount') {
    try {
      const k = JSON.parse(data.json);
      if (!k.client_email || !k.private_key) return 'Service account JSON must contain client_email and private_key';
    } catch { return 'Service account JSON is not valid JSON'; }
  }
  return null;
}
