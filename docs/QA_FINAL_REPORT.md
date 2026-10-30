# LiteForeFlow - final QA, performance and real-world report

Branch `optimize-performance`, tested on Windows 11 with Node 24, a real Ollama 0.30 (`qwen3.5:4b`) and the real internet.
Everything in the project was re-tested: Ollama, plugins, the REST connector, Respond to Webhook, the data tools, friendly fields, Test connection, the scheduler, the speed work and the editor itself.

## 1. Result at a glance

| Suite | What it covers | Result |
|---|---|---|
| `npm test` | API, engine, plugins, REST connector, webhooks, data tools, speed fast-paths, compression, concurrency, run records | **59 of 59 pass** |
| Original 200-scenario QA (`npm run qa`) | access, engine, integrations, platform, security, resilience | **184 pass, 0 fail**, 16 cannot be tested from outside (same as before any of this work) |
| Plugin / REST / webhook A-to-Z (`plugins-qa.mjs`) | 71 cases incl. security, races, restarts, clean download, speed vs `master` | **71 of 71 pass** |
| White-box QA (`qa-unit.mjs`) | sandbox timeout and reuse, event loop stays free, SSRF classifier, encryption ... | **16 of 16 pass** |
| Sandbox safety (`sandbox-safety.mjs`) | infinite loop, memory bomb, no state leaking between items, no host access | **27 of 27 pass** |
| **Real-world QA (`realworld-qa.mjs`)** | live Hacker News, GitHub, Open-Meteo, JSONPlaceholder + a real local AI model + a real schedule | **11 of 11 pass** |
| Ollama on a real model (`ollama-qa.mjs`) | 31 cases | **30 pass, 0 fail**, 1 needs a second model installed. The whole suite takes **159 s** (697 s before the Thinking setting) |
| Browser, by hand | every page, a workflow built and run in the UI, phone width, light theme, keyboard | all pass (details in section 5) |

## 2. Performance, before and after

Same workflows on the same computer, the **median of 3 runs**, machine otherwise idle. "Before" is the code before this work (`00a8c1e`).

| What it does | Before | After | Faster | Peak memory |
|---|---|---|---|---|
| 10,000 items, two plain `{{ $json.field }}` lookups each | 7,919 ms | **174 ms** | **45x** | 96 → 84 MB |
| 10,000 items through an IF block | 8,029 ms | **86 ms** | **93x** | 101 → 88 MB |
| 3,000 items, real JavaScript in an expression | 2,396 ms | **108 ms** | **22x** | 105 → 90 MB |
| 2,000 items, `{{ $node["Name"].json.x }}` | 13,511 ms | **37 ms** | **365x** | 149 → 91 MB |
| 40 items, one GET each to a 100 ms service | 4,931 ms | **976 ms** | **5.1x** | 117 → 130 MB |
| 300 small runs (3 blocks, 4 expressions), per run | 11.1 ms | **1.6 ms** | **6.8x** | 136 → 126 MB |
| 400 webhook calls, 8 at a time, per call | 4.6 ms | **0.8 ms** | **5.8x** | 113 → 124 MB |
| 50,000 items without expressions (sort, unique, aggregate) | 463 ms | **400 ms** | 1.2x | 151 → 138 MB |
| 30,000 items generated, keep 5 | 90 ms | 69 ms | 1.3x | 144 → 127 MB |
| 600 API list calls | 760 ms | 580 ms | 1.3x | similar |
| Start-up | 500 ms | **317 ms** | 1.6x | - |
| Memory at rest | 67 MB | 70 MB | same (42 MB of it is Node.js, 15 MB the web server library) | - |
| Memory after 25 s of quiet | 83 MB | 78 MB | similar | - |

The memory column is the highest the process reached during that case. In the last four rows it includes memory left over from the earlier heavy cases: Windows hands freed pages back only after the process has been quiet for a few seconds.

First editor page: **214 KB of script (68 KB over the wire)** instead of 402 KB (132 KB).

### Real-world timings (live internet)

