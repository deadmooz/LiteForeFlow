"""Builds QA_REPORT.md from the JSON result files written by qa.mjs / qa-unit.mjs / qa-infra.mjs plus the UI list below."""
import json
import os

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, '..', '..', '..'))
load = lambda f: json.load(open(os.path.join(here, f), encoding='utf8'))['results']
core, unit, infra = load('qa-results.json'), load('qa-unit-results.json'), load('qa-infra-results.json')

ui_fail = set()  # every UI finding from round 1 was fixed and re-verified
ui = [
    ('UI-01', 'Login page shows brand, title and form'), ('UI-02', 'Wrong credentials show an inline error'),
    ('UI-03', 'Signup enforces minimum password length client-side'), ('UI-04', 'Signup logs in and lands on the empty Workflows page'),
    ('UI-05', 'Unauthenticated visit to a private page redirects to /login'), ('UI-06', 'Garbage/expired token returns the user to login (no blank screen)'),
    ('UI-07a', 'Templates page lists 15 templates; category filter works'), ('UI-08', 'Template opens in the editor with nodes, edges and labelled Switch outputs'),
    ('UI-09', 'Same node type twice gets unique names; new node auto-connects to the selection'), ('UI-10', 'Deleting a node removes its connections'),
    ('UI-11', 'Duplicate node name warns; Run refused with a readable message'), ('UI-12', 'HTML/JS in a workflow name is rendered as inert text'),
    ('UI-13', 'New workflow creates a Manual Trigger and opens the editor'), ('UI-14', 'Unsaved-changes indicator + Save enabled'), ('UI-15', 'Ctrl+S saves'),
    ('UI-16', 'Run works under the strict CSP, colours nodes by status + summary'), ('UI-17', 'Data tab shows input/output'), ('UI-18', 'Test this step works'),
    ('UI-19', 'Retry-on-fail reveals its inputs'), ('UI-20', 'Activating a manual-trigger-only workflow gives clear feedback'),
    ('UI-21', 'Credential secrets are masked password inputs'), ('UI-22', 'Missing required secret shows an error, modal stays open'),
    ('UI-23', 'Credential created and listed'), ('UI-24', 'Editing never shows the stored secret'), ('UI-25', 'Escape closes modals'),
    ('UI-26', 'Delete credential asks for confirmation and removes it'), ('UI-27', 'n8n import: invalid JSON message'),
    ('UI-28', 'n8n import: non-n8n JSON message'), ('UI-29', 'Executions list + per-node detail modal'), ('UI-30', 'Executions status filter'),
    ('UI-31', 'Usage page meters + current plan'), ('UI-32', 'Accessibility basics on 5 pages (names, labels, one h1, lang)'),
    ('UI-33', 'Keyboard focus indicator defined'), ('UI-34', 'Light-mode colour contrast >= 4.5:1'), ('UI-35', 'Mobile 375 px: list pages fit the screen'),
    ('UI-36', 'Mobile 375 px: editor canvas usable'), ('UI-37', 'Dark-mode colour contrast >= 4.5:1'), ('UI-38', 'Editor renders 150 nodes in < 3 s (measured 1.1 s)'),
    ('UI-20b', 'A workflow with a Webhook trigger activates normally and shows its URL'), ('UI-35b', 'Mobile: table rows become stacked cards with field labels'),
    ('UI-36b', 'Mobile: palette/settings drawers open fully on screen'), ('UI-42', 'Owner row has no Remove/Leave action; invite form present'),
    ('UI-39', '150-node workflow runs and paints statuses'), ('UI-40', 'Editor buttons/inputs have accessible names'), ('UI-41', 'Sign out clears the session; Back shows nothing private'),
]

