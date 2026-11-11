# LiteForeFlow - advanced guide

Everything here is optional. In this Docker edition the app only runs inside its containers (`docker compose up -d --build`);
starting `node` directly on your computer is refused. Developers can opt out with `LITEFOREFLOW_ALLOW_HOST=1`.
Set the variables below in `.env` (Compose passes them on) and run `docker compose up -d`.

## Settings (environment variables)

Put them in the `.env` file next to `docker-compose.yml`, for example `PORT=4000`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on. If you do not set it and 3000 is busy, the next free port is used |
| `DATA_DIR` | `./data` (next to the app) | Where the database and the encryption key live |
| `LITEFOREFLOW_SECRET` | auto-created in `data/.secret` | Master key for saved credentials and logins. **Back it up** - without it saved credentials cannot be read |
| `ALLOW_SIGNUP` | `true` | Set `false` after you created your account so nobody else can register |
| `BLOCK_PRIVATE_NETWORK` | `false` | `true` stops the HTTP node (and AI agent) reaching `localhost` / internal addresses. Turn on if others use your server |
| `OLLAMA_HOST` | `localhost:11434` | Where the Ollama local-AI server runs. Still reachable by the AI nodes when `BLOCK_PRIVATE_NETWORK=true`; other internal addresses stay blocked |
| `ITEM_CONCURRENCY` | `5` | How many items a read-only API block (HTTP Request GET, the REST connector's GET operations) may fetch at the same time (1-20). `1` = strictly one after another, polite to rate-limited services. POST/PUT/DELETE calls never overlap |
| `ALERT_COOLDOWN_MIN` | `10` | Failure alerts ("Tell me if this fails" in a workflow's settings): at most one message per workflow in this many minutes, so a broken schedule cannot flood you. The next message says how many were held back. `0` turns the limit off |
| `PLUGINS_DIR` | - | An extra folder to load plugins from (besides `plugins/` and `data/plugins/`). See [PLUGINS.md](PLUGINS.md) |
| `ENABLE_CODE_NODE` | `true` | `false` removes the Code node |
| `SAVE_SUCCESS_DATA` | `true` | `false` stores only a one-line record of successful runs (saves disk) |
| `MAX_CONCURRENCY` | `10` | Runs at the same time |
| `SANDBOX_MEMORY_MB` | `64` | Memory cap for each code/expression run (strong sandbox only) |
| `STRIPE_*` | - | Only for charging customers; see the source (`server/src/routes/resources.js`) |

## The code sandbox

Expressions (`{{ ... }}`) and the Code node run in `isolated-vm`: each run gets its own memory-capped V8 isolate on a separate thread. `/api/health` reports it.

## Sharing it with other people

By default LiteForeFlow listens on all network interfaces so you can reach it from your phone. Before letting others use it:
set `ALLOW_SIGNUP=false` (after creating your accounts), set `BLOCK_PRIVATE_NETWORK=true`,
and put it behind HTTPS (for example Caddy or nginx). Do not expose it to the internet as-is.

## Scaling up (optional): Postgres + Redis + several workers

This is what the **Docker edition** does out of the box: see [DOCKER.md](DOCKER.md). Without Docker you need a Postgres and a Redis
server that you run yourself (the packages `pg`, `bullmq` and `ioredis` are already installed in this edition).

Set `DATABASE_URL=postgres://user:pass@host:5432/dbname` (the database must be UTF8) and `REDIS_URL=redis://host:6379`.
Run one or more API processes and any number of workers:

```bash
docker compose up -d --scale worker=4      # the API plus as many workers as you like
```

The API only queues runs; workers execute them. Schedules are stored in Redis so they fire once however many API processes run.
A worker that crashes mid-run marks that run as failed and does **not** re-run it (to avoid duplicate side effects).
More tuning: `MAX_QUEUE_DEPTH`, `QUEUE_ENQUEUE_TIMEOUT_MS`, `PG_POOL_SIZE`, `PG_CONNECT_TIMEOUT_MS`, `WORKER_LOCK_MS`, `QUEUE_NAME`, `PG_SCHEMA`.

## Adding your own integration

A node is one object in `server/src/nodes/` (see `registry.js`). The editor form, credential picker and palette entry are generated for you:

```js
defineNode({
  type: 'app.example', name: 'Example', group: 'app', icon: '🧪', credentialType: 'exampleApi',
  properties: [credentialProperty('exampleApi'), { name: 'title', label: 'Title', type: 'string', required: true }],
  async executeItem(ctx, item, i) {
    const { token } = await ctx.credential();
    const res = await httpRequest({ method: 'POST', url: 'https://api.example.com/things',
      headers: { authorization: `Bearer ${token}` }, body: { title: await ctx.param('title', i) } });
    return res.data;
  },
});
```

Add the credential type to `server/src/credentialTypes.js` and import your file in `server/src/nodes/index.js`.

## Changing the editor

The editor source is in `web/`; the built result `web/dist/` is committed so end users never need a build step.
After changing the source: `npm run build` (installs the editor tooling the first time). For live reload: `npm run dev:web`
in one terminal and `npm run dev` in another, then open http://localhost:5173.

## Tests

```bash
npm test          # unit and integration tests (starts a throwaway Postgres container; Docker must be running)
```

Tests for the Postgres/Redis mode need running Postgres and Redis servers and `TEST_DATABASE_URL` / `TEST_REDIS_URL` set; `npm run test:all` then also runs the multi-process worker and plugin tests.

## Known limits

- Vendor integrations (Slack, Notion, Airtable, Stripe, HubSpot, Telegram, Discord) call the vendors' documented APIs
  but were not run against live accounts; email, HTTP, AI, Postgres and webhooks were.
- No OAuth sign-in flow yet (so no Gmail/Calendar nodes; use SMTP for email).
- No loops in the workflow graph (nodes already process every item; use *Split Out* for lists), no file/binary data, no version history.
- Postgres is the only database; the API and every worker share it.
