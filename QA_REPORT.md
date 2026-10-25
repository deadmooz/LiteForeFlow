# LiteForeFlow - QA report

Scope: black-box HTTP scenarios against freshly started servers (6 configurations), white-box scenarios, production-stack scenarios (real Postgres 18 + Redis 8, with outage drills) and UI scenarios in a real browser (desktop, 375 px mobile, light and dark).

| Area | Total | Passed | Failed | Blocked |
|---|---|---|---|---|
| API / engine (black-box) | 200 | 184 | 0 | 16 |
| White-box | 16 | 16 | 0 | 0 |
| Production stack (Postgres + Redis) | 8 | 8 | 0 | 0 |
| UI (browser) | 45 | 45 | 0 | 0 |
| **All** | **269** | **253** | **0** | **16** |

Round 2 (after fixes): every finding from round 1 was fixed and re-verified.

Earlier in this session: 15 integration tests on each of 3 stacks (SQLite / Postgres / Postgres+BullMQ), 3 multi-process worker tests, the compose-stack e2e with 2 workers, and the SIGTERM / SIGKILL worker drills.

## Findings from round 1 - all fixed and re-verified

### UNIT-01 - Edit Fields: "__proto__.x", "constructor.prototype.x" paths cannot pollute Object.prototype
- **Severity:** Critical
- **Why it failed:** The Edit Fields node (`server/src/nodes/core.js`, `setPath`) walks `cur[k]` for every segment of a user-supplied field name, so a field named `__proto__.x` or `constructor.prototype.x` writes onto `Object.prototype`.
- **Impact:** Prototype pollution of the whole API/worker process: any workspace user can add properties to every object in the server (status codes, flags, config reads). Reject `__proto__`/`constructor`/`prototype` segments or build results with `Object.create(null)`.
- **Fix applied:** Edit Fields rejects `__proto__`, `constructor` and `prototype` path segments and only follows own properties (`setPath`/`getPath`).

### SEC-05 - ReDoS: a catastrophic user regex in an IF node must not freeze the whole server
- **Severity:** High
- **Why it failed:** The IF operator `regex` runs `new RegExp(userPattern).test(userValue)` directly in the Node process (`core.js`, OPS.regex).
- **Impact:** A catastrophic pattern such as `(a+)+$` on a 28-character value froze the **entire server for 32 s** (and exponentially longer with a longer string). One request from any user takes the instance down. Evaluate regexes in the sandbox with a timeout, use a linear-time engine (RE2), or cap pattern/input length.
- **Fix applied:** User regexes now run inside the sandbox via `testRegex` with a 250 ms timeout, pattern <= 1000 chars, subject <= 200 kB; catastrophic patterns fail with a clear message and never touch the server thread.

### CODE-05 - Infinite loop is killed by the timeout and the server stays responsive
- **Severity:** High
- **Why it failed:** Sandbox execution uses isolated-vm's *synchronous* API (`runSync`), so the 1-5 s script timeout blocks the Node event loop.
- **Impact:** One `while(true){}` in a Code node makes the whole process (API, webhooks, health check) unresponsive for ~5 s; repeating it keeps the server effectively down. The code itself stays contained, but this is a cheap denial of service. Move to async `run()` or a separate worker pool/process.
- **Fix applied:** Sandbox execution switched to isolated-vm's async API and all parameter resolution (`ctx.param`/`jsonParam`) became async, so looping code runs on a worker thread while the event loop keeps serving requests (measured: 97 timer ticks during 1.5 s of `while(true)`).

### HTTP-13 - SSRF protection ON: loopback, link-local metadata, private ranges, IPv6 and numeric-IP tricks are blocked
- **Severity:** High (only when BLOCK_PRIVATE_NETWORK=true)
- **Why it failed:** `isPrivateIp` recognises `::ffff:127.0.0.1` in dotted form, but Node's URL parser normalises `http://[::ffff:127.0.0.1]/` to hex `::ffff:7f00:1`, which is not recognised.
- **Impact:** SSRF protection can be bypassed to reach loopback/internal services through an IPv4-mapped IPv6 address. Use `net.BlockList` (or convert mapped addresses back to IPv4) before checking.
- **Fix applied:** New IP classifier expands any IPv6 spelling to bytes and checks IPv4-mapped (dotted and hex), IPv4-compatible, NAT64, 6to4, Teredo, link-local, unique-local, multicast and reserved ranges; unparseable addresses are refused.