A = {
    'UNIT-01': ('Critical', 'The Edit Fields node (`server/src/nodes/core.js`, `setPath`) walks `cur[k]` for every segment of a user-supplied field name, so a field named `__proto__.x` or `constructor.prototype.x` writes onto `Object.prototype`.',
                'Prototype pollution of the whole API/worker process: any workspace user can add properties to every object in the server (status codes, flags, config reads). Reject `__proto__`/`constructor`/`prototype` segments or build results with `Object.create(null)`.'),
    'SEC-05': ('High', 'The IF operator `regex` runs `new RegExp(userPattern).test(userValue)` directly in the Node process (`core.js`, OPS.regex).',
               'A catastrophic pattern such as `(a+)+$` on a 28-character value froze the **entire server for 32 s** (and exponentially longer with a longer string). One request from any user takes the instance down. Evaluate regexes in the sandbox with a timeout, use a linear-time engine (RE2), or cap pattern/input length.'),
    'CODE-05': ('High', 'Sandbox execution uses isolated-vm\'s *synchronous* API (`runSync`), so the 1-5 s script timeout blocks the Node event loop.',
                'One `while(true){}` in a Code node makes the whole process (API, webhooks, health check) unresponsive for ~5 s; repeating it keeps the server effectively down. The code itself stays contained, but this is a cheap denial of service. Move to async `run()` or a separate worker pool/process.'),
    'HTTP-13': ('High (only when BLOCK_PRIVATE_NETWORK=true)', '`isPrivateIp` recognises `::ffff:127.0.0.1` in dotted form, but Node\'s URL parser normalises `http://[::ffff:127.0.0.1]/` to hex `::ffff:7f00:1`, which is not recognised.',
                'SSRF protection can be bypassed to reach loopback/internal services through an IPv4-mapped IPv6 address. Use `net.BlockList` (or convert mapped addresses back to IPv4) before checking.'),
    'REL-05': ('Medium', '`engine.js` checks the workflow deadline only *between* nodes (`if (Date.now() > deadline)` at the top of the node loop).',
               'A last (or only) slow node can run far past `timeoutSec` and the run still reports success; a slow middle node overshoots by its full duration. Race each node against the remaining time (Promise.race + abort signal).'),
    'AUTH-13': ('Low', '`bcryptjs` only hashes the first 72 bytes and there is no maximum password length.',
                'Two different passwords that share their first 72 bytes are interchangeable. Enforce a max length (<= 72 bytes) or pre-hash with SHA-256 before bcrypt.'),
    'TEN-10': ('Medium (feature gap)', 'There is no endpoint or UI to remove a member or leave a workspace (only invite).',
               'An owner cannot revoke a member\'s access - a departing teammate keeps access to every workflow and credential. Add `DELETE /api/workspace/members/:id` and a "Leave workspace" action.'),
    'IMP-04': ('Low', 'The n8n import route calls `createWorkflow` without `checkDefinition`, so the 200-node cap and shape checks used elsewhere are skipped.',
               'A 250-node import is stored (only the 5 MB body limit applies). Reuse `checkDefinition` in the import route.'),
    'EXE-03': ('Medium', '`/api/executions` passes `Number(req.query.limit)` into SQL after only `Math.min(200, ...)` - no integer or minimum clamp.',
               '`limit=2.7` -> HTTP 500 on SQLite. Clamp with `Math.max(1, Math.floor(n))` for limit and `Math.max(0, Math.floor(n))` for offset.'),
    'INF-02': ('Medium', 'Same root cause as EXE-03, observed on the production database (Postgres is stricter than SQLite).',
               '4 of 6 hostile limit/offset values return HTTP 500: `limit=2.7`, `limit=-1`, `offset=-5`, `offset=1.5`.'),
    'SEC-02': ('Medium', 'Only `X-Content-Type-Options` is set (`app.js`).',
               'No `Content-Security-Policy`, `X-Frame-Options`/`frame-ancestors` or `Referrer-Policy`: the app can be framed (clickjacking) and there is no second line of defence if an XSS ever lands (the JWT lives in localStorage). Add them (e.g. with `helmet`).'),
    'INF-06': ('Medium', '`submitExecution` reserves monthly quota (`reserveRun`) before enqueueing; when the queue refuses the job (503) the reservation is not returned.',
               'Rejected requests still burn the customer\'s monthly quota (3 calls, 1 accepted -> usage 3). Refund on enqueue failure, or reserve after a successful enqueue.'),
    'INF-07': ('Medium', 'ioredis runs with `maxRetriesPerRequest: null` (required by BullMQ workers) and `enqueue` has no timeout, so `queue.add` waits indefinitely while Redis is down.',
               'During a Redis outage every webhook caller hangs (no answer in 12 s) and holds a socket. Verified: they all complete ~2 s after Redis returns, nothing is lost, reads keep working. Fail fast with a timeout and a 503 so senders can retry.'),
    'UI-20': ('Low (UX)', 'Activation validation only requires *a* trigger node; a Manual Trigger counts.',
              'The UI says "Workflow activated" / "Active" for a workflow that can never fire, and it consumes one of the 5 free active slots. Reject or warn when no schedule/webhook/RSS trigger exists.'),
    'UI-34': ('Low', 'Success green is 4.43:1 on its background (`--ok` in light mode).',
              'Misses WCAG AA (4.5:1) by 0.07 for success badges/text in light mode. Darken the green slightly.'),
    'UI-35': ('Medium', 'The Workflows and Executions tables have fixed intrinsic width and no responsive layout.',
              'On a 375 px phone the tables are 411 px / 238 px wider than the screen; users must scroll sideways inside the content area.'),
    'UI-36': ('Medium', 'The editor is three fixed columns (sidebar 64 + palette 150 + panel 280 px).',
              'At 375 px the canvas is 0 px wide - the editor is unusable on phones. Collapse palette/panel into drawers below ~900 px.'),
}


