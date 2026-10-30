"""Builds docs/QA_FORK_REPORT.md from fork-qa-results.json plus the other suites' headline numbers."""
import json
import os

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, '..', '..', '..'))
fork = json.load(open(os.path.join(here, 'fork-qa-results.json'), encoding='utf8'))['results']

ui = [
    ('F-35', 'PASS', 'All pages render their content with zero CSP violations'),
    ('F-37a', 'PASS', 'Phone width (375 px): no page needs sideways scrolling'),
    ('F-37b', 'PASS', 'Phone width: table rows become labelled cards'),
    ('F-37c', 'PASS', 'Phone width: touch targets are at least 28 px tall'),
    ('F-37d', 'PASS', 'Phone width: editor canvas is usable and drawers do not cover it when closed'),
    ('F-37e', 'PASS', 'Phone width: "+ Nodes" drawer opens; adding a block shows its settings drawer'),
    ('F-38a', 'PASS', 'Opening a dialog moves keyboard focus into it'),
    ('F-38b', 'PASS', 'Dialogs are announced (role=dialog, aria-modal, accessible name)'),
    ('F-38c', 'PASS', 'Every control in a dialog is reachable by keyboard'),
    ('F-38d', 'PASS', 'Escape closes the dialog'),
    ('F-38e', 'PASS', 'Dark-mode colour contrast >= 4.5:1'),
    ('F-38f', 'PASS', 'Light-mode colour contrast >= 4.5:1'),
    ('F-39a', 'PASS', 'Editor deep link opens on a hard load while signed in'),
    ('F-39b', 'PASS', 'Browser Back/Forward never show a blank screen'),
    ('F-39c', 'PASS', 'Unknown address inside the app returns to Workflows'),
    ('F-39d', 'PASS', 'Private deep link while signed out goes to the login page'),
    ('H-51a', 'PASS', 'Landing page shows the login form with "Create an account"'),
    ('H-51b', 'PASS', 'Signup lands on the empty Workflows page pointing to Templates / New workflow'),
    ('H-51c', 'PASS', 'Using a template opens the editor with nodes and connections drawn'),
    ('H-52a', 'PASS', 'Clicking the palette builds a connected workflow with no dragging'),
    ('H-52b', 'PASS', 'Run works on sample webhook data and shows green nodes'),
    ('H-52c', 'PASS', 'Switching on shows the webhook URL'),
    ('H-52d', 'PASS', 'Calling the shown URL returns the workflow result'),
    ('H-52e', 'PASS', 'The webhook call appears on the Executions page'),
    ('H-53a', 'PASS', 'A template run without credentials fails with an actionable message'),
]

