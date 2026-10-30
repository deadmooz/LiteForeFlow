# LiteForeFlow

Build automations by drawing them: *"when a form is submitted, save it to a sheet and message me on Slack"*.
A tiny, free, self-hosted alternative to n8n / Zapier. **No Docker, no database to set up, no accounts in the cloud** -
everything runs on your own computer and stays there.

## Start it in 3 steps

**1. Node.js (the engine that runs LiteForeFlow)** - you do not have to do anything. If it is missing, `start.bat` /
`start.sh` offer to download a private copy (about 30 MB) into a `runtime` folder next to the app: no administrator
rights, nothing else on your computer changes. Prefer your own install? Get the **LTS** from <https://nodejs.org>
(it must be 22.13 or higher).

**2. Download this project** (green *Code* button -> *Download ZIP* -> unzip it, or `git clone` it).

**3. Start it** - pick whichever is easiest for you:

| You use... | Do this |
|---|---|
| **Windows** | Double-click **`start.bat`** |
| **Mac / Linux** | Open a terminal in the folder and run `./start.sh` (the first time: `chmod +x start.sh`) |
| **Python** | `python run.py` |
| **npm** | `npm install` once, then `npm start` |

The first start installs a few small packages (about a minute, needs internet, only once). Then your browser opens at
**http://localhost:3000**. Click **Create an account** (it is free and stays on your computer) and open **Templates**
to try a ready-made automation.

To stop it, press **Ctrl+C** in the window (or just close the window).

## Using it

1. **Templates** - pick one and click *Use template*. 15 ready-made automations (alerts, reports, AI helpers...).
2. **Build your own** - *Workflows -> New workflow*. Click a block on the left to add it; it connects itself to the block you selected.
   Click a block to fill in its settings. Use `{{ $json.name }}` inside any text field to use data from the previous step.
3. **Run** - press **Run** to try it on the spot; each block turns green (worked) or red (failed) and *Data* shows what went through.
4. **Switch it on** - a workflow with a **Webhook** (runs when a URL is called), **Schedule** (runs on a timer) or **RSS** trigger
   can be switched to *Active*; then it runs by itself while LiteForeFlow is running.
5. **Credentials** - passwords and API keys for services like Slack are saved (encrypted) under *Credentials*, never inside workflows.

## Free AI on your own computer (Ollama)

1. Install [Ollama](https://ollama.com/download), then run `ollama pull llama3.2` once (a few GB download).
2. In a workflow add an **LLM** or **AI Agent** block and set *Provider* to **ollama**. No account, no API key and no credential are needed;
   leave *Model* empty for `llama3.2`, or choose any model you pulled from the list.
   *Thinking* is **off** by default: many local models (qwen3, deepseek-r1) otherwise write minutes of private reasoning before a simple answer (measured: 124 s with thinking, 4.5 s without). Turn it on only for hard problems.
3. Ollama runs on another computer? Add an **Ollama (local AI)** credential with its address, or set `OLLAMA_HOST` (see [docs/ADVANCED.md](docs/ADVANCED.md)).

## Plugins: add your own blocks

LiteForeFlow comes with plugins for **Respond to Webhook**, **data tools** (Filter, Sort, Remove Duplicates, Date & Time, Crypto, batches) and a **REST connector** (GitHub, Trello, OpenWeather, Hacker News).  
Open **Plugins** in the app to see or turn them off. To add your own, run `npm run plugin:new -- my-plugin`, edit the file it creates in `data/plugins`, and press *Reload*.
Connecting a web service needs no code at all, just one small JSON file. Guide: [docs/PLUGINS.md](docs/PLUGINS.md).

## Good to know

- **It only runs while it is started.** Schedules and webhooks work while the window is open. Leave it running on a computer that stays on.
- **Your data** (workflows, accounts, run history) lives in the `data` folder next to the app. Copy that folder to back it up or move to another computer.
  Keep `data/.secret` with it - it is the key that unlocks your saved credentials.
- **Updating:** download the new version, copy your old `data` folder into it, and start.
- **Other people on your network** can use it too: they open `http://<your-computer-ip>:3000`. Only do this on a network you trust,
  and read *Sharing it* in [docs/ADVANCED.md](docs/ADVANCED.md) first.

## Something went wrong?

| You see | Do this |
|---|---|
| "needs Node.js" | Answer **Y** to download it. Said no, or it failed? Install the LTS from <https://nodejs.org>, then **close and reopen** the window |
| Node.js too old | Answer **Y** and the launcher uses its own newer copy (your old one stays untouched) |
| The install fails / is stuck | Check your internet connection, delete the `node_modules` folder, start again |
| "Port 3000 is already in use" | LiteForeFlow picks the next free port automatically; or run `python run.py --port 3100` |
| Browser did not open | Open the address printed in the window (http://localhost:3000) yourself |
| Forgot your password | Your data is local: create a new account (or delete the `data` folder to start from scratch - this erases everything) |
| A workflow fails with "No credential selected" | Open the failing block, choose a credential (or click **+ New**) |

## More

- Settings, scaling up to Postgres + Redis, adding your own integrations, limits and security notes: **[docs/ADVANCED.md](docs/ADVANCED.md)**
- How it was tested: [QA_REPORT.md](QA_REPORT.md)