### REL-05 - Workflow timeout also applies when the slow node is the LAST node (and stops the node promptly)
- **Severity:** Medium
- **Why it failed:** `engine.js` checks the workflow deadline only *between* nodes (`if (Date.now() > deadline)` at the top of the node loop).
- **Impact:** A last (or only) slow node can run far past `timeoutSec` and the run still reports success; a slow middle node overshoots by its full duration. Race each node against the remaining time (Promise.race + abort signal).
- **Fix applied:** One abort signal per run races every node against the workflow timeout; Wait and HTTP nodes stop immediately, no retries after a timeout.

### TEN-10 - Owner can remove a member; the removed member immediately loses access
- **Severity:** Medium (feature gap)
- **Why it failed:** There is no endpoint or UI to remove a member or leave a workspace (only invite).
- **Impact:** An owner cannot revoke a member's access - a departing teammate keeps access to every workflow and credential. Add `DELETE /api/workspace/members/:id` and a "Leave workspace" action.
- **Fix applied:** New `DELETE /api/workspace/members/:userId` (owner removes a member, a member can leave, the owner cannot be removed) plus Remove / Leave buttons on the Usage page.

### EXE-03 - Hostile limit/offset values (negative, text, huge, float) are handled without 500
- **Severity:** Medium
- **Why it failed:** `/api/executions` passes `Number(req.query.limit)` into SQL after only `Math.min(200, ...)` - no integer or minimum clamp.
- **Impact:** `limit=2.7` -> HTTP 500 on SQLite. Clamp with `Math.max(1, Math.floor(n))` for limit and `Math.max(0, Math.floor(n))` for offset.
- **Fix applied:** limit/offset are clamped to whole numbers in range (limit 1-200, offset >= 0).

### INF-02 - Executions API with float / negative / text limits on Postgres does not 500
- **Severity:** Medium
- **Why it failed:** Same root cause as EXE-03, observed on the production database (Postgres is stricter than SQLite).
- **Impact:** 4 of 6 hostile limit/offset values return HTTP 500: `limit=2.7`, `limit=-1`, `offset=-5`, `offset=1.5`.
- **Fix applied:** Same clamp; verified on Postgres.

### SEC-02 - Clickjacking / CSP / referrer protection headers are set on the app shell and the API
- **Severity:** Medium
- **Why it failed:** Only `X-Content-Type-Options` is set (`app.js`).
- **Impact:** No `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors` or `Referrer-Policy`: the app can be framed (clickjacking) and there is no second line of defence if an XSS ever lands (the JWT lives in localStorage). Add them (e.g. with `helmet`).
- **Fix applied:** CSP (script-src self, frame-ancestors none), X-Frame-Options DENY, Referrer-Policy no-referrer, Permissions-Policy on every response, HSTS behind HTTPS proxies; the editor was re-tested under the CSP with zero violations.

### INF-06 - Queue back-pressure: with MAX_QUEUE_DEPTH=1 and no worker, extra webhook calls get 503 (not a hang) and do not leave ghost "queued" runs
- **Severity:** Medium
- **Why it failed:** `submitExecution` reserves monthly quota (`reserveRun`) before enqueueing; when the queue refuses the job (503) the reservation is not returned.
- **Impact:** Rejected requests still burn the customer's monthly quota (3 calls, 1 accepted -> usage 3). Refund on enqueue failure, or reserve after a successful enqueue.
- **Fix applied:** A run refused by the queue (503) gives its monthly-quota reservation back.

### INF-07 - Redis outage: API keeps answering reads, webhook calls fail fast with a 5xx, and everything recovers when Redis returns
- **Severity:** Medium
- **Why it failed:** ioredis runs with `maxRetriesPerRequest: null` (required by BullMQ workers) and `enqueue` has no timeout, so `queue.add` waits indefinitely while Redis is down.
- **Impact:** During a Redis outage every webhook caller hangs (no answer in 12 s) and holds a socket. Verified: they all complete ~2 s after Redis returns, nothing is lost, reads keep working. Fail fast with a timeout and a 503 so senders can retry.
- **Fix applied:** Enqueueing is bounded by `QUEUE_ENQUEUE_TIMEOUT_MS` (default 5 s) and answers 503 while Redis is unreachable; late jobs are ignored because the execution row is already closed. Recovery verified.

### UI-35 - Mobile 375 px: list pages fit the screen
- **Severity:** Medium
- **Why it failed:** The Workflows and Executions tables have fixed intrinsic width and no responsive layout.
- **Impact:** On a 375 px phone the tables are 411 px / 238 px wider than the screen; users must scroll sideways inside the content area.
- **Fix applied:** Tables become stacked label/value cards under 720 px.

