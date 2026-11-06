# Handoff: agent-audit viewer improvements

For the agent continuing `tools/agent-audit` (draft PR #191, branch `agent-audit-prototype` in irudd-scope). The goal: help the owner find out _why_ a long agent run took the time it did, directly in `viewer.html`, without an analyst writing one-off scripts.

The scripts in this folder are prototypes written against one real run. They read `data.json` (and, for `messages.py`, T3's `statev2.sqlite`) read-only and contain no personal data. Treat them as reference implementations to port into `collect.py` and `viewer.template.html`, not as finished code.

## Where this came from

We investigated one T3 thread: an orchestrated overnight build of a Rust game. It took 15.2 hours, with 124 child threads (build, fix, review, re-check) and about 40 agent-hours of work. The answers were:

- Review/fix loops took more than half the agent time.
- Reviewers rebuilt Rust from scratch in fresh worktrees: `cargo xtask check` averaged 5 min for reviewers and under 1 min for builders.
- Orchestrator instructions asked for full checks and open-ended sweeps.

Every one of those findings needed ad-hoc scripts. The viewer showed none of them. The suggestions below are what survived review with the owner. Each was built and run on real data, and the owner saw the output.

## UI still to build: start here

The classifier scripts feed two new views. **The scripts are not the deliverable; the views are.** As of commit `2a73e09` the viewer still has only the Threads and Tool calls tabs.

Open the mockups in `mockups/` in a browser. They are the views the owner approved, rendered from the investigated run with local paths replaced by `<path>`. `commands-view.mjs` and `failures-view.mjs` are the render code behind them (input: the JSON that `commands.mjs` and `failures.mjs` write).

| Build                                      | Mockup                         | What the owner should see                                                                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Commands tab** (or a mode of Tool calls) | `mockups/commands-mockup.html` | Summary line (shell time, calls, groups, "other" share). One row per program group, sorted by total time: total bar, avg, max, failed, cold builds, lock waits. Click a row to expand: split by model, then the slowest calls with their command text. |
| **Failures tab** (or a mode of Tool calls) | `mockups/failures-mockup.html` | Summary line (failed of total, %). One row per cause, sorted by count, with a bar and the split by model. Click a row to expand: example calls, each with the **output line that decided its cause**.                                                  |

Requirements for both:

- They respect the existing scope picker (machine, time span) and the thread filter, like the other tabs.
- Clicking a row also offers "show these calls", which opens Tool calls filtered to that group or cause.
- The "other" share is always visible, never hidden in a footnote.
- Match the viewer's existing look. The mockups carry their own theme only so they open standalone.

Done means the owner can open `viewer.html`, click Commands and Failures, and get the same answers as the mockups, without running a script.

## Collector changes (done)

1. **Stop cutting tool inputs at 400 characters.** `collect.py` does `input=clean(text(...))[:400]` in three places (T3 items, Claude logs, Codex logs).
   - In the investigated run this cut 2,184 of 7,353 commands (30%).
   - Long commands lose their tail, which is often where the real program is (`…; cargo xtask check`, `… | node`, `git push`).
   - Fix: keep the full text, or keep head and tail like outputs do (`outHead`/`outTail`). Head plus tail is enough for program matching.
2. **Export each thread's instructions and outcome.** Add `instructions` (first user message) and `outcome` (last assistant message) per thread, from `orchestration_v2_projection_messages` (`role`, `payload_json.text`, `streaming = 0`). See `messages.py`. All 131 threads in the test run had both. This costs a few KB per thread.

## Benchmark across machines

Both scripts take any number of exports and print the "other" share per machine, harness and project:

```
python3 -I build.py --days 7     # on each machine, writes data.json
vp exec node viewer-handoff/failures.mjs vm.json mac.json /tmp/failures.json
vp exec node viewer-handoff/commands.mjs vm.json mac.json /tmp/commands.json
```

Results on cloudbox (Linux VM, TS/Go/Python projects, 7 days, 9,559 calls, after the changes below):

|                              | Before | After |
| ---------------------------- | ------ | ----- |
| Failures left in "Other"     | 42%    | 10%   |
| Shell time left in "(other)" | 0.8%   | 0.6%  |

What closed the gap, all generic:

- **The last step decides the exit code.** In `rg foo src; cat notes.md 2>/dev/null` the output comes from earlier steps. If the last step is a search that exited 1, it is "Search found nothing". If it is a read with stderr hidden, it is "File not found (error hidden)". These rules run before output matching, so printed source lines (`TypeError:` inside a grep hit) no longer misfire.
- **Exit 130, 137 and 143 are signals:** "Stopped by a signal", usually a dev server or long job stopped on purpose.
- **Last step writes to a file** (`> run.log 2>&1`): "Output went to a file". The cause is in that log, not in the call.
- New causes: lint or format, package manager, service not reachable, API or HTTP error (before path errors). Compile errors now cover `error TS`, Go and C#.
- Commands: interpreters name their script (`vp exec node loader.mjs`, `python3 (inline)`). Value flags such as `go -C native build` are skipped. Programs run by path are named after the file.

Still to do: the Mac history (other harness mix and projects). Aim for under ~15% "Other" on each machine.

## Keep: Commands grouped by program (`commands.mjs`)

A mode in the Calls view that groups shell calls by the program doing the work, sorted by total time:

- Columns: calls, total, average, max, failed.
- Two columns read from output: **cold builds** (10 or more `Compiling` lines) and **lock waits** (`Blocking waiting for file lock`).
- Expanding a row shows the split by model and the slowest calls.
- Clicking should filter the existing call list.

**Method (keep this, it worked):**

- Never parse the wrapper shells (`powershell -Command "& bash -lc '…'"`, T3 or Codex wrappers).
- Search for known program names wherever a command can start: line start, after `;&|(` or a quote, or as the last part of a path.
- The key is the program plus 1–2 subcommand words, skipping flags and `+toolchain`. Examples: `cargo xtask check`, `cargo test`, `vp run build`, `gh pr view`.
- When a chain names several programs, the earliest in a priority list wins (build and test tools first). When the same program appears twice, the later use wins, since setup steps like `cargo fmt; cargo xtask check` come first.
- **Always show the "other" share.** It is the quality measure.

**Required before it's trustworthy:**

- Full command text (collector change 1).
- **Programs run by path** (`./some_tool.exe`, `target/debug/deps/harness-….exe`) become a group named after the file.
- Calls whose command only reads a log (`Get-Content x.log`, `tail`) while the heavy program ran in a script or binary can't be attributed from text. The cold-build and lock-wait columns at least flag them.

**Measured:**

- The investigated run had 3.9% of time in "other".
- The owner's other projects over 7 days (TS/JS, Node, Python, audio tools) had **37.8%**, mostly because of the 400-character cut and programs run by path.

## Keep: Failures grouped by cause (`failures.mjs`)

Groups failed calls by cause. The cause is read from output: an ordered list of `[cause, output regex, optional exit-code test]`, and the first match wins. Each example shows **the output line that matched**, so the owner can check every classification. Expanding a row shows the split by model and examples.

Current causes:

- Blocked by the harness
- Shell quoting or syntax
- Program not found
- Ran in the wrong folder
- Compile error
- Test failed
- Agent's own script crashed
- Merge conflict
- Waited on another build's lock
- Bad arguments to a tool
- File or path not found
- Git refused
- GitHub or network
- Timed out
- Search found nothing
- No output, non-zero exit
- Other (cause not in the output)

**The rule table is tuned to Rust and this one run.** Measured on the owner's other projects:

|                          | Investigated run | Other projects, 7 days |
| ------------------------ | ---------------- | ---------------------- |
| Failures left in "Other" | 20%              | **43%**                |

To get it working:

- **Add JS/TS rules:**
  - `vp run` / vitest / jest failure summaries
  - `error TS\d+`
  - `npm ERR!`
  - Node uncaught-exception stacks (a last line of `Node.js vNN` follows a stack trace)
- **Add an "API or HTTP error" cause, checked before "File or path not found".** JSON error bodies such as `500 {"error":…"does not exist"}` currently misfire as path errors.
- Add Python (`pytest` summaries), Go and .NET test and compile lines as the benchmark data demands.
- **Benchmark on many sessions** (the owner has a large Mac and Linux history). Report the "Other" share per project and per harness. Aim for under ~15% on several projects before trusting it. Keep rules generic: no project names, branch names or paths.

**Known limits** (show them, don't hide them):

- A test failing on purpose (a reviewer proving a bug) looks the same as a real failure.
- Chained commands can exit non-zero from a harmless step (PowerShell `Get-Process … -ErrorAction SilentlyContinue`), with nothing in the output.
- Outputs are clipped to 2 KB at each end.

## Tentative: Search child instructions and outcomes (`search-live.mjs`)

A search field over each child thread's `instructions` and `outcome` (collector change 2). It shows matching threads with the hit highlighted, a "What it was told / What it reported / Both" switch, and the full text on expand.

In the investigated run it answered:

- "how many reviewers were told to run the full check": 114 of 124 threads;
- "when was 'be proportionate' first said": only in late re-checks.

It is plain substring search. "CHANGES REQUESTED" also matches fix threads quoting the verdict. The owner isn't sure about this one yet. Build it cheaply.

## Noted, not decided: Time as a first-class measure

The viewer shows no time anywhere today. Proposal:

- **Thread list:** sortable _elapsed_ and _agent time_ (the sum of run durations, including children) columns.
- **Parent thread page:** a strip of agent-hours by kind of work, plus idle time.

**Unresolved:** how to group "kind of work". This run used title prefixes ("Review", "Fix"), which is specific to one orchestrator. Alternatives are grouping by model and provider, or letting the user pick. Discuss with the owner before building.

## Dropped (don't build)

- Timeline/swimlane of child threads.
- Per-PR chains of review rounds.
- Per-thread git commit sizes. It worked, but needed a local clone plus branch matching, and the owner skipped it.

## Rules for this work

- Read-only against T3 data and harness logs. Never commit `viewer.html`, `data.json` or any exported session data.
- No GitHub Actions for tests. Validate locally.
- Show every heuristic's leftover ("other") share in the UI, so a wrong classification is visible, not silent.
