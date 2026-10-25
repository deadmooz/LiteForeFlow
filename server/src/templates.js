/* Starter workflows. Credentials are intentionally left blank — users pick their own after import. */

const n = (id, type, name, parameters = {}, extra = {}) => ({ id, type, name, parameters, ...extra });
const link = (from, to, fromOutput = 0, toInput = 0) => ({ from, fromOutput, to, toInput });

/** Lays nodes out left-to-right and links them in sequence unless explicit links are given. */
function flow(nodes, links) {
  const placed = nodes.map((node, i) => ({ ...node, position: node.position ?? { x: 80 + i * 280, y: 160 } }));
  const connections = links ?? placed.slice(1).map((node, i) => link(placed[i].id, node.id));
  return { nodes: placed, connections };
}
const at = (x, y) => ({ position: { x, y } });
const webhook = (path, extra = {}) => n('t', 'trigger.webhook', 'Webhook', { path, method: 'POST', respond: 'immediately', ...extra });
const cronAt = (expr) => n('t', 'trigger.cron', 'Schedule', { cron: expr, timezone: 'UTC' });

export const templates = [
  {
    id: 'webhook-slack-alert', name: 'Webhook → Slack alert', category: 'Notifications',
    description: 'Post any incoming webhook payload to a Slack channel.',
    definition: flow([
      webhook('slack-alert'),
      n('s', 'app.slack', 'Slack', { channel: '#alerts', text: 'New event: {{ $json.body.message }}' }),
    ]),
  },
  {
    id: 'daily-digest-slack', name: 'Daily API digest to Slack', category: 'Reporting',
    description: 'Every weekday at 9:00, fetch JSON from an API and post a summary to Slack.',
    definition: flow([
      cronAt('0 9 * * 1-5'),
      n('h', 'http.request', 'Fetch data', { url: 'https://api.github.com/repos/n8n-io/n8n', method: 'GET' }),
      n('s', 'app.slack', 'Slack', { channel: '#general', text: '⭐ {{ $json.full_name }} has {{ $json.stargazers_count }} stars' }),
    ]),
  },
  {
    id: 'rss-discord', name: 'RSS → Discord', category: 'Content',
    description: 'Post every new blog or news entry to a Discord channel.',
    definition: flow([
      n('t', 'trigger.rss', 'RSS Feed', { url: 'https://hnrss.org/frontpage', intervalMinutes: 15 }),
      n('d', 'app.discord', 'Discord', { content: '📰 {{ $json.title }}\n{{ $json.link }}' }),
    ]),
  },
  {
    id: 'form-to-sheets', name: 'Form submission → Google Sheet', category: 'Data capture',
    description: 'Append every webhook form submission as a row in Google Sheets.',
    definition: flow([
      webhook('contact-form', { samplePayload: '{ "body": { "name": "Ada", "email": "ada@example.com" } }' }),
      n('g', 'app.googleSheets', 'Add row', { operation: 'appendRow', range: 'Sheet1', values: '["{{ $json.body.name }}", "{{ $json.body.email }}", "{{ $now }}"]' }),
    ]),
  },
  {
    id: 'lead-airtable-telegram', name: 'New lead → Airtable + Telegram', category: 'Sales',
    description: 'Save a lead in Airtable and ping your team on Telegram in parallel.',
    definition: flow(
      [
        webhook('new-lead', { samplePayload: '{ "body": { "name": "Ada", "email": "ada@example.com" } }' }),
        n('a', 'app.airtable', 'Airtable', { operation: 'createRecord', fields: '{"Name": "{{ $json.body.name }}", "Email": "{{ $json.body.email }}"}' }, at(380, 60)),
        n('g', 'app.telegram', 'Telegram', { text: '🎯 New lead: {{ $json.body.name }} ({{ $json.body.email }})' }, at(380, 260)),
      ],
      [link('t', 'a'), link('t', 'g')],
    ),
  },
  {
    id: 'stripe-to-hubspot', name: 'Stripe customers → HubSpot contacts', category: 'Sales',
    description: 'Hourly, copy recent Stripe customers into HubSpot.',
    definition: flow([
      cronAt('0 * * * *'),
      n('s', 'app.stripe', 'Stripe', { operation: 'listCustomers', limit: 10 }),
      n('h', 'app.hubspot', 'HubSpot', { operation: 'createContact', email: '{{ $json.email }}', firstname: '{{ $json.name }}' }),
    ]),
  },
  {
    id: 'ai-triage', name: 'AI support triage', category: 'AI',
    description: 'Classify incoming support messages with an LLM and alert Slack when they are urgent.',
    definition: flow(
      [
        webhook('support', { samplePayload: '{ "body": { "message": "Our checkout is down!" } }' }),
        n('l', 'ai.llm', 'Classify', {
          provider: 'openai', system: 'Reply with JSON only: {"urgent": boolean, "summary": string}',
          prompt: '{{ $json.body.message }}', parseJson: true,
        }),
        n('i', 'logic.if', 'Urgent?', { conditions: [{ left: '{{ $json.parsed.urgent }}', op: 'isTrue', right: '' }], combine: 'all' }),
        n('s', 'app.slack', 'Alert Slack', { channel: '#support', text: '🚨 {{ $json.parsed.summary }}' }),
      ],
      [link('t', 'l'), link('l', 'i'), link('i', 's', 0)],
    ),
  },
  {
    id: 'rss-summarize-telegram', name: 'RSS → AI summary → Telegram', category: 'AI',
    description: 'Summarise each new article in two sentences and send it to Telegram.',
    definition: flow([
      n('t', 'trigger.rss', 'RSS Feed', { url: 'https://hnrss.org/frontpage', intervalMinutes: 30 }),
      n('l', 'ai.llm', 'Summarize', { provider: 'openai', prompt: 'Summarize in two sentences:\n{{ $json.title }}\n{{ $json.summary }}' }),
      n('g', 'app.telegram', 'Telegram', { text: '{{ $node["RSS Feed"].json.title }}\n\n{{ $json.text }}\n{{ $node["RSS Feed"].json.link }}' }),
    ]),
  },
  {
    id: 'weather-email-alert', name: 'Weather alert by email', category: 'Notifications',
    description: 'Check the temperature each morning and email if it is freezing.',
    definition: flow(
      [
        cronAt('0 7 * * *'),
        n('h', 'http.request', 'Weather', { url: 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true' }),
        n('i', 'logic.if', 'Freezing?', { conditions: [{ left: '{{ $json.current_weather.temperature }}', op: 'lt', right: '0' }], combine: 'all' }),
        n('e', 'app.email', 'Email', { to: 'you@example.com', subject: 'Freezing today', text: 'It is {{ $json.current_weather.temperature }}°C outside.' }),
      ],
      [link('t', 'h'), link('h', 'i'), link('i', 'e', 0)],
    ),
  },
  {
    id: 'webhook-notion', name: 'Webhook → Notion page', category: 'Data capture',
    description: 'Create a Notion database entry for each incoming request.',
    definition: flow([
      webhook('notion-inbox', { samplePayload: '{ "body": { "title": "Idea" } }' }),
      n('p', 'app.notion', 'Notion', { operation: 'createPage', titleProperty: 'Name', title: '{{ $json.body.title }}' }),
    ]),
  },
  {
    id: 'ai-agent-chat', name: 'AI agent chat endpoint', category: 'AI',
    description: 'An HTTP endpoint backed by an LLM agent that can browse a URL, do maths and tell the time.',
    definition: flow([
      webhook('agent', { respond: 'lastNode', samplePayload: '{ "body": { "message": "What is 17% of 2450?" } }' }),
      n('a', 'ai.agent', 'Agent', { provider: 'openai', prompt: '{{ $json.body.message }}', tools: '["http_get","calculator","current_time"]' }),
    ]),
  },
  {
    id: 'postgres-report-email', name: 'Daily SQL report by email', category: 'Reporting',
    description: 'Run a SQL query each morning, aggregate the rows and email them.',
    definition: flow([
      cronAt('0 8 * * *'),
      n('q', 'app.postgres', 'Query', { query: 'SELECT date_trunc(\'day\', created_at) AS day, count(*) AS signups FROM users GROUP BY 1 ORDER BY 1 DESC LIMIT 7', params: '[]' }),
      n('a', 'data.aggregate', 'Aggregate', { field: 'rows' }),
      n('e', 'app.email', 'Email', { to: 'team@example.com', subject: 'Daily signups', text: '{{ JSON.stringify($json.rows, null, 2) }}' }),
    ]),
  },
  {
    id: 'error-alert', name: 'Error alert (use as Error workflow)', category: 'Operations',
    description: 'Set this as another workflow\'s Error workflow to get a Slack message when it fails.',
    definition: flow([
      n('t', 'trigger.error', 'Error Trigger'),
      n('s', 'app.slack', 'Slack', { channel: '#ops', text: '❌ "{{ $json.workflow.name }}" failed at {{ $json.error.nodeName }}: {{ $json.error.message }}' }),
    ]),
  },
  {
    id: 'route-by-type', name: 'Route events by type', category: 'Notifications',
    description: 'Send "alert" events to Slack, "news" to Discord, and everything else to Telegram.',
    definition: flow(
      [
        webhook('events', { samplePayload: '{ "body": { "type": "alert", "text": "Disk almost full" } }' }),
        n('w', 'logic.switch', 'Switch', { value: '{{ $json.body.type }}', cases: '["alert","news"]' }, at(360, 160)),
        n('s', 'app.slack', 'Slack', { channel: '#alerts', text: '{{ $json.body.text }}' }, at(640, 20)),
        n('d', 'app.discord', 'Discord', { content: '{{ $json.body.text }}' }, at(640, 180)),
        n('g', 'app.telegram', 'Telegram', { text: '{{ $json.body.text }}' }, at(640, 340)),
      ],
      [link('t', 'w'), link('w', 's', 0), link('w', 'd', 1), link('w', 'g', 2)],
    ),
  },
  {
    id: 'api-to-sheets', name: 'API list → Google Sheet rows', category: 'Data capture',
    description: 'Fetch a JSON list from an API, split it into items and write each as a sheet row.',
    definition: flow([
      cronAt('0 6 * * *'),
      n('h', 'http.request', 'Fetch', { url: 'https://jsonplaceholder.typicode.com/users' }),
      n('x', 'data.splitOut', 'Split Out', { field: 'data' }),
      n('f', 'data.set', 'Pick fields', { fields: [{ name: 'name', value: '{{ $json.name }}' }, { name: 'email', value: '{{ $json.email }}' }], keepOthers: false }),
      n('g', 'app.googleSheets', 'Add row', { operation: 'appendRow', range: 'Sheet1', values: '["{{ $json.name }}", "{{ $json.email }}"]' }),
    ]),
  },
];

export const getTemplate = (id) => templates.find((t) => t.id === id);