### UI-36 - Mobile 375 px: editor canvas usable
- **Severity:** Medium
- **Why it failed:** The editor is three fixed columns (sidebar 64 + palette 150 + panel 280 px).
- **Impact:** At 375 px the canvas is 0 px wide - the editor is unusable on phones. Collapse palette/panel into drawers below ~900 px.
- **Fix applied:** Below 900 px the node palette and settings panel become slide-in drawers (new "+ Nodes" / "Settings" buttons); canvas is 311 px wide at 375 px.

### AUTH-13 - Passwords that differ only after byte 72 must not be interchangeable
- **Severity:** Low
- **Why it failed:** `bcryptjs` only hashes the first 72 bytes and there is no maximum password length.
- **Impact:** Two different passwords that share their first 72 bytes are interchangeable. Enforce a max length (<= 72 bytes) or pre-hash with SHA-256 before bcrypt.
- **Fix applied:** Passwords longer than 72 bytes are rejected at signup with a clear message.

### IMP-04 - n8n import respects the 200-node limit that normal creation enforces
- **Severity:** Low
- **Why it failed:** The n8n import route calls `createWorkflow` without `checkDefinition`, so the 200-node cap and shape checks used elsewhere are skipped.
- **Impact:** A 250-node import is stored (only the 5 MB body limit applies). Reuse `checkDefinition` in the import route.
- **Fix applied:** The n8n import route now goes through the same `checkDefinition` (200-node cap, shape checks) as normal creation.

### UI-20 - Activating a manual-trigger-only workflow gives clear feedback
- **Severity:** Low (UX)
- **Why it failed:** Activation validation only requires *a* trigger node; a Manual Trigger counts.
- **Impact:** The UI says "Workflow activated" / "Active" for a workflow that can never fire, and it consumes one of the 5 free active slots. Reject or warn when no schedule/webhook/RSS trigger exists.
- **Fix applied:** Activation requires a Webhook, Schedule or RSS trigger and explains why when refused (Manual and Error triggers cannot start a workflow).

### UI-34 - Light-mode colour contrast >= 4.5:1
- **Severity:** Low
- **Why it failed:** Success green is 4.43:1 on its background (`--ok` in light mode).
- **Impact:** Misses WCAG AA (4.5:1) by 0.07 for success badges/text in light mode. Darken the green slightly.
- **Fix applied:** Success green darkened to #0f6b3c (5.85:1).

### Also hardened

- Postgres pool now has connect (5 s) and query (30 s) timeouts, and concurrent schema creation at boot tolerates the unique-violation race (12/12 simultaneous-boot rounds).

## Blocked (could not be tested here)

- **AUTH-11** Expired token is rejected - needs the signing key; expiry is delegated to the jsonwebtoken library (7d) — not independently verifiable black-box
- **TRG-23** RSS: feed parser handles RSS 2.0 (CDATA, entities) and Atom - covered in unit scenarios (UNIT-03) because polling interval is ≥ 5 min; see QA-UNIT report
- **HTTP-14** SSRF protection ON: public-looking host that redirects to loopback is not followed - needs a public redirector; with protection on the client uses redirect:"manual", so redirects are returned as 3xx and never followed (verified by code review)
- **APP-04** Slack: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-05** Telegram: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-06** Discord: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-07** Notion: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-08** Airtable: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-09** Stripe: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-10** HubSpot: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **APP-11** Google Sheets: request building and response mapping against the live service - needs a real account/token; vendor base URLs are hard-coded, so they cannot be pointed at a mock (see report: recommend configurable base URLs)
- **PLAN-12** Real Stripe Checkout round trip - needs live/test Stripe keys and a public webhook URL
- **EXE-10** Log retention pruning (free plan: 3 days) - needs a clock/DB manipulation; covered by unit-level review of pruneExecutions (QA-UNIT)
- **SEC-06** Prototype pollution via Edit Fields ("__proto__.x") does not modify Object.prototype in the server - verified in-process in the unit scenarios (UNIT-01) — cannot be observed from outside
- **RES-02** Graceful shutdown (SIGTERM) exits promptly - Windows cannot deliver SIGTERM to a Node child (process is terminated abruptly); verified on Linux containers earlier (docker stop finished the in-flight run)
- **RES-03** Corrupt/missing data dir: server refuses to start with a clear message instead of silently creating a new empty DB elsewhere - not exercised: SQLite creates the DB on demand by design

## Everything that passed

