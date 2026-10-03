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
change directly affects Scope. This policy follows the user's explicit override
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

## Integration

The permanent branch incorporates `origin/main` at `8f8d630`. Backend work is
in [PR #82](https://github.com/alundgren/irudd-scope/pull/82) and multiplexed
streams are in [PR #83](https://github.com/alundgren/irudd-scope/pull/83).
[PR #85](https://github.com/alundgren/irudd-scope/pull/85) contains the browser
implementation and scoped validation. These PRs target the permanent branch.
Never retarget them or this branch to main.

The User menu offers exactly Alex, Blair and Casey independently in each tab.
Queued commands retain their original actor. Permanent HTTP 400/413/422
rejections preserve work without blocking other editors. Saved and rejected
HTML restoration locks competing controls and retries one journaled operation.
Existing pins allow clicks through during comment placement and regain
interaction afterward.

## Run and validate

Run from a checkout containing the browser implementation:

```sh
vp install --frozen-lockfile
vp run plan-web#build
vp run plan-web
```

Open `http://localhost:43130/plans/team-plan` in two browser windows. Choose
Alex in one and Blair in the other. Each tab remembers its own selection on
reload. Visiting a new plan URL creates that plan.

The default SQLite database is `apps/plan-web/plan-web.sqlite`. Set
`PLAN_WEB_DB` to use another database. Retain its WAL and SHM files with the
database. Browser storage belongs to the origin; changing the host or port
creates a separate local recovery database. The app requires HTTPS or localhost
for durable browser editing.

Use focused app validation:

```sh
# App build, format/type/lint checks and all 56 app tests:
vp run plan-web:ready
# API/stream and bounded text merge:
vp test run --project=standard tests/plan-web-api.test.ts tests/plan-web-stream.test.ts tests/plan-web-merge.test.ts --maxWorkers=1
# Extended native-input concurrency pressure:
PLAN_WEB_PRESSURE_ROUNDS=50 vp test run --project=standard tests/plan-web-browser.test.ts -t 'multiple humans' --maxWorkers=1
```

`plan-web:check` checks only the app, its four test files and supporting
handoff/workflow/catalog files. Lint includes type-aware and TypeScript checks.
`plan-web:test` directly runs the four files with one file worker, without
launching Scope, Electron or Xvfb. The browser scenarios still run several
users and agents concurrently. CI uses this app gate for the exploration
branch and PRs targeting it. Other branches retain their Scope validation.

The app suite has 24 API/stream cases, six text-merge cases and 26 real
Chromium cases. It covers offline reload, duplicates, lost and hanging replies,
owner closure, worker/server restart, conflicts, comment detachment, copied
tabs, eight tabs/plans, fake users, permanent rejection and recovery after
committed replies are lost. Tests use isolated SQLite databases and headless
Chromium without credentials or models. Browser failures save screenshots and
observations to `/tmp/scope-web-*-evidence.json`.

The extended scenario runs two human editors, two witness tabs and six API
agents through 50 rounds. It checks every participant's rendered fields after
each round, accepts 400 edits, repeats 300 agent requests, and restarts the
server midway. Source edits use real native keyboard input. Comment tests use
unforced clicks and assertions that re-resolve pins when presence updates
replace their DOM nodes.

Keep current validation receipts and review evidence in the PR or external
report. Do not substitute historical passes for exact-head results. No Scope
suite is required for changes confined to this independent app.

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
