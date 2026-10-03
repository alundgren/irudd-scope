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

People edit HTML source beside a live preview. Edits first commit to the
browser recovery database and then send to the server. Disjoint source changes
reconcile across multiple separate text changes; overlapping changes preserve
the draft and open a merge editor. Browser merging uses bounded
[jsdiff character changes](https://github.com/kpdecker/jsdiff). Each changed-region
search allows 100 ms and 10,000 insertions/deletions; exceeding either budget
preserves the draft for manual reconciliation. Pure insertions/deletions avoid
that search. A whole-source paste replaces the visible source, including any
older content it deliberately reintroduces; that change receives its own version.
The top-bar User menu offers Alex, Blair and Casey with stable fake user IDs.
Each tab selects its user independently and remembers that choice for tab
reloads. Switching changes future edits and presence; already queued commands
keep their original author. API agents still supply their own actor.
Each tab owns an independent editor identity. Other tabs can deliver its saved
commands after it closes. Saved browser drafts also exposes unresolved work.
Permanent HTTP 400, 413 or 422 rejection parks the immutable command without
blocking other editors. Rejected changes retains its reason and original payload
across reloads, with export and dismissal. Rejected HTML stays editable; a changed
draft sends under a new ID. Restore rejected HTML lets another tab recover it
for editing, without automatically resending it. Source and merge inputs stay
read-only during restoration so typing cannot race the recovered generation. An
uncertain local restore keeps editing locked until Retry local save confirms
the durable row; HTML export remains available. Rejected comments offer an
editable retry. Network errors, timeouts and server errors keep the original ID.

Use Comment on preview to choose an element or position. Authored elements
receive persistent HTML IDs when needed. Generated or ambiguous elements stay
detached. Removing an element keeps its discussion; restoring its unique ID
reconnects it. History shows immutable HTML, comments, replies, resolution
state and the corresponding Git diff.

SQLite initialization retries competing writers asynchronously for up to five
seconds before reporting a timeout. The server requires native Git. It persists accepted state, events, snapshots,
and immutable command receipts in SQLite with WAL and full synchronous writes.
`PLAN_WEB_DB` selects its database file. `PORT` defaults to `43130`; `HOST`
defaults to `127.0.0.1`. Source development runs from this package, so its default
`./plan-web.sqlite` lives here. Keep the database, WAL and SHM files together.

The browser uses PGlite in a SharedWorker with IndexedDB and
`relaxedDurability: false`. Complete database operations run inside the worker.
A local transaction stores the accepted snapshot and replay cursor, retires
acknowledged commands and preserves newer draft generations together. Browser
editing needs HTTPS or localhost, SharedWorker and Web Locks support. Browser
eviction or clearing can remove unsent drafts. Export HTML saves the live local
draft, including while viewing history.

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
vp run test tests/plan-web-api.test.ts tests/plan-web-stream.test.ts tests/plan-web-browser.test.ts --maxWorkers=1
PLAN_WEB_PRESSURE_ROUNDS=50 vp run test tests/plan-web-browser.test.ts -t 'multiple humans' --maxWorkers=1
vp run ready
```

The browser tests launch real Chromium against an isolated SQLite server. They
exercise humans and agents, independent tabs, duplicates, restart, offline
reload, uncertain responses, copied tab identities, successor drafts, conflict
recovery, comments, authored DOM identity, physical database worker termination,
permanent rejection recovery, eight tabs, eight separate plans and read-only startup before local recovery is ready. Failure evidence is saved under
`/tmp/scope-web-*-evidence.json` with screenshots and observed command traffic.