### Authentication & accounts
- OK **AUTH-01** Sign up with valid data returns 201, token, workspace
- OK **AUTH-02** Duplicate email is rejected (409)
- OK **AUTH-03** Duplicate email with different letter case is rejected
- OK **AUTH-04** Malformed emails are rejected (400)
- OK **AUTH-05** Password shorter than 8 characters is rejected
- OK **AUTH-06** Signup with empty / missing body returns 400, not 500
- OK **AUTH-07** Login with correct credentials works; email is case/whitespace-insensitive
- OK **AUTH-08** Wrong password and unknown user give the same 401 message (no user enumeration on login)
- OK **AUTH-09** SQL-injection style input in login does not authenticate
- OK **AUTH-10** Protected endpoints reject missing / garbage / forged tokens
- OK **AUTH-12** Very long password (200 KB) is handled quickly (no DoS) and is not stored in plaintext
- OK **AUTH-13** Passwords that differ only after byte 72 must not be interchangeable
- OK **AUTH-14** HTML in display name is stored as text and returned unchanged (UI must escape) _(note: API returns raw text by design; React escapes it (see UI-12))_
- OK **AUTH-15** Overlong display name is truncated, not rejected with 500
- OK **AUTH-16** Brute-force protection: repeated failed logins eventually return 429
- OK **AUTH-17** Signups can be disabled (ALLOW_SIGNUP=false) and return 403

### Multi-tenancy & workspace isolation
- OK **TEN-01** User B cannot read, update, delete, run, duplicate, activate or test-node user A's workflow
- OK **TEN-02** Workflow list only contains the caller's own workflows
- OK **TEN-03** Credentials of another workspace are invisible and undeletable
- OK **TEN-04** Executions of another workspace are invisible and undeletable
- OK **TEN-05** B cannot use A's credential id inside B's own workflow
- OK **TEN-06** B cannot execute A's workflow through an Execute Workflow node
- OK **TEN-07** Spoofed x-workspace-id header for a workspace the user is not a member of is ignored
- OK **TEN-08** Team: only owner can invite; unknown email 404; duplicate 409; free plan caps members (402)
- OK **TEN-09** After upgrading, invited member can access shared workspace via header, owner-only actions stay blocked
- OK **TEN-10** Owner can remove a member; the removed member immediately loses access
- OK **TEN-11** Member removal rules: owner cannot be removed, a member cannot remove others, a member can leave, unknown id is 404

### Workflow CRUD & validation
- OK **WF-01** Create with no definition gives an empty workflow
- OK **WF-02** Malformed definitions are rejected with 400
- OK **WF-03** More than 200 nodes is rejected (400)
- OK **WF-04** Rename keeps the definition; update replaces it; updatedAt moves
- OK **WF-05** Mass assignment: PUT cannot set active/workspace/id through the body
- OK **WF-06** Workflow name is trimmed to 120 chars; empty name becomes "Untitled workflow"
- OK **WF-07** Delete returns 204, then 404; execution history is removed
- OK **WF-08** Deleting an ACTIVE workflow frees its webhook path immediately
- OK **WF-09** Duplicate creates an inactive copy with a new webhook path
- OK **WF-10** Invalid JSON body returns 400; oversized body returns 413 (not 500)
- OK **WF-11** List is ordered most-recently-updated first
- OK **WF-12** Settings (error workflow, timeout, saveSuccessData) persist round-trip
- OK **WF-13** Running a definition with duplicate node names / unknown type / dangling edge returns a clear 400
- OK **WF-14** Name containing quotes, emoji and RTL text round-trips

### Engine: data flow & expressions
- OK **ENG-01** Linear workflow passes data node to node
- OK **ENG-02** A whole-value expression keeps its type (number, boolean, object, array, null)
- OK **ENG-03** Mixed text + expressions interpolate; objects become JSON; null/undefined become empty
- OK **ENG-04** $node["Name"] reads another node's output; $input.all() and $itemIndex work
- OK **ENG-05** Reading a property of undefined fails the run with a readable "Expression error" naming the node
- OK **ENG-06** Expression syntax error is reported, not swallowed
- OK **ENG-07** Unicode, emoji, quotes and newlines survive expressions untouched
- OK **ENG-08** 1,500 items × 2 expressions complete within 10 s and are all processed _(note: 986 ms)_
- OK **ENG-09** Large single item (2 MB string) flows through nodes _(note: run succeeded, but the stored log omits node data above ~1 MB, so the editor shows no input/output for this run (by design, documented))_
- OK **ENG-10** Deeply nested JSON (200 levels) is processed

### Engine: branching & logic nodes
- OK **ENG-11** IF routes items to true/false outputs; empty branch downstream is skipped
- OK **ENG-12** IF operators: equals notEquals contains startsWith endsWith lt gte isEmpty isNotEmpty regex isTrue isFalse
- OK **ENG-13** IF combine=any vs all
- OK **ENG-14** Switch routes by case, sends unmatched to fallback; numeric/string values match
- OK **ENG-15** Switch with invalid cases JSON fails with a clear message
- OK **ENG-16** Merge: append, combineByPosition, combineByKey
- OK **ENG-17** Merge still runs when only one branch produced items
- OK **ENG-18** Split Out / Aggregate / Limit; Split Out on a non-array fails clearly
- OK **ENG-19** Edit Fields: dotted paths create nested objects; keepOthers=false drops the rest
- OK **ENG-20** Wait node pauses; Stop and Error fails with its message
- OK **ENG-21** Disabled node passes data through unchanged
- OK **ENG-22** Cycles, missing trigger and unknown nodes are rejected before running

