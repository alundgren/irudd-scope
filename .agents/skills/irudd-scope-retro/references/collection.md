# Native collection

Run `scripts/retro_sessions.py` with Python 3 from this skill's installed directory.
It uses the standard library and reads native files without changing them. Copy
this public helper to a remote temporary location when needed, using the agent's
SSH access; remove that copy afterward. Scope does not execute SSH commands.

## Inventory

```sh
python3 scripts/retro_sessions.py inventory --runtime codex --root "$HOME/.codex" \
  --source-id mac --current-session CONFIRMED_NATIVE_ID --tracking tracking.json
python3 scripts/retro_sessions.py inventory --runtime claude --root "$HOME/.claude" \
  --source-id remote --current-session CONFIRMED_NATIVE_ID --page-size 200
```

`--root` is the runtime home, containing Codex `sessions/`,
`archived_sessions/`, or both, or Claude `projects/`. Use configured overrides rather than
assuming defaults. `--tracking` is a temporary input combining every Scope tracking
page into one object with `audited`, `agents`, `mode` and `cutoff`. A non-null `next`
is rejected. This is agent working input, not a new persistent settings store.
For an agreed first-use historical cutoff, use a temporary tracking object with
`mode: "from-date"` and `cutoff` set to the agreed UTC timestamp, preserving the
combined `audited` and `agents` arrays. The helper accepts this staged input before
Scope tracking is initialized. It rejects future or invalid cutoffs and excludes
unknown starts and sessions started at or before the cutoff. Save that date as
`initializationCutoff` in source coverage; keep `discoveredAt` from the helper output.
After finish, use Scope's saved tracking unchanged.

The output contains `sessions`, `sessionCount`, `oldestStartedAt`, `discoveredAt`,
`inventoryComplete`, exclusions, coverage and `next`. Pass `next` unchanged as
`--after` with the same arguments until null. Preserve the first `discoveredAt`.
Changed eligible metadata rejects the cursor; restart discovery. Unrelated active
sessions already excluded by ID do not invalidate pages. Missing roots or traversal
errors exit nonzero with `inventoryComplete: false`; they never mean empty history.
Header errors and duplicate eligible IDs also prevent complete discovery.
Coverage includes the total unreadable-header count and at most 20 examples.

Inventory examines at most 20,000 JSONL files, 100,000 directory entries and the
first 64 lines / 256 KiB of each header. It emits metadata only, without conversation
excerpts or tool results. Canonical origin comes from native metadata or bounded
read-only `git config --get remote.origin.url` in the recorded cwd. GitHub SSH/HTTPS
case and default ports normalize; other hosts keep path case and explicit ports.
Fork origins remain distinct. Unresolvable recorded origins are ignored; only
an absent origin permits cwd lookup. Codex creation
comes from session metadata. Claude creation is known only when the bounded header
contains the first root user record with explicit `parentUuid: null`; otherwise
`startedAt` stays null. Native fractional creation precision is preserved for cutoff comparisons. File
modification time supplies activity, never creation.

Native child markers exclude child files from the primary inventory. A Codex spawn
parent or Claude `parentSessionId` can associate related evidence; no association
is guessed from nearby IDs or timestamps. Formats that omit a reliable parent
remain a stated limit. Audited IDs stay excluded even when a session later resumes.

For Scope inventory actions, copy only `sourceId`, `runtime`, `sessionId`,
`repository`, `startedAt`, `lastActivityAt`, `status` and `evidence` from selected
rows. `nativePath`, `cwd`, child/parent details and signatures are helper metadata,
not protocol fields. Apply repository inclusion choices before selecting rows;
the helper lists identifiable repositories so the operator can decide about new
ones. Coverage `sessionCount` in the report is the number of selected rows actually
stored for that source/runtime, which can differ from the discovery count.

## Explicit historical snapshot

```sh
python3 scripts/retro_sessions.py snapshot --runtime codex --root "$HOME/.codex" \
  --source-id mac --session-id HISTORICAL_NATIVE_ID
```

The same command supports `--runtime claude`. It requires exactly one matching
readable native file, not the newest file. Snapshot output contains conversations,
native tool inputs/results, metrics and coverage. Keep it in agent working context
on that source rather than pushing transcripts to Scope. Outputs are bounded at
32 MiB native file size, 200,000 records, 10,000 conversation/tool entries and
2 MiB JSON output. A truncated, corrupt, changing or unsupported snapshot is
incomplete or exits nonzero. Such a session cannot be marked reviewed. For larger
or unsupported logs, use the runtime's native inspection facilities and document
coverage; do not silently switch to a different session or mark partial work whole.

Codex token metrics use the latest cumulative native `total_token_usage`, never
sum repeated cumulative samples. Fork-inherited, decreasing or unusable counter observations remain
unknown with explicit coverage notes. If assistant messages or model tool calls follow the last usage counter, the counter is an
estimate of session consumption. Claude usage counts each native assistant message
ID once, retaining the latest usage for repeated streaming records. A later
unusable usage record makes that message unknown until a valid update arrives. It sums
input, output, cache-creation and cache-read tokens; assistant messages without usage
make a known subtotal estimated. Missing counters stay null. Metrics cover the
selected native file only. Claude conversation and usage records must match
the selected native identity; mixed or missing identities make the snapshot
incomplete. Related children are listed separately when explicit
parent metadata is available. Tool waits are call/result timestamp intervals and
include scheduling/transport, so they are estimates rather than measured test time.
Identify tests from actual command inputs and inspect their outputs before making
claims about test duration or correctness.

## Destination host capabilities

```sh
python3 scripts/retro_sessions.py destinations --source-id mac \
  --project /absolute/checkout --repository github.com/owner/repository \
  --claude-memory-path /runtime/confirmed/memory
```

Run this on the actual destination host. It checks executable availability and
writable supported instruction locations without creating files. `--codex-root`
can override the current host's `CODEX_HOME`. Project destinations require a
canonical `--repository`. Claude auto memory appears only when Claude is installed,
the directory exists and the operator/runtime has confirmed that absolute path
using `/memory`. Pass the resolved path after the runtime has applied settings,
environment overrides and trust rules. The helper cannot establish that resolution
from its own process environment and never toggles native memory. An unresolved
path stays unavailable; use normal editable instructions instead if appropriate.

`capabilities.okfExecutable` is null unless `irudd-okf` is detected on this host.
Executable detection alone is not a verified store or write API. Prefer the
`okf-personal-*` destinations from `retro settings`; Scope adds them while memory
sync is on for each machine whose synced `personal` bundle is registered. For
another store, inspect that CLI's installed help, verify the chosen store, then
pass `--okf-store STORE` to produce its destination. Do not infer commands from this helper. Codex generated
memory is not an editable destination; this helper exposes supported instruction
files instead. Recheck capability and concrete destination before applying edits.

Public format and memory references:

- [Codex native protocol definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- [Codex instruction files](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude memory and editable instruction locations](https://code.claude.com/docs/en/memory)