FIX = {
    'UNIT-01': 'Edit Fields rejects `__proto__`, `constructor` and `prototype` path segments and only follows own properties (`setPath`/`getPath`).',
    'SEC-05': 'User regexes now run inside the sandbox via `testRegex` with a 250 ms timeout, pattern <= 1000 chars, subject <= 200 kB; catastrophic patterns fail with a clear message and never touch the server thread.',
    'CODE-05': 'Sandbox execution switched to isolated-vm\'s async API and all parameter resolution (`ctx.param`/`jsonParam`) became async, so looping code runs on a worker thread while the event loop keeps serving requests (measured: 97 timer ticks during 1.5 s of `while(true)`).',
    'HTTP-13': 'New IP classifier expands any IPv6 spelling to bytes and checks IPv4-mapped (dotted and hex), IPv4-compatible, NAT64, 6to4, Teredo, link-local, unique-local, multicast and reserved ranges; unparseable addresses are refused.',
    'REL-05': 'One abort signal per run races every node against the workflow timeout; Wait and HTTP nodes stop immediately, no retries after a timeout.',
    'AUTH-13': 'Passwords longer than 72 bytes are rejected at signup with a clear message.',
    'TEN-10': 'New `DELETE /api/workspace/members/:userId` (owner removes a member, a member can leave, the owner cannot be removed) plus Remove / Leave buttons on the Usage page.',
    'IMP-04': 'The n8n import route now goes through the same `checkDefinition` (200-node cap, shape checks) as normal creation.',
    'EXE-03': 'limit/offset are clamped to whole numbers in range (limit 1-200, offset >= 0).',
    'INF-02': 'Same clamp; verified on Postgres.',
    'SEC-02': 'CSP (script-src self, frame-ancestors none), X-Frame-Options DENY, Referrer-Policy no-referrer, Permissions-Policy on every response, HSTS behind HTTPS proxies; the editor was re-tested under the CSP with zero violations.',
    'INF-06': 'A run refused by the queue (503) gives its monthly-quota reservation back.',
    'INF-07': 'Enqueueing is bounded by `QUEUE_ENQUEUE_TIMEOUT_MS` (default 5 s) and answers 503 while Redis is unreachable; late jobs are ignored because the execution row is already closed. Recovery verified.',
    'UI-20': 'Activation requires a Webhook, Schedule or RSS trigger and explains why when refused (Manual and Error triggers cannot start a workflow).',
    'UI-34': 'Success green darkened to #0f6b3c (5.85:1).',
    'UI-35': 'Tables become stacked label/value cards under 720 px.',
    'UI-36': 'Below 900 px the node palette and settings panel become slide-in drawers (new "+ Nodes" / "Settings" buttons); canvas is 311 px wide at 375 px.',
}
EXTRA_FIXES = ['Postgres pool now has connect (5 s) and query (30 s) timeouts, and concurrent schema creation at boot tolerates the unique-violation race (12/12 simultaneous-boot rounds).']