### Engine: Code node & sandbox
- OK **CODE-01** runOnce: array, single object, null and undefined returns are handled
- OK **CODE-02** eachItem mode sees $json per item
- OK **CODE-03** console.log output is captured into the node log
- OK **CODE-04** Syntax and runtime errors surface with a "Code error" message
- OK **CODE-05** Infinite loop is killed by the timeout and the server stays responsive _(note: worst health-check latency while a Code node looped for 5 s: 15 ms)_
- OK **CODE-06** Memory bomb is contained (run fails, server survives)
- OK **CODE-07** Async code / Promises are rejected with an explanation
- OK **CODE-08** Sandbox exposes no process/require/fetch/timers/Buffer/module/global
- OK **CODE-09** Sandbox-escape payloads (constructor chains, import(), prototype tricks) all fail safely
- OK **CODE-10** Expression-sandbox escapes ({{ }}) fail safely
- OK **CODE-11** Code node result larger than the cap fails instead of crashing the server _(note: status=error)_

### Engine: reliability (retry, continue-on-fail, timeouts, sub-workflows, error workflows)
- OK **REL-01** Retry-on-fail retries until success (503,503,200)
- OK **REL-02** Retry gives up after maxTries and fails the run with the last error
- OK **REL-03** continueOnFail keeps the run alive and passes the error downstream
- OK **REL-04** Workflow timeout: a run exceeding timeoutSec fails at the next node
- OK **REL-05** Workflow timeout also applies when the slow node is the LAST node (and stops the node promptly)
- OK **REL-13** A node that overruns the timeout is not retried and the next workflow still runs normally
- OK **REL-06** Sub-workflow (Execute Workflow) returns the child's output to the parent
- OK **REL-07** Missing sub-workflow id fails with a clear message
- OK **REL-08** Self-recursive sub-workflow stops at the depth limit instead of looping forever
- OK **REL-09** Error workflow fires with workflow/execution/error details; failing workflow without handler does not crash
- OK **REL-10** Error handler that itself fails does not trigger an infinite error loop
- OK **REL-11** Run data: output longer than 100 items is capped in the log but the run still processes all items _(note: log capped at 100 items/output (aggregate saw all 500 internally))_
- OK **REL-12** Test-step on a single node uses the previous run's input

### Triggers: webhooks
- OK **TRG-01** POST JSON webhook delivers body/query/method/headers to the workflow
- OK **TRG-02** GET / PUT / DELETE / ANY methods; mismatched method returns 404
- OK **TRG-03** Leading/trailing slashes and nested paths resolve
- OK **TRG-04** Inactive, deleted and unknown webhooks return 404 JSON
- OK **TRG-05** Shared secret: missing → 401, wrong → 401, correct → 200
- OK **TRG-06** Body formats: form-urlencoded and text/plain are parsed; invalid JSON → 400; empty body ok
- OK **TRG-07** Respond=lastNode returns the last node's data; failure returns 500 with the message and execution id
- OK **TRG-08** Immediate mode answers fast (<1 s) even when the workflow is slow, and the run completes afterwards
- OK **TRG-09** Authorization / cookie / secret headers are NOT written to the execution log
- OK **TRG-10** Two active workflows cannot claim the same path; same path with different methods is allowed
- OK **TRG-11** Webhook path claimed by user A cannot be taken by user B (global namespace) and reveals nothing sensitive _(note: paths are a global namespace: a user can learn that a path is taken (acceptable; paths are unguessable by convention))_
- OK **TRG-12** Unicode / spaces / special characters in a webhook path
- OK **TRG-13** Activating a webhook node with an empty path fails with 400
- OK **TRG-14** 100 concurrent webhook calls are all accepted and recorded exactly once
- OK **TRG-15** A 4 MB webhook body is accepted; a 6 MB body is rejected with 413
- OK **TRG-16** Editor run of a webhook workflow with invalid sample payload returns a clear 400

### Triggers: schedule, RSS, manual
- OK **TRG-20** Cron: invalid expression is rejected at activation; valid 5- and 6-field expressions activate
- OK **TRG-21** Cron fires on schedule (every 2 s) and stops after deactivation
- OK **TRG-22** Editing an active cron workflow re-arms the schedule with the new expression
- OK **TRG-24** Activating a workflow nothing can start (manual-only / error-trigger-only) is refused with guidance and uses no quota

