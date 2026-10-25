# LiteForeFlow

A self-hostable workflow-automation tool: a cheaper, flat-priced alternative to n8n / Zapier. This is the **V1 MVP** — visual editor, reliable execution engine, 25+ nodes, templates, an n8n importer, and plan limits with a Stripe hook.

> **Pricing idea being tested:** a flat price per workspace. Runs are counted per workflow execution — never per step, node or loop iteration — and the `runsPerMonth` caps are a fair-use guardrail, not the billing unit. Numbers live in [`server/src/plans.js`](server/src/plans.js) and are hypotheses to validate with users.

## Quick start

Requires **Node 22.5+** (uses the built-in `node:sqlite`; no native modules to compile).

```bash
npm install
npm run build        # builds the editor into web/dist
npm start            # http://localhost:3000  (API + editor on one port)
```

Development with hot reload (API on :3000, editor on :5173):

```bash
npm run dev
```

Create an account on the login page, open **Templates**, and pick one — or build a workflow from scratch.

### Two ways to run it

| | Local / single node (default) | Production topology |
|---|---|---|
| Database | SQLite file in `DATA_DIR` | **Postgres** (`DATABASE_URL`) |
| Queue | in-process limiter + timers | **Redis + BullMQ** (`REDIS_URL`) |
| Processes | one (`LITEFOREFLOW_ROLE=all`) | any number of **API** (`api`) and **worker** (`worker`) processes |
| Code/expressions | isolated-vm V8 isolates (both) | same |

```bash
# production topology, by hand (needs Postgres with a UTF8 database, and Redis)
export DATABASE_URL=postgres://user:pass@host:5432/liteforeflow REDIS_URL=redis://host:6379 LITEFOREFLOW_SECRET=<64 hex chars>
LITEFOREFLOW_ROLE=api    npm start --prefix server      # HTTP, webhooks, enqueue, schedules
LITEFOREFLOW_ROLE=worker npm start --prefix server      # run as many of these as you need
# or with Docker:  LITEFOREFLOW_SECRET=... docker compose up --build --scale worker=3   (see "Not yet verified")
```

How it fits together:

- The **API** never runs user workflows. A webhook/editor run inserts an `executions` row (`queued`), puts a job on the BullMQ queue (job id = execution id, so it cannot be enqueued twice), and answers — or, for "respond with last node" and editor runs, waits for the worker's result.
- **Workers** claim the execution (`queued → running`, atomically), run the graph in V8 isolates, and write results back to Postgres. Sub-workflows run inline in the same worker slot, so workers can never deadlock waiting on each other.
- **Schedules** (cron, RSS polling) are BullMQ *job schedulers* stored in Redis, so they fire exactly once no matter how many API instances you run, survive restarts, and are removed on deactivation.
- **Crashes:** `maxStalledCount` is 0 — a workflow whose worker dies is marked `error` ("Worker failed: job stalled…") and is **not** re-run, because replaying a half-finished workflow could repeat side effects (double emails, double charges). A reaper also fails any execution stuck in `queued/running` for 2h.
- **Back-pressure:** new runs are refused with 503 when more than `MAX_QUEUE_DEPTH` jobs are waiting. Monthly run limits are enforced with an atomic `UPDATE … WHERE runs < cap`, so they hold across processes.
- Shutdown (`SIGTERM`) stops taking jobs and waits for in-flight ones (up to 30 s).

### Tests

```bash
npm test                                   # 14 tests on SQLite + in-process queue (no services needed)

# same suite on the production stack, plus multi-process tests with real worker processes:
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/liteforeflow TEST_REDIS_URL=redis://localhost:6379
npm test -w server && node --test --test-concurrency=1 server/test/distributed.test.js
```

Each run uses its own Postgres schema and queue name and cleans up after itself.

## What's in V1