| Workflow | Before | After |
|---|---|---|
| Hacker News digest: 16 live calls, filter, sort, date, collect | 5.2 s | **1.8 s** (making the same 16 calls by hand, one after another, takes 4.4 s) |
| A tiny weather API built with LiteForeFlow (2 live calls per request), 24 requests, 6 at a time | works | median **274 ms**, 95th percentile 1,027 ms; the two upstream calls alone cost about 1,027 ms; memory 93 → 98 MB |
| 500 real comments cleaned and batched | - | 84 ms |
| Local AI reads the HN titles and returns JSON | **timed out after 300 s** (empty answers) | **19 s** (13 tokens) |
| Local AI agent fetches live weather with a tool | 66 s | **26 s** |
| Same small JSON task, direct to the model | 124 s with thinking, answer empty | **4.5 s** with thinking off |
| Full Ollama QA suite | 697 s | **159 s** |

## 3. What the real world found that fake servers could not

These were all found by running against real services and a real model, then fixed and re-tested.

| # | Found | Fix |
|---|---|---|
| 1 | **Thinking models were almost unusable**: a local model spent minutes (or all its tokens) reasoning before a trivial answer. One job: 124 s and an empty reply; with the switch off, 4.5 s. | New **Thinking** setting on the LLM and AI Agent blocks, **off by default**, sent as `reasoning_effort: none`; a model that cannot switch it off is asked normally and remembered. |
| 2 | **A big API answer erased the whole run's data.** Real GitHub release notes pushed a run past the 1 MB record limit and every block's input and output were thrown away, so the editor showed nothing although the run worked. | The record now shrinks step by step (fewer items, shorter texts, shorter lists) and keeps something for every block. A single giant item (an Aggregate of 50,000 rows) is trimmed cheaply. |
| 3 | **"HTTP 400 - true"**: Open-Meteo answers `{"error": true, "reason": "..."}` and the message showed the `true`. | The reason is now read from every common place (`reason`, `message`, `error.message`, `detail`, `errors[0]` ...). |
| 4 | **One API call per item ran strictly one after another** (15 stories = 15 x 0.3 s of waiting). | Read-only (GET) calls in the HTTP Request block and the REST connector overlap, up to 5 at a time (setting `ITEM_CONCURRENCY`), in order, stopping on the first failure; POST/PUT/DELETE never overlap. |
| 5 | The HTTP Request block read and decrypted its credential from the database **for every item**. | Opened once per node run. |
| 6 | **The editor did not connect the first block you added** to the trigger; it landed next to it, unconnected. | A new block now joins the last block when that block has no outgoing connection. |
| 7 | My own speed fix made one case 20% slower (a single item holding 50,000 rows was copied several times while trimming the run record). | Long lists inside items are trimmed first; that case is now faster than before the work. |
| 8 | **A real API changed under us**: REST Countries now answers "this API version has been deprecated". | Not a LiteForeFlow bug. It is exactly why services are small JSON files you can edit; the service was left out of the bundled set. |

Also confirmed with the real world: **a service you describe in one JSON file works against the real API** (GitHub, Open-Meteo, JSONPlaceholder were all added that way, with no code), **a real n8n workflow downloaded from GitHub imports** (its three AI-chain blocks are listed as unsupported in a readable report), and **a workflow set to run every minute fired on its own** and fetched live data.

## 4. Real-world cases (all pass)

| ID | Case | Result |
|---|---|---|
| RW-01 | Hacker News digest: top ids → 15 stories → keep real stories → sort by score → format date → collect | 15 stories in 1.8 s; scores in descending order; real titles; valid dates |
| RW-02 | GitHub release watcher: 2 repositories → de-duplicate → newest first → days ago | real releases (`v27.0.0-alpha.0.0.0` ...), ages correct |
| RW-03 | A real web API: `GET /webhook/rw-weather?city=` → place search → forecast → answer or 404 | Mumbai 28°C "mild"; unknown city → 404 JSON; empty request → a clean 500 with the reason, no crash |
| RW-04 | That API under load: 24 requests, 6 at a time, 4 cities | all correct; memory +5 MB |
| RW-05 | 500 real comments → unique → sorted → batches of 50; plus a real POST | 500 → 10 batches in 84 ms; POST returned id 101 |
| RW-06 | Real failures | GitHub 404 "Not Found"; dead host "could not connect ... (no such address)"; Open-Meteo "Latitude must be in range of -90 to 90°"; retry counted 3 tries; continue-on-fail carried on |
| RW-07 | Test connection against real services | a made-up GitHub token → "HTTP 401 - Bad credentials. The key or token was rejected."; Ollama as an OpenAI-style server → "Connected. 1 models available."; Ollama's own test lists its models |
| RW-08 | Import a real n8n workflow from GitHub | imported, readable report of what could not be converted |
| RW-09 | Local AI + live HN titles → JSON with `parse as JSON` | `{"theme":"tech and business","mood":"neutral"}` in 19 s |
| RW-10 | AI agent uses the `http_get` tool on a real Open-Meteo URL | tool called, answered "11.2°C" |
| RW-11 | A real every-minute schedule | ran by itself, recorded as a non-manual run, with live data |