### HTTP Request node
- OK **HTTP-01** GET JSON object: fields are spread + statusCode; array response is under "data"
- OK **HTTP-02** Plain-text response is returned as text
- OK **HTTP-03** POST JSON body with expressions; query + headers JSON are sent
- OK **HTTP-04** Form-encoded body
- OK **HTTP-05** Bearer, Basic and custom-header credentials set the right headers
- OK **HTTP-06** 4xx/5xx fails the run with "HTTP <code>"; ignoreStatus lets the workflow continue
- OK **HTTP-07** Timeout is honoured (1 s timeout vs 3 s response)
- OK **HTTP-08** Invalid URL, unsupported schemes and unresolvable hosts produce clear errors
- OK **HTTP-09** Redirects are followed
- OK **HTTP-10** Header-injection attempt through a header value is rejected, not sent
- OK **HTTP-11** Invalid headers JSON gives a clear message
- OK **HTTP-12** SSRF: default install CAN reach loopback/private addresses (by design for self-hosting) _(note: expected on self-hosted; BLOCK_PRIVATE_NETWORK=true closes it (next test))_
- OK **HTTP-13** SSRF protection ON: loopback, link-local metadata, private ranges, IPv6 and numeric-IP tricks are blocked

### Credentials
- OK **CRED-01** Create / list / get / update / delete lifecycle
- OK **CRED-02** Validation: missing fields, unknown type and bad body are 400
- OK **CRED-03** Secrets never appear in list/get responses; only "secretsSet" names do
- OK **CRED-04** Updating without re-entering a secret keeps the stored secret; entering a new one replaces it
- OK **CRED-05** Secret is encrypted at rest (not found as plaintext in the database files)
- OK **CRED-06** Using a credential of the wrong type, or after deletion, fails with a clear message
- OK **CRED-07** Google service-account credential validates the JSON key shape
- OK **CRED-08** Credential values do not leak into execution logs or error messages

