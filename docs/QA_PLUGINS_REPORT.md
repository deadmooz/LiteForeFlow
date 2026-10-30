# LiteForeFlow - A-to-Z QA of the plugin, Ollama and friendly-fields work

Scope: everything built on the `ollama-support`, `schedule_changes` and `plugins-and-friendly-fields` branches: Ollama as an AI provider, the plugin system and Plugins page, the REST connector, Respond to Webhook, the data tools, friendly (live) fields, Test connection, and the earlier schedule picker. Tested on Windows 11, Node 24, with a **real Ollama 0.30.10** (`qwen3.5:4b`) and fake stand-ins for Notion, GitHub-style REST services and OpenAI-style APIs (no real third-party accounts were used).

## Result

| Suite | Cases | Result |
|---|---|---|
| Automated unit / API tests (`npm test`) | 43 | **43 pass**. 7 of them were added for the bugs below |
| A-to-Z QA harness (`server/test/qa/plugins-qa.mjs`): real app processes, security, plugins, REST, webhook, data tools, Notion, credentials, performance, clean download | 71 | **71 pass, 0 fail**. The first run had 49 pass and 22 fail; all 22 are resolved (14 product bugs fixed, 8 mistakes in my test expectations corrected) |
| Ollama on a real model (`server/test/qa/ollama-qa.mjs`, see [QA_OLLAMA_REPORT.md](QA_OLLAMA_REPORT.md)) | 31 | 29 pass, 1 not testable (needs a second model). A regression re-run found one flaky case that exposed a real problem (D14); fixed and re-run |
| Browser checks by hand | see below | all passed after the UI fixes |

## Defects found and fixed

| # | Severity | Case | What was wrong | Fix |
|---|---|---|---|---|
| D1 | **High (security)** | SEC-10 | A saved credential whose plugin was switched off (so its type was unknown) was returned to the browser **with its secret values in clear text** (`GET /api/credentials/:id`). | A credential of an unknown type now reveals no values at all. Regression test added. |
| D2 | Medium (security) | SEC-08 | A path value of `..` in a REST block climbed out of its endpoint (`/tasks/..` became `/`). | `.` and `..` parts are refused with a plain message. |
| D3 | Low (hardening) | SEC-11 | A plugin's `entry` could point at a file outside its own folder. | The entry file must be inside the plugin folder. |
| D4 | Medium | PLG-12/13/14 + new unit test | Reload and on/off calls could run at the same time and corrupt each other. Switching on a plugin that was already on registered its blocks a second time and left it in "Problem". A disabled plugin could also forget which blocks it had, so a workflow gave a vague "unknown type" instead of naming the plugin. | All plugin loading and switching now runs one at a time; switching on is safe to repeat; the list of blocks is never forgotten. |
| D5 | Medium | RESP-04 | If a step failed *after* Respond to Webhook had already run, the caller got a 500 instead of the answer it was promised. | The promised answer is sent; the failure is still recorded in the run. |
| D6 | Medium | SEC-05 | One invalid header (line break, odd name, huge value) made the whole webhook answer fail with 500. | Unsafe headers are left out; the rest of the answer goes through. |
| D7 | Low | RESP-03 | The status code could not come from an `{{ expression }}` (always 200). | It is now resolved like every other setting. |
| D8 | Medium | DATA-03 | Remove Duplicates treated `{a:1,b:2}` and `{b:2,a:1}` as different items. | Items are compared with their keys in a fixed order. |
| D9 | Medium | DATA-05 | Date & Time read a JSON number of seconds as milliseconds (1970 dates). A wrong timezone or amount gave a technical error. | Numbers are understood as seconds or milliseconds; bad timezone and amount messages are plain English. |
| D10 | Low | DATA-06 | An unsupported hash algorithm gave a raw OpenSSL error. | A plain message listing the supported algorithms. |
| D11 | Low | REST-06 | A "result path" that was not in the answer produced one empty item. | It produces no items. |
| D12 | Low | REST-08, REST-12 | REST errors showed an HTML error page, or the bare words "fetch failed" when a service was down. | HTML bodies are dropped; messages say "could not connect to host (connection refused / no such address)" or "did not answer in 30 seconds". |
| D13 | Medium | NOT-03, NOT-04, NOT-06 + UI | Notion: text in a number column was silently sent as null; a pasted database link or dashed id failed; a column added in Notion was missing from the editor for 30 seconds; switching database kept the old database's column values and the run then failed. | Clear "needs a number" error; links and dashed ids are understood; the editor always loads fresh columns; stale column values are dropped when the database changes. |
| D14 | Medium | OLL-10 (regression run) | With the default Max tokens (1024), a thinking model sometimes spent all of it reasoning on a long prompt and the node stopped with an error. | Max tokens left blank is now automatic: 1,024, or 4,000 with Ollama. Re-tested on the real model. |
| D15 | Low (UX) | UI | People who are not the owner saw working Turn off / Reload buttons that then failed; the live dropdowns had no accessible name; plugin block chips had no border. | The buttons are disabled with a tooltip for non-owners; labels added; chips styled. |