allres = core + unit + infra
st = lambda rs, s: sum(1 for r in rs if r['status'] == s)
fails = list(A.keys())  # all round-1 findings (now fixed)
blocked = [r for r in allres if r['status'] == 'BLOCKED']
titles = {r['id']: r['title'] for r in allres}
titles.update(dict(ui))
order = ['Critical', 'High', 'Medium', 'Low']
sev_rank = lambda i: next(n for n, k in enumerate(order) if A[i][0].startswith(k))
fails = sorted(dict.fromkeys(fails), key=sev_rank)

uiP = len(ui) - len(ui_fail)
total = len(allres) + len(ui)
passed = st(allres, 'PASS') + uiP
failed = st(allres, 'FAIL') + len(ui_fail)
assert failed == 0, 'unexpected failures remain'

md = ['# LiteForeFlow - QA report', '']
md.append('Scope: black-box HTTP scenarios against freshly started servers (6 configurations), white-box scenarios, production-stack scenarios '
          '(real Postgres 18 + Redis 8, with outage drills) and UI scenarios in a real browser (desktop, 375 px mobile, light and dark).')
md += ['', '| Area | Total | Passed | Failed | Blocked |', '|---|---|---|---|---|']
md.append(f'| API / engine (black-box) | {len(core)} | {st(core, "PASS")} | {st(core, "FAIL")} | {st(core, "BLOCKED")} |')
md.append(f'| White-box | {len(unit)} | {st(unit, "PASS")} | {st(unit, "FAIL")} | 0 |')
md.append(f'| Production stack (Postgres + Redis) | {len(infra)} | {st(infra, "PASS")} | {st(infra, "FAIL")} | 0 |')
md.append(f'| UI (browser) | {len(ui)} | {uiP} | {len(ui_fail)} | 0 |')
md.append(f'| **All** | **{total}** | **{passed}** | **{failed}** | **{len(blocked)}** |')
md += ['', 'Round 2 (after fixes): every finding from round 1 was fixed and re-verified.', '', 'Earlier in this session: 15 integration tests on each of 3 stacks (SQLite / Postgres / Postgres+BullMQ), 3 multi-process worker tests, '
       'the compose-stack e2e with 2 workers, and the SIGTERM / SIGKILL worker drills.', '', '## Findings from round 1 - all fixed and re-verified', '']
for i in fails:
    sev, cause, impact = A[i]
    md += [f'### {i} - {titles[i]}', f'- **Severity:** {sev}', f'- **Why it failed:** {cause}', f'- **Impact:** {impact}', f'- **Fix applied:** {FIX[i]}', '']
md += ['### Also hardened', ''] + [f'- {x}' for x in EXTRA_FIXES] + ['']
md += ['## Blocked (could not be tested here)', '']
md += [f'- **{r["id"]}** {r["title"]} - {r["note"]}' for r in blocked]
md += ['', '## Everything that passed', '']
cur, group = None, []


def flush():
    if not group:
        return
    md.append(f'### {cur}')
    for r in group:
        if r['status'] == 'PASS':
            md.append(f'- OK **{r["id"]}** {r["title"]}' + (f' _(note: {r["note"]})_' if r['note'] else ''))
    md.append('')


for r in allres:
    if r['area'] != cur:
        flush()
        cur, group = r['area'], []
    group.append(r)
flush()
md.append('### UI (browser)')
md += [f'- OK **{i}** {t}' for i, t in ui if i not in ui_fail]
open(os.path.join(root, 'QA_REPORT.md'), 'w', encoding='utf8').write('\n'.join(md) + '\n')
print(total, passed, failed, len(blocked))
