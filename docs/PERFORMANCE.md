# Speed and memory

LiteForeFlow is meant to be light. This page says what was measured, what was changed because of it, and how to measure it again on your own computer.

## Results

Same workflows, same computer (Windows 11, Node 24), the median of 3 runs each on an idle machine, before the work (`00a8c1e`) and after. The full report with real-world timings is in [QA_FINAL_REPORT.md](QA_FINAL_REPORT.md).

| What it does | Before | After | Faster | Peak memory |
|---|---|---|---|---|
| 10,000 items, each with two plain `{{ $json.field }}` lookups | 7,919 ms | **174 ms** | **45x** | 96 -> 84 MB |
| 10,000 items through an IF block | 8,029 ms | **86 ms** | **93x** | 101 -> 88 MB |
| 3,000 items with real JavaScript in an expression | 2,396 ms | **108 ms** | **22x** | 105 -> 90 MB |
| 2,000 items using `{{ $node["Name"].json.x }}` | 13,511 ms | **37 ms** | **365x** | 149 -> 91 MB |
| 40 items, one GET each to a 100 ms service | 4,931 ms | **976 ms** | **5.1x** | - |
| 300 small runs (3 blocks, 4 expressions each), per run | 11.1 ms | **1.6 ms** | **6.8x** | 136 -> 126 MB |
| 400 webhook calls, 8 at a time, per call | 4.6 ms | **0.8 ms** | **5.8x** | - |
| 50,000 items through blocks without expressions | 463 ms | 400 ms | 1.2x | 151 -> 138 MB |

Start-up: 500 ms -> **317 ms**. Memory at rest: 67 MB (42 MB of it is Node.js itself, 15 MB the web server library). CPU while idle: 0.3% (one timer an hour). After heavy work both versions return to the same memory once the process has been quiet for about 25 seconds.

First page of the editor: **214 KB (68 KB over the wire)** instead of 402 KB (132 KB).

Real internet: a 16-call Hacker News digest 5.2 s -> **1.8 s**; a local AI job on a thinking model **300+ s (timed out) -> 19 s**; the whole Ollama QA suite 697 s -> **159 s**.

## What was slow, and what changed

Measured with a CPU profile before changing anything: **64% of the time in a small run was spent creating V8 isolates and contexts** (an isolate costs about 1.9 ms, a context about 0.5 ms, running a compiled expression about 0.06 ms).

1. **Plain lookups never touch the sandbox.** `{{ $json.a.b }}`, `{{ $json["x"][0] }}`, `{{ $itemIndex }}`, `{{ $now }}`, `{{ $workflow.name }}` and `{{ $node["Name"].json.path }}` are answered directly, with the same results (and the same error messages, because anything unusual falls back to the sandbox).
2. **One sandbox context per node run, not per item.** Only the current item is swapped in. Expressions are compiled once per distinct text. A short synchronous try (10 ms) comes first; anything slower, or an infinite loop, takes the safe asynchronous route with the full 1 s limit.
3. **Isolates are pooled.** A node run borrows one and gives it back; up to 2 small ones are kept for 10 s. An isolate that timed out, ran out of memory, served 400 runs, or holds more than 4 MB is thrown away instead of reused, so one workflow cannot leave damage for the next and big jobs free their memory at once.
4. **Shared data is no longer rebuilt for every item.** `$node[...]` and `$input` used to be re-collected and re-sent for each item (work grew with the square of the item count). They are now stored once and parsed fresh for each item only if an expression touches them, so an expression that changes them (for example `list.reverse()`) can never affect the next item. The Code block in "each item" mode had the same problem and got the same fix.
5. **SQL statements are prepared once** instead of on every call.
6. **Run logs use a faster compression level** (3 instead of 6: same size, 2x faster).
7. **Read-only API calls overlap.** A block that calls a web service once per item (HTTP Request GET, the REST connector's GET operations) fetches up to 5 items at the same time, in order, and stops on the first failure (`ITEM_CONCURRENCY`, 1 = one by one). Settings are still read one item at a time, so the sandbox is never shared between items. The credential is opened once per node run instead of once per item.
8. **Local AI answers directly.** The LLM and AI Agent blocks have a *Thinking* setting, off by default: a thinking model needed 124 s (and sometimes produced an empty answer) for a job that takes 4.5 s without thinking.
9. **The run record shrinks gracefully.** Over the 1 MB limit it used to drop every block's data; now it keeps fewer items, then shorter texts and lists, so something is always there.
10. **The editor is split in two** (the canvas loads on demand) and the built files are **served gzip-compressed** from a small in-memory cache (about 100 KB), with no extra package.

## What was measured and left alone

- **Node/V8 flags.** Smaller or larger young-generation sizes (`--max-semi-space-size` 1, 2, 4, 8) changed speed by less than 10% and memory by noise, so the launcher's settings stay.
- **Memory after a big run.** The JavaScript heap shrinks right away, but the operating system keeps freed native pages in the process for a while (a 50,000-item run leaves about +40 MB until the process has been quiet for a few seconds). This is allocator behaviour, not a leak: repeating the run does not grow it.
- **Start-up** is mostly loading many small files; nothing worth the risk.
- **Node's built-in `fetch` costs about 13 ms per call on Windows** against any server, including a trivial one. The benchmark therefore uses plain `http` with keep-alive. (Browsers are not affected.)

## Measure it yourself

```bash
node server/test/bench/bench.mjs mylabel               # speed + memory of the scenarios above, saved as server/test/bench/result-mylabel.json
node server/test/bench/bench.mjs mylabel --repeat=3    # three runs, to take the median
node server/test/bench/bench.mjs old --cwd=../other-checkout   # compare another copy of the code
node --expose-gc server/test/bench/memory.mjs 50000    # where the memory of one big run goes
node --cpu-prof --cpu-prof-dir=prof server/test/bench/profile.mjs small && node server/test/bench/top.mjs prof   # what the CPU is doing
node server/test/bench/sandbox-safety.mjs              # infinite loops, memory bombs, state leaking between items
```

`npm test` includes `server/test/perf.test.mjs`, which keeps the fast paths honest: the same answers as real JavaScript, fresh shared data for every item, a damaged isolate never reused, and the compressed files only ever served from inside the web folder.