**Test mistakes corrected (not product bugs):** DATA-06, DATA-07, PLG-01, PLG-17, PLG-18, REST-07, SEC-01, SEC-06. For example SEC-06 compared against the app's own security header, and DATA-07 wrongly demanded a speed the engine itself does not have (see below).

## Observations (not defects)

- **Expressions cost about 0.6 ms per item in the engine.** 20,000 items through any block that evaluates `{{ }}` take 12-14 s: the built-in IF 14.2 s, Edit Fields 12.1 s, the new Filter 12.1 s. The new tools that need no expressions are instant (Sort 79 ms, Remove Duplicates 26 ms, Batches 41 ms for 20,000 items). A fast path for plain `{{ $json.field }}` lookups would speed up every block; it is a separate engine change.
- **Footprint is unchanged:** start-up 308 ms vs 311 ms on `master`; memory after 200 runs 73 MB vs 73 MB; block list 34 KB; editor script 402 KB; Reload 42-177 ms; 200 Respond-to-Webhook calls 9 ms each; 100 REST calls 1.4 s.
- Notion's database list shows the first 100 databases (no paging). Date & Time adds days in exact 24-hour steps, so across a daylight-saving change the clock time can shift by an hour.
- Ollama answers one request at a time and loaded the model with a 4096-token context, so long prompts are cut by Ollama itself.
- A plugin runs with the same rights as LiteForeFlow (by design, documented). Plugins that hang while loading would delay start-up.

## Browser checks (done by hand against a running app)

| Check | Result |
|---|---|
| All 42 block types open their settings panel with no error, no `undefined`, no `[object Object]` | Pass |
| A plugin named `<img src=x onerror=...>` with `<script>` in its description, and a block with HTML in its name: shown as plain text on the Plugins page, palette and canvas; nothing executed | Pass |
| Owner: Turn off / Turn on / Reload work. Member: all buttons disabled with a tooltip | Pass (after D15) |
| Notion node: database dropdown, columns appear, filled values reach Notion correctly; stale column dropped when it is not in the database | Pass (after D13) |
| LLM node: Ollama model dropdown lists the real installed model | Pass |
| Credential form: setup steps, Test connection with success (real Ollama), warning, failure | Pass |
| Phone width (375 px): Plugins, Credentials, Templates, Executions, Usage, Workflows: no sideways scrolling; credential form usable | Pass |
| Dark and light themes for the new screens | Pass |
| Earlier schedule picker still renders and saves cron after the form refactor (Schedule block panel + three cron values run) | Pass |

## Not covered

- Real third-party services (Notion, GitHub, Trello, OpenWeather, OpenAI, Slack, Telegram): only fake servers that copy their documented behaviour. Run **Test connection** with your own keys once.
- Linux / macOS runs of this branch, Postgres + Redis mode and separate worker processes (the plugin loader runs in every process role; not exercised here).
- Ollama "model cannot use tools" message (needs a second model), screen readers, and very small or very large phone screens other than 375 px.

## Every case