### AI nodes (against a local OpenAI/Anthropic-compatible mock)
- OK **AI-01** LLM node: OpenAI-compatible provider returns text/model/usage
- OK **AI-02** LLM node: Anthropic provider
- OK **AI-03** parseJson extracts JSON (also from ```json fences); non-JSON reply fails clearly
- OK **AI-04** Provider 401 surfaces a useful error (and the API key is not echoed)
- OK **AI-05** Credential for the wrong provider is rejected
- OK **AI-06** Agent (OpenAI): tool-calling loop runs calculator and returns the final answer
- OK **AI-07** Agent (Anthropic): tool_use loop
- OK **AI-08** Agent: a hallucinated tool name is handled gracefully (no crash)
- OK **AI-09** Agent: runaway tool loop stops at maxSteps
- OK **AI-10** Agent: calculator tool refuses non-arithmetic input (model-injected code)
- OK **AI-11** Agent: http_get tool can fetch a URL (and is subject to the SSRF setting) _(note: prompt-injection risk: a model can be told to fetch internal URLs unless BLOCK_PRIVATE_NETWORK=true)_
- OK **AI-12** Agent: tools given as invalid JSON / non-array fails clearly

### App integrations (Slack, Telegram, Discord, Notion, Airtable, Stripe, HubSpot, Postgres, SMTP, Sheets)
- OK **APP-01** Every app node refuses to run without a credential, with a clear message
- OK **APP-02** SMTP email node sends a real message to a local SMTP server
- OK **APP-03** SMTP failure (connection refused) is reported, not hung

### Plans, limits & billing
- OK **PLAN-01** Free plan: 6th active workflow is refused with 402; deactivating one frees a slot
- OK **PLAN-02** Re-activating an already-active workflow does not consume extra quota
- OK **PLAN-03** Monthly run cap (1000): run #1000 passes, #1001 is refused with 402; usage shows 1000/1000
- OK **PLAN-04** Cap is exact under concurrency: 50 parallel runs when 10 remain → exactly 10 succeed
- OK **PLAN-05** At the cap, webhooks answer 402 and editor shows the limit message; upgrading lifts it immediately
- OK **PLAN-06** Errors, sub-workflow and error-handler runs are not double-counted against the cap
- OK **PLAN-07** dev-plan endpoint: unknown plan → 400; works for the owner; is hidden (404) in production mode
- OK **PLAN-08** Stripe checkout without configuration returns 501 with guidance
- OK **PLAN-09** Stripe webhook: bad / missing / stale / tampered signatures are rejected (400) and change nothing
- OK **PLAN-10** Stripe webhook: valid checkout.session.completed upgrades the plan; subscription.deleted downgrades
- OK **PLAN-11** Stripe webhook: unknown plan name in metadata is ignored

### Templates & n8n import
- OK **TPL-01** All 15 templates are listed and each one creates a structurally valid workflow
- OK **TPL-02** Using the same template twice yields unique webhook paths that can both be active
- OK **TPL-03** Unknown template id is 404
- OK **IMP-01** n8n import: converts nodes, connections (incl. IF true/false outputs) and strips "=" from expressions
- OK **IMP-02** n8n import: unsupported nodes become placeholders and are reported; sticky notes are dropped
- OK **IMP-03** n8n import: garbage input is rejected with 400 (string, empty object, nodes not array, null)
- OK **IMP-04** n8n import respects the 200-node limit that normal creation enforces
- OK **IMP-05** n8n import: schedule trigger / webhook / http / code / wait convert with sane parameters

### Executions API
- OK **EXE-01** List supports status and workflow filters; newest first
- OK **EXE-02** Pagination: limit + offset page through without overlap
- OK **EXE-03** Hostile limit/offset values (negative, text, huge, float) are handled without 500
- OK **EXE-04** Negative limit must not turn into "return everything"
- OK **EXE-05** Detail returns per-node input/output/timing/status and error with node name
- OK **EXE-06** Unknown execution id → 404; delete works and is scoped to the owner
- OK **EXE-07** SQL-injection style filter values are treated as data
- OK **EXE-08** Run data is gzip-compressed at rest and transparent through the API
- OK **EXE-09** saveSuccessData=false keeps only a record for successes but full data for failures

### Security
- OK **SEC-01** x-powered-by removed; X-Content-Type-Options: nosniff on every response
- OK **SEC-02** Clickjacking / CSP / referrer protection headers are set on the app shell and the API
- OK **SEC-03** Static file serving cannot escape the web root (path traversal)
- OK **SEC-04** Unknown /api routes return JSON 404; unknown pages fall back to the SPA
- OK **SEC-05** ReDoS: a catastrophic user regex in an IF node must not freeze the whole server _(note: worst health latency 10 ms; run failed cleanly with: Regular expression took too long to evaluate (possible catas)_
- OK **SEC-12** Regex operator still works for normal patterns; invalid / oversized patterns give clear errors
- OK **SEC-07** Error responses never leak stack traces or file paths
- OK **SEC-08** CORS: cross-origin pages can call the API only with a bearer token (no cookies); preflight answers _(note: ACAO: * — wide open, but safe because auth is a bearer header (no cookie/CSRF surface). Tighten for a hosted SaaS.)_
- OK **SEC-09** Bearer token is stored in localStorage (XSS-exposed) _(note: design note: a successful XSS would exfiltrate the 7-day JWT. React escaping + a CSP (SEC-02) are the mitigations; httpOnly cookies would be stronger.)_
- OK **SEC-10** Webhook secret comparison is constant-time and the secret is not echoed back anywhere _(note: webhook secret is stored in the workflow definition in plaintext (visible to workspace members in the editor) — by design)_
- OK **SEC-11** A __proto__/constructor key in JSON bodies does not break or pollute the server

### Resilience: crash & restart
- OK **RES-01** After kill -9 and restart: accounts, workflows, credentials and active webhooks survive; in-flight run is marked failed; cron resumes
- OK **RES-04** Concurrent edits: two simultaneous PUTs to one workflow never corrupt the definition _(note: last-write-wins (no optimistic locking): two editors silently overwrite each other — product gap)_

### Unit / white-box
- OK **UNIT-01** Edit Fields: "__proto__.x", "constructor.prototype.x" paths cannot pollute Object.prototype
- OK **UNIT-02** Execution-log compression round-trips and passes small/legacy plain JSON through
- OK **UNIT-03** RSS feed parser: RSS 2.0 with CDATA/entities, Atom, empty and malformed input
- OK **UNIT-04** n8n expression conversion: leading "=", $('Node').item/first/last, $input.item
- OK **UNIT-05** Credential validation: required/optional fields, Google key shape
- OK **UNIT-06** Form encoding handles nested objects and skips empty values (Stripe style)
- OK **UNIT-07** Graph ordering is fast on large graphs (200-node chain and wide fan-out) and detects cycles
- OK **UNIT-08** Sandbox: CPU-bound expression is killed by the 1 s timeout; isolates are reusable afterwards
- OK **UNIT-09** Sandbox: expression result size cap and JSON-unsafe values (functions, cycles, BigInt) fail cleanly
- OK **UNIT-10** Code node: 1000 sequential isolate creations do not leak memory (RSS growth < 150 MB) _(note: RSS grew 5 MB over 1000 isolates)_
- OK **UNIT-11** Retention pruning deletes old logs per plan and fails executions stuck in running/queued > 2 h
- OK **UNIT-12** Credential encryption: random IV per message, tampering detected, wrong key rejected
- OK **UNIT-13** Usage counter: atomic upsert under 200 parallel reservations never exceeds the cap
- OK **UNIT-14** SSRF classifier: every spelling of loopback / private / link-local / mapped / NAT64 / 6to4 is private; public addresses are not
- OK **UNIT-15** testRegex: matches normally, rejects invalid / oversized patterns, aborts catastrophic backtracking in < 1 s without blocking the event loop
- OK **UNIT-16** Event loop stays free while the sandbox burns CPU (async execution) _(note: 97 timer ticks during 1515 ms of looping code)_

### Production stack: Postgres + Redis/BullMQ
- OK **INF-01** Postgres node: parameterised SELECT, quote-safe values, multi-row output, INSERT rowCount
- OK **INF-02** Executions API with float / negative / text limits on Postgres does not 500
- OK **INF-03** Execution data is stored compressed in Postgres and readable via the API
- OK **INF-04** Two API processes + shared worker: workflow activated on one is served by the other; cron fires once per tick (not per instance)
- OK **INF-05** 3 servers booting at once against a fresh schema all migrate safely (advisory lock)
- OK **INF-06** Queue back-pressure: with MAX_QUEUE_DEPTH=1 and no worker, extra webhook calls get 503 (not a hang) and do not leave ghost "queued" runs
- OK **INF-07** Redis outage: API keeps answering reads, webhook calls fail fast with a 5xx, and everything recovers when Redis returns
- OK **INF-08** Postgres outage: API answers 5xx quickly (no hang) and the process stays alive

### UI (browser)
- OK **UI-01** Login page shows brand, title and form
- OK **UI-02** Wrong credentials show an inline error
- OK **UI-03** Signup enforces minimum password length client-side
- OK **UI-04** Signup logs in and lands on the empty Workflows page
- OK **UI-05** Unauthenticated visit to a private page redirects to /login
- OK **UI-06** Garbage/expired token returns the user to login (no blank screen)
- OK **UI-07a** Templates page lists 15 templates; category filter works
- OK **UI-08** Template opens in the editor with nodes, edges and labelled Switch outputs
- OK **UI-09** Same node type twice gets unique names; new node auto-connects to the selection
- OK **UI-10** Deleting a node removes its connections
- OK **UI-11** Duplicate node name warns; Run refused with a readable message
- OK **UI-12** HTML/JS in a workflow name is rendered as inert text
- OK **UI-13** New workflow creates a Manual Trigger and opens the editor
- OK **UI-14** Unsaved-changes indicator + Save enabled
- OK **UI-15** Ctrl+S saves
- OK **UI-16** Run works under the strict CSP, colours nodes by status + summary
- OK **UI-17** Data tab shows input/output
- OK **UI-18** Test this step works
- OK **UI-19** Retry-on-fail reveals its inputs
- OK **UI-20** Activating a manual-trigger-only workflow gives clear feedback
- OK **UI-21** Credential secrets are masked password inputs
- OK **UI-22** Missing required secret shows an error, modal stays open
- OK **UI-23** Credential created and listed
- OK **UI-24** Editing never shows the stored secret
- OK **UI-25** Escape closes modals
- OK **UI-26** Delete credential asks for confirmation and removes it
- OK **UI-27** n8n import: invalid JSON message
- OK **UI-28** n8n import: non-n8n JSON message
- OK **UI-29** Executions list + per-node detail modal
- OK **UI-30** Executions status filter
- OK **UI-31** Usage page meters + current plan
- OK **UI-32** Accessibility basics on 5 pages (names, labels, one h1, lang)
- OK **UI-33** Keyboard focus indicator defined
- OK **UI-34** Light-mode colour contrast >= 4.5:1
- OK **UI-35** Mobile 375 px: list pages fit the screen
- OK **UI-36** Mobile 375 px: editor canvas usable
- OK **UI-37** Dark-mode colour contrast >= 4.5:1
- OK **UI-38** Editor renders 150 nodes in < 3 s (measured 1.1 s)
- OK **UI-20b** A workflow with a Webhook trigger activates normally and shows its URL
- OK **UI-35b** Mobile: table rows become stacked cards with field labels
- OK **UI-36b** Mobile: palette/settings drawers open fully on screen
- OK **UI-42** Owner row has no Remove/Leave action; invite form present
- OK **UI-39** 150-node workflow runs and paints statuses
- OK **UI-40** Editor buttons/inputs have accessible names
- OK **UI-41** Sign out clears the session; Back shows nothing private
