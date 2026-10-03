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
review changes before integration. Run `vp run ready` before every push and
completion. Exercise multiple browser users and agents, dropped connections,
duplicate delivery, process restart, competing edits, and comment detachment.

## Status

Repository and storage/stream scouts are investigating. No implementation is
complete yet. Architecture, run commands, PR links, verification evidence, and
remaining work will be recorded here as the prototype develops.

## Proposed ownership and persistence

The exploration owns a separate `apps/plan-web` package. It does not import
desktop internals or change the deployed artifact API. Its backend owns SQLite
records for HTML snapshots, Git-generated unified diffs, comments, accepted
commands, and replayable events. One transaction commits a mutation and its
event before clients can observe success.

Browser drafts, outgoing commands, cached snapshots, and replay cursors use a
PGlite multi-tab worker backed by IndexedDB, with normal durability. This is
the web app's local recovery database, separate from desktop-owned SQLite.
Every tab keeps its own draft. Stable command IDs make competing tab retries
safe. Browser eviction or clearing can still remove locally unsynced work.

HTTP commands and a typed SSE feed provide both directions of communication.
The durable event log determines accepted order. Disjoint HTML edits can rebase;
overlapping edits must keep the local draft and show a conflict. Presence is a
transient lease and does not create plan history for every pointer movement.

An independent reviewer is evaluating these decisions before implementation.

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

[PGlite's worker](https://pglite.dev/docs/multi-tab-worker) elects one database
owner across tabs and serializes SQL access. Its
[IndexedDB filesystem](https://pglite.dev/docs/filesystems) loads database files
into memory and flushes changed files after queries. Normal durability is
required for the local recovery database. A leader change can leave a request
outcome uncertain, so command IDs and database constraints must make retries
safe. Browser data is still subject to
[quota and eviction](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).

Native IndexedDB remains a useful comparison for the small recovery records.
Measure startup, enqueue latency, database size, and leader-change recovery
before making a long-term browser storage choice. V1's conservative source
rebase may reject independent edits when one edit spans several distant parts
of the HTML; it must retain the draft for explicit reconciliation.