### Security

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| SEC-01 | Every new API needs a login | Call /plugins, /plugins/reload, /node-options, /credentials/test without a token. | All answer 401. | **PASS (first run: FAIL)** | 5 endpoints refuse anonymous callers |
| SEC-02 | Only the owner can reload, enable or disable plugins; others can still look | Second account tries each action. | GET works; reload/enable/disable give 403. | **PASS** | 403 x3 |
| SEC-03 | Live dropdowns cannot use someone else's credential | User B asks /node-options with user A's Notion credential id. | Refused ("Credential not found"), nothing from A leaks. | **PASS** | both refused |
| SEC-04 | Secrets never come back from the new endpoints | Notion token "secret_leakcheck" through node-options and credentials/test (ok and error cases). | The token text appears in no response. | **PASS** | 5 responses clean |
| SEC-05 | Header injection through Respond to Webhook cannot crash the server or add headers | Header values with CR/LF, invalid names, a 100 KB value. | Server stays up; no injected header. | **PASS** | status 200, X-Ok=fine |
| SEC-06 | Respond to Webhook cannot set cookies, CSP or hop-by-hop headers | Headers Set-Cookie, Content-Security-Policy, Transfer-Encoding, Content-Length. | None of them is applied. | **PASS (first run: FAIL)** | blocked |
| SEC-07 | BLOCK_PRIVATE_NETWORK also covers the REST connector | App with BLOCK_PRIVATE_NETWORK=true; REST block calls the fake service on localhost. | Blocked with the private-network message. | **PASS** | blocked |
| SEC-08 | A ".." in a path field cannot climb out of the endpoint | REST path /tasks/{id} with id "..", "../me" and "%2e%2e". | Requests stay under /svc/tasks/ (or are refused). | **PASS (first run: FAIL)** | ..: refused before any call \| ../me: /svc/tasks/..%2Fme \| %2e%2e: /svc/tasks/%252e%252e \| .: refused before any call |
| SEC-09 | Garbage sent to the new APIs gives 4xx, never 500 or a crash | null / array / string / huge / prototype names as type and property. | Only 400/404 answers; server alive. | **PASS** | codes 400,404,200 |
| SEC-10 | Credentials of a plugin type do not leak their secrets when the plugin is switched off | Save a REST credential, switch the REST connector off, GET /credentials/:id. | No secret value in the answer. | **PASS (first run: FAIL)** | no leak |
| SEC-11 | A plugin cannot point its entry file outside its own folder | plugin.json "entry": "../outside.js". | Rejected with a plain message. | **PASS (first run: FAIL)** | The entry file must be inside the plugin folder |

