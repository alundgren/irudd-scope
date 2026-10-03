# Collaborative HTML plans

This standalone web app belongs to the permanent exploration branch in
[HANDOFF.md](../../HANDOFF.md). Never merge that branch into main.

From the repository root:

```sh
vp install
vp run plan-web#build
vp run plan-web
```

Open `http://localhost:43130/plans/team-plan`. Visiting a new plan URL creates
it. Change the name in the URL to start another plan. The app accepts ordinary
HTML, including scripts. V1 has no authentication or authorization.

The browser is a reader and discussion tool. Agents edit HTML through the API.
The accepted HTML fills the content area and runs authored scripts. Comments
opens a panel; closing it gives the space back to the HTML. More contains
read-only history, exports, rejected comments and the browser HTML archive.
Returning from history shows the current accepted plan.

The User menu offers Alex, Blair and Casey with stable fake user IDs. Each tab
remembers its own choice through reload. Switching changes future comments and
presence; queued commands keep their captured author. Separate tabs keep
independent session identities, including tabs using the same fake user.
API agents supply their own actor.

Use Comment on preview, then click an element or position. A unique existing
authored HTML ID connects the comment. Missing IDs, duplicate IDs, generated
elements and ambiguous source matches produce detached comments. Selection,
cancellation and submission never insert IDs or change canonical HTML bytes.
Removing an element keeps its discussion; restoring its unique authored ID
reconnects it. History includes immutable HTML, comments, replies, resolution
state and the corresponding Git diff.

Comments, replies and resolution changes commit to the browser database before
the composer clears. Other tabs can deliver saved commands after their owner
closes. Network errors, timeouts and server errors retry the exact original ID
and payload. A permanent HTTP 400, 413 or 422 refusal parks the command without
blocking other comments. Rejected comments retains the original reason and
payload across reloads and offers edited retry, export and dismissal.

On the first database opening with this reader, a transaction freezes all old
browser HTML drafts and HTML outbox records into a read-only archive before
snapshot acceptance. It preserves HTML and base HTML bytes, actors,
generations, conflicts, request IDs, original status and rejection details.
HTML requests leave the live queue in that same transaction and never retry or
autoqueue. Pending records may already have reached the server, so their
original outcome remains unknown. Old draft rows also remain unchanged.
Export the archive for deliberate recovery by an agent. There are no browser
HTML editing, merging, saving or restoration controls. Archived HTML cannot
block comments or replace the accepted server HTML in the preview.

SQLite initialization retries competing writers asynchronously for up to five
seconds before reporting a timeout. The server requires native Git. It persists accepted state, events, snapshots,
and immutable command receipts in SQLite with WAL and full synchronous writes.
`PLAN_WEB_DB` selects its database file. `PORT` defaults to `43130`; `HOST`
defaults to `127.0.0.1`. Source development runs from this package, so its default
`./plan-web.sqlite` lives here. Keep the database, WAL and SHM files together.

The browser uses PGlite in a SharedWorker with IndexedDB and
`relaxedDurability: false`. Complete database operations run inside the worker.
A local transaction stores the accepted snapshot and replay cursor and retires
acknowledged comments together. Comment readiness belongs to a separate reader
row, independently of archived HTML. Durable comments need HTTPS or localhost,
SharedWorker and Web Locks support. Until storage is ready, cached or fetched
HTML remains readable while comment controls stay unavailable. Browser eviction
or clearing can remove unsent comments and archived work. Export HTML saves the
accepted HTML currently being viewed, including a selected historical version.

Agents use `/api/plans/:name`. GET returns the latest snapshot. POST
`/commands` accepts the command union in [contracts.ts](src/contracts.ts).
HTML edits carry `baseHtmlRevision`; every command carries an actor and stable
`requestId`. JSON command bodies are limited to 2 MiB. After an uncertain
outcome, retry exactly the same command and ID.
A changed payload under that ID rejects. A 409 preserves the original conflict
receipt; read current state and reconcile under a new ID.

GET `/events?after=N` on a plan emits typed `plan` events with revision IDs and transient
`presence` events without durable IDs. SSE resumes from its cursor or
`Last-Event-ID`; SQLite polling closes the snapshot/live gap and sees commits
from another server connection. Replay uses bounded batches, and a stalled
subscriber disconnects after five seconds so it can reconnect and catch up.
GET `/versions` pages history; GET `/versions/:revision` reads an exact snapshot.
POST `/presence` sends the session actor and pointer position.

The browser shares one origin-wide `/api/events?subscriptions=...` connection
inside the database worker. Subscriptions contain plan names and committed
revision cursors. Plan frames identify their plan through the snapshot; presence
frames contain `{name, people}`. Versioned SSE IDs encode the cursor map. The
endpoint accepts at most 20 plans, a 4,096-character encoded query and an
8,192-character combined query/cursor budget. The worker commits snapshots and
cursors before notifying tabs and reconnects from those committed cursors.
This avoids the browser HTTP/1 limit of six SSE connections per origin.

HTML and comments have a shared document revision. HTML also has a separate
revision, so comment traffic does not create false source conflicts. Presence
expires after 15 seconds and belongs to one server process. Durable writes and
replay safely share SQLite across server processes; presence does not.

Run API and browser scenarios with:

```sh
vp run plan-web:ready
vp test run --project=standard tests/plan-web-browser.test.ts --maxWorkers=1
```

The browser tests launch real Chromium against an isolated SQLite server. They
exercise comment readers and external API agents, independent tabs, duplicate
commands, restart, offline reload, lost and delayed acknowledgements, owner
closure, comment rejection recovery, authored DOM identity without HTML
mutation, physical database worker termination, eight tabs, eight separate plans,
read-only startup and preservation of legacy HTML records across database reopen.
Failure evidence is saved under `/tmp/scope-web-*-evidence.json` with screenshots
and observed command traffic.