| Area | Included |
|---|---|
| **Editor** | React Flow canvas, searchable palette (click to add + auto-connect, or drag), per-node form generated from the node's schema, `{{ expressions }}`, **Test this step**, per-node run data, status colours, webhook URL bar, Ctrl+S |
| **Triggers** | Manual, Webhook (path, method, shared secret, respond immediately / with last node), Schedule (cron + timezone), RSS polling, Error trigger |
| **Logic / data** | HTTP Request, IF, Switch, Merge (append / by position / by key), Wait, Execute Workflow (sub-workflows), Stop and Error, Edit Fields, Code (JS), Split Out, Aggregate, Limit, No-op |
| **AI** | LLM node (OpenAI, Anthropic, or any OpenAI-compatible API via base URL; optional JSON parsing) and an **AI Agent** with tool calling (HTTP GET, calculator, clock) |
| **Apps** | Slack, Telegram, Discord, Notion, Airtable, Stripe, HubSpot, Postgres, SMTP email, Google Sheets (service account) |
| **Reliability** | Per-node retries, continue-on-fail, per-workflow timeout, error workflows, execution history with per-node input/output, bounded log size, retention per plan, concurrency limiter |
| **Security** | Credentials encrypted with AES-256-GCM, secrets never returned to the browser, workspace isolation, bcrypt + JWT, rate-limited auth, sandboxed expressions/code, webhook secrets, optional private-network blocking for the HTTP node |
| **Business** | Workspaces + member invites, Free/Pro/Team plan limits (runs, active workflows, members, log retention), Stripe Checkout + signed-webhook handler, dev-mode plan switch |
| **Adoption** | 15 templates, **n8n workflow importer** with a "N of M nodes converted" compatibility report |

## Adding an integration

A node is one declarative object (see [`server/src/nodes/registry.js`](server/src/nodes/registry.js)). The editor form, credential picker and palette entry come for free:

```js
defineNode({
  type: 'app.example', name: 'Example', group: 'app', icon: '🧪', credentialType: 'exampleApi',
  description: 'Create a thing.',
  properties: [
    credentialProperty('exampleApi'),
    { name: 'title', label: 'Title', type: 'string', required: true },
  ],
  async executeItem(ctx, item, i) {            // runs once per input item
    const { token } = await ctx.credential();
    const res = await httpRequest({ method: 'POST', url: 'https://api.example.com/things',
      headers: { authorization: `Bearer ${token}` }, body: { title: ctx.param('title', i) } });
    return res.data;                           // object, array of objects, or null
  },
});
```