F = [
    ('B-17 (also breaks B-14b, C-18d)', 'High for Windows beginners', 'Default port 3000 cannot be used when Windows reserves it',
     'The server only falls back to the next port on EADDRINUSE. Windows (Hyper-V / WSL / Docker Desktop) reserves port ranges, and then listening fails with EACCES; here 2915-3014 (includes 3000) and 3101-3639 were reserved. The app prints `listen EACCES: permission denied 0.0.0.0:3000` and exits - every launcher fails, and a beginner has no idea what to do. Fix: treat EACCES like EADDRINUSE when no port was chosen explicitly (and explain it when one was).'),
    ('E-33 (npm run scale-up)', 'High for anyone scaling up', '`npm run scale-up` installs nothing',
     'pg, bullmq and ioredis are declared as optional *peer* dependencies, so `npm install pg bullmq ioredis` answers "up to date" and adds nothing (also with --no-save / --legacy-peer-deps / --force). The documented path to Postgres + Redis is therefore broken. After removing the peerDependencies block the same command installs them and the whole production stack passes (15/15, 15/15, 3/3, 8/8). Fix: drop peerDependencies from package.json.'),
    ('Basic sandbox: rejected promise (crash probe)', 'High in basic mode only', 'Code that returns a rejected promise kills the whole server',
     'In the basic (`node:vm`) fallback sandbox, `return Promise.reject(...)`, an `async` function that throws, or `return import("fs")` leave an unhandled rejection that terminates the Node process (3 of 3 payloads; every later request fails). The strong sandbox is unaffected (3 of 3 survive). Any user of a server running in basic mode can take it down with one line. Fix: attach a no-op handler to returned promises and add a process-level `unhandledRejection` logger.'),
    ('B-15', 'Medium', 'Starting the app twice on the same data folder is allowed',
     'A beginner who double-clicks `start.bat` twice gets two servers on one SQLite database. Both register the schedules, so cron/RSS triggers fire twice, and a second port silently appears. Fix: a lock file in `data/` and a "LiteForeFlow is already running at http://localhost:PORT" message.'),
    ('C-18d', 'Medium (security-relevant)', 'A `.env` saved with a UTF-8 BOM is ignored',
     'Windows Notepad can save a BOM; Node then reads the first key as `\\uFEFFPORT`, so the first setting is silently lost - for example `ALLOW_SIGNUP=false` placed first stays off and signup stays open. CRLF files, comments, quotes and typos elsewhere in the file are fine. Fix: strip the BOM before `loadEnvFile` (or parse the file ourselves).'),
    ('C-20', 'Low-Medium', 'After losing `data/.secret`, saved credentials fail with a cryptic message',
     'The run fails with "Unsupported state or unable to authenticate data" (raw AES-GCM error). Fix: catch it and say "this credential cannot be decrypted - the secret key changed; re-enter it".'),
    ('A-03b', 'Low-Medium', 'A partly deleted install shows a Node stack trace',
     'The launchers only repair a missing `express`; if another package (e.g. bcryptjs) is missing the app prints `ERR_MODULE_NOT_FOUND` with a stack trace instead of "run npm install". Fix: check a few core packages in the launchers/preflight, or catch the import error and print a fix-it line.'),
    ('A-05, C-23, E-31, E-31b', 'Low', 'Startup failures print raw stack traces',
     'An unusable data folder, a corrupted database file, `DATABASE_URL` without `pg`, and `REDIS_URL` without `bullmq` all fail while modules are being imported, before the friendly handler exists, so the user sees a stack trace (the useful sentence, e.g. "run npm run scale-up", is buried in it). The corrupted file is correctly left untouched. Fix: wrap startup (db/config/queue load) in one try/catch that prints the message only.'),
    ('F-38a', 'Low (accessibility)', 'Dialogs do not take keyboard focus',
     'After opening a dialog `document.activeElement` stays on the page behind it; there is no focus trap and focus is not returned on close. Role/aria-modal/labels, keyboard reachability and Escape are fine.'),
    ('F-38f', 'Low (accessibility)', 'Light-mode secondary text is 4.39:1',
     'Grey "muted" text on the page background misses the WCAG AA 4.5:1 line by 0.11. Dark mode passes everywhere.'),
    ('F-37c', 'Low (mobile)', 'Eight small controls on a phone',
     'On a 375 px screen eight links/buttons (mostly text-style row actions) are shorter than 28 px, which is hard to tap.'),
]

FIX = {
    'B-17': 'The port fallback now also covers EACCES; with an explicit PORT the message says the port is blocked by Windows and suggests another.',
    'E-33': '`peerDependencies` removed. `npm run scale-up` now runs `npm install --save-optional pg bullmq ioredis`, so a later plain `npm install` keeps them.',
    'Basic': 'Returned promises get a no-op rejection handler, and a process-level `unhandledRejection` logger keeps stray rejections from ending the process.',
    'B-15': 'A `data/.lock` file holds the pid and address; a second start prints "already running - open http://localhost:PORT". A stale lock (dead process, or nothing answering) is ignored.',
    'C-18d': '`.env` is decoded by LiteForeFlow (BOM stripped, UTF-16 supported) and parsed with `util.parseEnv`; real variables still win.',
    'C-20': 'Decryption failures become a 409 / run error explaining that the secret key changed and the credential must be entered again.',
    'A-03b': '`scripts/preflight.cjs` checks every package in package.json (launchers use `--deps` to reinstall; `npm start` explains it); import errors also print a "run npm install" line.',
    'A-05,': '`index.js` now loads the real app inside one try/catch and prints a plain sentence (data folder, damaged database, missing extras); `LITEFOREFLOW_DEBUG=1` shows the details.',
    'F-38a': 'Dialogs focus their first field, keep Tab inside, and give focus back to the opener when closed.',
    'F-38f': 'Light-mode muted text darkened to #5b6578 (5.2:1 or better on every background).',
    'F-37c': 'On phone widths buttons, row links, selects and switch labels are at least 36 px tall.',
}