### Plugins

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| PLG-01 | Bundled plugins load at start-up | List /plugins on a fresh app. | rest-connector, respond-to-webhook, data-tools are ON and "bundled"; _template is not listed. | **PASS (first run: FAIL)** | 6 on |
| PLG-02 | A plugin dropped into data/plugins loads (not only PLUGINS_DIR) | Folder created in <data>/plugins before start. | Loaded as "user" plugin; its block runs. | **PASS** | ok |
| PLG-03 | A user plugin cannot take over a bundled plugin's id | User folder with id "data-tools". | Rejected as a duplicate; the bundled one keeps working. | **PASS** | duplicate refused |
| PLG-04 | A plugin in a folder with spaces and non-English letters loads | Folder "मेरा plugin é". | Loads and runs. | **PASS** | ok |
| PLG-05 | Every kind of bad plugin.json is explained in plain words | invalid JSON / no id / bad id / no name / newer API. | Each shows status Problem with a readable reason; the app starts. | **PASS** | 19 problems reported |
| PLG-06 | Register that throws, rejects, returns nothing or has a syntax error is isolated | Four broken plugins. | All four show Problem; good plugins unaffected. | **PASS** | bad-id: plugin.json "id" must be 2-40 characters: lowercas \| bad-json: plugin.json is not valid JSON (Expected property n \| cred-clash: Credential type "httpBearer" already exists \| escape-test: The entry file must be inside the plugin folder \| newer-api: This plugin needs a newer LiteForeFlow ( |
| PLG-07 | Rules for block names and definitions are enforced with clear messages | Uppercase type, no dot, spaces, no executor, no name, clash with built-in, duplicate in same plugin. | Each rejected; partly registered blocks rolled back. | **PASS** | rules-upper: Node type "Rules.Upper" must look like "myplugin.hello" (let \| rules-nodot: Node type "nodot" must look like "myplugin.hello" (letters a \| rules-noexec: Node "rulesnoexec.a" needs an executeItem() or execute() fun \| rules-noname: Node "rulesnoname.a" needs a name \| rules-clash: Node |
| PLG-08 | A credential type id that already exists is refused | Plugin defines credential type "httpBearer". | Refused; its block is not left behind. | **PASS** | Credential type "httpBearer" already exists |
| PLG-09 | Turning a plugin off survives a restart; turning it on survives too | Disable data-tools, restart the app on the same data, check, enable, restart, check. | State is remembered both ways. | **PASS** | disabled and enabled states both survive a restart |
| PLG-10 | A corrupted data/plugins.json does not stop the app | Write garbage into plugins.json, start. | All plugins load; no crash. | **PASS** | defaults used |
| PLG-11 | Reload picks up a new folder, a changed file and a deleted folder without a restart | Add, edit, delete a plugin folder; press Reload each time. | Block appears, changes, then disappears. | **PASS** | add / edit / delete all seen |
| PLG-12 | Pressing Reload many times at once leaves everything consistent | 8 simultaneous POST /plugins/reload. | Afterwards every good plugin is ON, no "already exists" errors, node count unchanged. | **PASS** | 49 blocks, stable |
| PLG-13 | Toggling the same plugin from several places at once ends in a sane state | 10 mixed enable/disable calls at once. | Final status matches the last state; blocks present iff ON; no error status. | **PASS** | ended ok; enabling twice is harmless |
| PLG-14 | A workflow that uses a switched-off plugin still opens and says what to do | Disable the plugin, GET the workflow, run it, try to activate a webhook version. | GET works; run/activate give the plain "switched off" message. | **PASS (first run: FAIL)** | plain messages |
| PLG-15 | A workflow already ACTIVE when its plugin goes off fails politely, then works again after turning it on | Activate webhook workflow using Respond to Webhook; disable plugin; call; enable; call. | Error (not a hang or crash) while off, 201 answer after. | **PASS** | while off: 500 {"error":"Unknown node type respond.webhook","executionId":" |
| PLG-16 | The palette data is JSON-safe and tags plugin blocks | /node-types. | No functions leak; plugin blocks carry their plugin id; built-ins have none. | **PASS** | 49 node types, 34955 bytes |
| PLG-17 | A plugin's private folder, readJson and listFiles work | Plugin uses sdk.dataDir(), readJson, listFiles. | Folder under data/plugin-data/<id>; values read back. | **PASS (first run: FAIL)** | Temp\pqa-main-6BYRU1\plugin-data\sdk-use |
| PLG-18 | The scaffold command rejects bad names and makes a plugin that really works | npm run plugin:new with BAD names, then a good one, Reload, run its block. | Bad names refused (no folder written outside data/plugins); good one runs. | **PASS (first run: FAIL)** | 7 bad names refused; generated block says HELLO, ZED! |

### REST connector

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| REST-01 | Every bundled service file is valid and complete | Check the 4 shipped specs and their blocks. | No problems; each has a label per operation; services with auth have setup steps. | **PASS** | 4 services |
| REST-02 | checkSpec explains 16 kinds of mistakes in plain words and never throws | Table of bad specs. | Each gives at least one readable problem. | **PASS** | 19 bad specs all explained |
| REST-03 | Query/body/header/path values: zero, false, empty, JSON and expressions are handled right | Echo service with fields of each type. | Zero and false are sent; empty is omitted; JSON parsed; expressions resolved per item. | **PASS** | {"count":"0","flag":"false"} |
| REST-04 | Basic, header-key and query-key authentication all work | Three small services. | Each service sees the right credential. | **PASS** | basic + header(prefix) ok |
| REST-05 | A per-account part of the web address (subdomain) comes from the credential | baseUrl with {sub}. | Request goes to the filled-in address. | **PASS** | localhost:7738 |
| REST-06 | Different answer shapes become sensible items | JSON object, array, nested result path, text/plain, 204, empty list, missing result path. | Object=1 item, array=N, text={value}, 204={ok:true}, empty list=0 items, missing path=no junk item. | **PASS (first run: FAIL)** | all shapes ok |
| REST-07 | A huge list is capped (1000 items) instead of flooding the run | /big returns 1500 entries. | 1000 items. | **PASS (first run: FAIL)** | 1000 of 1500 items kept, in 54 ms |
| REST-08 | Failures are explained: 401, 404, 429, HTML 500 page, server down, slow service | One run each. | Messages name the service and say what happened; slow (2.5 s) still works; no raw HTML or "fetch failed". | **PASS (first run: FAIL)** | down => "Dead: could not connect to 127.0.0.1:1 (network error). Check the address and yo" |
| REST-09 | Redirects are followed and 100 items make 100 correct calls | Redirect endpoint; 100 items through a call with an expression. | Redirect resolves; 100 calls each with its own value, in under 20 s. | **PASS** | 1272 ms for 100 calls |
| REST-10 | Live dropdown edge cases: empty list, missing labels, dependent dropdown, wrong credential | node-options for empty list, label-less entries, board->list, no credential. | Clean answers or readable reasons. | **PASS** | ok |
| REST-11 | Service files added, broken, duplicated and removed while running | Drop a file + Reload; break it + Reload; add a duplicate id; remove. | Block appears; broken file skipped without losing others; duplicate ignored; removed block disappears. | **PASS** | ok |
| REST-12 | Test connection for service credentials | Good key, bad key, service with no test path, service down. | Friendly message each time. | **PASS (first run: FAIL)** | down => "Dead: could not connect to 127.0.0.1:1 (network error). Check the addr" |

### Respond to Webhook

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| RESP-01 | Every "Send" mode over real HTTP | json / text / empty / firstItem / allItems with custom status. | Right status, content-type and body each time. | **PASS** | ok |
| RESP-02 | Redirect with status 302 and a Location header | Respond status 302, header Location. | Caller sees 302 + Location. | **PASS** | 302 + Location |
| RESP-03 | Status can come from an expression | Status = {{ $json.body.code }}. | 418 when the caller sends 418. | **PASS (first run: FAIL)** | 418 |
| RESP-04 | If a later step fails AFTER the Respond node ran, the caller still gets the answer it was promised | Respond (201) then Stop and Error. | Caller gets 201 (the failure is recorded in the run). | **PASS (first run: FAIL)** | 201 promised |
| RESP-05 | Two Respond nodes: the last one that runs wins; a bad JSON answer gives a plain error | Chain of two; JSON mode with broken JSON. | Second answer used; broken JSON -> 500 with message. | **PASS** | ok |
| RESP-06 | Big answers, GET and HEAD webhooks, and 25 callers at once each get their own answer | 2 MB body; method GET/HEAD; 25 parallel calls with different numbers. | All correct, no mix-ups. | **PASS** | 25 parallel ok |
| RESP-07 | Webhook secret and a missing Respond node behave as before | Secret required; responseNode with no Respond node on the path. | 401 without secret; falls back to last output. | **PASS** | ok |
| RESP-08 | Running a Respond node from the editor (Run / Test this step) does not crash | Manual run and single-node test of a workflow that has Respond to Webhook. | Success; output passes through. | **PASS** | ok |

### Data tools

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| DATA-01 | Filter: no conditions, no input, regex on a hostile pattern | Empty condition list; zero items; (a+)+$ on a long string. | Keeps all; empty out; the regex cannot freeze the server. | **PASS** | hostile regex finished in 279 ms (error) |
| DATA-02 | Sort: mixed types, nulls, nested path, dates, stability, missing field, prototype names | Several sorts. | Sensible order; equal keys keep their order; no crash; no pollution. | **PASS** | mixed order: 2,10,a,b,∅,∅, |
| DATA-03 | Remove Duplicates ignores the order of keys and tells 1 from "1" | Whole-item compare with different key order; nested path; number vs string. | {a,b} equals {b,a}; 1 and "1" differ. | **PASS (first run: FAIL)** | ok |
| DATA-04 | Split into Batches: odd sizes and empty input | size 0, -5, 2.7, "abc", huge; empty list. | Never crashes; size falls back sensibly; empty input gives no batches. | **PASS** | batches per size: {"0":1,"1000000000":1,"-5":5,"2.7":3,"abc":1} |
| DATA-05 | Date & Time: numbers, bad timezone, leap years, negative amounts, weeks, other units | A list of calculations. | Correct results and friendly errors. | **PASS (first run: FAIL)** | all calculations correct |
| DATA-06 | Crypto: unknown algorithm, odd inputs, 1000 UUIDs | sha3 typo; missing text; invalid base64; random length bounds. | Plain errors, bounded output, unique ids. | **PASS (first run: FAIL)** | ok |
| DATA-07 | The new tools are no slower than the built-in blocks on 10,000 items | Same data through the built-in IF, the Filter plugin, and the tools that need no expressions. | Filter within 1.5x of IF; Sort / Remove Duplicates / Batches under 2 s each. | **PASS (first run: FAIL)** | 10,000 items: built-in IF 5974 ms, Filter 5987 ms (expressions cost about 0.60 ms per item in the engine itself); Sort 45 ms, Remove Duplicates 25 ms, Batches 52 ms |

### Friendly fields

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| NOT-01 | Database list: names, untitled databases, empty account, slow Notion | node-options for databases in four situations. | Names shown, "(untitled)" for blank, helpful message when nothing shared, slow answer still arrives. | **PASS** | ok |
| NOT-02 | Columns: only fillable types are offered; the title is excluded | fields for a database with formula/relation/title columns. | Gender, Score, Done only. | **PASS** | Gender:string, Score:number, Done:boolean |
| NOT-03 | A number column given text ("abc") gives a clear error, not a silent null | Score = "abc". | Error names the column. | **PASS (first run: FAIL)** | The column "Score" needs a number, but got "abc" |
| NOT-04 | Pasting a whole Notion link or an ID with dashes into the database field works | databaseId as full URL with ?v=, as dashed UUID. | The page is created in the right database. | **PASS (first run: FAIL)** | both forms understood |
| NOT-05 | Read rows works and bad filter JSON is explained | queryDatabase with and without a filter; broken filter text. | 2 rows; "not valid JSON" message. | **PASS** | ok |
| NOT-06 | The column list is never stale in the editor after a change in Notion | fields requested twice after the schema changes. | Second request sees the new column. | **PASS (first run: FAIL)** | fresh |

### Credentials

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| CRED-01 | Test connection for OpenAI-compatible and Anthropic-style APIs, and bad input | Good key, wrong key, unknown type, missing field, 5 KB value. | Plain results, no crash. | **PASS** | ok |
| CRED-02 | Editing a saved credential: blank secret keeps the old one; Test uses the stored secret | PUT with blank token, then test by id. | Still connected. | **PASS** | Connected as Ada. |

### Regression

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| REG-01 | Every built-in template still validates against the block list | Load every template and run the workflow checker. | No unknown blocks or problems. | **PASS** | 15 templates ok |
| REG-02 | An n8n export containing a Notion and a Webhook-respond node imports without crashing | POST /import/n8n with a small export. | Imported or refused politely. | **PASS** | status 201 |
| REG-03 | The earlier schedule picker saves cron and the Schedule node still validates | Create a Schedule workflow with a picker-style cron and a custom one. | Accepted. | **PASS** | 3 schedules run |

### Performance

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| PERF-01 | The plugin system keeps start-up and memory lean (compared with master) | Start master and this branch, 3 times each; then 200 runs; read memory. | Start-up within +600 ms and memory within +25 MB of master. | **PASS** | start-up master 314 ms vs branch 453 ms; memory master 71->74 MB vs branch 73->74 MB |
| PERF-02 | The block list stays small and the editor bundle did not balloon | Size of /node-types and the built JS/CSS. | Block list < 120 KB; JS < 450 KB. | **PASS** | node-types 34 KB, js 402 KB |
| PERF-03 | Reload is quick and 200 Respond-to-Webhook calls are fast | Time 5 reloads; 200 sequential webhook calls. | Reload < 1 s each; 200 calls < 20 s. | **PASS** | reload 68/46/47/39/37 ms; 200 calls 1255 ms (6 ms each) |

### Download

| ID | Test case | Steps | Expected | Result | What happened |
|---|---|---|---|---|---|
| DIST-01 | A fresh copy (as a user would download it) contains the plugins and starts with them | git archive of this branch into an empty folder, npm install, start, list plugins. | Plugins page data is complete; the editor bundle has the Plugins page. | **PASS** | 3 plugins in a clean copy |
