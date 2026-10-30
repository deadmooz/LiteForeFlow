# LiteForeFlow - Docker edition

Build automations by drawing them: *"when a form is submitted, save it to a sheet and message me on Slack"*.
A free, self-hosted alternative to n8n / Zapier, packaged to **run in Docker** with Postgres, a Redis queue and as many
worker containers as you need.

> **Looking for the no-Docker version?** That is the separate *Lite edition* (one folder, double-click to start).
> This Docker edition has **every Lite feature** and adds the production pieces below.

## Start it (3 steps)

**1. Install Docker** - [Docker Desktop](https://www.docker.com/products/docker-desktop/) on Windows/Mac, Docker Engine on Linux.

**2. Create your settings file** (in this folder). Copy `.env.example` to `.env` and put a long random text after
`LITEFOREFLOW_SECRET=` (it encrypts your saved passwords/API keys - **keep a copy of it**):

```bash
openssl rand -hex 32      # prints a good value (on Windows PowerShell: -join ((1..64) | % { '{0:x}' -f (Get-Random -Max 16) }))
```

**3. Start everything**

```bash
docker compose up -d --build --scale worker=2
```

Open **http://localhost:3000**, click **Create an account** (the first account is the owner) and try **Templates**.
Stop with `docker compose down` (your data stays); `docker compose logs -f` shows what is happening.

## What you get (the same as the Lite edition)

- **Visual editor** with 15 templates, friendly fields, a **schedule picker**, per-block *Data*, *Test this step*, n8n import
- **Plugins**: Respond to Webhook, data tools (Filter, Sort, Remove Duplicates, Date & Time, Crypto, batches), a REST connector;
  add your own - [docs/PLUGINS.md](docs/PLUGINS.md)
- **Free local AI with Ollama**, plus OpenAI / Anthropic / any OpenAI-compatible API (LLM and AI Agent blocks)
- **Triggers**: Webhook, Schedule, RSS, Error handler; HTTP, email, Postgres, Slack, Telegram, Discord, Notion, Airtable, Stripe, HubSpot, Sheets
- **Safe by default**: encrypted credentials, sandboxed code, plan limits, security headers, private-network blocking

## What Docker adds

| | Lite edition | Docker edition |
|---|---|---|
| Start | double-click / `npm start` | `docker compose up` |
| Database | one SQLite file | **Postgres** |
| Running workflows | inside the one process | **Redis queue + any number of worker containers** |
| If something crashes | restart it | queued runs wait; a crashed worker's run is marked failed (never repeated) |
| Several servers | no | yes (API + workers share Postgres and Redis) |
| Code sandbox | strong, with a weaker automatic fallback | **strong only** (the container refuses to run without it) |
| Private-network blocking | off | **on** (Ollama on your computer is still allowed) |

## Everyday things

- **More power:** `docker compose up -d --scale worker=4`
- **Your own plugins:** drop a folder into `plugins-user/` - the API and every worker pick it up within seconds. Switching a plugin on/off on the *Plugins* page also reaches all workers.
- **Ollama on your computer:** works out of the box (`OLLAMA_HOST=http://host.docker.internal:11434`). Ollama on another machine: set `OLLAMA_HOST` in `.env`.
- **Backup:** Postgres (`docker compose exec postgres pg_dump -U liteforeflow liteforeflow > backup.sql`) **and** your `LITEFOREFLOW_SECRET`.
- **Update:** pull the new code, then `docker compose up -d --build --scale worker=2`.
- **Close registration** after you created your accounts: `ALLOW_SIGNUP=false` in `.env`, then `docker compose up -d`.
- **Put it on the internet?** Only behind HTTPS (Caddy / nginx / Traefik). Read [docs/DOCKER.md](docs/DOCKER.md) first.

## Something went wrong?

| You see | Do this |
|---|---|
| `set LITEFOREFLOW_SECRET in .env` | Step 2 above: create `.env` and fill in the secret |
| "port is already allocated" | Something else uses 3000: set `PORT=3100` in `.env`, run `docker compose up -d` again |
| Page does not open | `docker compose ps` (everything should say *Up/healthy*), then `docker compose logs api` |
| A run fails with "queue is unavailable" | Redis is down or restarting - wait a few seconds; `docker compose logs redis` |
| "Could not reach Ollama" | Start Ollama on your computer. On Linux also start it with `OLLAMA_HOST=0.0.0.0` so containers can reach it |
| Forgot the secret | Saved credentials cannot be read again; accounts and workflows still work - re-enter the credentials |

## More

- Docker details, settings table, scaling and the test commands: **[docs/DOCKER.md](docs/DOCKER.md)**
- All settings, security notes and limits: [docs/ADVANCED.md](docs/ADVANCED.md)
- Performance numbers: [docs/PERFORMANCE.md](docs/PERFORMANCE.md)