Add the credential type to [`credentialTypes.js`](server/src/credentialTypes.js) and import your file in `nodes/index.js`.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `PUBLIC_URL` | `http://localhost:PORT` | Used in Stripe redirect URLs |
| `DATA_DIR` | `./data` | SQLite database and generated secret |
| `LITEFOREFLOW_SECRET` | auto-generated in `DATA_DIR/.secret` | Master key for credential encryption and JWTs. **Back it up — losing it makes stored credentials unreadable.** |
| `BLOCK_PRIVATE_NETWORK` | `false` | `true` makes the HTTP node refuse loopback/private IPs (set this when hosting for others) |
| `ENABLE_CODE_NODE` | `true` | Disable the Code node |
| `ALLOW_SIGNUP` | `true` | `false` to close registration after creating your account |
| `DATABASE_URL` | — (SQLite) | Postgres connection string. The database **must be UTF8** (checked at boot). Required for `api`/`worker` roles |
| `PG_SCHEMA`, `PG_POOL_SIZE` | — , `10` | Optional schema (created if missing) and pool size |
| `REDIS_URL` | — (in-process queue) | Enables BullMQ. Use `maxmemory-policy noeviction` (and AOF) on Redis |
| `LITEFOREFLOW_ROLE` | `all` | `all` = API + worker; `api` = HTTP/enqueue/schedules; `worker` = executes jobs only |
| `QUEUE_NAME` | `liteforeflow-executions` | Change to isolate environments sharing one Redis |
| `MAX_CONCURRENCY` | `10` | Simultaneous workflow runs **per worker process** |
| `MAX_QUEUE_DEPTH` | `10000` | Waiting jobs before new runs get HTTP 503 |
| `WORKER_LOCK_MS`, `WORKER_STALLED_INTERVAL_MS` | `60000`, `15000` | How quickly a dead worker's job is declared failed |
| `SANDBOX_MEMORY_MB` | `64` | Heap cap of each V8 isolate running expressions / Code nodes |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM`, `STRIPE_WEBHOOK_SECRET` | — | Enable billing. Point a Stripe webhook at `/api/billing/webhook` (events: `checkout.session.completed`, `customer.subscription.deleted`) |
| `NODE_ENV=production` | — | Disables the dev-only `/api/billing/dev-plan` endpoint |

## Known limitations (be honest with early users)

These are deliberate V1 cuts or things not yet verified:

- **Third-party nodes are not tested against the live services.** The HTTP, LLM and agent paths are covered by tests against a local mock server; Slack, Notion, Airtable, Stripe, HubSpot, Postgres, SMTP, Telegram, Discord and Google Sheets call documented REST APIs but have not been run against real accounts. Expect small fixes during beta.
- **No OAuth2 flow yet**, so there is no Gmail / Google Drive / Calendar node. Email works through SMTP (Gmail app passwords work); Sheets uses a service account that the sheet is shared with. OAuth2 is the first thing to add for the "400 integrations" story.
- **Sandbox:** expressions and the Code node run in separate **isolated-vm V8 isolates**: no Node globals (`process`, `require`, `fetch`, timers, `Buffer` are all absent), a per-isolate memory cap, wall-clock timeouts, JSON-only data exchange. Tests cover escape attempts, infinite loops and memory bombs. This is a much stronger boundary than `node:vm`, but it is still in-process: it does not limit CPU *share* (a hot loop pins a core until its 1–5 s timeout) and V8 itself can have bugs. For strictly hostile tenants add OS-level isolation (a container/gVisor per worker, or a dedicated worker pool for untrusted workspaces). Code is synchronous only (no `await`, no network from code — use the HTTP node).
- **Execution is evaluated synchronously inside a worker**, so a heavy expression blocks that worker's event loop for up to its timeout; keep `MAX_CONCURRENCY` modest and scale workers horizontally. `Wait` holds a worker slot (max 5 min).
- **Editor "Run" results are the stored execution log**, so they follow the same size caps as history (100 items per output, ~1 MB per run).
- **No per-workspace fairness yet:** one busy workspace can fill the queue. Per-tenant concurrency limits need either BullMQ Pro groups or separate queues.
- Windows: `SIGTERM` cannot be trapped, so graceful worker shutdown only applies on Linux/macOS/containers.
- **No loops/cycles in the graph** (nodes already run per item; use Split Out for arrays). No binary/file data. No versioning/Git, environments, SSO, or fine-grained RBAC (owner/member only). Invites require the person to have signed up already (no email delivery).
- **The n8n importer is best-effort**: it maps ~15 core node types and reports the rest as placeholders. Credentials are never in n8n exports. There is no Zapier importer (Zapier has no portable export).
- Billing has not been exercised against Stripe; only signature verification and the plan-limit logic are tested. 

## Not yet verified

- Redis was only tested as a single node (no Sentinel/Cluster); Postgres 17 (compose) and 18 (tests) only — the SQL is plain and expected to work on 14+.
- The image was built and run on Docker Desktop for Windows (Linux containers) only.

## Verified in containers

`docker compose up --build --scale worker=2` (Postgres 17, Redis 7, 1 API, 2 workers), then `node server/test/e2e-compose.mjs`:

- isolated-vm works in the Linux image; editor runs execute in the sandbox on a worker container.
- 40 concurrent webhooks all answered correctly and were spread over both workers.
- Cron ticks fire once per tick (not once per container); usage metering holds across processes.
- `docker stop` (SIGTERM) on a worker mid-run: the run **finished** before the container exited.
- `docker kill` (SIGKILL) mid-run: the run is marked `error` ("job stalled…") ~75 s later by a surviving worker and is **not** re-run. (A crash with no other worker alive is only noticed when a worker next starts, or by the 2 h reaper.)
- Restarting the API, and `down` / `up` with volumes kept, preserve users, workflows, active webhooks and history.

Compose needs `LITEFOREFLOW_SECRET` in the environment on **every** `docker compose` command (it is required, so the stack refuses to start without it).
- Throughput/soak behaviour under sustained load has not been measured.
- Licensing: this is a clean-room implementation — do not copy code from n8n (Sustainable Use License). Have counsel review before launch.

## Suggested next steps

1. Run the 15 user interviews and validate flat pricing before building more.
2. OAuth2 framework + Gmail / Google Sheets (OAuth) / Calendar.
3. Postgres + Redis queue, `isolated-vm`, email-based invites.
4. Execution-time metrics (cost per run) to confirm unit economics under the flat price.

## Layout

```
server/src
  engine.js        graph execution, retries, per-item processing, cycle detection
  expressions.js   sandboxed {{ }} evaluation and Code node runtime
  runner.js        execution records, concurrency limiter, sub/error workflows
  scheduler.js     activation, webhook registry, cron, RSS polling
  nodes/           registry.js (SDK), core.js, ai.js, apps.js
  routes/          auth, workflows, resources (credentials, executions, templates, import, billing), webhooks
  templates.js  importer.js  plans.js  credentialTypes.js
web/src            React editor (pages/, components/)
```