Services used (none needs an account): [Hacker News API](https://github.com/HackerNews/API), the [GitHub REST API](https://docs.github.com/rest) (60 anonymous calls an hour), [Open-Meteo](https://open-meteo.com/en/docs), [JSONPlaceholder](https://jsonplaceholder.typicode.com), picked from the [public-apis list](https://github.com/public-apis/public-apis), and the n8n demo workflow in [n8n-io/self-hosted-ai-starter-kit](https://github.com/n8n-io/self-hosted-ai-starter-kit).

## 5. Browser walkthrough (done by hand against a running app)

| Area | Checked | Result |
|---|---|---|
| Login | wrong login → "Invalid email or password" (does not say which); short password → "Password must be at least 8 characters"; valid sign-up lands on Workflows with all 6 menu links | pass |
| Building | new workflow; clicking blocks in the palette (now auto-connected); friendly settings for Hacker News, Limit, Sort, Date & Time; Save; Run; the Data tab | a live 6-block workflow built and run in the UI: 5 real stories, scores 826 > 290 > 177 > 175 > 22, dates formatted |
| Persistence | rename, Save, reload | name, 6 blocks and 5 connections kept |
| Activation | switch on a manual-only workflow | refused with "Nothing can start this workflow automatically. Add a Webhook, Schedule or RSS trigger ..." |
| Executions | list with status, mode, time, duration; status filter | pass (the list shows the workflow's name as it was at run time) |
| Templates | 15 templates, 7 categories; "Use template" opens the new workflow | pass |
| Workflows list | trigger type, block count, updated, on/off; Duplicate ("... (copy)"); Delete asks "Delete ... and its execution history?" | pass |
| Credentials | 20 types incl. Ollama and the REST services; setup steps; Test connection (real Ollama); save; list | pass |
| Usage & plan | runs counted (1 / 1,000), plans, members | pass |
| Scheduler | every mode gives a plain-English sentence; Advanced shows `*/15 * * * *`; 419 timezones; "Use my computer's timezone" | pass |
| Plugins | listed, turn off/on (owner), disabled for non-owners with a tooltip, HTML in plugin names shown as plain text | pass |
| All 42 block types | each settings panel opens with no error, no "undefined" | pass |
| Phone width (375 px) | every page, the editor drawers, the credential form: no sideways scrolling; light theme legible | pass |
| Keyboard | credential dialog is announced as a modal, focus stays inside (25 Tab presses), Escape closes it and focus returns | pass |
| Browser console | only the 3 errors caused by my deliberate negative tests (bad login 401, short password 400, manual-only activation 400); no script errors | pass |

## 6. Known limits and honest notes

- Tested on **Windows** only; Linux and macOS were not run for this branch. Postgres + Redis mode and separate worker processes were not exercised (the code path is unchanged).
- Expressions that need real JavaScript still cost about 0.04 ms per item (the plain lookups are essentially free).
- GitHub allows 60 anonymous calls an hour, so the GitHub cases use only a handful; a rate-limit answer is reported as "not testable", not as a failure.
- The 1 MB run record means a run with huge answers keeps only the first entries of every block in its history (the run itself uses all of the data).
- Ollama answers one request at a time, so several AI blocks in parallel wait for each other.
- The Workflows list has no search box, and the Executions list shows the name a workflow had when it ran. Neither was changed.
- Third-party services change (REST Countries did while I was testing): Test connection and the plain error messages are there to make that visible quickly.
