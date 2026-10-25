const secret = (name, label, extra = {}) => ({ name, label, type: 'password', required: true, ...extra });
const text = (name, label, extra = {}) => ({ name, label, type: 'string', required: true, ...extra });

export const credentialTypes = [
  { id: 'httpBearer', name: 'HTTP Bearer Token', fields: [secret('token', 'Token')] },
  { id: 'httpBasic', name: 'HTTP Basic Auth', fields: [text('user', 'Username'), secret('password', 'Password')] },
  { id: 'httpHeader', name: 'HTTP Header Auth', fields: [text('name', 'Header name', { placeholder: 'X-API-Key' }), secret('value', 'Header value')] },
  { id: 'slackApi', name: 'Slack (Bot token)', fields: [secret('token', 'Bot token (xoxb-…)')] },
  { id: 'telegramApi', name: 'Telegram Bot', fields: [secret('token', 'Bot token')] },
  { id: 'discordWebhook', name: 'Discord Webhook', fields: [secret('url', 'Webhook URL')] },
  { id: 'notionApi', name: 'Notion', fields: [secret('token', 'Integration token')] },
  { id: 'airtableApi', name: 'Airtable', fields: [secret('token', 'Personal access token')] },
  { id: 'stripeApi', name: 'Stripe', fields: [secret('secretKey', 'Secret key')] },
  { id: 'hubspotApi', name: 'HubSpot', fields: [secret('token', 'Private app token')] },
  { id: 'openaiApi', name: 'OpenAI (or compatible)', fields: [secret('apiKey', 'API key'), text('baseUrl', 'Base URL', { required: false, placeholder: 'https://api.openai.com/v1' })] },
  { id: 'anthropicApi', name: 'Anthropic', fields: [secret('apiKey', 'API key'), text('baseUrl', 'Base URL', { required: false, placeholder: 'https://api.anthropic.com' })] },
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
