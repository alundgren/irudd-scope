# Collaborative plan web exploration

This is a permanent experimental branch: `t3code/collaborative-plan-web-exploration`.
**Never merge this branch into `main` or any release branch.** Do not create a
pull request from this branch to `main`. Implementation PRs target this branch
and may be merged here after review and validation. Preserve this branch for
continued exploration and handoff between agents.

## Goal

Explore a standalone web app where people and coding agents plan together in
ordinary HTML. Each plan has a name and URL; visiting an unknown plan URL
creates it. V1 intentionally has no authentication or authorization.

The app needs durable versioned edits and comments, replayable realtime events,
optimistic local editing with explicit reconciliation, presence indicators,
and comments attached to DOM elements that survive removal of those elements.
Historical versions and diffs must remain available.

## Workflow

Use isolated worktrees for implementers and child PRs against this branch.
Research storage and durable stream systems using primary sources. Independently
review changes before integration. This is an independent app: use its build,
format, type/lint and API/stream/browser/concurrency checks. Do not repeatedly
run whole-Scope validation for app-only work. Run Scope validation only when a
change directly affects Scope. This policy follows the user’s explicit override
of the repository-wide gate. Exercise multiple browser users and agents,
dropped connections,
duplicate delivery, process restart, competing edits, and comment detachment.

## Current implementation

`apps/plan-web` is a separate package with its own contracts. It does not import
desktop internals or change the deployed artifact API. Start it with:

```sh
vp install
vp run plan-web#build
vp run plan-web
```

Open `http://localhost:43130/plans/team-plan`; unknown plan URLs create plans.
Read [the app guide](apps/plan-web/README.md) for API commands and operating limits.
The backend stores HTML snapshots, native Git unified diffs, comments, accepted
commands and replayable events in SQLite. One `BEGIN IMMEDIATE` transaction
commits state, revision, event and immutable command receipt. WAL and full
synchronous writes are enabled. Reusing a command ID requires the same payload.
Disjoint source edits rebase through each accepted HTML revision; overlaps keep
the local draft and require explicit reconciliation.

PGlite 0.5.8 stores browser drafts, outgoing commands, snapshots and replay
cursors in IndexedDB with `relaxedDurability: false`. An app-owned SharedWorker
holds a Web Lock and serializes complete database operations. Each tab owns a
separate draft identity; another tab can deliver its durable commands after it
closes. Snapshot/cursor advancement, acknowledgement retirement and preservation
of newer draft generations are atomic. Editing is enabled after its recovery
row exists. Browser eviction or clearing can remove unsynced work; export it
when needed. Browser editing requires HTTPS or localhost and SharedWorker/Web
Locks support. Plain HTTP shows the server plan read-only with an explanation.