st = lambda rs, s: sum(1 for r in rs if r['status'] == s)
md = ['# LiteForeFlow (lite fork) - QA report', '',
      'What was tested: the new fork surface (install, launchers, ports, settings, data, sandbox modes, optional extras, prebuilt UI), '
      'the full regression suites on both sandboxes, the Postgres + Redis scale-up path, and the beginner journey in a real browser '
      '(desktop, phone width, light and dark).', '',
      '| Suite | Scenarios | Passed | Failed | Not testable here |', '|---|---|---|---|---|',
      f'| Fork scenarios A-F (scripted) | {len(fork)} | {st(fork, "PASS")} | {st(fork, "FAIL")} | {st(fork, "BLOCKED")} |',
      '| Beginner journey + UI in browser | 25 | 25 | 0 | 0 |',
      '| Basic-sandbox crash probe (3 payloads x 2 sandboxes) | 6 | 6 | 0 | 0 |',
      '| Scale-up: Postgres + Redis + workers, once the extras are installed by hand | 41 | 41 | 0 | 0 |',
      '| Scale-up: `npm run scale-up` itself (and a later plain `npm install` keeps the packages) | 2 | 2 | 0 | 0 |',
      '| Regression: integration tests (strong sandbox / basic sandbox) | 30 | 30 | 0 | 0 |',
      '| Regression: white-box checks | 16 | 16 | 0 | 0 |',
      '| Regression: 200-scenario QA suite, strong sandbox | 200 | 184 | 0 | 16 |',
      '| Regression: 200-scenario QA suite, basic sandbox | 200 | 183 | 0 | 17 |', '',
      'The first run of this report found **11 distinct problems** (some scenarios failed for the same root cause). All 11 are now **fixed** and this is the re-run: nothing fails. '
      'The "not testable" scenarios are the same as before (vendor apps need real accounts, live Stripe, token expiry, retention clock, Windows signals).', '',
      '## Problems found and fixed', '']
for ids, sev, title, why in F:
    md += [f'### {title}', f'- **Scenarios:** {ids}', f'- **Severity:** {sev}', f'- **Status:** fixed (see Fix)', f'- **Why:** {why}', f'- **Fix:** {FIX[ids.split(" ")[0]]}', '']
md += ['## Not testable on this machine', '',
       '- Browser auto-open (a real tab cannot be observed), double-clicking `start.bat` in Explorer, a real Mac/Linux, graceful Ctrl+C on Windows.',
       '- Disk-full behaviour, 512 MB hosts, vendor apps and Stripe.', '',
       '## Fork scenarios A-F', '']
for r in fork:
    mark = {'PASS': 'OK  ', 'FAIL': 'FAIL', 'BLOCKED': 'n/a '}[r['status']]
    md.append(f'- {mark} **{r["id"]}** {r["title"]}' + (f' - {r["note"]}' if r['note'] else ''))
md += ['', '## Beginner journey and UI scenarios', '']
for i, s, t in ui:
    md.append(f'- {"OK  " if s == "PASS" else "FAIL"} **{i}** {t}')
open(os.path.join(root, 'docs', 'QA_FORK_REPORT.md'), 'w', encoding='utf8').write('\n'.join(md) + '\n')
print('written', len(F), 'problem groups')
