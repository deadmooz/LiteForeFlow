# LiteForeFlow - Docker edition

The Docker edition runs the **same code as the Lite edition** (plugins, Ollama, friendly fields, schedule picker, the speed work,
everything) and wraps it in the production setup: Postgres, a Redis queue, one API container and any number of worker containers.

```
 browser / webhook senders ──► api  ──► Redis queue ──► worker (x N)
                                │                          │
                                └──────► Postgres ◄────────┘          shared volume "appdata": plugin switches, plugin files
```

- **api** serves the editor and the webhooks, queues runs, owns the schedules. It never runs your workflows itself.
- **worker** containers run the workflows. Scale them up or down at any time: `docker compose up -d --scale worker=N`.
- **postgres** holds accounts, workflows, credentials (encrypted) and run history. **redis** holds the queue and the schedules.

## Settings

Put them in `.env` next to `docker-compose.yml` (see `.env.example`). Only `LITEFOREFLOW_SECRET` is required.

| Setting | Default in Docker | Meaning |
|---|---|---|
| `LITEFOREFLOW_SECRET` | *(required)* | Encrypts saved credentials. Back it up - without it they cannot be read |
| `POSTGRES_PASSWORD` | `liteforeflow` | Password of the bundled Postgres |
| `PUBLIC_URL`, `PORT` | `http://localhost:3000`, `3000` | Address shown for webhooks; host port of the API |
| `ALLOW_SIGNUP` | `true` | Set to `false` once your accounts exist |
| `BLOCK_PRIVATE_NETWORK` | `true` | The HTTP node cannot call private/internal addresses (the configured Ollama address is still allowed) |
| `OLLAMA_HOST` | `http://host.docker.internal:11434` | Where Ollama runs |
| `MAX_CONCURRENCY` | `10` | Workflows each worker container runs at once |
| `SAVE_SUCCESS_DATA` | `true` | `false` keeps only a one-line record of successful runs (saves space) |
| `PLUGINS_DIR` | `/plugins` (= `./plugins-user`) | Folder with your own plugins |

Set automatically by the image: `LITEFOREFLOW_REQUIRE_STRONG_SANDBOX=true` (refuse the weaker code sandbox),
`DATA_DIR=/data`, and Node memory flags. More tuning (all optional): `MAX_QUEUE_DEPTH`, `QUEUE_ENQUEUE_TIMEOUT_MS`,
`WORKER_LOCK_MS`, `WORKER_STALLED_INTERVAL_MS`, `PG_POOL_SIZE`, `PG_CONNECT_TIMEOUT_MS`, `PG_QUERY_TIMEOUT_MS`, `SANDBOX_MEMORY_MB`.

## Plugins in Docker

- The bundled plugins are inside the image (`/app/plugins`).
- **Your own plugins:** put a folder (with `plugin.json` and `index.js`) into `plugins-user/` on the host. It is mounted read-only into
  the API and every worker. See [PLUGINS.md](PLUGINS.md).
- The on/off switches live in `/data/plugins.json` on the shared `appdata` volume. Each container checks for changes every few seconds
  (`[plugins] a change was detected, reloading` in the logs), so a switch made on the **Plugins** page reaches **all** workers, and a
  new plugin folder becomes available everywhere without restarting anything.
- Only the first account (the owner) can turn plugins on or off. Plugins run with the same rights as the server: install only plugins you trust.
- Several *machines* (not just containers on one machine) need `/data` to be a shared network folder.

## Ollama

Ollama stays on your computer; containers reach it through `host.docker.internal` (the compose file adds that name for Linux too).
On **Linux** start Ollama so it listens beyond localhost: `OLLAMA_HOST=0.0.0.0 ollama serve`.
Another machine runs Ollama? Set `OLLAMA_HOST=http://that-machine:11434` in `.env`.

## Operating it

- **Logs:** `docker compose logs -f api worker`
- **Restart / update:** `docker compose up -d --build --scale worker=2`. Workers finish their running workflows (up to 60 s) before stopping.
- **If a worker dies mid-run:** that run is marked failed after about a minute and is **not** repeated (a repeat could send an email twice).
- **If Redis is down:** webhooks answer `503` within about 5 seconds (senders can retry) and recover by themselves; reads keep working.
- **Backup / restore:** `docker compose exec postgres pg_dump -U liteforeflow liteforeflow > backup.sql`; restore with `psql`. Keep the secret too.
- **Sharing it:** put it behind HTTPS, set `ALLOW_SIGNUP=false`, and do not publish Postgres or Redis ports.

## Tests

```bash
npm install
npm test                     # all Lite suites on SQLite (no services needed)
# against real Postgres + Redis (set TEST_DATABASE_URL and TEST_REDIS_URL first):
npm run test:all             # + the multi-process worker tests and the plugin-sync test
node server/test/qa/qa-infra.mjs                 # production-stack scenarios incl. Redis/Postgres outage drills
# against the running compose stack:
node server/test/e2e-docker-features.mjs         # plugins on every worker, plugin switches, dropped-in plugin, schedules
node server/test/e2e-compose.mjs                 # fan-out, cron, usage metering
```

### What was verified for this edition

- Lite suites on the Docker edition's code: 59 tests (SQLite), 16 on Postgres, 16 on Postgres + Redis, 3 multi-process worker tests,
  3 cross-process plugin tests, 200 black-box scenarios (0 failures), 16 white-box checks, 8 production-stack scenarios with outage drills.
- The image builds (391 MB) and runs as a non-root user; compose with 2 workers: plugins on both workers, plugin switches reaching both,
  a plugin dropped in from the host, schedules firing once per tick, plugin state surviving restarts, and a real **Ollama** model
  (running on the host) answering a workflow executed by a worker container.
- **Not verified:** Docker on a Linux host (only Docker Desktop on Windows), several machines, Redis Sentinel/Cluster, HTTPS in front of it.