HTTP commands and a typed multiplexed SSE stream provide both directions.
One origin-wide browser connection covers all active plans, avoiding the
[six-connection HTTP/1 browser limit](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
The worker persists events before notifying tabs and reconnects only from
committed cursors. The server bounds replay batches, rotates subscribed plans
and disconnects a stalled reader after five seconds. Presence is a transient
15-second lease owned by one server process, rather than durable plan history.
HTML, comments, replies and resolution state are immutable versioned records.

Authored HTML runs with scripts. Humans can edit its source beside a live
preview. Comment anchors use unique authored element IDs. Removing an element
keeps the discussion detached; restoring its ID reconnects it. Generated or
ambiguous elements remain detached. A real HTML parser supplies source offsets
without serializing the runtime DOM or rewriting authored attributes/scripts.

## Handoff for tomorrow

The permanent branch incorporates `origin/main` at `8f8d630` through merge
`e9ac271`. Client integration `305a76d` was independently reviewed; its app,
browser tests and Chromium setup are byte-identical to reviewed `cdfdcfb`.
No product code changed in this handoff/validation update.

- [PR #82](https://github.com/alundgren/irudd-scope/pull/82): backend, merged.
- [PR #83](https://github.com/alundgren/irudd-scope/pull/83): multiplexed streams
  and asynchronous SQLite startup correction, merged.
- [PR #85](https://github.com/alundgren/irudd-scope/pull/85): complete browser
  app, recovery, tests, CI and this handoff, open against the permanent branch.
  Never retarget it to main.

Completed: versioned HTML/comments/replies/resolution, native Git diffs,
transactional server receipts, multiplexed durable replay, PGlite drafts and
outbox, closed-editor delivery, concurrent reconciliation, presence, HTML
source/live preview, authored DOM anchors, history, export and recovery.
The User menu offers exactly Alex, Blair and Casey independently in each tab;
queued commands retain their original actor. Permanent HTTP 400/413/422
rejections preserve work without blocking valid editors. Saved/rejected HTML
restoration locks competing controls and retries one journaled operation.
The latest pin fix makes existing pins pass pointer clicks through during
comment placement and regain discussion focus afterward.

The client worktree is `/tmp/scope-plan-web-client` on
`explore/plan-web-client`. The root worktree is
`/home/dev/.t3/worktrees/irudd-scope/t3code-a3fabf72`. The preview is currently stopped. Its last URL was
`http://localhost:43130/plans/two-window-smoke` on the development machine.
Its retained SQLite file is
`/home/dev/.t3/worktrees/irudd-scope/t3code-a3fabf72/apps/plan-web/plan-web.sqlite`.
Keep its WAL/SHM files together with the database. To restart the current client:

```sh
cd /tmp/scope-plan-web-client
PLAN_WEB_DB=/home/dev/.t3/worktrees/irudd-scope/t3code-a3fabf72/apps/plan-web/plan-web.sqlite vp run plan-web
```

The parent worktree does not yet contain the browser implementation; restart
its preview there after PR #85 merges.

Remaining: inspect both exact-head PR/push CI results, run a renewed quiet-host
50-round scenario, and merge PR #85 into the permanent branch after review and
passing app checks. Then restart the preview from the parent branch and perform
a two-window smoke check. Preserve the branch for further exploration; never
merge it into main or a release branch.

## Validation state and commands

Historical evidence is not a claim that the current handoff commit passed a
whole-repository gate. Earlier reviewed heads passed all 503 tests in 72 files.
A native-input 50-round run on `15998db` passed in 175.19 seconds: two human
editors, two witnesses, six API agents, 400 accepted edits, 300 duplicate
requests and a server restart; every preview was checked each round.
The pin fix on `cdfdcfb` passed five focused comment scenarios in 49.29 seconds
and independent review. Backend API/stream coverage comprises 24 cases,
and the browser suite comprises 26 cases plus six text-merge cases.

Later extended runs encountered latency under extreme host CPU contention.
An untracked diagnostic captured 18–21 second database replies that subsequently
completed, with bounded outstanding calls and ongoing stream messages; it did
not expose a controller promise cycle. These failed runs remain failures.
Whole-repository retries were interrupted, including the latest `305a76d` run
at the user’s request. Its build/check passed but its test gate did not finish.
The updated full 56-case app suite and renewed 50-round run remain pending.
No further local tests were run during the final wrap-up, as requested.
The scoped validation scripts and CI changes are new; inspect their exact-head
CI results tomorrow. Historical passes are not current-head passes.

Use these scoped commands; they do not launch Scope, Electron or Xvfb:

```sh
vp install --frozen-lockfile
vp run plan-web#build
vp run plan-web:check
vp run plan-web:test
# App build + format/type/lint + all 56 app tests:
vp run plan-web:ready
# API/stream + bounded text merge:
vp test run --project=standard tests/plan-web-api.test.ts tests/plan-web-stream.test.ts tests/plan-web-merge.test.ts --maxWorkers=1
# Pin focus/placement and authored/removed anchors (five browser cases):
vp test run --project=standard tests/plan-web-browser.test.ts -t 'rejected comment HTTP|humans can attach|generated nodes' --maxWorkers=1
# Renew extended native-input concurrency pressure on a quiet host:
PLAN_WEB_PRESSURE_ROUNDS=50 vp test run --project=standard tests/plan-web-browser.test.ts -t 'multiple humans' --maxWorkers=1
```

`plan-web:check` formats/checks only the app, four app test files and this
change’s handoff/workflow/catalog files; lint includes type-aware and TypeScript
checks. `plan-web:test` directly runs those four files with one file worker.
The browser scenarios still run several users and agents concurrently.
CI runs `plan-web:ready` for the permanent exploration branch, pushes under
`explore/plan-web-*`, and PRs targeting the permanent branch. Other branches
retain the Scope `vp run ready` path. Chromium is installed only for app CI.

Tests use isolated SQLite databases and real headless Chromium without
credentials or models. Browser failures save screenshots/observations to
`/tmp/scope-web-*-evidence.json`. Coverage includes offline reload, duplicates,
lost/hanging replies, owner closure, worker/server restart, conflicts, comment
detachment, copied tabs, eight tabs/plans, fake users, permanent rejection,
delayed restoration and recovery after committed replies are lost.
Startup retries a competing SQLite writer asynchronously for up to five seconds.

## Research notes

Primary sources were checked on 2026-10-03. The server choice is SQLite plus
native Git diffs. This keeps the accepted state, event, and command receipt in
one transaction. The browser prototype deliberately explores PGlite despite
its larger download and startup cost than native IndexedDB.

| Option                                                             | Practical fit for this exploration                                                                                                       |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Native Git](https://git-scm.com/docs/git-fast-import.html)        | Mature diff tooling and packed history. Full Git repositories add refs, maintenance, and locking beyond the current need.                |
| [libgit2](https://libgit2.org/docs/reference/main/diff/index.html) | In-process diffs and custom object storage are available, with native binding and deployment costs.                                      |
| [gix](https://docs.rs/gix/latest/gix/)                             | Modern Rust implementation; worth benchmarking for a Rust service, without assuming it beats Git on our workload.                        |
| [isomorphic-git](https://isomorphic-git.org/docs/en/quickstart)    | JavaScript integration is convenient; no evidence establishes better server performance for this workload.                               |
| [SQLite WAL](https://www.sqlite.org/wal.html)                      | Concurrent reads and serialized writers suit a small standalone server. Accepted state and replay records share one durable transaction. |
| [Postgres](https://www.postgresql.org/docs/current/mvcc.html)      | A possible next step for distributed service deployment. It introduces another service to operate.                                       |

| Realtime system                                                                                 | Relevant mechanism and remaining application work                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Durable Streams](https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md)     | Persistent offsets, catch-up reads, live HTTP tailing, and producer deduplication inform our replay protocol. This prototype does not claim protocol compatibility. |
| [Replicache](https://v12.doc.replicache.dev/reference/server-push)                              | Optimistic client mutations with an atomically committed server mutation cursor. Application write endpoints and conflict behavior remain necessary.                |
| [Zero](https://zero.rocicorp.dev/docs/self-host)                                                | Optimistic sync with Postgres replication and a cache service. More infrastructure than the standalone prototype needs.                                             |
| [Yjs](https://docs.yjs.dev/api/document-updates)                                                | Commutative, idempotent updates support simultaneous text editing. HTML semantics and comment anchors still need an application policy.                             |
| [Automerge](https://automerge.org/docs/reference/documents/conflicts/)                          | Concurrent document changes merge, with explicit conflicting values. A source editor integration would still be required.                                           |
| [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream/consumers)                        | Durable consumers and replay are useful at larger scale. Database writes and broker publication still need reliable coordination.                                   |
| [Redis Streams](https://redis.io/docs/latest/develop/use-cases/streaming/)                      | Ordered entries, acknowledgements, and pending-message recovery. Adds a service and a second persistence system.                                                    |
| [Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) | A room owner, persistent storage, and socket hibernation. Useful hosted alternative that requires the Cloudflare runtime.                                           |

The [PGlite worker design](https://pglite.dev/docs/multi-tab-worker) informed
the multi-tab database owner. We reproduced an SDK teardown failure when a
closed tab interrupted transaction RPC and replaced that wrapper with complete
app-owned worker operations; see the related
[upstream report](https://github.com/electric-sql/pglite/issues/1084). Its
[IndexedDB filesystem](https://pglite.dev/docs/filesystems) loads database files
into memory and flushes changed files after queries. Normal durability is
required for the local recovery database. A leader change can leave a request
outcome uncertain, so command IDs and database constraints must make retries
safe. Browser data is still subject to
[quota and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

Native IndexedDB remains a useful comparison for the small recovery records.
Measure startup, enqueue latency, database size, and leader-change recovery
before making a long-term browser storage choice. The current browser merge
uses bounded multiple text edits to preserve distant independent changes. True overlaps or an exhausted merge work limit retain the
draft for explicit reconciliation.
